"""Curriculum learning, self-play checkpoints, and deterministic evaluation gates."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
from typing import Literal

import numpy as np

from .athletes import athlete_profile
from .coach import AdaptiveTrainingCoach
from .environment import FIGHTER_SIDES, FighterSide, ForgeBoxingEnv, TacticalCommand
from .policy import RecurrentMotorPolicy, RecurrentTacticalPolicy


CurriculumName = Literal[
    "balance",
    "footwork",
    "moving_strikes",
    "projectile_evasion",
    "impact_recovery",
    "scripted_defense",
    "self_play",
]

TRAINING_VERSION = 15
SOLO_STAGES = (
    "balance",
    "footwork",
    "projectile_evasion",
    "impact_recovery",
)
# Every stage is now graded unassisted. The scripted teacher only ever appears
# inside a separate demonstration episode that distills joint targets into the
# brain; it never touches a search rollout or an evaluation. Grading a stage
# with the assist switched on is what let an athlete post 15 s upright while
# its own controller could not stand for 2 s.
AUTONOMOUS_VALIDATION_STAGES = (
    "balance",
    "footwork",
    "moving_strikes",
    "projectile_evasion",
    "impact_recovery",
    "scripted_defense",
    "self_play",
)
# Held-out courses used for every baseline/candidate comparison. Keeping them
# fixed is what makes reward comparable from one generation to the next; the
# search rollouts still draw fresh seeds so the policy cannot simply memorize
# these few episodes.
EVALUATION_EPISODES = {
    "balance": 2,
    "footwork": 2,
    "moving_strikes": 2,
    "projectile_evasion": 4,
    "impact_recovery": 2,
    "scripted_defense": 3,
    "self_play": 3,
}
# Rollouts each population member runs per perturbation. Projectile courses are
# the noisiest drill, so its members are averaged over two launches.
SEARCH_EPISODES = {"projectile_evasion": 2}
PROMOTION_STREAK = 5


@dataclass(frozen=True)
class CurriculumStage:
    name: CurriculumName
    episode_seconds: float
    domain_randomization: float
    promotion_reward: float
    teacher_weight: float


# teacher_weight is the assist a demonstration episode may start with, and it
# only means something where the scripted teacher actually produces joint
# targets. Measured at one control step per stage, the balance teacher emits
# exactly zero on all 33 joints, so an assist there did nothing but mute the
# athlete's own controller and hand distillation a target of "output nothing",
# which erased the seeded vestibular reflex it needs to stand.
CURRICULUM = (
    CurriculumStage("balance", 8.0, 0.00, 50.0, 0.00),
    CurriculumStage("footwork", 28.0, 0.05, 280.0, 0.90),
    CurriculumStage("moving_strikes", 14.0, 0.10, 105.0, 0.85),
    CurriculumStage("projectile_evasion", 15.0, 0.14, 112.0, 0.00),
    CurriculumStage("impact_recovery", 15.0, 0.18, 110.0, 0.35),
    CurriculumStage("scripted_defense", 15.0, 0.22, 112.0, 0.70),
    CurriculumStage("self_play", 18.0, 0.30, 140.0, 0.00),
)


def movement_requirements(stage: CurriculumName) -> tuple[float, float]:
    return {
        "balance": (0.0, 0.0),
        "footwork": (4.0, 4.5),
        "moving_strikes": (0.30, 0.30),
        "projectile_evasion": (0.12, 0.20),
        "impact_recovery": (0.0, 0.0),
        "scripted_defense": (0.10, 0.10),
        "self_play": (0.03, 0.08),
    }[stage]


class AdamOptimizer:
    """Per-parameter adaptive ascent for the evolution-strategy gradient.

    A single fixed step size cannot serve a 148-wide observation matrix and a
    33-element bias at once: whichever scale it suits, the other either stalls
    or diverges. Adam normalizes each group by its own gradient history.
    """

    def __init__(self, learning_rate: float = 0.012) -> None:
        self.learning_rate = learning_rate
        self.steps = 0
        self.first: dict[str, np.ndarray] = {}
        self.second: dict[str, np.ndarray] = {}

    def reset(self) -> None:
        self.steps = 0
        self.first = {}
        self.second = {}

    def damp(self, factor: float) -> None:
        for moment in (self.first, self.second):
            for value in moment.values():
                value *= factor

    def step(
        self,
        gradient: dict[str, np.ndarray],
        learning_rate: float | None = None,
    ) -> dict[str, np.ndarray]:
        rate = self.learning_rate if learning_rate is None else learning_rate
        self.steps += 1
        first_correction = 1.0 - 0.9 ** self.steps
        second_correction = 1.0 - 0.999 ** self.steps
        update: dict[str, np.ndarray] = {}
        for name, value in gradient.items():
            first = self.first.get(name)
            second = self.second.get(name)
            if first is None or first.shape != value.shape:
                first = np.zeros_like(value)
                second = np.zeros_like(value)
            first = 0.9 * first + 0.1 * value
            second = 0.999 * second + 0.001 * value * value
            self.first[name] = first
            self.second[name] = second
            update[name] = rate * (first / first_correction) / (
                np.sqrt(second / second_correction) + 1e-8
            )
        return update


@dataclass
class TrainingMetrics:
    generation: int = 0
    episodes: int = 0
    physics_steps: int = 0
    checkpoint_reward: float = 0.0
    working_reward: float = 0.0
    candidate_reward: float = 0.0
    accepted_checkpoints: int = 0
    curriculum_index: int = 0
    promotion_streak: int = 0
    motor_updates: int = 0
    tactical_updates: int = 0
    autonomous_episodes: int = 0
    demonstration_episodes: int = 0
    autonomous_evaluations: int = 0
    learning_updates: int = 0
    verified_checkpoints: int = 0
    distillation_error: float = 0.0
    stagnant_generations: int = 0


@dataclass(frozen=True)
class EvaluationGate:
    accepted: bool
    learning_advanced: bool
    reward_improved: bool
    finite_state: bool
    upright_seconds: float
    minimum_upright_seconds: float
    commanded_distance: float
    minimum_commanded_distance: float
    foot_travel: float
    minimum_foot_travel: float
    behavior_passed: bool
    behavior_improved: bool
    projectile_hits: float
    projectile_defenses: float
    incoming_impulse_ns: float
    outgoing_impulse_ns: float
    defense_attempts: float
    defense_evades: float
    defense_blocks: float
    defense_clean_hits: float
    clean_incoming_impulse_ns: float
    guard_impulse_ns: float
    promotion_streak: int
    autonomous: bool
    # Assist allowed inside the demonstration episode that distills joint
    # targets into the brain. It anneals to zero as skill is measured.
    teacher_weight: float
    # Assist present while the athlete is graded. Always zero: every stage is
    # now scored on what the athlete does by itself.
    validation_teacher_weight: float
    footwork_goal_reached: bool
    footwork_remaining_distance_m: float


@dataclass(frozen=True)
class EpisodeResult:
    reward: float
    upright_seconds: float
    physics_steps: int
    commanded_distance: float
    foot_travel: float
    end_reason: str = "horizon"
    projectile_hits: float = 0.0
    incoming_impulse_ns: float = 0.0
    outgoing_impulse_ns: float = 0.0
    projectile_dodges: float = 0.0
    projectile_deflections: float = 0.0
    defense_attempts: float = 0.0
    defense_evades: float = 0.0
    defense_blocks: float = 0.0
    defense_clean_hits: float = 0.0
    clean_incoming_impulse_ns: float = 0.0
    guard_impulse_ns: float = 0.0
    elapsed_seconds: float = 0.0
    footwork_goal_reached: bool = False
    footwork_remaining_distance_m: float = 0.0
    projectile_attempts: tuple[dict[str, object], ...] = ()


def defense_rate(result: EpisodeResult) -> float:
    defended = result.defense_evades + result.defense_blocks
    return defended / max(result.defense_attempts, 1.0)


def projectile_skill_score(result: EpisodeResult) -> float:
    """Prioritize resolved defenses and reduce the force of unavoidable hits."""
    return (
        3.0 * result.projectile_dodges
        + 2.0 * result.projectile_deflections
        - 4.0 * result.projectile_hits
        - 0.08 * result.incoming_impulse_ns
    )


def behavior_gate(stage: CurriculumName, result: EpisodeResult) -> bool:
    projectile_defenses = result.projectile_dodges + result.projectile_deflections
    if stage == "moving_strikes":
        return result.outgoing_impulse_ns >= 1.0
    if stage == "footwork":
        return (
            result.footwork_goal_reached
            and result.commanded_distance >= 4.0
            and result.end_reason == "horizon"
        )
    if stage == "projectile_evasion":
        return result.projectile_hits <= 4.0 and projectile_defenses >= 2.0
    if stage == "impact_recovery":
        return result.incoming_impulse_ns >= 5.0
    if stage == "scripted_defense":
        return (
            result.defense_attempts >= 4.0
            and defense_rate(result) >= 0.65
            and result.clean_incoming_impulse_ns <= 4.0
        )
    if stage == "self_play":
        return result.outgoing_impulse_ns >= 0.5
    return True


def behavior_preserved(
    stage: CurriculumName,
    baseline: EpisodeResult,
    candidate: EpisodeResult,
) -> bool:
    if stage == "footwork":
        if baseline.footwork_goal_reached:
            return candidate.footwork_goal_reached
        return candidate.commanded_distance + 0.02 >= baseline.commanded_distance
    if stage == "projectile_evasion":
        baseline_defenses = baseline.projectile_dodges + baseline.projectile_deflections
        candidate_defenses = candidate.projectile_dodges + candidate.projectile_deflections
        return (
            candidate_defenses >= baseline_defenses
            or candidate.projectile_hits < baseline.projectile_hits
        )
    if stage == "scripted_defense":
        return (
            defense_rate(candidate) + 0.03 >= defense_rate(baseline)
            and candidate.clean_incoming_impulse_ns
            <= baseline.clean_incoming_impulse_ns + 0.20
        )
    if stage == "moving_strikes":
        return candidate.outgoing_impulse_ns + 0.05 >= baseline.outgoing_impulse_ns
    if stage == "impact_recovery":
        return candidate.incoming_impulse_ns + 0.25 >= baseline.incoming_impulse_ns
    if stage == "self_play":
        return candidate.outgoing_impulse_ns + 0.05 >= baseline.outgoing_impulse_ns
    return behavior_gate(stage, candidate)


@dataclass
class OpponentCheckpoint:
    athlete_id: str
    path: str
    rating: float
    generation: int
    reward: float
    tactical_path: str | None = None


class OpponentPool:
    """Small persistent league of frozen neural opponents for self-play."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.manifest_path = self.root / "opponents.json"
        self.entries: list[OpponentCheckpoint] = []
        self.load()

    def load(self) -> None:
        if not self.manifest_path.exists():
            return
        payload = json.loads(self.manifest_path.read_text())
        self.entries = [OpponentCheckpoint(**entry) for entry in payload.get("opponents", [])]

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {"opponents": [asdict(entry) for entry in self.entries[-24:]]}
        self.manifest_path.write_text(json.dumps(payload, indent=2) + "\n")

    def add(
        self,
        athlete_id: str,
        policy: RecurrentMotorPolicy,
        tactical_policy: RecurrentTacticalPolicy,
        generation: int,
        reward: float,
        rating: float = 1200.0,
    ) -> OpponentCheckpoint:
        filename = f"{athlete_id}-g{generation:06d}.npz"
        path = self.root / filename
        policy.save(path)
        tactical_filename = f"{athlete_id}-g{generation:06d}-tactical.npz"
        tactical_policy.save(self.root / tactical_filename)
        entry = OpponentCheckpoint(
            athlete_id,
            filename,
            rating,
            generation,
            reward,
            tactical_filename,
        )
        self.entries.append(entry)
        self.entries = self.entries[-24:]
        self.save()
        return entry

    def sample(
        self,
        rng: np.random.Generator,
        observation_size: int | None = None,
        action_size: int | None = None,
    ) -> RecurrentMotorPolicy | None:
        available = [entry for entry in self.entries if (self.root / entry.path).exists()]
        if not available:
            return None
        ratings = np.asarray([entry.rating for entry in available], dtype=np.float64)
        weights = np.exp((ratings - ratings.max()) / 240.0)
        selected = available[int(rng.choice(len(available), p=weights / weights.sum()))]
        return RecurrentMotorPolicy.load(
            self.root / selected.path,
            observation_size=observation_size,
            action_size=action_size,
        )

    def sample_brain(
        self,
        rng: np.random.Generator,
        motor_observation_size: int,
        motor_action_size: int,
        tactical_observation_size: int,
    ) -> tuple[RecurrentMotorPolicy | None, RecurrentTacticalPolicy | None, str | None]:
        available = [entry for entry in self.entries if (self.root / entry.path).exists()]
        if not available:
            return None, None, None
        ratings = np.asarray([entry.rating for entry in available], dtype=np.float64)
        weights = np.exp((ratings - ratings.max()) / 240.0)
        selected = available[int(rng.choice(len(available), p=weights / weights.sum()))]
        motor = RecurrentMotorPolicy.load(
            self.root / selected.path,
            observation_size=motor_observation_size,
            action_size=motor_action_size,
        )
        tactical_path = self.root / selected.tactical_path if selected.tactical_path else None
        tactical = (
            RecurrentTacticalPolicy.load(
                tactical_path,
                observation_size=tactical_observation_size,
            )
            if tactical_path and tactical_path.exists()
            else None
        )
        return motor, tactical, selected.athlete_id


def curriculum_command(
    stage: CurriculumStage,
    time_seconds: float,
    side: FighterSide,
) -> TacticalCommand:
    phase = int(time_seconds / 0.8) % 6
    direction = 1.0 if side == "blue" else -1.0
    if stage.name == "balance":
        return TacticalCommand()
    if stage.name == "footwork":
        return TacticalCommand(
            advance=0.88,
            guard=0.30,
            urgency=0.68,
        )
    if stage.name == "moving_strikes":
        return TacticalCommand(
            advance=0.62 if phase in (0, 1, 2) else 0.55 if phase >= 4 else 0.0,
            retreat=0.52 if phase == 3 else 0.0,
            circle=direction * (0.28 if phase >= 4 else 0.0),
            pivot=direction * (0.35 if phase == 5 else 0.0),
            guard=0.72,
            jab=0.85 if phase in (0, 3) else 0.0,
            cross=0.85 if phase in (1, 4) else 0.0,
            hook=0.75 if phase in (2, 5) else 0.0,
            body_target=0.7 if phase >= 3 else 0.0,
            urgency=0.68,
        )
    if stage.name == "projectile_evasion":
        return TacticalCommand(
            guard=0.28,
            urgency=0.88,
        )
    if stage.name == "impact_recovery":
        return TacticalCommand(
            retreat=0.52 if phase in (1, 2, 4) else 0.0,
            circle=direction * (0.22 if phase in (0, 3, 5) else 0.0),
            guard=0.48,
            head_movement=0.15,
            urgency=0.58,
        )
    if stage.name == "scripted_defense":
        return TacticalCommand(
            retreat=0.52,
            circle=direction * 0.28,
            pivot=-direction * 0.45,
            guard=0.95,
            head_movement=0.8,
            level_change=0.55 if phase % 3 == 0 else 0.0,
            jab=0.45 if phase == 5 else 0.0,
            urgency=0.68,
        )
    return TacticalCommand(
        advance=0.62 if phase in (0, 1) else 0.0,
        retreat=0.48 if phase == 4 else 0.0,
        circle=direction * (0.30 if phase % 2 == 0 else -0.22),
        pivot=direction * (0.35 if phase == 5 else 0.0),
        guard=0.82,
        head_movement=0.55,
        level_change=0.35 if phase == 3 else 0.0,
        jab=0.7 if phase in (0, 3) else 0.0,
        cross=0.72 if phase in (1, 4) else 0.0,
        hook=0.65 if phase in (2, 5) else 0.0,
        body_target=0.55 if phase >= 3 else 0.0,
        urgency=0.78,
    )


class EvolutionStrategyTrainer:
    """Gradient-estimating reinforcement learner for recurrent motor weights."""

    def __init__(
        self,
        checkpoint_root: str | Path,
        seed: int = 0,
        population_pairs: int = 10,
        noise_scale: float = 0.035,
        learning_rate: float = 0.012,
        athlete_id: str | None = None,
    ) -> None:
        self.checkpoint_root = Path(checkpoint_root)
        self.athlete_id = athlete_id
        self.state_root = (
            self.checkpoint_root / "athlete_training" / athlete_id
            if athlete_id
            else self.checkpoint_root
        )
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.population_pairs = population_pairs
        self.noise_scale = noise_scale
        self.learning_rate = learning_rate
        self.metrics = TrainingMetrics()
        self._load_metrics()
        self.opponents = OpponentPool(self.checkpoint_root / "opponent_pool")
        self.coach = AdaptiveTrainingCoach(self.state_root, athlete_id or "unassigned")
        self.motor_optimizer = AdamOptimizer(learning_rate)
        self.tactical_optimizer = AdamOptimizer(learning_rate)
        self.reward_history: list[float] = []
        self.latest_replay: list[dict[str, object]] = []
        self.latest_replay_id = 0
        self.latest_replay_end_reason = "waiting"
        self.last_evaluation_result = EpisodeResult(0.0, 0.0, 0, 0.0, 0.0, "waiting")
        self.pinned_stage: CurriculumName | None = None

    @property
    def stage(self) -> CurriculumStage:
        if self.pinned_stage is not None:
            return next(stage for stage in CURRICULUM if stage.name == self.pinned_stage)
        return CURRICULUM[self.metrics.curriculum_index]

    def set_pinned_stage(self, name: CurriculumName | None) -> None:
        """Pin the trainer to one scenario, or restore auto-rotation with None.

        Pinning temporarily runs the requested stage and freezes promotion. It
        does not rewrite the athlete's saved curriculum progress.
        """
        if name is None:
            self.pinned_stage = None
            return
        index = next(
            (i for i, entry in enumerate(CURRICULUM) if entry.name == name),
            None,
        )
        if index is None:
            return
        self.pinned_stage = name

    def _episode(
        self,
        target_policy: RecurrentMotorPolicy,
        target_tactical_policy: RecurrentTacticalPolicy,
        side: FighterSide,
        episode_seed: int,
        opponent_policy: RecurrentMotorPolicy | None = None,
        opponent_tactical_policy: RecurrentTacticalPolicy | None = None,
        opponent_athlete_id: str | None = None,
        capture_replay: bool = False,
        motor_teacher_override: float | None = None,
        imitation_learning_rate: float = 0.0,
    ) -> EpisodeResult:
        stage = self.stage
        challenge_scale = self.coach.state.challenge_scale
        motor_teacher_weight = (
            self._motor_teacher_weight(stage)
            if motor_teacher_override is None
            else motor_teacher_override
        )
        env = ForgeBoxingEnv(
            seed=episode_seed,
            max_seconds=stage.episode_seconds,
            domain_randomization=float(np.clip(
                stage.domain_randomization * challenge_scale,
                0.0,
                0.50,
            )),
            training_stage=stage.name,
            termination_sides=(side,),
            solo_side=side if stage.name in SOLO_STAGES else None,
            starting_separation_m=(
                0.82
                if stage.name == "moving_strikes"
                else 0.82
                if stage.name == "scripted_defense"
                else 0.68
                if stage.name == "self_play"
                else None
            ),
            motor_teacher_weight=motor_teacher_weight,
            projectile_difficulty=challenge_scale,
            projectile_focus=tuple(self.coach.state.llm_course_focus),
            athlete_profiles={
                side: athlete_profile(self.athlete_id),
                "red" if side == "blue" else "blue": athlete_profile(
                    opponent_athlete_id
                    or ("jonah-vale" if self.athlete_id == "malik-okoro" else "malik-okoro")
                ),
            },
        )
        target_policy.reset()
        target_tactical_policy.reset()
        opponent = "red" if side == "blue" else "blue"
        if opponent_policy is None:
            opponent_policy = env.create_policy(opponent, episode_seed + 1000)
            if stage.name not in ("moving_strikes", "scripted_defense", "self_play"):
                for value in opponent_policy.weights.values():
                    value.fill(0.0)
        if opponent_tactical_policy is None:
            opponent_tactical_policy = env.create_tactical_policy(
                opponent,
                episode_seed + 2000,
            )
        opponent_policy.reset()
        opponent_tactical_policy.reset()
        env.seed_tactical_prior(target_tactical_policy)
        env.seed_tactical_prior(opponent_tactical_policy)
        policies = {side: target_policy, opponent: opponent_policy}
        tactical_policies = {
            side: target_tactical_policy,
            opponent: opponent_tactical_policy,
        }
        autonomous_stage = stage.name in ("scripted_defense", "self_play")
        tactical_teacher_weight = (
            stage.teacher_weight
            if motor_teacher_override is None or motor_teacher_override > 0.0
            else 0.0
        )
        total_reward = 0.0
        upright_seconds = 0.0
        physics_steps = 0
        commanded_distance = 0.0
        foot_travel = 0.0
        incoming_impulse_ns = 0.0
        outgoing_impulse_ns = 0.0
        clean_incoming_impulse_ns = 0.0
        guard_impulse_ns = 0.0
        info: dict[str, object] = {}
        footwork_direction = np.zeros(2, dtype=np.float64)
        maximum_goal_progress = 0.0
        if stage.name == "footwork":
            footwork_delta = env.footwork_target[:2] - env.footwork_start[:2]
            footwork_direction = footwork_delta / max(
                float(np.linalg.norm(footwork_delta)),
                1e-6,
            )
        while True:
            time_seconds = float(env.data.time)
            env.data.xfrc_applied[:] = 0.0
            if stage.name == "balance":
                pelvis_id = env.model.body(f"{side}_pelvis").id
                direction = 1.0 if episode_seed % 2 == 0 else -1.0
                if 2.40 <= time_seconds < 2.52:
                    env.data.xfrc_applied[pelvis_id, 1] = 65.0 * direction * challenge_scale
                elif 5.20 <= time_seconds < 5.30:
                    env.data.xfrc_applied[pelvis_id, 0] = 55.0 * direction * challenge_scale
            if autonomous_stage:
                learned_commands = env.autonomous_commands(tactical_policies)
                target_teacher = (
                    curriculum_command(stage, time_seconds, side)
                    if stage.teacher_weight > 0.0
                    else TacticalCommand()
                )
                opponent_teacher = (
                    curriculum_command(
                        CURRICULUM[2] if stage.name == "scripted_defense" else stage,
                        time_seconds + 0.4,
                        opponent,
                    )
                    if stage.teacher_weight > 0.0
                    else TacticalCommand()
                )
                target_command = TacticalCommand.blend(
                    target_teacher,
                    learned_commands[side],
                    tactical_teacher_weight,
                )
                opponent_command = (
                    opponent_teacher
                    if stage.name == "scripted_defense"
                    else TacticalCommand.blend(
                        opponent_teacher,
                        learned_commands[opponent],
                        tactical_teacher_weight,
                    )
                )
            else:
                target_command = curriculum_command(stage, time_seconds, side)
                opponent_command = TacticalCommand()
            if stage.name == "footwork" and env.footwork_goal_reached:
                target_command = TacticalCommand(guard=0.30)
            pelvis_before = env._body_position(f"{side}_pelvis")
            feet_before = {
                leg: env._body_position(f"{side}_{leg}_foot")
                for leg in ("left", "right")
            }
            _, rewards, done, info = env.step(
                policies,
                {side: target_command, opponent: opponent_command},
                exploration=0.0,
                imitation_learning_rate=imitation_learning_rate,
            )
            total_reward += rewards[side]
            impacts = info["impacts"]
            outgoing = impacts[side]  # type: ignore[index]
            incoming = impacts[opponent]  # type: ignore[index]
            outgoing_impulse_ns += float(
                outgoing["head_impulse_ns"]
                + outgoing["body_impulse_ns"]
                + outgoing["guard_impulse_ns"]
            )
            clean_incoming = float(
                incoming["head_impulse_ns"] + incoming["body_impulse_ns"]
            )
            guarded = float(incoming["guard_impulse_ns"])
            projectile_impulse = float(
                info["projectiles"][side]["hit_impulse_ns"]  # type: ignore[index]
            )
            clean_incoming_impulse_ns += clean_incoming + projectile_impulse
            guard_impulse_ns += guarded
            incoming_impulse_ns += clean_incoming + guarded + projectile_impulse
            pelvis_after = env._body_position(f"{side}_pelvis")
            pelvis_matrix = env._body_matrix(f"{side}_pelvis")
            displacement = pelvis_after - pelvis_before
            locomotion = (
                (target_command.advance - target_command.retreat)
                * float(np.dot(displacement[:2], pelvis_matrix[:2, 0]))
                + target_command.circle
                * float(np.dot(displacement[:2], pelvis_matrix[:2, 1]))
            )
            if stage.name == "footwork":
                maximum_goal_progress = max(
                    maximum_goal_progress,
                    float(np.dot(
                        pelvis_after[:2] - env.footwork_start[:2],
                        footwork_direction,
                    )),
                )
                commanded_distance = max(0.0, maximum_goal_progress)
            else:
                commanded_distance += max(0.0, locomotion)
            for leg in ("left", "right"):
                foot_travel += float(np.linalg.norm(
                    env._body_position(f"{side}_{leg}_foot") - feet_before[leg]
                ))
            pelvis_up = env._body_matrix(f"{side}_pelvis")[2, 2]
            if pelvis_up > 0.72 and env._body_position(f"{side}_head")[2] > 1.15:
                upright_seconds += env.control_seconds
            physics_steps += 10
            if done:
                break
        if (
            stage.name in AUTONOMOUS_VALIDATION_STAGES
            and motor_teacher_weight <= 0.0
        ):
            self.metrics.autonomous_episodes += 1
        if capture_replay:
            self.latest_replay = env.replay.copy()
            self.latest_replay_id += 1
            self.latest_replay_end_reason = str(info.get("endReason") or "horizon")
        projectile_totals = info["projectileTotals"][side]  # type: ignore[index]
        defense_totals = info["defenseTotals"][side]  # type: ignore[index]
        footwork = info["footwork"]  # type: ignore[index]
        projectile_attempts = info["projectileAttempts"][side]  # type: ignore[index]
        return EpisodeResult(
            reward=total_reward,
            upright_seconds=upright_seconds,
            physics_steps=physics_steps,
            commanded_distance=commanded_distance,
            foot_travel=foot_travel,
            end_reason=str(info.get("endReason") or "horizon"),
            projectile_hits=float(projectile_totals["hits"]),
            incoming_impulse_ns=incoming_impulse_ns,
            outgoing_impulse_ns=outgoing_impulse_ns,
            projectile_dodges=float(projectile_totals["dodges"]),
            projectile_deflections=float(projectile_totals["deflections"]),
            defense_attempts=float(defense_totals["attacks"]),
            defense_evades=float(defense_totals["evades"]),
            defense_blocks=float(defense_totals["blocks"]),
            defense_clean_hits=float(defense_totals["clean_hits"]),
            clean_incoming_impulse_ns=clean_incoming_impulse_ns,
            guard_impulse_ns=guard_impulse_ns,
            elapsed_seconds=float(info.get("time", env.data.time)),
            footwork_goal_reached=bool(footwork["goalReached"]),
            footwork_remaining_distance_m=float(footwork["remainingDistanceM"]),
            projectile_attempts=tuple(projectile_attempts),
        )

    def _stage_offset(self, name: CurriculumName) -> int:
        return next(index for index, stage in enumerate(CURRICULUM) if stage.name == name)

    def evaluation_seeds(self, episodes: int) -> list[int]:
        """Fixed held-out courses for this athlete and stage.

        Re-drawing evaluation seeds every generation, as this loop used to,
        means the baseline and the candidate are compared on tasks that keep
        changing underneath them. Measured episode-to-episode spread was about
        4.5 reward units against a real improvement under 1 unit per 200
        generations, so the accept/reject decision was reading noise.
        """
        base = self.seed + 900_000 + 1_000 * self._stage_offset(self.stage.name)
        return [base + index for index in range(episodes)]

    def evaluate(
        self,
        policy: RecurrentMotorPolicy,
        tactical_policy: RecurrentTacticalPolicy,
        side: FighterSide = "blue",
        episodes: int = 2,
        capture_replay: bool = False,
        motor_teacher_override: float | None = None,
    ) -> tuple[float, float, int, float, float]:
        seeds = self.evaluation_seeds(episodes)
        rewards = []
        upright = []
        commanded_distance = []
        foot_travel = []
        results: list[EpisodeResult] = []
        physics_steps = 0
        for episode in range(episodes):
            if self.stage.name == "self_play":
                opponent, opponent_tactical, opponent_athlete_id = self.opponents.sample_brain(
                    self.rng,
                    policy.observation_size,
                    policy.action_size,
                    tactical_policy.observation_size,
                )
            else:
                opponent, opponent_tactical, opponent_athlete_id = None, None, None
            result = self._episode(
                policy.copy(),
                tactical_policy.copy(),
                side,
                seeds[episode],
                opponent,
                opponent_tactical,
                opponent_athlete_id,
                capture_replay=capture_replay and episode == episodes - 1,
                motor_teacher_override=motor_teacher_override,
            )
            rewards.append(result.reward)
            results.append(result)
            upright.append(result.upright_seconds)
            commanded_distance.append(result.commanded_distance)
            foot_travel.append(result.foot_travel)
            physics_steps += result.physics_steps
        self.metrics.episodes += episodes
        self.metrics.physics_steps += physics_steps
        end_reason = next(
            (reason for reason in ("knockout", "fall") if any(
                result.end_reason == reason for result in results
            )),
            "horizon",
        )
        self.last_evaluation_result = EpisodeResult(
            float(np.mean(rewards)),
            float(np.mean(upright)),
            physics_steps,
            float(np.mean(commanded_distance)),
            float(np.mean(foot_travel)),
            end_reason,
            float(np.mean([result.projectile_hits for result in results])),
            float(np.mean([result.incoming_impulse_ns for result in results])),
            float(np.mean([result.outgoing_impulse_ns for result in results])),
            float(np.mean([result.projectile_dodges for result in results])),
            float(np.mean([result.projectile_deflections for result in results])),
            float(np.mean([result.defense_attempts for result in results])),
            float(np.mean([result.defense_evades for result in results])),
            float(np.mean([result.defense_blocks for result in results])),
            float(np.mean([result.defense_clean_hits for result in results])),
            float(np.mean([result.clean_incoming_impulse_ns for result in results])),
            float(np.mean([result.guard_impulse_ns for result in results])),
            float(np.mean([result.elapsed_seconds for result in results])),
            bool(all(result.footwork_goal_reached for result in results)),
            float(np.mean([result.footwork_remaining_distance_m for result in results])),
            tuple(
                attempt
                for result in results
                for attempt in result.projectile_attempts
            ),
        )
        return (
            float(np.mean(rewards)),
            float(np.mean(upright)),
            physics_steps,
            float(np.mean(commanded_distance)),
            float(np.mean(foot_travel)),
        )

    def _search_seeds(self, generation: int) -> list[int]:
        """Common random numbers: one course list shared by the whole population.

        Every member of a generation must face the identical course, otherwise
        the advantage of a perturbation is confounded with the difficulty of
        whichever seed it happened to draw and rank shaping compares numbers
        that were never comparable. The list rotates each generation so the
        search still has to generalize.
        """
        count = SEARCH_EPISODES.get(self.stage.name, 1)
        base = self.seed + 1 + generation * 97
        return [base + index for index in range(count)]

    def _search_rollout(
        self,
        policy: RecurrentMotorPolicy,
        tactical_policy: RecurrentTacticalPolicy,
        side: FighterSide,
        seeds: list[int],
    ) -> float:
        total = 0.0
        for seed in seeds:
            result = self._episode(
                policy,
                tactical_policy,
                side,
                seed,
                motor_teacher_override=0.0,
            )
            total += result.reward
            self.metrics.episodes += 1
            self.metrics.physics_steps += result.physics_steps
        return total / max(1, len(seeds))

    def _distill_demonstration(
        self,
        policy: RecurrentMotorPolicy,
        tactical_policy: RecurrentTacticalPolicy,
        side: FighterSide,
        teacher_weight: float,
    ) -> None:
        """Copy the scripted teacher's joint targets into the neural controller.

        This is the only place assistance is allowed. The athlete watches the
        teacher drive the body and regresses its own output onto those targets,
        so what it learns here is exactly what it must reproduce alone during
        the unassisted search and evaluation that follow.
        """
        demonstration = self._episode(
            policy,
            tactical_policy,
            side,
            self.seed + self.metrics.generation * 100 + 77,
            motor_teacher_override=teacher_weight,
            imitation_learning_rate=0.0035,
        )
        self.metrics.episodes += 1
        self.metrics.demonstration_episodes += 1
        self.metrics.physics_steps += demonstration.physics_steps

    def train_generation(
        self,
        athlete_id: str,
        policy: RecurrentMotorPolicy,
        tactical_policy: RecurrentTacticalPolicy,
        side: FighterSide = "blue",
    ) -> tuple[RecurrentMotorPolicy, RecurrentTacticalPolicy, EvaluationGate]:
        stage = self.stage
        validation_episodes = EVALUATION_EPISODES.get(stage.name, 2)
        # Every stage is graded with the assist off, so the search optimizes the
        # same controller the gate measures.
        autonomous_validation = stage.name in AUTONOMOUS_VALIDATION_STAGES
        validation_teacher = 0.0
        teacher_weight = self._motor_teacher_weight(stage)
        (
            baseline_reward,
            baseline_upright,
            _,
            baseline_distance,
            baseline_foot_travel,
        ) = self.evaluate(
            policy,
            tactical_policy,
            side,
            episodes=validation_episodes,
            motor_teacher_override=validation_teacher,
        )
        baseline_result = self.last_evaluation_result
        search_policy = policy.copy()
        if teacher_weight > 0.0:
            self._distill_demonstration(
                search_policy,
                tactical_policy.copy(),
                side,
                teacher_weight,
            )
        autonomous_stage = stage.name in ("scripted_defense", "self_play")
        train_tactical = autonomous_stage and self.metrics.generation % 2 == 1
        active_policy = tactical_policy if train_tactical else search_policy
        gradient = {
            name: np.zeros_like(value)
            for name, value in active_policy.weights.items()
        }
        advantages: list[float] = []
        noises: list[dict[str, np.ndarray]] = []
        effective_noise_scale = self.noise_scale * self.coach.state.exploration_scale
        search_seeds = self._search_seeds(self.metrics.generation)
        for _ in range(self.population_pairs):
            noise = (
                tactical_policy.noise(self.rng, self._tactical_trainable_parameters())
                if train_tactical
                else search_policy.noise(self.rng, self._trainable_parameters())
            )
            if train_tactical:
                plus_reward = self._search_rollout(
                    search_policy.copy(),
                    tactical_policy.perturb(noise, effective_noise_scale),
                    side,
                    search_seeds,
                )
                minus_reward = self._search_rollout(
                    search_policy.copy(),
                    tactical_policy.perturb(noise, -effective_noise_scale),
                    side,
                    search_seeds,
                )
            else:
                plus_reward = self._search_rollout(
                    search_policy.perturb(noise, effective_noise_scale),
                    tactical_policy.copy(),
                    side,
                    search_seeds,
                )
                minus_reward = self._search_rollout(
                    search_policy.perturb(noise, -effective_noise_scale),
                    tactical_policy.copy(),
                    side,
                    search_seeds,
                )
            advantages.append(plus_reward - minus_reward)
            noises.append(noise)
        weights = self._rank_weights(advantages)
        for weight, noise in zip(weights, noises, strict=True):
            for name in gradient:
                gradient[name] += weight * noise[name]
        # Finish the Monte-Carlo gradient estimate. The old code divided by
        # max(1.0, pairs * sigma), and pairs * sigma is 0.35 here, so the
        # normalization never actually applied.
        estimator_scale = 1.0 / (self.population_pairs * max(effective_noise_scale, 1e-6))
        for value in gradient.values():
            value *= estimator_scale
        candidate_policy = search_policy.copy()
        candidate_tactical = tactical_policy.copy()
        stage_learning_rate = self.learning_rate * self.coach.state.learning_rate_scale
        optimizer = self.tactical_optimizer if train_tactical else self.motor_optimizer
        step = optimizer.step(gradient, stage_learning_rate)
        # An evolution strategy is a stochastic gradient method: the step is
        # taken every generation. Gating each one on a noisy single-episode
        # comparison, as this loop used to, turns the whole search into a random
        # walk that reverts most of its own progress.
        if train_tactical:
            candidate_tactical.add_scaled(step, 1.0)
            self.metrics.tactical_updates += 1
        else:
            candidate_policy.add_scaled(step, 1.0)
            self.metrics.motor_updates += 1
        finite = all(
            np.isfinite(value).all()
            for value in (
                *candidate_policy.weights.values(),
                *candidate_tactical.weights.values(),
            )
        )
        if not finite:
            candidate_policy = search_policy.copy()
            candidate_tactical = tactical_policy.copy()
            optimizer.reset()
        (
            candidate_reward,
            candidate_upright,
            _,
            candidate_distance,
            candidate_foot_travel,
        ) = self.evaluate(
            candidate_policy,
            candidate_tactical,
            side,
            episodes=validation_episodes,
            motor_teacher_override=validation_teacher,
        )
        self.metrics.autonomous_evaluations += 2 * validation_episodes
        candidate_result = self.last_evaluation_result
        minimum_upright = stage.episode_seconds * (
            0.90 if stage.name == "footwork" else 0.75
        )
        reward_margin = max(1e-5, abs(baseline_reward) * 1e-7)
        improved = candidate_reward > baseline_reward + reward_margin
        upright_improved = candidate_upright >= baseline_upright + 0.05
        minimum_distance, minimum_foot_travel = movement_requirements(stage.name)
        task_behavior_preserved = behavior_preserved(
            stage.name,
            baseline_result,
            candidate_result,
        )
        task_behavior_passed = behavior_gate(stage.name, candidate_result)
        if stage.name == "projectile_evasion":
            behavior_improved = (
                projectile_skill_score(candidate_result)
                > projectile_skill_score(baseline_result) + 0.02
            )
        elif stage.name == "footwork":
            behavior_improved = (
                candidate_result.footwork_goal_reached
                and not baseline_result.footwork_goal_reached
            ) or candidate_distance > baseline_distance + 0.05
        else:
            behavior_improved = task_behavior_preserved and improved
        # The working brain follows the gradient; the verified checkpoint is
        # what stays conservative.
        learning_advanced = finite
        self.metrics.generation += 1
        self.metrics.candidate_reward = candidate_reward
        if learning_advanced:
            policy = candidate_policy
            tactical_policy = candidate_tactical
            self.metrics.learning_updates += 1
            self.metrics.working_reward = candidate_reward
            policy.save(self.checkpoint_root / "athletes" / f"{athlete_id}-working.npz")
            tactical_policy.save(
                self.checkpoint_root / "athletes" / f"{athlete_id}-tactical-working.npz"
            )
        # A verified checkpoint has to clear the stage's measured skill gate
        # unassisted, survive the horizon, and beat the reward the last verified
        # brain scored on these same held-out courses.
        accepted = bool(
            finite
            and task_behavior_passed
            and task_behavior_preserved
            and candidate_result.end_reason == "horizon"
            and candidate_upright >= minimum_upright
            and candidate_distance >= minimum_distance
            and candidate_foot_travel >= minimum_foot_travel
            and (
                self.metrics.verified_checkpoints == 0
                or candidate_reward >= self.metrics.checkpoint_reward
            )
        )
        if accepted:
            self.metrics.accepted_checkpoints += 1
            self.metrics.verified_checkpoints += 1
            self.metrics.checkpoint_reward = candidate_reward
            self.metrics.working_reward = candidate_reward
            policy.save(self.checkpoint_root / "athletes" / f"{athlete_id}.npz")
            tactical_policy.save(
                self.checkpoint_root / "athletes" / f"{athlete_id}-tactical.npz"
            )
            if self.metrics.accepted_checkpoints == 1 or self.metrics.accepted_checkpoints % 5 == 0:
                self.opponents.add(
                    athlete_id,
                    policy,
                    tactical_policy,
                    self.metrics.generation,
                    candidate_reward,
                )
        showcase = self._episode(
            policy.copy(),
            tactical_policy.copy(),
            side,
            self.seed + self.metrics.generation * 100 + 99,
            capture_replay=True,
            motor_teacher_override=validation_teacher,
        )
        self.metrics.episodes += 1
        self.metrics.physics_steps += showcase.physics_steps
        selected_result = candidate_result
        measured_distance = selected_result.commanded_distance
        measured_foot_travel = selected_result.foot_travel
        # Promotion is decided by measured skill, not by a fixed reward number.
        # The old absolute thresholds sat above where reward plateaus: malik
        # spent 200 generations scoring 105-110 against a bar of 112, so the
        # streak reset every single generation and the stage never ended.
        stage_passed = bool(
            selected_result.upright_seconds >= minimum_upright
            and measured_distance >= minimum_distance
            and measured_foot_travel >= minimum_foot_travel
            and selected_result.end_reason == "horizon"
            and behavior_gate(stage.name, selected_result)
        )
        self.metrics.promotion_streak = self.metrics.promotion_streak + 1 if stage_passed else 0
        self._track_progress(candidate_reward)
        review_stage = stage
        self.coach.review(
            stage=review_stage.name,
            generation=self.metrics.generation,
            accepted=accepted,
            stage_passed=stage_passed,
            finite_state=finite,
            reward=selected_result.reward,
            promotion_reward=self._reward_target(),
            upright_seconds=selected_result.upright_seconds,
            minimum_upright_seconds=minimum_upright,
            commanded_distance=selected_result.commanded_distance,
            minimum_commanded_distance=minimum_distance,
            foot_travel=selected_result.foot_travel,
            minimum_foot_travel=minimum_foot_travel,
            end_reason=selected_result.end_reason,
            projectile_hits=selected_result.projectile_hits,
            incoming_impulse_ns=selected_result.incoming_impulse_ns,
            outgoing_impulse_ns=selected_result.outgoing_impulse_ns,
            projectile_dodges=selected_result.projectile_dodges,
            projectile_deflections=selected_result.projectile_deflections,
            defense_attempts=selected_result.defense_attempts,
            defense_evades=selected_result.defense_evades,
            defense_blocks=selected_result.defense_blocks,
            defense_clean_hits=selected_result.defense_clean_hits,
            clean_incoming_impulse_ns=selected_result.clean_incoming_impulse_ns,
            guard_impulse_ns=selected_result.guard_impulse_ns,
            footwork_goal_reached=selected_result.footwork_goal_reached,
            footwork_remaining_distance_m=selected_result.footwork_remaining_distance_m,
            projectile_attempts=selected_result.projectile_attempts,
            learning_advanced=learning_advanced,
            autonomous=autonomous_validation,
            stagnant_generations=self.metrics.stagnant_generations,
        )
        if (
            self.pinned_stage is None
            and self.metrics.curriculum_index < len(CURRICULUM) - 1
            and self.metrics.promotion_streak >= PROMOTION_STREAK
        ):
            self.metrics.curriculum_index += 1
            self.metrics.promotion_streak = 0
            self.metrics.checkpoint_reward = 0.0
            self.metrics.working_reward = 0.0
            self.metrics.candidate_reward = 0.0
            self.metrics.verified_checkpoints = 0
            self.metrics.stagnant_generations = 0
            self.reward_history = []
            self.motor_optimizer.reset()
            self.tactical_optimizer.reset()
        self._save_metrics(athlete_id)
        return policy, tactical_policy, EvaluationGate(
            accepted=accepted,
            learning_advanced=learning_advanced,
            reward_improved=improved,
            finite_state=finite,
            upright_seconds=candidate_upright,
            minimum_upright_seconds=minimum_upright,
            commanded_distance=candidate_distance,
            minimum_commanded_distance=minimum_distance,
            foot_travel=candidate_foot_travel,
            minimum_foot_travel=minimum_foot_travel,
            behavior_passed=task_behavior_passed,
            behavior_improved=behavior_improved,
            projectile_hits=candidate_result.projectile_hits,
            projectile_defenses=(
                candidate_result.projectile_dodges
                + candidate_result.projectile_deflections
            ),
            incoming_impulse_ns=candidate_result.incoming_impulse_ns,
            outgoing_impulse_ns=candidate_result.outgoing_impulse_ns,
            defense_attempts=candidate_result.defense_attempts,
            defense_evades=candidate_result.defense_evades,
            defense_blocks=candidate_result.defense_blocks,
            defense_clean_hits=candidate_result.defense_clean_hits,
            clean_incoming_impulse_ns=candidate_result.clean_incoming_impulse_ns,
            guard_impulse_ns=candidate_result.guard_impulse_ns,
            promotion_streak=self.metrics.promotion_streak,
            autonomous=autonomous_validation,
            teacher_weight=teacher_weight,
            validation_teacher_weight=validation_teacher,
            footwork_goal_reached=candidate_result.footwork_goal_reached,
            footwork_remaining_distance_m=candidate_result.footwork_remaining_distance_m,
        )

    def _reward_target(self) -> float:
        """The athlete's own recent best, used as the coach's efficiency mark."""
        if not self.reward_history:
            return self.stage.promotion_reward
        return max(self.reward_history)

    def _track_progress(self, reward: float) -> None:
        """Notice a search that has stopped moving and shake it loose.

        Without this the coach saturates at its own bounds and keeps repeating
        the same block: malik's challenge scale sat pinned at the 0.65 floor and
        its exploration scale at the 1.30 ceiling for hundreds of generations.
        """
        self.reward_history.append(reward)
        self.reward_history = self.reward_history[-40:]
        if len(self.reward_history) < 20:
            return
        recent = np.asarray(self.reward_history[-10:])
        earlier = np.asarray(self.reward_history[-20:-10])
        spread = max(float(np.std(self.reward_history)), 1e-6)
        if float(recent.mean() - earlier.mean()) < 0.05 * spread:
            self.metrics.stagnant_generations += 1
        else:
            self.metrics.stagnant_generations = 0
        if self.metrics.stagnant_generations >= 12:
            # Flat for a dozen generations: drop the stale gradient history and
            # let the coach widen the search rather than grind the same step.
            self.motor_optimizer.damp(0.2)
            self.tactical_optimizer.damp(0.2)
            self.coach.report_stagnation()
            self.metrics.stagnant_generations = 0
            self.reward_history = []

    @staticmethod
    def _rank_weights(advantages: list[float]) -> np.ndarray:
        """Shape signed antithetic advantages by rank, without inventing tie gradients.

        Dividing raw advantages by their standard deviation lets one lucky
        episode dominate a whole generation's step. Ranking the magnitudes
        bounds every member's influence to 1/n while keeping the sign, which is
        the part that says which side of the mirrored pair was better.
        """
        values = np.asarray(advantages, dtype=np.float64)
        if values.size == 0:
            return values
        magnitudes = np.abs(values)
        if float(np.max(magnitudes)) <= 1e-9:
            return np.zeros_like(values)
        order = np.argsort(np.argsort(magnitudes))
        return np.sign(values) * (order + 1.0) / values.size

    def reset_progress(self, athlete_id: str) -> None:
        self.metrics = TrainingMetrics()
        self.motor_optimizer.reset()
        self.tactical_optimizer.reset()
        self.reward_history = []
        self.coach.reset()
        self.latest_replay = []
        self.latest_replay_id = 0
        self.latest_replay_end_reason = "waiting"
        self._save_metrics(athlete_id)

    def _trainable_parameters(self) -> tuple[str, ...]:
        if self.stage.name == "balance":
            defaults = ("balance_reflex", "motor_bias")
        elif self.stage.name == "footwork":
            defaults = ("balance_reflex", "command_motor", "gait_reflex", "motor_bias")
        else:
            defaults = tuple(self.policies_parameter_names())
        return self.coach.trainable_parameters(self.stage.name, defaults)

    def _motor_teacher_weight(self, stage: CurriculumStage) -> float:
        """Fade the scripted assist to nothing as unassisted skill is measured.

        This used to bottom out at 0.25 for the assisted stages and stay at the
        stage constant everywhere else, so the athlete never practised at full
        authority and never had to own the movement.
        """
        if stage.teacher_weight <= 0.0:
            return 0.0
        skill = float(np.clip(self.coach.state.skill_estimates.get(stage.name, 0.0), 0.0, 1.0))
        return float(np.clip(stage.teacher_weight * (1.0 - skill), 0.0, stage.teacher_weight))

    def _tactical_trainable_parameters(self) -> tuple[str, ...]:
        if self.stage.name == "scripted_defense":
            return ("action", "action_bias", "interrupt", "instinct")
        return (
            "observation",
            "recurrent",
            "hidden_bias",
            "action",
            "action_bias",
            "interrupt",
            "instinct",
        )

    @staticmethod
    def policies_parameter_names() -> tuple[str, ...]:
        return (
            "observation",
            "recurrent",
            "command",
            "hidden_bias",
            "motor",
            "motor_bias",
            "balance_reflex",
            "command_motor",
            "gait_reflex",
        )

    def _load_metrics(self) -> None:
        path = self.state_root / "training-status.json"
        if (
            not path.exists()
            and self.athlete_id == "malik-okoro"
            and (self.checkpoint_root / "training-status.json").exists()
        ):
            path = self.checkpoint_root / "training-status.json"
        if not path.exists():
            return
        try:
            payload = json.loads(path.read_text())
            saved = payload.get("metrics", {})
            saved_version = payload.get("trainingVersion")
            if saved_version in (8, 9, 10, 11, 12, 13, 14, TRAINING_VERSION):
                saved["curriculum_index"] = int(np.clip(
                    saved.get("curriculum_index", 0),
                    0,
                    len(CURRICULUM) - 1,
                ))
                self.metrics = TrainingMetrics(**{
                    field: saved.get(field, getattr(self.metrics, field))
                    for field in asdict(self.metrics)
                })
                if saved_version != TRAINING_VERSION:
                    # Reward is now measured unassisted and centred on the
                    # standing payout, so every stored score predates the scale
                    # it would be compared against.
                    self.metrics.checkpoint_reward = 0.0
                    self.metrics.working_reward = 0.0
                    self.metrics.candidate_reward = 0.0
                    self.metrics.accepted_checkpoints = 0
                    self.metrics.promotion_streak = 0
                    self.metrics.autonomous_episodes = 0
                    self.metrics.demonstration_episodes = 0
                    self.metrics.autonomous_evaluations = 0
                    self.metrics.learning_updates = 0
                    self.metrics.verified_checkpoints = 0
            else:
                self.metrics.generation = int(saved.get("generation", 0))
                self.metrics.episodes = int(saved.get("episodes", 0))
                self.metrics.physics_steps = int(saved.get("physics_steps", 0))
                self.metrics.accepted_checkpoints = int(saved.get("accepted_checkpoints", 0))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self.metrics = TrainingMetrics()

    def _save_metrics(self, athlete_id: str) -> None:
        self.state_root.mkdir(parents=True, exist_ok=True)
        payload = {
            "trainingVersion": TRAINING_VERSION,
            "athleteId": athlete_id,
            "metrics": asdict(self.metrics),
            "curriculum": asdict(self.stage),
        }
        (self.state_root / "training-status.json").write_text(
            json.dumps(payload, indent=2) + "\n"
        )
