"""Agent/environment boundary around the native MuJoCo boxing world."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

import mujoco
import numpy as np

from .athletes import AthleteProfile, BASELINE_PROFILE
from .conditioning import ConditioningProfile, JointFatigue, PhysiologyState, actuator_endurance
from .model import (
    CONTROL_DECIMATION,
    DRILL_PROJECTILE_COUNT,
    FIGHTER_SIDES,
    PHYSICS_TIMESTEP,
    build_boxing_model_xml,
)
from .policy import RecurrentMotorPolicy, RecurrentTacticalPolicy


FighterSide = Literal["blue", "red"]
# Per-control-step stability reward a competently standing athlete already
# banks. Outside the balance drill that payout is a near-constant offset
# (measured spread under 0.0005) worth ~107 over a 15 s episode, which buries
# the skill terms it is summed with. Skill stages score the deviation from it
# instead, so evasion, striking, and defense carry the learning signal.
COMPETENT_STANDING_REWARD = 0.1429
# Falling stops the episode. With the standing offset removed, an early fall
# would otherwise cost almost nothing, so unused horizon is charged directly.
FALL_PENALTY_PER_REMAINING_SECOND = 1.4
# Projectile drill difficulty ramp: balls launched in the same round share a
# speed multiplier that steps up every DRILL_ROUND_LENGTH launches.
DRILL_ROUND_LENGTH = 3
DRILL_ROUND_SPEED_GAIN = 0.14
DRILL_ROUND_MAX_SCALE = 2.1
PERCEPTION_PARTS = (
    "pelvis",
    "chest",
    "head",
    "left_upper_arm",
    "right_upper_arm",
    "left_glove",
    "right_glove",
    "left_foot",
    "right_foot",
)


def conditioning_from_profile(profile: AthleteProfile) -> ConditioningProfile:
    return ConditioningProfile(
        lower_body_power=float(np.clip(0.58 * profile.power + 0.42 * profile.speed, 0.55, 0.98)),
        lower_body_endurance=float(np.clip(0.82 * profile.cardio + 0.18 * profile.defense, 0.55, 0.98)),
        kinetic_chain=float(np.clip(
            0.42 * profile.reaction + 0.30 * profile.speed + 0.28 * profile.power,
            0.55,
            0.98,
        )),
        shoulder_endurance=float(np.clip(0.62 * profile.cardio + 0.38 * profile.speed, 0.55, 0.98)),
    )


@dataclass(frozen=True)
class TacticalCommand:
    advance: float = 0.0
    retreat: float = 0.0
    circle: float = 0.0
    pivot: float = 0.0
    guard: float = 0.0
    head_movement: float = 0.0
    level_change: float = 0.0
    jab: float = 0.0
    cross: float = 0.0
    hook: float = 0.0
    body_target: float = 0.0
    urgency: float = 0.25

    def as_array(self) -> np.ndarray:
        return np.clip(np.asarray(list(asdict(self).values()), dtype=np.float64), -1.0, 1.0)

    @classmethod
    def from_policy_output(cls, output: np.ndarray) -> TacticalCommand:
        values = np.clip(np.asarray(output, dtype=np.float64), -1.0, 1.0)
        if values.shape != (12,):
            raise ValueError(f"Expected 12 tactical actions, got {values.shape}.")
        advance = max(0.0, float(values[0]))
        retreat = max(0.0, float(values[1]))
        cancellation = min(advance, retreat)
        return cls(
            advance=advance - cancellation,
            retreat=retreat - cancellation,
            circle=float(values[2]),
            pivot=float(values[3]),
            guard=max(0.0, float(values[4])),
            head_movement=max(0.0, float(values[5])),
            level_change=max(0.0, float(values[6])),
            jab=max(0.0, float(values[7])),
            cross=max(0.0, float(values[8])),
            hook=max(0.0, float(values[9])),
            body_target=float(np.clip(0.5 + 0.5 * values[10], 0.0, 1.0)),
            urgency=float(np.clip(0.25 + 0.75 * max(0.0, values[11]), 0.25, 1.0)),
        )

    @classmethod
    def blend(
        cls,
        teacher: TacticalCommand,
        learned: TacticalCommand,
        teacher_weight: float,
    ) -> TacticalCommand:
        weight = float(np.clip(teacher_weight, 0.0, 1.0))
        values = weight * teacher.as_array() + (1.0 - weight) * learned.as_array()
        return cls(**{
            name: float(value)
            for name, value in zip(asdict(teacher), values, strict=True)
        })


@dataclass
class BodyMotion:
    position: np.ndarray
    velocity: np.ndarray
    acceleration: np.ndarray
    angular_velocity: np.ndarray


@dataclass
class ProjectileMotion:
    name: str
    position: np.ndarray
    velocity: np.ndarray
    acceleration: np.ndarray
    active: bool
    target_side: FighterSide


@dataclass
class MotionSnapshot:
    bodies: dict[str, dict[str, BodyMotion]]
    projectiles: tuple[ProjectileMotion, ...]


@dataclass
class ImpactTelemetry:
    head_impulse_ns: float = 0.0
    body_impulse_ns: float = 0.0
    guard_impulse_ns: float = 0.0
    glancing_impulse_ns: float = 0.0
    peak_force_n: float = 0.0
    kinetic_energy_j: float = 0.0
    head_energy_j: float = 0.0
    body_energy_j: float = 0.0
    closing_velocity_mps: float = 0.0
    effective_mass_kg: float = 0.0
    directness: float = 0.0
    rotational_transfer: float = 0.0
    rotational_impulse_nms: float = 0.0
    neurological_load: float = 0.0
    body_shock: float = 0.0
    guard_absorption: float = 0.0
    counter: bool = False
    power_shot: bool = False
    target: str = "none"
    anatomical_zone: str = "none"
    strike_kind: str = "none"
    glove: str = "none"
    impact_point: tuple[float, float, float] = (0.0, 0.0, 0.0)
    trajectory: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def add(self, update: ImpactTelemetry) -> None:
        self.head_impulse_ns += update.head_impulse_ns
        self.body_impulse_ns += update.body_impulse_ns
        self.guard_impulse_ns += update.guard_impulse_ns
        self.glancing_impulse_ns += update.glancing_impulse_ns
        self.kinetic_energy_j += update.kinetic_energy_j
        self.head_energy_j += update.head_energy_j
        self.body_energy_j += update.body_energy_j
        self.rotational_impulse_nms += update.rotational_impulse_nms
        self.neurological_load += update.neurological_load
        self.body_shock += update.body_shock
        self.peak_force_n = max(self.peak_force_n, update.peak_force_n)
        self.power_shot = self.power_shot or update.power_shot
        if update.closing_velocity_mps >= self.closing_velocity_mps:
            self.closing_velocity_mps = update.closing_velocity_mps
            self.effective_mass_kg = update.effective_mass_kg
            self.directness = update.directness
            self.rotational_transfer = update.rotational_transfer
            self.guard_absorption = update.guard_absorption
            self.counter = update.counter
            self.target = update.target
            self.anatomical_zone = update.anatomical_zone
            self.strike_kind = update.strike_kind
            self.glove = update.glove
            self.impact_point = update.impact_point
            self.trajectory = update.trajectory


@dataclass
class StrikeState:
    kind: str = "none"
    arm: str = "left"
    phase: float = 0.0
    drive: float = 0.0
    completed: bool = False
    cooldown: float = 0.0


@dataclass
class FighterTelemetry:
    reward: float = 0.0
    total_reward: float = 0.0
    head_damage: float = 0.0
    body_damage: float = 0.0
    mechanical_work_j: float = 0.0
    impact: ImpactTelemetry = field(default_factory=ImpactTelemetry)


@dataclass
class ProjectileTelemetry:
    hits: int = 0
    dodges: int = 0
    deflections: int = 0
    hit_impulse_ns: float = 0.0
    head_impulse_ns: float = 0.0
    body_impulse_ns: float = 0.0
    peak_force_n: float = 0.0
    incoming_speed_mps: float = 0.0
    clearance_gain_m: float = 0.0
    timely_responses: int = 0
    wrong_way_responses: int = 0

    def add(self, update: ProjectileTelemetry) -> None:
        self.hits += update.hits
        self.dodges += update.dodges
        self.deflections += update.deflections
        self.hit_impulse_ns += update.hit_impulse_ns
        self.head_impulse_ns += update.head_impulse_ns
        self.body_impulse_ns += update.body_impulse_ns
        self.peak_force_n = max(self.peak_force_n, update.peak_force_n)
        self.incoming_speed_mps = max(self.incoming_speed_mps, update.incoming_speed_mps)
        self.clearance_gain_m += update.clearance_gain_m
        self.timely_responses += update.timely_responses
        self.wrong_way_responses += update.wrong_way_responses


@dataclass
class DefenseTelemetry:
    attacks: int = 0
    evades: int = 0
    blocks: int = 0
    clean_hits: int = 0

    def add(self, update: DefenseTelemetry) -> None:
        self.attacks += update.attacks
        self.evades += update.evades
        self.blocks += update.blocks
        self.clean_hits += update.clean_hits


@dataclass
class ProjectileState:
    name: str
    active: bool = False
    target_side: FighterSide = "blue"
    launched_at: float = 0.0
    hit: bool = False
    attempt: ProjectileAttemptTelemetry | None = None
    last_target_clearance_m: float = 0.0


@dataclass
class ProjectileAttemptTelemetry:
    sequence: int
    course_seed: int
    projectile: str
    target_side: FighterSide
    outcome: str
    failure_reason: str
    incoming_direction: str
    target_height: str
    launched_at_s: float
    resolved_at_s: float
    expected_flight_s: float
    reaction_time_s: float | None
    incoming_speed_mps: float
    launch_origin: tuple[float, float, float]
    target_point: tuple[float, float, float]
    launch_velocity: tuple[float, float, float]
    initial_head_position: tuple[float, float, float]
    launch_forward: tuple[float, float, float]
    launch_lateral: tuple[float, float, float]
    minimum_head_height_m: float
    maximum_head_displacement_m: float = 0.0
    signed_forward_displacement_m: float = 0.0
    signed_lateral_displacement_m: float = 0.0
    vertical_displacement_m: float = 0.0
    minimum_ball_head_distance_m: float = 99.0
    maximum_target_clearance_m: float = 0.0
    contact_body: str = "none"
    contact_point: tuple[float, float, float] = (0.0, 0.0, 0.0)
    contact_impulse_ns: float = 0.0


class ForgeBoxingEnv:
    """Two free-standing 33-DOF athletes in deterministic contact physics."""

    def __init__(
        self,
        seed: int = 0,
        max_seconds: float = 30.0,
        domain_randomization: float = 0.0,
        training_stage: str = "boxing",
        termination_sides: tuple[FighterSide, ...] = FIGHTER_SIDES,
        solo_side: FighterSide | None = None,
        body_mass_kg: dict[FighterSide, float] | None = None,
        athlete_profiles: dict[FighterSide, AthleteProfile] | None = None,
        starting_separation_m: float | None = None,
        motor_teacher_weight: float = 0.0,
        projectile_difficulty: float = 1.0,
        projectile_focus: tuple[str, ...] = (),
    ) -> None:
        supplied_profiles = athlete_profiles or {}
        self.athlete_profiles = {
            side: supplied_profiles.get(side, BASELINE_PROFILE)
            for side in FIGHTER_SIDES
        }
        self.profiled_perception = athlete_profiles is not None
        xml, specs = build_boxing_model_xml(self.athlete_profiles)
        self.model = mujoco.MjModel.from_xml_string(xml)
        self.data = mujoco.MjData(self.model)
        requested_mass = body_mass_kg or {}
        for side in FIGHTER_SIDES:
            body_ids = np.asarray([
                body_id
                for body_id in range(1, self.model.nbody)
                if self.model.body(body_id).name.startswith(f"{side}_")
            ], dtype=np.int32)
            current_mass = float(np.sum(self.model.body_mass[body_ids]))
            target_mass = float(np.clip(
                requested_mass.get(side, self.athlete_profiles[side].mass_kg),
                45.0,
                125.0,
            ))
            mass_scale = target_mass / max(current_mass, 1e-6)
            self.model.body_mass[body_ids] *= mass_scale
            self.model.body_inertia[body_ids] *= mass_scale
        mujoco.mj_setConst(self.model, self.data)
        self.specs = specs
        self.rng = np.random.default_rng(seed)
        self.seed = seed
        self.max_seconds = max_seconds
        self.domain_randomization = float(np.clip(domain_randomization, 0.0, 1.0))
        self.training_stage = training_stage
        self.termination_sides = termination_sides
        self.solo_side = solo_side
        self.starting_separation_m = (
            float(np.clip(starting_separation_m, 0.62, 2.40))
            if starting_separation_m is not None
            else None
        )
        self.motor_teacher_weight = float(np.clip(motor_teacher_weight, 0.0, 1.0))
        self.projectile_difficulty = float(np.clip(projectile_difficulty, 0.50, 1.50))
        self.projectile_focus = tuple(projectile_focus)
        self.control_seconds = PHYSICS_TIMESTEP * CONTROL_DECIMATION
        self.actuator_ids: dict[str, np.ndarray] = {}
        self.joint_ids: dict[str, np.ndarray] = {}
        self.qpos_addresses: dict[str, np.ndarray] = {}
        self.qvel_addresses: dict[str, np.ndarray] = {}
        self.neutral: dict[str, np.ndarray] = {}
        self.action_span: dict[str, np.ndarray] = {}
        self.motor_index: dict[str, dict[str, int]] = {}
        self.arm_motor_mask: dict[str, np.ndarray] = {}
        self.spine_neck_mask: dict[str, np.ndarray] = {}
        self.joint_speed_limits: dict[str, np.ndarray] = {}
        self.last_motor_targets: dict[str, np.ndarray] = {}
        self.teacher_actions: dict[str, np.ndarray] = {}
        self.force_limits: dict[str, np.ndarray] = {}
        self.fatigue: dict[str, JointFatigue] = {}
        self.physiology = {
            "blue": PhysiologyState(),
            "red": PhysiologyState(),
        }
        self.strike_state = {
            "blue": StrikeState(),
            "red": StrikeState(),
        }
        self.locomotion_phase = {"blue": 0.0, "red": 0.0}
        self.locomotion_drive = {
            side: np.zeros(2, dtype=np.float64)
            for side in FIGHTER_SIDES
        }
        self.locomotion_footholds = {
            side: {
                leg: np.zeros(3, dtype=np.float64)
                for leg in ("left", "right")
            }
            for side in FIGHTER_SIDES
        }
        self.locomotion_swing_start = {
            side: {
                leg: np.zeros(3, dtype=np.float64)
                for leg in ("left", "right")
            }
            for side in FIGHTER_SIDES
        }
        self.locomotion_swinging = {
            side: {"left": False, "right": False}
            for side in FIGHTER_SIDES
        }
        self.evasion_drive = {"blue": 0.0, "red": 0.0}
        self.locomotion_velocity = {
            side: np.zeros(2, dtype=np.float64)
            for side in FIGHTER_SIDES
        }
        self.gait_tuning = {
            "cadence_base": 0.48,
            "cadence_urgency": 0.22,
            "cadence_speed": 0.45,
            "step_base": 0.13,
            "step_urgency": 0.10,
            "stance_drive": 0.12,
            "lean_reference": 0.14,
            "lean_drive": 0.0,
            "lean_gain": 1.10,
            "velocity_gain": 1.10,
            "desired_forward": 0.14,
            "desired_backward": 0.10,
            "desired_lateral": 0.18,
            "com_lateral_hip": 0.90,
            "com_lateral_ankle": 0.45,
            "burst_seconds": 0.85,
            "settle_seconds": 0.75,
        }
        self.conditioning = {
            side: conditioning_from_profile(self.athlete_profiles[side])
            for side in FIGHTER_SIDES
        }
        self.endurance: dict[str, np.ndarray] = {}
        self.telemetry = {
            "blue": FighterTelemetry(),
            "red": FighterTelemetry(),
        }
        self.last_commands = {
            "blue": TacticalCommand(),
            "red": TacticalCommand(),
        }
        self.tactical_tick = 0
        self.tactical_update_interval = 3
        self.tactical_held_commands = {
            "blue": TacticalCommand(),
            "red": TacticalCommand(),
        }
        self.tactical_interrupt = {"blue": False, "red": False}
        self.tactical_salience = {"blue": 0.0, "red": 0.0}
        self.instinct_salience = {"blue": 0.0, "red": 0.0}
        self.recent_impact_memory = {
            "blue": np.zeros(3, dtype=np.float64),
            "red": np.zeros(3, dtype=np.float64),
        }
        self.perception_latency_steps = self._perception_latency(seed)
        self.perception_history: list[MotionSnapshot] = []
        self.perceived_motion: dict[str, MotionSnapshot] = {}
        self.motion_previous_velocities: dict[str, np.ndarray] = {}
        self.projectile_previous_velocities: dict[str, np.ndarray] = {}
        self.projectile_names = tuple(
            f"drill_ball_{index}"
            for index in range(DRILL_PROJECTILE_COUNT)
        )
        self.projectile_qpos_addresses: dict[str, int] = {}
        self.projectile_qvel_addresses: dict[str, int] = {}
        self.projectile_states: dict[str, ProjectileState] = {}
        self.projectile_totals = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        self.projectile_step = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        self.projectile_recovery_seconds = {"blue": 0.0, "red": 0.0}
        self.projectile_next_launch = 1.2
        self.projectile_sequence = 0
        self.projectile_round = 0
        self.projectile_attempts: dict[FighterSide, list[ProjectileAttemptTelemetry]] = {
            "blue": [],
            "red": [],
        }
        self.footwork_start = np.zeros(3, dtype=np.float64)
        self.footwork_target = np.zeros(3, dtype=np.float64)
        self.footwork_goal_reached = False
        self.defense_totals = {
            "blue": DefenseTelemetry(),
            "red": DefenseTelemetry(),
        }
        self.defense_step = {
            "blue": DefenseTelemetry(),
            "red": DefenseTelemetry(),
        }
        self.strike_outcome = {"blue": "none", "red": "none"}
        self.replay: list[dict[str, object]] = []
        self.fall_seconds = {"blue": 0.0, "red": 0.0}
        self._base_body_mass = self.model.body_mass.copy()
        self._base_body_inertia = self.model.body_inertia.copy()
        self._base_geom_friction = self.model.geom_friction.copy()
        self._index_model()
        self._index_projectiles()
        self.reset()

    def _perception_latency(self, seed: int) -> dict[FighterSide, int]:
        if not self.profiled_perception:
            return {
                "blue": 4 + seed % 2,
                "red": 4 + (seed + 1) % 2,
            }
        return {
            side: int(np.clip(round(7.0 - 3.0 * self.athlete_profiles[side].reaction), 4, 6))
            for side in FIGHTER_SIDES
        }

    def _index_model(self) -> None:
        for side in FIGHTER_SIDES:
            actuator_ids = np.asarray([
                self.model.actuator(f"{spec.name}_motor").id
                for spec in self.specs[side]
            ], dtype=np.int32)
            joint_ids = self.model.actuator_trnid[actuator_ids, 0].astype(np.int32)
            qpos_addresses = self.model.jnt_qposadr[joint_ids].astype(np.int32)
            qvel_addresses = self.model.jnt_dofadr[joint_ids].astype(np.int32)
            ranges = self.model.jnt_range[joint_ids]
            self.actuator_ids[side] = actuator_ids
            self.joint_ids[side] = joint_ids
            self.qpos_addresses[side] = qpos_addresses
            self.qvel_addresses[side] = qvel_addresses
            self.neutral[side] = self.model.qpos0[qpos_addresses].copy()
            self.action_span[side] = np.minimum((ranges[:, 1] - ranges[:, 0]) * 0.32, 0.72)
            names = [spec.name for spec in self.specs[side]]
            self.motor_index[side] = {name: index for index, name in enumerate(names)}
            self.arm_motor_mask[side] = np.asarray([
                any(part in name for part in ("shoulder", "elbow", "forearm", "wrist"))
                for name in names
            ], dtype=bool)
            self.spine_neck_mask[side] = np.asarray([
                any(part in name for part in ("lumbar", "neck"))
                for name in names
            ], dtype=bool)
            self.joint_speed_limits[side] = np.asarray([
                7.5 if any(part in name for part in ("shoulder", "elbow"))
                else 6.0 if any(part in name for part in ("hip", "lumbar"))
                else 5.0
                for name in names
            ], dtype=np.float64) * (0.78 + 0.28 * self.athlete_profiles[side].speed)
            self.last_motor_targets[side] = self.neutral[side].copy()
            self.teacher_actions[side] = np.zeros(len(actuator_ids), dtype=np.float64)
            self.force_limits[side] = (
                self.model.actuator_forcerange[actuator_ids].copy()
                * (0.78 + 0.28 * self.athlete_profiles[side].power)
            )
            self.fatigue[side] = JointFatigue(len(actuator_ids))
            self.endurance[side] = actuator_endurance(names, self.conditioning[side])

    def _index_projectiles(self) -> None:
        for name in self.projectile_names:
            joint_id = self.model.joint(f"{name}_free").id
            self.projectile_qpos_addresses[name] = int(self.model.jnt_qposadr[joint_id])
            self.projectile_qvel_addresses[name] = int(self.model.jnt_dofadr[joint_id])
            self.projectile_states[name] = ProjectileState(name)

    @property
    def degrees_of_freedom_per_athlete(self) -> int:
        return len(self.specs["blue"]) + 6

    @property
    def motor_count_per_athlete(self) -> int:
        return len(self.specs["blue"])

    @property
    def observation_size(self) -> int:
        return self.observe("blue").size

    @property
    def tactical_observation_size(self) -> int:
        return self.tactical_observe("blue").size

    def create_policy(self, side: FighterSide, seed: int | None = None) -> RecurrentMotorPolicy:
        policy = RecurrentMotorPolicy(
            self.observation_size,
            self.motor_count_per_athlete,
            seed=self.seed + (1 if side == "blue" else 2) if seed is None else seed,
        )
        policy.weights["motor"] *= 0.10
        self.seed_locomotion_prior(policy, side)
        return policy

    def seed_locomotion_prior(
        self,
        policy: RecurrentMotorPolicy,
        side: FighterSide,
    ) -> None:
        """Give the trainable motor brain a spinal gait basis, not external propulsion."""
        gait = policy.weights["gait_reflex"]
        if policy.gait_version >= 3:
            return
        indexes = self.motor_index[side]
        balance = policy.weights["balance_reflex"]
        balance.fill(0.0)
        orientation = 1.0 if side == "blue" else -1.0
        for leg in ("left", "right"):
            ankle_pitch = indexes[f"{side}_{leg}_ankle_pitch"]
            ankle_roll = indexes[f"{side}_{leg}_ankle_roll"]
            balance[ankle_pitch, 0] = 6.0 * orientation
            balance[ankle_pitch, 4] = 20.0 * orientation
            balance[ankle_roll, 1] = -6.0 * orientation
            balance[ankle_roll, 3] = 20.0 * orientation
        gait.fill(0.0)

        def add(joint: str, feature: int, weight: float) -> None:
            gait[indexes[f"{side}_{joint}"], feature] += weight

        for leg, swing, opposite_swing in (("left", 3, 4), ("right", 4, 3)):
            motion_swing = 5 if leg == "left" else 6
            lateral_swing = 7 if leg == "left" else 8
            add(f"{leg}_hip_flex", swing, -0.42)
            add(f"{leg}_hip_flex", opposite_swing, 0.16)
            add(f"{leg}_knee", motion_swing, 0.46)
            add(f"{leg}_ankle_pitch", swing, -0.12)
            add(f"{leg}_ankle_pitch", opposite_swing, 0.18)
            add(f"{leg}_toe", opposite_swing, 0.16)
            add(f"{leg}_hip_abduct", lateral_swing, 0.20 if leg == "left" else -0.20)
        add("left_hip_abduct", 1, 0.12)
        add("right_hip_abduct", 1, 0.12)
        add("lumbar_pitch", 0, -0.08)
        gait *= 1.4352
        policy.gait_version = 3

    def create_tactical_policy(
        self,
        side: FighterSide,
        seed: int | None = None,
    ) -> RecurrentTacticalPolicy:
        policy = RecurrentTacticalPolicy(
            self.tactical_observation_size,
            seed=self.seed + (101 if side == "blue" else 202) if seed is None else seed,
        )
        self.seed_tactical_prior(policy)
        return policy

    @staticmethod
    def seed_tactical_prior(policy: RecurrentTacticalPolicy) -> None:
        """Start every tactical brain with pressure and defense instincts it can unlearn."""
        if policy.strategy_version >= 3:
            return
        policy.weights["action_bias"][0] = max(
            1.20,
            float(policy.weights["action_bias"][0]),
        )
        policy.weights["action_bias"][4] = max(
            0.24,
            float(policy.weights["action_bias"][4]),
        )
        for index, minimum in ((5, 0.16), (7, 0.45), (8, 0.35), (9, 0.25)):
            policy.weights["action_bias"][index] = max(
                minimum,
                float(policy.weights["action_bias"][index]),
            )
        policy.strategy_version = 3

    def _sensor(self, name: str) -> np.ndarray:
        sensor = self.model.sensor(name)
        start = int(sensor.adr[0]) if np.ndim(sensor.adr) else int(sensor.adr)
        size = int(sensor.dim[0]) if np.ndim(sensor.dim) else int(sensor.dim)
        return self.data.sensordata[start:start + size].copy()

    def upright(self, side: FighterSide) -> bool:
        """Whether this athlete is still carrying its own posture."""
        return bool(
            self._body_matrix(f"{side}_pelvis")[2, 2] > 0.72
            and self._body_position(f"{side}_head")[2] > 1.15
        )

    def _body_position(self, name: str) -> np.ndarray:
        return self.data.body(name).xpos.copy()

    def _body_matrix(self, name: str) -> np.ndarray:
        return self.data.body(name).xmat.reshape(3, 3).copy()

    def _capture_motion_snapshot(self) -> MotionSnapshot:
        bodies: dict[str, dict[str, BodyMotion]] = {}
        for side in FIGHTER_SIDES:
            bodies[side] = {}
            for part in PERCEPTION_PARTS:
                name = f"{side}_{part}"
                spatial_velocity = self._body_spatial_velocity(self.model.body(name).id)
                velocity = spatial_velocity[3:]
                previous = self.motion_previous_velocities.get(name, velocity)
                acceleration = (velocity - previous) / self.control_seconds
                self.motion_previous_velocities[name] = velocity.copy()
                bodies[side][part] = BodyMotion(
                    self._body_position(name),
                    velocity,
                    acceleration,
                    spatial_velocity[:3],
                )
        projectiles = []
        for state in self.projectile_states.values():
            velocity_address = self.projectile_qvel_addresses[state.name]
            velocity = self.data.qvel[velocity_address:velocity_address + 3].copy()
            previous = self.projectile_previous_velocities.get(state.name, velocity)
            acceleration = (velocity - previous) / self.control_seconds
            self.projectile_previous_velocities[state.name] = velocity.copy()
            projectiles.append(ProjectileMotion(
                state.name,
                self._body_position(state.name),
                velocity,
                acceleration,
                state.active,
                state.target_side,
            ))
        return MotionSnapshot(bodies, tuple(projectiles))

    def _noisy_snapshot(self, snapshot: MotionSnapshot) -> MotionSnapshot:
        spread = 1.0 + 1.5 * self.domain_randomization
        position_noise = 0.005 * spread
        velocity_noise = 0.035 * spread
        acceleration_noise = 0.22 * spread
        bodies: dict[str, dict[str, BodyMotion]] = {}
        for side in FIGHTER_SIDES:
            bodies[side] = {}
            for part in PERCEPTION_PARTS:
                motion = snapshot.bodies[side][part]
                bodies[side][part] = BodyMotion(
                    motion.position + self.rng.normal(0.0, position_noise, 3),
                    motion.velocity + self.rng.normal(0.0, velocity_noise, 3),
                    motion.acceleration + self.rng.normal(0.0, acceleration_noise, 3),
                    motion.angular_velocity + self.rng.normal(0.0, velocity_noise, 3),
                )
        projectiles = tuple(
            ProjectileMotion(
                projectile.name,
                projectile.position + self.rng.normal(0.0, position_noise, 3),
                projectile.velocity + self.rng.normal(0.0, velocity_noise, 3),
                projectile.acceleration + self.rng.normal(0.0, acceleration_noise, 3),
                projectile.active,
                projectile.target_side,
            )
            for projectile in snapshot.projectiles
        )
        return MotionSnapshot(bodies, projectiles)

    def _reset_perception(self) -> None:
        self.motion_previous_velocities = {}
        self.projectile_previous_velocities = {}
        snapshot = self._capture_motion_snapshot()
        history_size = max(self.perception_latency_steps.values()) + 1
        self.perception_history = [snapshot] * history_size
        self.perceived_motion = {
            side: self._noisy_snapshot(snapshot)
            for side in FIGHTER_SIDES
        }

    def _refresh_perception(self) -> None:
        self.perception_history.append(self._capture_motion_snapshot())
        self.perception_history = self.perception_history[-24:]
        self.perceived_motion = {}
        for side in FIGHTER_SIDES:
            source = self.perception_history[-self.perception_latency_steps[side] - 1]
            self.perceived_motion[side] = self._noisy_snapshot(source)

    def _perceived_body_motion(
        self,
        observer: FighterSide,
        subject: FighterSide,
        part: str,
    ) -> BodyMotion:
        return self.perceived_motion[observer].bodies[subject][part]

    def _perceived_facing_and_distance(self, side: FighterSide) -> tuple[float, float]:
        opponent = "red" if side == "blue" else "blue"
        own_position = self._body_position(f"{side}_pelvis")
        opponent_position = self._perceived_body_motion(side, opponent, "pelvis").position
        direction = opponent_position - own_position
        distance = float(np.linalg.norm(direction[:2]))
        if distance < 1e-8:
            return 1.0, 0.0
        local_forward = self._body_matrix(f"{side}_pelvis")[:, 0]
        facing = float(np.dot(local_forward[:2], direction[:2] / distance))
        return facing, distance

    def _facing_and_distance(self, side: FighterSide) -> tuple[float, float]:
        opponent = "red" if side == "blue" else "blue"
        own_position = self._body_position(f"{side}_pelvis")
        opponent_position = self._body_position(f"{opponent}_pelvis")
        direction = opponent_position - own_position
        distance = float(np.linalg.norm(direction[:2]))
        if distance < 1e-8:
            return 1.0, 0.0
        local_forward = self._body_matrix(f"{side}_pelvis")[:, 0]
        facing = float(np.dot(local_forward[:2], direction[:2] / distance))
        return facing, distance

    def observe(self, side: FighterSide) -> np.ndarray:
        opponent = "red" if side == "blue" else "blue"
        qpos = self.data.qpos[self.qpos_addresses[side]]
        ranges = self.model.jnt_range[self.joint_ids[side]]
        centers = (ranges[:, 0] + ranges[:, 1]) * 0.5
        spans = np.maximum((ranges[:, 1] - ranges[:, 0]) * 0.5, 1e-6)
        normalized_qpos = np.clip((qpos - centers) / spans, -2.0, 2.0)
        normalized_qvel = np.clip(
            self.data.qvel[self.qvel_addresses[side]] / 12.0,
            -2.0,
            2.0,
        )
        pelvis_id = self.model.body(f"{side}_pelvis").id
        pelvis_velocity = np.clip(self.data.cvel[pelvis_id] / 8.0, -2.0, 2.0)
        upright = self._body_matrix(f"{side}_pelvis")[:, 2]
        own_pelvis = self._body_position(f"{side}_pelvis")
        relative_targets = np.concatenate([
            (self._perceived_body_motion(side, opponent, body).position - own_pelvis) / 3.05
            for body in ("pelvis", "head", "left_glove", "right_glove")
        ])
        contact = np.asarray([
            float(self._sensor(f"{side}_{name}")[0]) / 1600.0
            for name in (
                "left_foot_force",
                "right_foot_force",
                "left_glove_force",
                "right_glove_force",
                "head_force",
                "body_force",
            )
        ])
        head_acceleration = np.clip(self._sensor(f"{side}_head_acceleration") / 75.0, -3.0, 3.0)
        head_angular_velocity = np.clip(self._sensor(f"{side}_head_angular_velocity") / 25.0, -3.0, 3.0)
        facing, distance = self._perceived_facing_and_distance(side)
        physiology = self.physiology[side]
        return np.concatenate([
            normalized_qpos,
            normalized_qvel,
            self.fatigue[side].fatigue,
            pelvis_velocity,
            upright,
            relative_targets,
            np.clip(contact, 0.0, 3.0),
            head_acceleration,
            head_angular_velocity,
            np.asarray([facing, distance / 3.05]),
            np.asarray([
                physiology.stamina,
                physiology.guard_stability,
                physiology.equilibrium,
                physiology.active_control,
                self.strike_state[side].phase,
            ]),
            self._projectile_observation(side),
        ]).astype(np.float64)

    def _projectile_observation(self, side: FighterSide) -> np.ndarray:
        own_head = self._body_position(f"{side}_head")
        rotation = self._body_matrix(f"{side}_pelvis")
        nearest: tuple[float, np.ndarray] | None = None
        for projectile in self.perceived_motion[side].projectiles:
            if not projectile.active:
                continue
            relative = rotation.T @ (projectile.position - own_head)
            distance = float(np.linalg.norm(relative))
            candidate = (distance, relative)
            if nearest is None or candidate[0] < nearest[0]:
                nearest = candidate
        if nearest is None:
            return np.zeros(9, dtype=np.float64)
        distance, relative = nearest
        bearing = relative / max(distance, 1e-6)
        apparent_size = float(np.clip(0.09 / max(distance, 0.09), 0.0, 1.0))
        return np.concatenate([
            np.clip(relative / 3.05, -2.0, 2.0),
            np.clip(bearing, -1.0, 1.0),
            np.asarray([
                min(distance / 3.05, 2.0),
                apparent_size,
                1.0,
            ]),
        ])

    def tactical_observe(self, side: FighterSide) -> np.ndarray:
        opponent = "red" if side == "blue" else "blue"
        own_pelvis = self._body_position(f"{side}_pelvis")
        own_pelvis_velocity = self._body_velocity(self.model.body(f"{side}_pelvis").id)
        rotation = self._body_matrix(f"{side}_pelvis")
        opponent_motion = []
        for part in PERCEPTION_PARTS:
            motion = self._perceived_body_motion(side, opponent, part)
            opponent_motion.extend((
                np.clip(rotation.T @ (motion.position - own_pelvis) / 3.05, -2.0, 2.0),
                np.clip(rotation.T @ (motion.velocity - own_pelvis_velocity) / 12.0, -2.0, 2.0),
                np.clip(rotation.T @ motion.acceleration / 80.0, -3.0, 3.0),
                np.clip(rotation.T @ motion.angular_velocity / 15.0, -2.0, 2.0),
            ))
        contact = np.asarray([
            float(self._sensor(f"{side}_{name}")[0]) / 1600.0
            for name in (
                "left_foot_force",
                "right_foot_force",
                "left_glove_force",
                "right_glove_force",
            )
        ])
        pelvis_id = self.model.body(f"{side}_pelvis").id
        physiology = self.physiology[side]
        facing, distance = self._perceived_facing_and_distance(side)
        return np.concatenate([
            *opponent_motion,
            self._body_matrix(f"{side}_pelvis")[:, 2],
            np.clip(self.data.cvel[pelvis_id] / 8.0, -2.0, 2.0),
            np.clip(self._sensor(f"{side}_head_acceleration") / 75.0, -3.0, 3.0),
            np.clip(self._sensor(f"{side}_head_angular_velocity") / 25.0, -3.0, 3.0),
            np.clip(contact, 0.0, 3.0),
            np.asarray([
                physiology.stamina,
                physiology.guard_stability,
                physiology.equilibrium,
                physiology.active_control,
            ]),
            np.asarray([float(np.mean(self.fatigue[side].fatigue))]),
            np.asarray([facing, distance / 3.05]),
            self.last_commands[side].as_array(),
            self._projectile_observation(side),
        ]).astype(np.float64)

    def perceived_threat_salience(self, side: FighterSide) -> float:
        opponent = "red" if side == "blue" else "blue"
        own_head = self._body_position(f"{side}_head")
        own_velocity = self._body_velocity(self.model.body(f"{side}_head").id)
        salience = 0.0
        for part in ("left_upper_arm", "right_upper_arm", "left_glove", "right_glove"):
            motion = self._perceived_body_motion(side, opponent, part)
            to_head = own_head - motion.position
            distance = float(np.linalg.norm(to_head))
            direction = to_head / max(distance, 1e-6)
            closing_speed = max(0.0, float(np.dot(motion.velocity - own_velocity, direction)))
            acceleration = float(np.linalg.norm(motion.acceleration))
            angular_speed = float(np.linalg.norm(motion.angular_velocity))
            proximity = float(np.clip(1.0 - distance / 1.65, 0.0, 1.0))
            salience = max(
                salience,
                proximity * (
                    0.62 * closing_speed / 6.0
                    + 0.23 * acceleration / 55.0
                    + 0.15 * angular_speed / 8.0
                ),
            )
        for projectile in self.perceived_motion[side].projectiles:
            if not projectile.active:
                continue
            to_head = own_head - projectile.position
            distance = float(np.linalg.norm(to_head))
            proximity = float(np.clip(1.0 - distance / 2.4, 0.0, 1.0))
            salience = max(salience, proximity)
        return float(np.clip(salience, 0.0, 1.0))

    def survival_instinct_features(
        self,
        side: FighterSide,
        threat_salience: float | None = None,
    ) -> np.ndarray:
        physiology = self.physiology[side]
        fatigue = float(np.clip(1.0 - physiology.stamina, 0.0, 1.0))
        guard_damage = float(np.clip(1.0 - physiology.guard_stability, 0.0, 1.0))
        equilibrium_loss = float(np.clip(1.0 - physiology.equilibrium, 0.0, 1.0))
        head_impact, body_impact, pressure = self.recent_impact_memory[side]
        _, distance = self._perceived_facing_and_distance(side)
        striking_range = self.athlete_profiles[side].reach_m * 0.5 + 0.28
        close_pressure = float(np.clip(1.0 - distance / max(striking_range, 0.5), 0.0, 1.0))
        pelvis = self._body_position(f"{side}_pelvis")
        ring_margin = 3.05 - max(abs(float(pelvis[0])), abs(float(pelvis[1])))
        rope_danger = float(np.clip(1.0 - ring_margin / 0.80, 0.0, 1.0))
        lateral = self._body_matrix(f"{side}_pelvis")[:2, 1]
        center_direction = -pelvis[:2]
        escape_direction = float(np.sign(np.dot(center_direction, lateral))) * rope_danger
        threat = self.perceived_threat_salience(side) if threat_salience is None else threat_salience
        return np.asarray([
            fatigue,
            guard_damage,
            equilibrium_loss,
            head_impact,
            body_impact,
            pressure,
            close_pressure,
            escape_direction,
            threat,
        ], dtype=np.float64)

    @staticmethod
    def survival_instinct_salience(features: np.ndarray) -> float:
        fatigue, guard, equilibrium, head, body, pressure, close, _, threat = features
        return float(np.clip(max(
            head,
            0.85 * equilibrium,
            0.72 * pressure,
            0.62 * body,
            0.58 * guard,
            fatigue * (0.35 + 0.65 * close),
            threat,
        ), 0.0, 1.0))

    def autonomous_commands(
        self,
        policies: dict[FighterSide, RecurrentTacticalPolicy],
        exploration: float = 0.0,
    ) -> dict[FighterSide, TacticalCommand]:
        scheduled_update = self.tactical_tick % self.tactical_update_interval == 0
        for side in FIGHTER_SIDES:
            salience = self.perceived_threat_salience(side)
            instinct_features = self.survival_instinct_features(side, salience)
            instinct_salience = self.survival_instinct_salience(instinct_features)
            fast_interrupt = instinct_salience >= 0.30 and not scheduled_update
            if scheduled_update or fast_interrupt:
                output = policies[side].act(
                    self.tactical_observe(side),
                    fast_interrupt=fast_interrupt,
                    instinct_features=instinct_features,
                    exploration=exploration,
                    rng=self.rng,
                )
                self.tactical_held_commands[side] = TacticalCommand.from_policy_output(output)
            self.tactical_interrupt[side] = fast_interrupt
            self.tactical_salience[side] = salience
            self.instinct_salience[side] = instinct_salience
        self.tactical_tick += 1
        return self.tactical_held_commands.copy()

    def _apply_domain_randomization(self) -> None:
        self.model.body_mass[:] = self._base_body_mass
        self.model.body_inertia[:] = self._base_body_inertia
        self.model.geom_friction[:] = self._base_geom_friction
        if self.domain_randomization > 0.0:
            spread = self.domain_randomization
            for side in FIGHTER_SIDES:
                body_ids = [
                    body_id
                    for body_id in range(1, self.model.nbody)
                    if self.model.body(body_id).name.startswith(f"{side}_")
                ]
                mass_scale = self.rng.uniform(1.0 - 0.08 * spread, 1.0 + 0.08 * spread)
                self.model.body_mass[body_ids] = self._base_body_mass[body_ids] * mass_scale
                self.model.body_inertia[body_ids] = self._base_body_inertia[body_ids] * mass_scale
            floor_id = self.model.geom("ring_floor").id
            friction_scale = self.rng.uniform(1.0 - 0.18 * spread, 1.0 + 0.18 * spread)
            self.model.geom_friction[floor_id, 0] = self._base_geom_friction[floor_id, 0] * friction_scale
        mujoco.mj_setConst(self.model, self.data)

    def reset(self, seed: int | None = None) -> dict[str, np.ndarray]:
        if seed is not None:
            self.seed = seed
            self.rng = np.random.default_rng(seed)
            self.perception_latency_steps = self._perception_latency(seed)
        self._apply_domain_randomization()
        mujoco.mj_resetData(self.model, self.data)
        if self.starting_separation_m is not None and not self.solo_side:
            for side, direction in (("blue", -1.0), ("red", 1.0)):
                root_id = self.model.joint(f"{side}_root_free").id
                root_address = int(self.model.jnt_qposadr[root_id])
                self.data.qpos[root_address] = (
                    direction * self.starting_separation_m * 0.5
                )
                self.data.qpos[root_address + 1] = 0.0
        if self.solo_side:
            opponent = "red" if self.solo_side == "blue" else "blue"
            root_id = self.model.joint(f"{opponent}_root_free").id
            root_address = int(self.model.jnt_qposadr[root_id])
            corner = 2.45 if opponent == "red" else -2.45
            self.data.qpos[root_address:root_address + 3] = [corner, corner, 0.92]
        if self.training_stage == "footwork" and self.solo_side:
            root_id = self.model.joint(f"{self.solo_side}_root_free").id
            root_address = int(self.model.jnt_qposadr[root_id])
            self.data.qpos[root_address:root_address + 3] = [-2.35, 0.0, 0.92]
        for side in FIGHTER_SIDES:
            self.fatigue[side].reset_bout()
            self.physiology[side].reset_bout()
            self.strike_state[side] = StrikeState()
            self.strike_outcome[side] = "none"
            self.defense_totals[side] = DefenseTelemetry()
            self.defense_step[side] = DefenseTelemetry()
            self.locomotion_phase[side] = 0.0
            self.locomotion_drive[side].fill(0.0)
            self.evasion_drive[side] = 0.0
            self.locomotion_velocity[side].fill(0.0)
            self.fall_seconds[side] = 0.0
            self.telemetry[side] = FighterTelemetry()
            self.last_commands[side] = TacticalCommand()
            self.tactical_held_commands[side] = TacticalCommand()
            self.tactical_interrupt[side] = False
            self.tactical_salience[side] = 0.0
            self.instinct_salience[side] = 0.0
            self.recent_impact_memory[side].fill(0.0)
            self.data.ctrl[self.actuator_ids[side]] = self.neutral[side]
            self.last_motor_targets[side] = self.neutral[side].copy()
            self.model.actuator_forcerange[self.actuator_ids[side]] = self.force_limits[side]
        self._reset_projectiles()
        mujoco.mj_forward(self.model, self.data)
        if self.training_stage == "footwork" and self.solo_side:
            self.footwork_start = self._body_position(f"{self.solo_side}_pelvis")
            self.footwork_target = np.asarray([2.35, 0.0, self.footwork_start[2]])
        else:
            self.footwork_start.fill(0.0)
            self.footwork_target.fill(0.0)
        self.footwork_goal_reached = False
        for side in FIGHTER_SIDES:
            for leg in ("left", "right"):
                foothold = self._body_position(f"{side}_{leg}_foot")
                foothold[2] = 0.10
                self.locomotion_footholds[side][leg] = foothold.copy()
                self.locomotion_swing_start[side][leg] = foothold.copy()
                self.locomotion_swinging[side][leg] = False
        self.tactical_tick = 0
        self._reset_perception()
        self.replay = [self.pose_frame()]
        return {side: self.observe(side) for side in FIGHTER_SIDES}

    def _park_projectile(self, name: str) -> None:
        index = self.projectile_names.index(name)
        qpos_address = self.projectile_qpos_addresses[name]
        qvel_address = self.projectile_qvel_addresses[name]
        self.data.qpos[qpos_address:qpos_address + 3] = [0.0, 0.0, -3.0 - index]
        self.data.qpos[qpos_address + 3:qpos_address + 7] = [1.0, 0.0, 0.0, 0.0]
        self.data.qvel[qvel_address:qvel_address + 6] = 0.0

    def _reset_projectiles(self) -> None:
        for name, state in self.projectile_states.items():
            self._park_projectile(name)
            state.active = False
            state.target_side = self.solo_side or "blue"
            state.launched_at = 0.0
            state.hit = False
            state.attempt = None
            state.last_target_clearance_m = 0.0
        self.projectile_totals = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        self.projectile_step = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        self.projectile_recovery_seconds = {"blue": 0.0, "red": 0.0}
        self.projectile_next_launch = 1.2
        self.projectile_sequence = 0
        self.projectile_round = 0
        self.projectile_attempts = {"blue": [], "red": []}

    def _launch_projectile(self, state: ProjectileState, side: FighterSide) -> None:
        sequence = self.projectile_sequence
        # Round-based difficulty: every DRILL_ROUND_LENGTH launches the drill
        # steps up a round, throwing faster (and therefore harder-hitting) balls.
        self.projectile_round = sequence // DRILL_ROUND_LENGTH
        difficulty_scale = min(
            1.0 + DRILL_ROUND_SPEED_GAIN * self.projectile_round,
            DRILL_ROUND_MAX_SCALE,
        )
        difficulty_scale *= 0.85 + 0.15 * self.projectile_difficulty
        angles = (0.0, np.pi, np.pi * 0.5, -np.pi * 0.5, np.pi * 0.25, -np.pi * 0.75)
        angle = angles[sequence % len(angles)] + float(self.rng.uniform(-0.28, 0.28))
        target_segment = "head" if self.training_stage == "projectile_evasion" else "chest"
        target = self._body_position(f"{side}_{target_segment}")
        initial_head = self._body_position(f"{side}_head")
        launch_rotation = self._body_matrix(f"{side}_pelvis")
        direction_focus = [
            name for name in self.projectile_focus
            if name in ("left", "right", "front", "rear")
        ]
        if direction_focus and self.rng.random() < 0.65:
            selected = direction_focus[sequence % len(direction_focus)]
            local_direction = {
                "front": np.asarray([1.0, 0.0, 0.0]),
                "rear": np.asarray([-1.0, 0.0, 0.0]),
                "left": np.asarray([0.0, 1.0, 0.0]),
                "right": np.asarray([0.0, -1.0, 0.0]),
            }[selected]
            world_direction = launch_rotation @ local_direction
            angle = float(np.arctan2(world_direction[1], world_direction[0]))
            angle += float(self.rng.uniform(-0.16, 0.16))
        if "high" in self.projectile_focus and self.rng.random() < 0.65:
            target[2] += 0.10
        elif "low" in self.projectile_focus and self.rng.random() < 0.65:
            target[2] -= 0.10
        if self.training_stage == "projectile_evasion":
            target += self._body_matrix(f"{side}_pelvis")[:, 1] * float(
                self.rng.uniform(-0.20, 0.20)
            )
        radius = 3.05 if self.training_stage == "projectile_evasion" else 1.80
        height_offsets = (
            (0.08, 0.04, 0.10, 0.06)
            if self.training_stage == "projectile_evasion"
            else (0.12, -0.08, 0.03, -0.14)
        )
        origin = target + np.asarray([
            np.cos(angle) * radius,
            np.sin(angle) * radius,
            height_offsets[sequence % len(height_offsets)] + float(
                self.rng.uniform(-0.06, 0.06)
            ),
        ])
        base_speed = 4.5 if self.training_stage == "projectile_evasion" else 8.5
        response_scaffold = 1.0
        if "no_reaction" in self.projectile_focus:
            response_scaffold = 0.82
        elif "late_reaction" in self.projectile_focus:
            response_scaffold = 0.88
        elif any(
            name in self.projectile_focus
            for name in (
                "wrong_direction",
                "insufficient_displacement",
                "insufficient_clearance",
            )
        ):
            response_scaffold = 0.92
        speed = (
            base_speed
            * difficulty_scale
            * response_scaffold
            * float(self.rng.uniform(0.92, 1.08))
        )
        flight_seconds = radius / speed
        velocity = (target - origin) / flight_seconds
        velocity[2] += 4.905 * flight_seconds
        qpos_address = self.projectile_qpos_addresses[state.name]
        qvel_address = self.projectile_qvel_addresses[state.name]
        self.data.qpos[qpos_address:qpos_address + 3] = origin
        self.data.qpos[qpos_address + 3:qpos_address + 7] = [1.0, 0.0, 0.0, 0.0]
        self.data.qvel[qvel_address:qvel_address + 3] = velocity
        self.data.qvel[qvel_address + 3:qvel_address + 6] = 0.0
        state.active = True
        state.target_side = side
        state.launched_at = float(self.data.time)
        state.hit = False
        incoming_local = launch_rotation.T @ (origin - target)
        if abs(float(incoming_local[1])) >= abs(float(incoming_local[0])):
            incoming_direction = "left" if incoming_local[1] > 0.0 else "right"
        else:
            incoming_direction = "front" if incoming_local[0] > 0.0 else "rear"
        height_delta = float(target[2] - initial_head[2])
        target_height = "high" if height_delta > 0.04 else "low" if height_delta < -0.04 else "center"
        initial_clearance = float(np.linalg.norm(initial_head - target))
        state.attempt = ProjectileAttemptTelemetry(
            sequence=sequence,
            course_seed=self.seed,
            projectile=state.name,
            target_side=side,
            outcome="active",
            failure_reason="unresolved",
            incoming_direction=incoming_direction,
            target_height=target_height,
            launched_at_s=float(self.data.time),
            resolved_at_s=0.0,
            expected_flight_s=flight_seconds,
            reaction_time_s=None,
            incoming_speed_mps=float(np.linalg.norm(velocity)),
            launch_origin=tuple(float(value) for value in origin),
            target_point=tuple(float(value) for value in target),
            launch_velocity=tuple(float(value) for value in velocity),
            initial_head_position=tuple(float(value) for value in initial_head),
            launch_forward=tuple(float(value) for value in launch_rotation[:, 0]),
            launch_lateral=tuple(float(value) for value in launch_rotation[:, 1]),
            minimum_head_height_m=float(initial_head[2]),
            minimum_ball_head_distance_m=float(np.linalg.norm(origin - initial_head)),
            maximum_target_clearance_m=initial_clearance,
        )
        state.last_target_clearance_m = initial_clearance
        launch_speed = float(np.linalg.norm(velocity))
        self.projectile_step[side].incoming_speed_mps = launch_speed
        self.projectile_totals[side].incoming_speed_mps = max(
            self.projectile_totals[side].incoming_speed_mps,
            launch_speed,
        )
        self.projectile_sequence += 1

    def _update_projectile_attempt(self, state: ProjectileState) -> ProjectileTelemetry:
        attempt = state.attempt
        if attempt is None:
            return ProjectileTelemetry()
        side = state.target_side
        head = self._body_position(f"{side}_head")
        projectile = self._body_position(state.name)
        initial = np.asarray(attempt.initial_head_position)
        displacement = head - initial
        forward = np.asarray(attempt.launch_forward)
        lateral = np.asarray(attempt.launch_lateral)
        forward_displacement = float(np.dot(displacement, forward))
        lateral_displacement = float(np.dot(displacement, lateral))
        vertical_displacement = float(displacement[2])
        total_displacement = float(np.linalg.norm(displacement))
        target_clearance = float(np.linalg.norm(head - np.asarray(attempt.target_point)))
        clearance_gain = target_clearance - state.last_target_clearance_m
        state.last_target_clearance_m = target_clearance
        attempt.minimum_head_height_m = min(attempt.minimum_head_height_m, float(head[2]))
        attempt.minimum_ball_head_distance_m = min(
            attempt.minimum_ball_head_distance_m,
            float(np.linalg.norm(projectile - head)),
        )
        if total_displacement >= attempt.maximum_head_displacement_m:
            attempt.maximum_head_displacement_m = total_displacement
            attempt.signed_forward_displacement_m = forward_displacement
            attempt.signed_lateral_displacement_m = lateral_displacement
            attempt.vertical_displacement_m = vertical_displacement
        attempt.maximum_target_clearance_m = max(
            attempt.maximum_target_clearance_m,
            target_clearance,
        )
        timely = 0
        wrong_way = 0
        if attempt.reaction_time_s is None and total_displacement >= 0.025:
            attempt.reaction_time_s = float(self.data.time) - attempt.launched_at_s
            timely = int(attempt.reaction_time_s <= 0.35)
            incoming_side = (
                1.0 if attempt.incoming_direction == "left"
                else -1.0 if attempt.incoming_direction == "right"
                else 0.0
            )
            if incoming_side != 0.0:
                wrong_way = int(lateral_displacement * incoming_side >= 0.0)
        return ProjectileTelemetry(
            clearance_gain_m=clearance_gain,
            timely_responses=timely,
            wrong_way_responses=wrong_way,
        )

    def _resolve_projectile_attempt(
        self,
        state: ProjectileState,
        outcome: str,
        contact_body: str = "none",
        contact_point: np.ndarray | None = None,
        contact_impulse_ns: float = 0.0,
    ) -> None:
        attempt = state.attempt
        if attempt is None:
            return
        attempt.outcome = outcome
        attempt.resolved_at_s = float(self.data.time)
        attempt.contact_body = contact_body
        attempt.contact_point = tuple(
            float(value) for value in (
                np.zeros(3, dtype=np.float64) if contact_point is None else contact_point
            )
        )
        attempt.contact_impulse_ns = contact_impulse_ns
        if outcome == "dodge":
            attempt.failure_reason = "clean_evasion"
        elif outcome == "deflection":
            attempt.failure_reason = "guard_deflection"
        elif attempt.reaction_time_s is None:
            attempt.failure_reason = "no_reaction"
        elif attempt.reaction_time_s > 0.35:
            attempt.failure_reason = "late_reaction"
        elif attempt.incoming_direction in ("left", "right"):
            incoming_side = 1.0 if attempt.incoming_direction == "left" else -1.0
            attempt.failure_reason = (
                "wrong_direction"
                if attempt.signed_lateral_displacement_m * incoming_side >= 0.0
                else "insufficient_clearance"
            )
        elif attempt.maximum_head_displacement_m < 0.10:
            attempt.failure_reason = "insufficient_displacement"
        else:
            attempt.failure_reason = "insufficient_clearance"
        self.projectile_attempts[state.target_side].append(attempt)
        state.attempt = None

    def _advance_projectile_drill(self) -> None:
        self.projectile_step = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        if self.training_stage not in ("projectile_evasion", "impact_recovery"):
            return
        changed = False
        for state in self.projectile_states.values():
            if not state.active:
                continue
            movement_update = self._update_projectile_attempt(state)
            self.projectile_step[state.target_side].add(movement_update)
            self.projectile_totals[state.target_side].add(movement_update)
            position = self._body_position(state.name)
            expired = (
                float(self.data.time) - state.launched_at >= 1.65
                or position[2] < -0.35
                or float(np.linalg.norm(position[:2])) > 4.25
            )
            if expired:
                if not state.hit:
                    update = ProjectileTelemetry(dodges=1)
                    self.projectile_step[state.target_side].add(update)
                    self.projectile_totals[state.target_side].add(update)
                    self._resolve_projectile_attempt(state, "dodge")
                self._park_projectile(state.name)
                state.active = False
                changed = True
        if float(self.data.time) >= self.projectile_next_launch:
            available = next(
                (state for state in self.projectile_states.values() if not state.active),
                None,
            )
            if available is not None:
                self._launch_projectile(available, self.solo_side or "blue")
                self.projectile_next_launch = float(self.data.time) + 2.05
                changed = True
        if changed:
            mujoco.mj_forward(self.model, self.data)

    def _advance_strike_state(
        self,
        side: FighterSide,
        command: TacticalCommand,
    ) -> StrikeState:
        choices = {
            "jab": float(command.jab),
            "cross": float(command.cross),
            "hook": float(command.hook),
        }
        kind = max(choices, key=choices.get)
        intensity = choices[kind]
        state = self.strike_state[side]
        if intensity < 0.20:
            state.kind = "none"
            state.phase = 0.0
            state.drive = 0.0
            state.completed = False
            state.cooldown = 0.0
            return state
        if state.kind != kind:
            state.kind = kind
            state.arm = "right" if kind == "cross" else "left"
            state.phase = 0.0
            state.completed = False
            state.cooldown = 0.0
        elif state.completed:
            state.drive = 0.0
            state.cooldown += self.control_seconds
            recovery_seconds = 0.02 + 0.22 * self.motor_teacher_weight
            if state.cooldown < recovery_seconds:
                return state
            state.phase = 0.0
            state.completed = False
            state.cooldown = 0.0
        duration = (0.78 - 0.24 * np.clip(command.urgency, 0.0, 1.0)) / self.physiology[side].speed_capacity
        state.phase = float(state.phase + self.control_seconds / max(duration, 0.35))
        if state.phase >= 1.0:
            state.phase = 1.0
            state.drive = 0.0
            state.completed = True
            state.cooldown = 0.0
            return state
        if state.phase < 0.16:
            state.drive = -0.34 * np.sin(np.pi * state.phase / 0.16 * 0.5)
        elif state.phase < 0.66:
            progress = (state.phase - 0.16) / 0.50
            state.drive = float(progress * progress * (3.0 - 2.0 * progress))
        else:
            progress = (state.phase - 0.66) / 0.34
            state.drive = float(1.0 - progress * progress * (3.0 - 2.0 * progress))
        return state

    def _strike_guidance(
        self,
        side: FighterSide,
        command: TacticalCommand,
        state: StrikeState,
    ) -> np.ndarray:
        guidance = np.zeros(self.motor_count_per_athlete, dtype=np.float64)
        if state.kind == "none":
            return guidance
        intensity = float(max(command.jab, command.cross, command.hook))
        chain = state.drive * intensity * self.conditioning[side].kinetic_chain
        rotation_sign = 1.0 if state.arm == "right" else -1.0
        rear_leg = "right" if state.arm == "right" else "left"
        indexes = self.motor_index[side]

        def add(name: str, value: float) -> None:
            index = indexes.get(f"{side}_{name}")
            if index is not None:
                guidance[index] += value

        add(f"{rear_leg}_ankle_pitch", 0.025 * chain)
        add(f"{rear_leg}_hip_flex", 0.025 * chain)
        add(f"{rear_leg}_hip_rotate", rotation_sign * 0.07 * chain)
        add("lumbar_yaw", rotation_sign * (0.13 if state.kind == "hook" else 0.09) * chain)
        add("lumbar_pitch", -0.025 * chain)
        add(f"{state.arm}_shoulder_rotate", rotation_sign * 0.12 * chain)
        if state.kind == "hook":
            add(f"{state.arm}_elbow", 0.34 * max(0.0, chain))

        extension = max(0.0, state.drive) * intensity
        if extension <= 0.0:
            return guidance
        opponent = "red" if side == "blue" else "blue"
        target_segment = "chest" if command.body_target >= 0.5 else "head"
        target = self._perceived_body_motion(side, opponent, target_segment).position.copy()
        glove_body = self.model.body(f"{side}_{state.arm}_glove").id
        glove = self.data.body(glove_body).xpos.copy()
        opponent_to_attacker = glove[:2] - target[:2]
        facing_length = float(np.linalg.norm(opponent_to_attacker))
        if facing_length > 1e-6:
            opponent_to_attacker /= facing_length
        opponent_left = np.asarray(
            [-opponent_to_attacker[1], opponent_to_attacker[0]],
            dtype=np.float64,
        )
        if target_segment == "head":
            if state.kind == "cross":
                target[2] -= 0.065
            elif state.kind == "hook":
                target[:2] -= opponent_left * 0.050
                target[2] -= 0.052
        elif state.kind == "jab":
            target[2] += 0.050
        elif state.kind == "cross":
            target[2] -= 0.035
        else:
            target[:2] -= opponent_left * 0.078
            target[2] -= 0.045
        error = target - glove
        error_length = float(np.linalg.norm(error))
        if error_length > 0.55:
            error *= 0.55 / error_length
        jacobian = np.zeros((3, self.model.nv), dtype=np.float64)
        mujoco.mj_jacBody(self.model, self.data, jacobian, None, glove_body)
        arm_indexes = np.asarray([
            index
            for name, index in indexes.items()
            if f"_{state.arm}_" in name
        ], dtype=np.int32)
        arm_dofs = self.qvel_addresses[side][arm_indexes]
        arm_jacobian = jacobian[:, arm_dofs]
        damping = np.eye(3, dtype=np.float64) * 0.025
        correction = arm_jacobian.T @ np.linalg.solve(
            arm_jacobian @ arm_jacobian.T + damping,
            error,
        )
        guidance[arm_indexes] += np.clip(correction, -1.35, 1.35) * extension * 1.90
        shoulder = self._body_position(f"{side}_{state.arm}_upper_arm")
        target_direction = target - shoulder
        elevation = float(np.arctan2(
            target_direction[2],
            max(float(np.linalg.norm(target_direction[:2])), 1e-6),
        ))
        add(f"{state.arm}_shoulder_pitch", -0.28 * elevation * extension)
        return guidance

    def _locomotion_guidance(
        self,
        side: FighterSide,
        command: TacticalCommand,
    ) -> np.ndarray:
        """Track planted and swing footholds through leg joints and floor contact."""
        guidance = np.zeros(self.motor_count_per_athlete, dtype=np.float64)
        tuning = self.gait_tuning
        burst_seconds = tuning["burst_seconds"] * (
            0.75 if command.retreat > command.advance else 1.0
        )
        shuffle_period = burst_seconds + tuning["settle_seconds"]
        bursting = float(self.data.time) % shuffle_period < burst_seconds
        requested_drive = np.asarray([
            command.advance - command.retreat,
            0.35 * command.circle,
        ], dtype=np.float64) * (1.0 if bursting else 0.0)
        self.locomotion_drive[side] = (
            0.85 * self.locomotion_drive[side]
            + 0.15 * requested_drive
        )
        local_drive = self.locomotion_drive[side].copy()
        magnitude = float(np.linalg.norm(local_drive))
        commanded_intensity = (
            abs(command.advance - command.retreat) + abs(command.circle)
        )
        if magnitude <= 0.04:
            if commanded_intensity <= 0.04:
                return guidance
            rotation = self._body_matrix(f"{side}_pelvis")
            pelvis_velocity = rotation.T @ self._body_velocity(
                self.model.body(f"{side}_pelvis").id
            )
            self.locomotion_velocity[side] = (
                0.90 * self.locomotion_velocity[side]
                + 0.10 * pelvis_velocity[:2]
            )
            tracked_velocity = self.locomotion_velocity[side]
            local_lean = np.asarray([
                float(np.dot(rotation[:2, 2], rotation[:2, 0])),
                float(np.dot(rotation[:2, 2], rotation[:2, 1])),
            ])
            forward_intent = float(np.clip(command.advance - command.retreat, -1.0, 1.0))
            settle_lean_reference = (
                tuning["lean_reference"] * forward_intent
                if forward_intent >= 0.0
                else 0.5 * tuning["lean_reference"] * forward_intent
            )
            lean_error = local_lean[0] - settle_lean_reference
            settle_target = 0.5 * tuning["desired_forward"] * forward_intent
            forward_drive = float(np.clip(
                tuning["velocity_gain"] * (float(tracked_velocity[0]) - settle_target),
                -0.28,
                0.28,
            )) + float(np.clip(tuning["lean_gain"] * lean_error, -0.34, 0.34))
            settle_hip = float(np.clip(0.65 * lean_error, -0.38, 0.38))
            lateral_drive = float(np.clip(
                -0.72 * float(tracked_velocity[1]) - 0.80 * local_lean[1],
                -0.24,
                0.24,
            ))
            lateral_hip_balance = float(np.clip(
                2.20 * float(tracked_velocity[1]) + 1.50 * local_lean[1],
                -0.65,
                0.65,
            ))
            indexes = self.motor_index[side]
            for leg in ("left", "right"):
                self.locomotion_swinging[side][leg] = False
                guidance[indexes[f"{side}_{leg}_ankle_pitch"]] += forward_drive
                guidance[indexes[f"{side}_{leg}_hip_flex"]] += settle_hip
                guidance[indexes[f"{side}_{leg}_ankle_roll"]] += lateral_drive
                guidance[indexes[f"{side}_{leg}_hip_abduct"]] += lateral_hip_balance
            return guidance
        magnitude = min(magnitude, 1.0)
        local_drive /= max(float(np.linalg.norm(local_drive)), 1e-6)
        pelvis = self._body_position(f"{side}_pelvis")
        rotation = self._body_matrix(f"{side}_pelvis")
        planar_speed = float(np.linalg.norm(
            self._body_velocity(self.model.body(f"{side}_pelvis").id)[:2]
        ))
        cadence_hz = (
            tuning["cadence_base"]
            + tuning["cadence_urgency"] * float(np.clip(command.urgency, 0.0, 1.0))
            + tuning["cadence_speed"] * min(planar_speed, 0.50)
        )
        self.locomotion_phase[side] = float(
            (self.locomotion_phase[side] + 2.0 * np.pi * cadence_hz * self.control_seconds)
            % (2.0 * np.pi)
        )
        direction = rotation[:, 0] * local_drive[0] + rotation[:, 1] * local_drive[1]
        direction[2] = 0.0
        direction /= max(float(np.linalg.norm(direction)), 1e-6)
        center_of_mass = self._sensor(f"{side}_center_of_mass")
        support_offset = center_of_mass[:2] - (
            self._body_position(f"{side}_left_foot")[:2]
            + self._body_position(f"{side}_right_foot")[:2]
        ) * 0.5
        com_lead = np.zeros(3, dtype=np.float64)
        com_lead[:2] = direction[:2] * float(np.clip(
            np.dot(support_offset, direction[:2]),
            -0.20,
            0.20,
        ))
        indexes = self.motor_index[side]
        active_leg = "left" if self.locomotion_phase[side] < np.pi else "right"
        stance_leg = "left" if active_leg == "right" else "right"
        step_progress = float((self.locomotion_phase[side] % np.pi) / np.pi)
        lateral_offsets = {"left": 0.21, "right": -0.21}
        for leg in ("left", "right"):
            swinging = leg == active_leg and step_progress < 0.70
            foot_body = self.model.body(f"{side}_{leg}_foot").id
            foot = self.data.body(foot_body).xpos.copy()
            step_length = (
                tuning["step_base"] + tuning["step_urgency"] * command.urgency
            ) * magnitude
            if local_drive[0] < 0.0:
                step_length *= 0.65
            if not swinging and self.locomotion_swinging[side][leg]:
                self.locomotion_footholds[side][leg][:2] = foot[:2]
            if swinging and not self.locomotion_swinging[side][leg]:
                self.locomotion_swing_start[side][leg] = foot.copy()
                capture_offset = self._body_velocity(
                    self.model.body(f"{side}_pelvis").id
                ) * 0.055
                stance_foot = self._body_position(f"{side}_{stance_leg}_foot")
                target = (
                    stance_foot
                    + rotation[:, 1] * lateral_offsets[leg]
                    + direction * step_length
                    + capture_offset
                    + 0.85 * com_lead
                )
                target[:2] = np.clip(target[:2], -2.80, 2.80)
                target[2] = 0.10
                self.locomotion_footholds[side][leg] = target
            self.locomotion_swinging[side][leg] = swinging
            if swinging:
                minimum_offset = 0.13 if leg == "left" else -0.13
                stance_foot = self._body_position(f"{side}_{stance_leg}_foot")
                capture_target = (
                    stance_foot
                    + rotation[:, 1] * lateral_offsets[leg]
                    + direction * step_length
                    + self._body_velocity(
                        self.model.body(f"{side}_pelvis").id
                    ) * 0.28
                    + 0.85 * com_lead
                )
                capture_delta = np.clip(
                    capture_target[:2] - self.locomotion_swing_start[side][leg][:2],
                    -0.28,
                    0.28,
                )
                self.locomotion_footholds[side][leg][:2] = (
                    0.82 * self.locomotion_footholds[side][leg][:2]
                    + 0.18 * (
                        self.locomotion_swing_start[side][leg][:2]
                        + capture_delta
                    )
                )
                lateral_from_stance = float(np.dot(
                    self.locomotion_footholds[side][leg][:2] - stance_foot[:2],
                    rotation[:2, 1],
                ))
                separation_shortfall = (
                    minimum_offset - lateral_from_stance
                    if leg == "left"
                    else min(0.0, minimum_offset - lateral_from_stance)
                )
                if leg == "left":
                    separation_shortfall = max(0.0, separation_shortfall)
                self.locomotion_footholds[side][leg][:2] += (
                    rotation[:2, 1] * separation_shortfall
                )
                motion_progress = float(np.clip((step_progress - 0.25) / 0.45, 0.0, 1.0))
                smooth = motion_progress * motion_progress * (3.0 - 2.0 * motion_progress)
                target = (
                    (1.0 - smooth) * self.locomotion_swing_start[side][leg]
                    + smooth * self.locomotion_footholds[side][leg]
                )
                lift_curve = np.sin(motion_progress * np.pi) * magnitude
                target[2] += 0.035 * lift_curve
            else:
                target = self.locomotion_footholds[side][leg]
            error = target - foot
            error_length = float(np.linalg.norm(error))
            maximum_error = 0.20 if swinging else 0.09
            if error_length > maximum_error:
                error *= maximum_error / error_length
            jacobian = np.zeros((3, self.model.nv), dtype=np.float64)
            mujoco.mj_jacBody(self.model, self.data, jacobian, None, foot_body)
            leg_indexes = np.asarray([
                index
                for name, index in indexes.items()
                if f"_{leg}_" in name
            ], dtype=np.int32)
            leg_dofs = self.qvel_addresses[side][leg_indexes]
            leg_jacobian = jacobian[:, leg_dofs]
            damping = np.eye(3, dtype=np.float64) * 0.035
            correction = leg_jacobian.T @ np.linalg.solve(
                leg_jacobian @ leg_jacobian.T + damping,
                error,
            )
            gain = 1.05 if swinging else 0.72
            limit = 0.45 if swinging else 0.70
            guidance[leg_indexes] += gain * np.clip(correction, -limit, limit)
            if swinging and motion_progress > 0.0:
                guidance[indexes[f"{side}_{leg}_knee"]] += 0.58 * lift_curve
                guidance[indexes[f"{side}_{leg}_hip_flex"]] -= (
                    0.28 * lift_curve
                    + 0.48 * local_drive[0] * smooth * magnitude
                )
                swing_sign = 1.0 if leg == "left" else -1.0
                guidance[indexes[f"{side}_{leg}_hip_abduct"]] += (
                    swing_sign * 0.24 * lift_curve
                )
                guidance[indexes[f"{side}_{leg}_ankle_pitch"]] += 0.08 * lift_curve
        pelvis_velocity = rotation.T @ self._body_velocity(
            self.model.body(f"{side}_pelvis").id
        )
        self.locomotion_velocity[side] = (
            0.90 * self.locomotion_velocity[side]
            + 0.10 * pelvis_velocity[:2]
        )
        tracked_velocity = self.locomotion_velocity[side]
        local_lean = np.asarray([
            float(np.dot(rotation[:2, 2], rotation[:2, 0])),
            float(np.dot(rotation[:2, 2], rotation[:2, 1])),
        ])
        desired_velocity = np.asarray([
            (
                tuning["desired_forward"]
                if local_drive[0] >= 0.0
                else tuning["desired_backward"]
            ) * local_drive[0] * magnitude,
            tuning["desired_lateral"] * local_drive[1] * magnitude,
        ], dtype=np.float64)
        propulsion_phase = float(np.clip(
            (step_progress - 0.18) / 0.52,
            0.0,
            1.0,
        ))
        propulsion_phase = propulsion_phase * propulsion_phase * (
            3.0 - 2.0 * propulsion_phase
        )
        forward_bias = local_drive[0] * magnitude
        dynamic_lean_reference = (
            tuning["lean_reference"] * forward_bias
            if forward_bias >= 0.0
            else 0.0
        )
        velocity_error = desired_velocity[0] - float(tracked_velocity[0])
        lean_error = (
            local_lean[0]
            - dynamic_lean_reference
            - tuning["lean_drive"] * local_drive[0] * magnitude
        )
        forward_drive = float(np.clip(
            -tuning["velocity_gain"] * velocity_error,
            -0.28,
            0.28,
        )) + float(np.clip(tuning["lean_gain"] * lean_error, -0.34, 0.34))
        stance_hip_pitch = float(np.clip(
            0.65 * (local_lean[0] - dynamic_lean_reference),
            -0.38,
            0.38,
        )) + tuning["stance_drive"] * local_drive[0] * magnitude
        for leg in ("left", "right"):
            if not self.locomotion_swinging[side][leg]:
                guidance[indexes[f"{side}_{leg}_hip_flex"]] += stance_hip_pitch
        com_lateral_error = 0.0
        if self.locomotion_swinging[side][active_leg]:
            stance_position = self._body_position(f"{side}_{stance_leg}_foot")
            center_of_mass = self._sensor(f"{side}_center_of_mass")
            com_lateral_error = float(np.dot(
                stance_position[:2] - center_of_mass[:2],
                rotation[:2, 1],
            ))
        lateral_drive = float(np.clip(
            0.72 * (desired_velocity[1] - float(tracked_velocity[1]))
            - 0.80 * local_lean[1]
            + tuning["com_lateral_ankle"] * com_lateral_error,
            -0.24,
            0.24,
        ))
        lateral_hip_balance = float(np.clip(
            -2.20 * (desired_velocity[1] - float(tracked_velocity[1]))
            + 1.50 * local_lean[1]
            - tuning["com_lateral_hip"] * com_lateral_error,
            -0.65,
            0.65,
        ))
        for leg in ("left", "right"):
            guidance[indexes[f"{side}_{leg}_hip_abduct"]] += lateral_hip_balance
            guidance[indexes[f"{side}_{leg}_ankle_pitch"]] += forward_drive
            guidance[indexes[f"{side}_{leg}_ankle_roll"]] += lateral_drive
        for part in ("lumbar_pitch", "lumbar_roll"):
            index = indexes[f"{side}_{part}"]
            current = float(self.data.qpos[self.qpos_addresses[side][index]])
            guidance[index] -= 0.85 * (current - self.neutral[side][index])
        guidance[indexes[f"{side}_lumbar_pitch"]] += 0.015 * local_drive[0] * magnitude
        guidance[indexes[f"{side}_lumbar_roll"]] -= 0.015 * local_drive[1] * magnitude
        return guidance

    def _apply_motor_targets(
        self,
        side: FighterSide,
        action: np.ndarray,
        command: TacticalCommand,
    ) -> None:
        action = np.asarray(action, dtype=np.float64)
        if action.shape != (self.motor_count_per_athlete,):
            raise ValueError(f"Expected {self.motor_count_per_athlete} motor targets, got {action.shape}.")
        strike = self._advance_strike_state(side, command)
        strike_guidance = self._strike_guidance(side, command, strike)
        locomotion_guidance = self._locomotion_guidance(side, command)
        teacher_guidance = strike_guidance + locomotion_guidance
        self.teacher_actions[side] = np.clip(
            teacher_guidance / np.maximum(self.action_span[side], 1e-6),
            -1.0,
            1.0,
        )
        # Residual control: the athlete's own targets always apply at full
        # strength and the scripted assist is added on top. Scaling the learner
        # down by the assist would also mute its balance reflex, and the assist
        # is only a coarse prior - the scripted gait itself topples in about two
        # seconds - so it can never be the thing holding the body up.
        motor_residual = np.clip(action, -1.0, 1.0) * self.action_span[side]
        guidance = self.motor_teacher_weight * teacher_guidance
        physiology = self.physiology[side]
        actuator_ids = self.actuator_ids[side]
        control_range = self.model.jnt_range[self.joint_ids[side]]
        requested = self.neutral[side] + motor_residual + guidance
        requested = np.clip(requested, control_range[:, 0], control_range[:, 1])
        speed = (
            self.joint_speed_limits[side]
            * physiology.speed_capacity
            * (0.35 + 0.65 * physiology.active_control)
        )
        maximum_change = speed * self.control_seconds
        target = self.last_motor_targets[side] + np.clip(
            requested - self.last_motor_targets[side],
            -maximum_change,
            maximum_change,
        )
        self.last_motor_targets[side] = target
        self.data.ctrl[actuator_ids] = target

        capacity = self.fatigue[side].capacity * physiology.force_capacity * physiology.active_control
        strike_intensity = max(command.jab, command.cross, command.hook)
        arm_coordination = max(strike_intensity, command.guard * physiology.guard_stability)
        capacity[self.arm_motor_mask[side]] *= 0.72 + 0.28 * np.clip(arm_coordination, 0.0, 1.0)
        if physiology.equilibrium < 0.45:
            localized_control = float(np.clip(physiology.equilibrium / 0.45, 0.18, 1.0))
            capacity[self.spine_neck_mask[side]] *= localized_control
        base_force = self.force_limits[side]
        self.model.actuator_forcerange[actuator_ids, 0] = base_force[:, 0] * capacity
        self.model.actuator_forcerange[actuator_ids, 1] = base_force[:, 1] * capacity

    def _body_spatial_velocity(self, body_id: int) -> np.ndarray:
        velocity = np.zeros(6, dtype=np.float64)
        mujoco.mj_objectVelocity(
            self.model,
            self.data,
            mujoco.mjtObj.mjOBJ_BODY,
            body_id,
            velocity,
            0,
        )
        return velocity

    def _body_velocity(self, body_id: int) -> np.ndarray:
        return self._body_spatial_velocity(body_id)[3:].copy()

    def _kinetic_chain_transfer(self, side: FighterSide, arm: str) -> float:
        rear_foot = "right" if arm == "right" else "left"
        ground_force = float(self._sensor(f"{side}_{rear_foot}_foot_force")[0])
        indexes = self.motor_index[side]

        def speed(name: str) -> float:
            index = indexes[f"{side}_{name}"]
            return abs(float(self.data.qvel[self.qvel_addresses[side][index]]))

        lumbar_speed = speed("lumbar_yaw")
        hip_speed = speed(f"{rear_foot}_hip_rotate")
        shoulder_speed = speed(f"{arm}_shoulder_rotate")
        return float(np.clip(
            0.22
            + 0.25 * min(1.0, ground_force / 520.0)
            + 0.18 * min(1.0, hip_speed / 5.0)
            + 0.20 * min(1.0, lumbar_speed / 5.0)
            + 0.15 * min(1.0, shoulder_speed / 7.0),
            0.20,
            1.0,
        ))

    def _effective_striking_mass(
        self,
        side: FighterSide,
        arm: str,
        transfer: float,
    ) -> float:
        arm_mass = sum(
            float(self.model.body_mass[self.model.body(f"{side}_{segment}").id])
            for segment in (f"{arm}_upper_arm", f"{arm}_forearm", f"{arm}_glove")
        )
        total_mass = sum(
            float(self.model.body_mass[body_id])
            for body_id in range(1, self.model.nbody)
            if self.model.body(body_id).name.startswith(f"{side}_")
        )
        return arm_mass * 0.56 + total_mass * (0.018 + 0.052 * transfer)

    def _strike_contact_within_reach(
        self,
        attacker: FighterSide,
        target_id: int,
        glove_id: int,
    ) -> bool:
        pelvis = self._body_position(f"{attacker}_pelvis")
        target_position = self.data.geom(target_id).xpos
        center_distance = float(np.linalg.norm(target_position[:2] - pelvis[:2]))
        target_radius = float(np.max(self.model.geom_size[target_id]))
        maximum_contact_range = (
            self.athlete_profiles[attacker].reach_m * 0.5
            + target_radius
            + float(np.max(self.model.geom_size[glove_id]))
            + 0.03
        )
        return center_distance <= maximum_contact_range

    def _anatomical_zone(
        self,
        target_name: str,
        target_body: int,
        contact_position: np.ndarray,
    ) -> str:
        body_position = np.asarray(self.data.xpos[target_body], dtype=np.float64)
        body_matrix = np.asarray(self.data.xmat[target_body], dtype=np.float64).reshape(3, 3)
        local = body_matrix.T @ (contact_position - body_position)
        lateral = float(local[1])
        vertical = float(local[2])
        if "head_target" in target_name:
            if vertical < -0.040:
                return "jaw" if abs(lateral) >= 0.025 else "chin"
            if abs(lateral) > 0.055:
                return "temple"
            if vertical > 0.045:
                return "forehead"
            if abs(lateral) <= 0.034 and abs(vertical) <= 0.040:
                return "nose"
            return "cheek"
        if "chest_target" in target_name:
            if abs(lateral) > 0.075:
                return "ribs"
            return "chest" if vertical > 0.025 else "solar_plexus"
        if "abdomen_target" in target_name:
            if lateral < -0.040:
                return "liver"
            if abs(lateral) > 0.065:
                return "ribs"
            return "abdomen"
        return "guard"

    @staticmethod
    def _zone_properties(zone: str) -> tuple[float, float]:
        properties = {
            "guard": (0.08, 0.04),
            "jaw": (1.32, 0.0),
            "chin": (1.38, 0.0),
            "nose": (0.76, 0.0),
            "temple": (1.20, 0.0),
            "forehead": (0.62, 0.0),
            "cheek": (0.90, 0.0),
            "chest": (0.18, 0.55),
            "solar_plexus": (0.22, 1.18),
            "ribs": (0.16, 0.88),
            "liver": (0.20, 1.30),
            "abdomen": (0.15, 0.72),
        }
        return properties.get(zone, (0.10, 0.10))

    def _contact_impacts(self) -> dict[str, ImpactTelemetry]:
        impact = {"blue": ImpactTelemetry(), "red": ImpactTelemetry()}
        contact_force = np.zeros(6, dtype=np.float64)
        for contact_index in range(self.data.ncon):
            contact = self.data.contact[contact_index]
            first = self.model.geom(int(contact.geom1)).name
            second = self.model.geom(int(contact.geom2)).name
            pair = (first, second)
            mujoco.mj_contactForce(self.model, self.data, contact_index, contact_force)
            force_n = abs(float(contact_force[0]))
            if force_n <= 1.0:
                continue
            for attacker, defender in (("blue", "red"), ("red", "blue")):
                glove = next((name for name in pair if name.startswith(f"{attacker}_") and "glove_geom" in name), None)
                target = next((
                    name
                    for name in pair
                    if name.startswith(f"{defender}_")
                    and (
                        name.endswith("_target")
                        or any(part in name for part in ("glove_geom", "forearm_geom", "upper_arm_geom"))
                    )
                ), None)
                if glove is None or target is None:
                    continue
                arm = "left" if "_left_" in glove else "right"
                strike_state = self.strike_state[attacker]
                if (
                    strike_state.kind == "none"
                    or strike_state.arm != arm
                    or strike_state.drive <= 0.08
                ):
                    continue
                target_kind = (
                    "head" if "head_target" in target
                    else "body" if target.endswith("_target")
                    else "guard"
                )
                glove_id = self.model.geom(glove).id
                target_id = self.model.geom(target).id
                if not self._strike_contact_within_reach(attacker, target_id, glove_id):
                    continue
                glove_body = int(self.model.geom_bodyid[glove_id])
                target_body = int(self.model.geom_bodyid[target_id])
                relative_velocity = self._body_velocity(glove_body) - self._body_velocity(target_body)
                speed = float(np.linalg.norm(relative_velocity))
                normal = np.asarray(contact.frame[:3], dtype=np.float64)
                normal_speed = abs(float(np.dot(relative_velocity, normal)))
                directness = float(np.clip(normal_speed / max(speed, 1e-6), 0.0, 1.0))
                raw_impulse = force_n * PHYSICS_TIMESTEP
                direct_impulse = raw_impulse * (0.20 + 0.80 * directness)
                transfer = self._kinetic_chain_transfer(attacker, arm)
                effective_mass = self._effective_striking_mass(attacker, arm, transfer)
                available_energy = 0.5 * effective_mass * normal_speed * normal_speed
                contact_energy = min(
                    available_energy,
                    direct_impulse * normal_speed * 0.5,
                )
                defender_command = self.last_commands[defender]
                defender_state = self.physiology[defender]
                defender_is_striking = max(
                    defender_command.jab,
                    defender_command.cross,
                    defender_command.hook,
                ) >= 0.35
                counter_multiplier = 1.18 if defender_is_striking else 1.0
                if target_kind == "guard":
                    absorption = float(np.clip(
                        0.86 + 0.10 * defender_command.guard * defender_state.guard_stability,
                        0.0,
                        0.97,
                    ))
                else:
                    brace = (
                        defender_command.guard
                        * defender_state.guard_stability
                        * (0.75 + 0.25 * defender_state.stamina)
                    )
                    ceiling = 0.52 if target_kind == "head" else 0.40
                    absorption = float(np.clip(0.06 + ceiling * brace, 0.0, ceiling))
                transmitted_impulse = direct_impulse * (1.0 - absorption) * counter_multiplier
                transmitted_energy = contact_energy * (1.0 - absorption) * counter_multiplier
                contact_position = np.asarray(contact.pos, dtype=np.float64)
                trajectory_vector = relative_velocity / max(speed, 1e-6)
                zone = self._anatomical_zone(
                    target,
                    target_body,
                    contact_position,
                )
                vulnerability, body_vulnerability = self._zone_properties(zone)
                rotational_impulse = 0.0
                neurological_load = 0.0
                body_shock = 0.0
                if target_kind == "head":
                    moment_arm = contact_position - np.asarray(
                        self.data.xipos[target_body],
                        dtype=np.float64,
                    )
                    impulse_vector = trajectory_vector * transmitted_impulse
                    rotational_impulse = float(np.linalg.norm(np.cross(
                        moment_arm,
                        impulse_vector,
                    )))
                    neurological_load = vulnerability * (
                        transmitted_impulse / 26.5 * 0.32
                        + transmitted_energy / 121.0 * 0.28
                        + rotational_impulse / 1.72 * 0.40
                    )
                elif target_kind == "body":
                    body_shock = transmitted_energy / 70.0 * body_vulnerability
                power_score = (
                    normal_speed / 9.14 * 0.34
                    + effective_mass / 2.9 * 0.26
                    + available_energy / 121.0 * 0.30
                    + directness * 0.10
                )
                power_shot = bool(
                    target_kind != "guard"
                    and directness >= 0.72
                    and normal_speed >= 7.4
                    and available_energy >= 82.0
                    and power_score >= 0.78
                )
                update = ImpactTelemetry(
                    peak_force_n=force_n,
                    kinetic_energy_j=contact_energy,
                    closing_velocity_mps=normal_speed,
                    effective_mass_kg=effective_mass,
                    directness=directness,
                    rotational_transfer=transfer,
                    rotational_impulse_nms=rotational_impulse,
                    neurological_load=neurological_load,
                    body_shock=body_shock,
                    guard_absorption=absorption,
                    counter=defender_is_striking,
                    power_shot=power_shot,
                    target=target_kind,
                    anatomical_zone=zone,
                    strike_kind=strike_state.kind,
                    glove=arm,
                    impact_point=tuple(float(value) for value in contact_position),
                    trajectory=tuple(float(value) for value in trajectory_vector),
                    glancing_impulse_ns=raw_impulse * (1.0 - directness),
                )
                if target_kind == "head":
                    update.head_impulse_ns = transmitted_impulse
                    update.head_energy_j = transmitted_energy
                elif target_kind == "body":
                    update.body_impulse_ns = transmitted_impulse
                    update.body_energy_j = transmitted_energy
                else:
                    update.guard_impulse_ns = direct_impulse
                impact[attacker].add(update)
        return impact

    def _projectile_contacts(self) -> dict[str, ProjectileTelemetry]:
        impacts = {
            "blue": ProjectileTelemetry(),
            "red": ProjectileTelemetry(),
        }
        if self.training_stage not in ("projectile_evasion", "impact_recovery"):
            return impacts
        contact_force = np.zeros(6, dtype=np.float64)
        for contact_index in range(self.data.ncon):
            contact = self.data.contact[contact_index]
            first = self.model.geom(int(contact.geom1)).name
            second = self.model.geom(int(contact.geom2)).name
            projectile_geom = next(
                (name for name in (first, second) if name.startswith("drill_ball_")),
                None,
            )
            if projectile_geom is None:
                continue
            projectile_name = projectile_geom.removesuffix("_geom")
            state = self.projectile_states[projectile_name]
            fighter_geom = next(
                (
                    name
                    for name in (first, second)
                    if name.startswith(f"{state.target_side}_")
                ),
                None,
            )
            if not state.active or fighter_geom is None:
                continue
            mujoco.mj_contactForce(self.model, self.data, contact_index, contact_force)
            force_n = abs(float(contact_force[0]))
            if force_n <= 1.0:
                continue
            qvel_address = self.projectile_qvel_addresses[projectile_name]
            speed = float(np.linalg.norm(self.data.qvel[qvel_address:qvel_address + 3]))
            impulse = force_n * PHYSICS_TIMESTEP
            target_kind = "head" if any(
                part in fighter_geom
                for part in ("head", "neck")
            ) else "body"
            deflected = any(
                part in fighter_geom
                for part in ("glove", "forearm", "upper_arm")
            ) and (
                self.last_commands[state.target_side].guard >= 0.20
                or self.last_commands[state.target_side].head_movement >= 0.20
            )
            update = ProjectileTelemetry(
                hit_impulse_ns=impulse,
                head_impulse_ns=impulse if target_kind == "head" and not deflected else 0.0,
                body_impulse_ns=impulse if target_kind == "body" and not deflected else 0.0,
                peak_force_n=force_n,
                incoming_speed_mps=speed,
            )
            if not state.hit:
                movement_update = self._update_projectile_attempt(state)
                impacts[state.target_side].add(movement_update)
                self.projectile_totals[state.target_side].add(movement_update)
                update.deflections = 1 if deflected else 0
                update.hits = 0 if deflected else 1
                state.hit = True
                self._resolve_projectile_attempt(
                    state,
                    "deflection" if deflected else "hit",
                    contact_body=fighter_geom,
                    contact_point=np.asarray(contact.pos, dtype=np.float64),
                    contact_impulse_ns=impulse,
                )
                if not deflected:
                    self.projectile_recovery_seconds[state.target_side] = 1.0
            impacts[state.target_side].add(update)
            self.projectile_totals[state.target_side].add(update)
        return impacts

    def _stage_reward(
        self,
        side: FighterSide,
        command: TacticalCommand,
        position_before: np.ndarray,
        distance_before: float,
        outgoing: ImpactTelemetry,
        incoming: ImpactTelemetry,
        projectile: ProjectileTelemetry,
    ) -> float:
        facing, distance = self._facing_and_distance(side)
        pelvis_matrix = self._body_matrix(f"{side}_pelvis")
        pelvis_position = self._body_position(f"{side}_pelvis")
        head_height = float(self._body_position(f"{side}_head")[2])
        upright = float(pelvis_matrix[2, 2])
        left_force = float(self._sensor(f"{side}_left_foot_force")[0])
        right_force = float(self._sensor(f"{side}_right_foot_force")[0])
        foot_force = left_force + right_force
        work = float(np.sum(self.fatigue[side].mechanical_work_j))
        center_of_mass = self._sensor(f"{side}_center_of_mass")
        left_foot = self._body_position(f"{side}_left_foot")
        right_foot = self._body_position(f"{side}_right_foot")
        support_center = (left_foot[:2] + right_foot[:2]) * 0.5
        support_error = float(np.linalg.norm(center_of_mass[:2] - support_center))
        pelvis_velocity = self.data.cvel[self.model.body(f"{side}_pelvis").id]
        joint_speed = float(np.mean(np.abs(self.data.qvel[self.qvel_addresses[side]])))
        lean = float(np.linalg.norm(pelvis_matrix[:2, 2]))
        head_offset = float(np.linalg.norm(
            self._body_position(f"{side}_head")[:2] - pelvis_position[:2]
        ))
        straight_score = float(np.exp(-8.0 * lean * lean - 5.0 * head_offset * head_offset))
        support_score = float(np.exp(-12.0 * support_error * support_error))
        two_foot_score = float(np.clip(
            2.0 * min(left_force, right_force) / max(foot_force, 1.0),
            0.0,
            1.0,
        ))
        height_score = float(np.clip((pelvis_position[2] - 0.30) / 0.62, 0.0, 1.0))
        head_score = float(np.clip((head_height - 0.55) / 1.05, 0.0, 1.0))
        upright_score = float(np.clip((upright + 0.15) / 1.15, 0.0, 1.0))
        contact_score = float(np.clip(foot_force / 620.0, 0.0, 1.0))
        stability = (
            0.012
            + 0.036 * upright_score * upright_score
            + 0.018 * height_score
            + 0.014 * head_score
            + 0.024 * straight_score
            + 0.020 * support_score
            + 0.012 * two_foot_score
            + 0.010 * contact_score
            - 0.0012 * float(np.linalg.norm(pelvis_velocity))
            - 0.0007 * joint_speed
        )
        if self.training_stage == "balance":
            return stability - 0.0000008 * work
        stability -= COMPETENT_STANDING_REWARD
        displacement = pelvis_position - position_before
        forward = pelvis_matrix[:, 0]
        lateral = pelvis_matrix[:, 1]
        locomotion = (
            (command.advance - command.retreat) * float(np.dot(displacement[:2], forward[:2]))
            + command.circle * float(np.dot(displacement[:2], lateral[:2]))
        )
        if self.training_stage == "footwork":
            target_delta = self.footwork_target[:2] - position_before[:2]
            target_direction = target_delta / max(float(np.linalg.norm(target_delta)), 1e-6)
            goal_progress = float(np.dot(displacement[:2], target_direction))
            lateral_drift = abs(float(
                target_direction[0] * displacement[1]
                - target_direction[1] * displacement[0]
            ))
            remaining = float(np.linalg.norm(self.footwork_target[:2] - pelvis_position[:2]))
            goal_bonus = 0.0
            if remaining <= 0.35 and not self.footwork_goal_reached:
                self.footwork_goal_reached = True
                goal_bonus = 24.0
            supported_progress = goal_progress * upright_score * height_score * support_score
            progress_reward = (48.0 if supported_progress >= 0.0 else 72.0) * supported_progress
            idle_penalty = 0.008 if goal_progress < 0.00005 and not self.footwork_goal_reached else 0.0
            return (
                stability
                + progress_reward
                + goal_bonus
                - 12.0 * lateral_drift
                - idle_penalty
                - 0.0000010 * work
            )
        if self.training_stage == "projectile_evasion":
            defense_reward = 8.0 * projectile.dodges + 6.0 * projectile.deflections
            hit_penalty = 0.18 * projectile.hit_impulse_ns + 5.0 * projectile.hits
            mechanics_reward = (
                18.0 * projectile.clearance_gain_m
                + 0.35 * projectile.timely_responses
                - 0.50 * projectile.wrong_way_responses
            )
            return stability + defense_reward + mechanics_reward - hit_penalty - 0.0000010 * work
        if self.training_stage == "impact_recovery":
            recovery_bonus = (
                0.018 * upright_score * support_score
                if self.projectile_recovery_seconds[side] > 0.0
                else 0.0
            )
            return stability + 0.50 * projectile.hits + recovery_bonus - 0.0000010 * work

        if self.training_stage == "scripted_defense":
            defense = self.defense_step[side]
            outcome_reward = (
                2.6 * defense.evades
                + 1.8 * defense.blocks
                - 3.6 * defense.clean_hits
            )
            damage_penalty = (
                0.42 * incoming.head_impulse_ns
                + 0.18 * incoming.body_impulse_ns
                + 0.55 * incoming.neurological_load
                + 0.25 * incoming.body_shock
            )
            guard_cost = 0.018 * incoming.guard_impulse_ns
            return stability + outcome_reward - damage_penalty - guard_cost - 0.0000015 * work

        distance_change = distance_before - distance
        strike = (
            outgoing.head_impulse_ns * 0.025
            + outgoing.body_impulse_ns * 0.014
            + outgoing.neurological_load * 0.22
            + outgoing.body_shock * 0.14
        )
        defense = (
            incoming.head_impulse_ns * 0.020
            + incoming.body_impulse_ns * 0.010
            + incoming.neurological_load * 0.24
            + incoming.body_shock * 0.12
        )
        facing_reward = 0.012 * facing
        effort_penalty = 0.0000015 * work
        range_reward = 1.5 * (command.advance - command.retreat) * distance_change
        motion_reward = 1.8 * locomotion if self.training_stage == "moving_strikes" else 0.0
        return stability + facing_reward + range_reward + motion_reward + strike - defense - effort_penalty

    def step(
        self,
        policies: dict[FighterSide, RecurrentMotorPolicy],
        commands: dict[FighterSide, TacticalCommand] | None = None,
        exploration: float = 0.0,
        imitation_learning_rate: float = 0.0,
    ) -> tuple[dict[str, np.ndarray], dict[str, float], bool, dict[str, object]]:
        self._advance_projectile_drill()
        impact_decay = float(np.exp(-self.control_seconds / 1.35))
        for side in FIGHTER_SIDES:
            self.recent_impact_memory[side] *= impact_decay
        commands = commands or {
            "blue": TacticalCommand(),
            "red": TacticalCommand(),
        }
        completed_before = {
            side: self.strike_state[side].completed
            for side in FIGHTER_SIDES
        }
        kind_before = {
            side: self.strike_state[side].kind
            for side in FIGHTER_SIDES
        }
        self.defense_step = {
            "blue": DefenseTelemetry(),
            "red": DefenseTelemetry(),
        }
        distance_before = {
            side: self._facing_and_distance(side)[1]
            for side in FIGHTER_SIDES
        }
        position_before = {
            side: self._body_position(f"{side}_pelvis")
            for side in FIGHTER_SIDES
        }
        for side in FIGHTER_SIDES:
            command = commands[side]
            self.last_commands[side] = command
            action = policies[side].act(
                self.observe(side),
                command.as_array(),
                exploration=exploration,
                rng=self.rng,
            )
            self._apply_motor_targets(side, action, command)
            if imitation_learning_rate > 0.0 and self.upright(side):
                # Distill only the share of the demonstration the assist is not
                # already supplying. The athlete then takes over exactly as much
                # as the assist gives up, so the commanded motion stays the same
                # while the assist anneals and nothing is ever double counted.
                #
                # Frames after the demonstrator has lost its posture are skipped:
                # the scripted footwork gait topples about two seconds in, and
                # cloning a fall teaches the athlete to fall.
                policies[side].imitate(
                    (1.0 - self.motor_teacher_weight) * self.teacher_actions[side],
                    imitation_learning_rate,
                )
            state = self.strike_state[side]
            if (
                state.kind != "none"
                and (
                    state.kind != kind_before[side]
                    or (completed_before[side] and not state.completed)
                )
            ):
                self.strike_outcome[side] = "none"

        impacts = {"blue": ImpactTelemetry(), "red": ImpactTelemetry()}
        projectile_impacts = self.projectile_step
        work_before = {
            side: float(np.sum(self.fatigue[side].mechanical_work_j))
            for side in FIGHTER_SIDES
        }
        for _ in range(CONTROL_DECIMATION):
            mujoco.mj_step(self.model, self.data)
            frame_impacts = self._contact_impacts()
            frame_projectiles = self._projectile_contacts()
            for side in FIGHTER_SIDES:
                impacts[side].add(frame_impacts[side])
                projectile_impacts[side].add(frame_projectiles[side])
                actuator_ids = self.actuator_ids[side]
                self.fatigue[side].step(
                    self.data.actuator_force[actuator_ids],
                    self.data.qvel[self.qvel_addresses[side]],
                    PHYSICS_TIMESTEP,
                    self.endurance[side],
                )
        self._refresh_perception()

        for attacker in FIGHTER_SIDES:
            contact = impacts[attacker]
            if contact.head_impulse_ns + contact.body_impulse_ns > 0.0:
                self.strike_outcome[attacker] = "clean"
            elif contact.guard_impulse_ns > 0.0 and self.strike_outcome[attacker] != "clean":
                self.strike_outcome[attacker] = "block"
            if self.strike_state[attacker].completed and not completed_before[attacker]:
                defender = "red" if attacker == "blue" else "blue"
                outcome = self.strike_outcome[attacker]
                update = DefenseTelemetry(
                    attacks=1,
                    evades=int(outcome == "none"),
                    blocks=int(outcome == "block"),
                    clean_hits=int(outcome == "clean"),
                )
                self.defense_step[defender].add(update)
                self.defense_totals[defender].add(update)

        for side in FIGHTER_SIDES:
            opponent = "red" if side == "blue" else "blue"
            step_work = max(
                0.0,
                float(np.sum(self.fatigue[side].mechanical_work_j)) - work_before[side],
            )
            incoming = impacts[opponent]
            projectile = projectile_impacts[side]
            head_impulse = incoming.head_impulse_ns + projectile.head_impulse_ns
            body_impulse = incoming.body_impulse_ns + projectile.body_impulse_ns
            pressure_impulse = head_impulse + body_impulse + 0.25 * incoming.guard_impulse_ns
            self.recent_impact_memory[side] = np.clip(
                self.recent_impact_memory[side]
                + np.asarray([
                    head_impulse / 18.0,
                    body_impulse / 24.0,
                    pressure_impulse / 26.0,
                ]),
                0.0,
                1.0,
            )
            self.physiology[side].step(
                step_work,
                incoming.guard_impulse_ns,
                incoming.head_impulse_ns + projectile.head_impulse_ns,
                incoming.body_impulse_ns + projectile.body_impulse_ns,
                incoming.head_energy_j,
                commands[side].guard,
                float(np.mean(self.endurance[side])),
                self.control_seconds,
                rotational_impulse_nms=incoming.rotational_impulse_nms,
                neurological_load=incoming.neurological_load,
                body_shock=incoming.body_shock,
                impact_zone=incoming.anatomical_zone,
            )

        rewards: dict[str, float] = {}
        for side in FIGHTER_SIDES:
            opponent = "red" if side == "blue" else "blue"
            telemetry = self.telemetry[side]
            telemetry.impact = impacts[side]
            telemetry.head_damage += impacts[opponent].head_impulse_ns
            telemetry.body_damage += impacts[opponent].body_impulse_ns
            telemetry.mechanical_work_j = float(np.sum(self.fatigue[side].mechanical_work_j))
            reward = self._stage_reward(
                side,
                commands[side],
                position_before[side],
                distance_before[side],
                impacts[side],
                impacts[opponent],
                projectile_impacts[side],
            )
            telemetry.reward = reward
            telemetry.total_reward += reward
            rewards[side] = reward

        settled_falls: dict[str, bool] = {}
        for side in FIGHTER_SIDES:
            body_is_down = (
                self._body_position(f"{side}_pelvis")[2] < 0.34
                and self._body_position(f"{side}_head")[2] < 0.62
            )
            self.fall_seconds[side] = self.fall_seconds[side] + self.control_seconds if body_is_down else 0.0
            settled_falls[side] = self.fall_seconds[side] >= 0.45
            if settled_falls[side]:
                remaining_seconds = max(0.0, self.max_seconds - float(self.data.time))
                fall_penalty = (
                    8.0
                    if self.training_stage == "balance"
                    else 4.0
                    if self.training_stage in ("projectile_evasion", "impact_recovery")
                    else 2.0
                ) + FALL_PENALTY_PER_REMAINING_SECOND * remaining_seconds
                rewards[side] -= fall_penalty
                self.telemetry[side].reward = rewards[side]
                self.telemetry[side].total_reward -= fall_penalty
        fallen = any(settled_falls[side] for side in self.termination_sides)
        damaged = any(self.physiology[side].knockout for side in self.termination_sides)
        done = bool(self.data.time >= self.max_seconds or fallen)
        for side in FIGHTER_SIDES:
            self.projectile_recovery_seconds[side] = max(
                0.0,
                self.projectile_recovery_seconds[side] - self.control_seconds,
            )
        self.replay.append(self.pose_frame())
        if len(self.replay) > 900:
            self.replay = self.replay[-900:]
        observations = {side: self.observe(side) for side in FIGHTER_SIDES}
        info = {
            "time": float(self.data.time),
            "fallen": fallen,
            "fallenSides": settled_falls,
            "damage_stop": damaged,
            "endReason": "knockout" if fallen and damaged else "fall" if fallen else "horizon" if done else None,
            "impacts": {
                side: asdict(impacts[side])
                for side in FIGHTER_SIDES
            },
            "fatigue": {
                side: float(np.mean(self.fatigue[side].fatigue))
                for side in FIGHTER_SIDES
            },
            "physiology": {
                side: asdict(self.physiology[side])
                for side in FIGHTER_SIDES
            },
            "projectiles": {
                side: asdict(projectile_impacts[side])
                for side in FIGHTER_SIDES
            },
            "projectileTotals": {
                side: asdict(self.projectile_totals[side])
                for side in FIGHTER_SIDES
            },
            "projectileAttempts": {
                side: [asdict(attempt) for attempt in self.projectile_attempts[side]]
                for side in FIGHTER_SIDES
            },
            "footwork": {
                "start": self.footwork_start.round(6).tolist(),
                "target": self.footwork_target.round(6).tolist(),
                "goalReached": self.footwork_goal_reached,
                "remainingDistanceM": round(float(np.linalg.norm(
                    self.footwork_target[:2]
                    - self._body_position(f"{self.solo_side or 'blue'}_pelvis")[:2]
                )), 4) if self.training_stage == "footwork" else 0.0,
            },
            "defense": {
                side: asdict(self.defense_step[side])
                for side in FIGHTER_SIDES
            },
            "defenseTotals": {
                side: asdict(self.defense_totals[side])
                for side in FIGHTER_SIDES
            },
        }
        return observations, rewards, done, info

    def pose_frame(self) -> dict[str, object]:
        bodies = {}
        contacts = {}
        segment_names = (
            "pelvis",
            "abdomen",
            "chest",
            "head",
            "left_thigh",
            "left_shin",
            "left_foot",
            "right_thigh",
            "right_shin",
            "right_foot",
            "left_upper_arm",
            "left_forearm",
            "left_glove",
            "right_upper_arm",
            "right_forearm",
            "right_glove",
        )
        for side in FIGHTER_SIDES:
            bodies[side] = {
                segment: {
                    "position": self.data.body(f"{side}_{segment}").xpos.round(6).tolist(),
                    "quaternion": self.data.body(f"{side}_{segment}").xquat.round(6).tolist(),
                }
                for segment in segment_names
            }
            contacts[side] = {
                "groundForces": {
                    "left": round(float(self._sensor(f"{side}_left_foot_force")[0]), 4),
                    "right": round(float(self._sensor(f"{side}_right_foot_force")[0]), 4),
                },
                "gloveForces": {
                    "left": round(float(self._sensor(f"{side}_left_glove_force")[0]), 4),
                    "right": round(float(self._sensor(f"{side}_right_glove_force")[0]), 4),
                },
                "headForce": round(float(self._sensor(f"{side}_head_force")[0]), 4),
                "bodyForce": round(float(self._sensor(f"{side}_body_force")[0]), 4),
                "centerOfMass": self._sensor(f"{side}_center_of_mass").round(6).tolist(),
            }
        return {
            "time": round(float(self.data.time), 6),
            "bodies": bodies,
            "contacts": contacts,
            "tactics": {
                side: {
                    "command": asdict(self.last_commands[side]),
                    "perceivedThreat": round(self.tactical_salience[side], 6),
                    "survivalInstinct": round(self.instinct_salience[side], 6),
                    "recentImpactMemory": self.recent_impact_memory[side].round(6).tolist(),
                    "fastInterrupt": self.tactical_interrupt[side],
                    "perceptionLatencyMs": round(
                        self.perception_latency_steps[side] * self.control_seconds * 1000
                    ),
                }
                for side in FIGHTER_SIDES
            },
            "projectiles": [
                {
                    "id": state.name,
                    "position": self._body_position(state.name).round(6).tolist(),
                    "velocity": self.data.qvel[
                        self.projectile_qvel_addresses[state.name]:
                        self.projectile_qvel_addresses[state.name] + 3
                    ].round(6).tolist(),
                    "active": state.active,
                    "targetSide": state.target_side,
                    "hit": state.hit,
                }
                for state in self.projectile_states.values()
            ],
            "projectileDrill": {
                side: {
                    **asdict(self.projectile_totals[side]),
                    "recoverySeconds": round(self.projectile_recovery_seconds[side], 4),
                }
                for side in FIGHTER_SIDES
            },
            "projectileAttempts": {
                side: [asdict(attempt) for attempt in self.projectile_attempts[side][-8:]]
                for side in FIGHTER_SIDES
            },
            "projectileRound": self.projectile_round,
            "projectileCourseSeed": self.seed,
            "physiology": {
                side: {
                    "stamina": round(self.physiology[side].stamina, 6),
                    "guardStability": round(self.physiology[side].guard_stability, 6),
                    "equilibrium": round(self.physiology[side].equilibrium, 6),
                    "activeControl": round(self.physiology[side].active_control, 6),
                    "jointFatigue": round(float(np.mean(self.fatigue[side].fatigue)), 6),
                    "neurologicalLoad": round(
                        self.physiology[side].neurological_load,
                        6,
                    ),
                    "bodyShock": round(self.physiology[side].body_shock, 6),
                    "stunSeconds": round(self.physiology[side].stun_seconds, 6),
                    "knockout": self.physiology[side].knockout,
                    "knockoutCause": self.physiology[side].knockout_cause,
                }
                for side in FIGHTER_SIDES
            },
            "impacts": {
                side: asdict(self.telemetry[side].impact)
                for side in FIGHTER_SIDES
            },
            "strikes": {
                side: asdict(self.strike_state[side])
                for side in FIGHTER_SIDES
            },
        }

    def status(self) -> dict[str, object]:
        body_mass = {
            side: round(sum(
                float(self.model.body_mass[body_id])
                for body_id in range(1, self.model.nbody)
                if self.model.body(body_id).name.startswith(f"{side}_")
            ), 2)
            for side in FIGHTER_SIDES
        }
        return {
            "engine": f"MuJoCo {mujoco.__version__}",
            "physicsHz": round(1.0 / PHYSICS_TIMESTEP),
            "motorHz": round(1.0 / self.control_seconds),
            "degreesOfFreedomPerAthlete": self.degrees_of_freedom_per_athlete,
            "motorsPerAthlete": self.motor_count_per_athlete,
            "athletes": 2,
            "bodyMassKg": body_mass,
            "anthropometrics": {
                side: {
                    "athleteId": self.athlete_profiles[side].athlete_id,
                    "heightM": round(self.athlete_profiles[side].height_m, 3),
                    "reachM": round(self.athlete_profiles[side].reach_m, 3),
                    "massKg": round(self.athlete_profiles[side].mass_kg, 2),
                }
                for side in FIGHTER_SIDES
            },
            "time": round(float(self.data.time), 4),
            "observationSize": self.observation_size,
            "tacticalObservationSize": self.tactical_observation_size,
            "contactDerivedGroundForce": True,
            "activeRagdollMuscles": True,
            "fatigueLimitedForce": True,
            "trainableVestibularBalance": True,
            "jacobianStrikeGuidance": True,
            "momentumResolvedImpacts": True,
            "anatomicalImpactZones": True,
            "rotationalKnockoutModel": True,
            "deterministicPowerShots": True,
            "motorTeacherWeight": round(self.motor_teacher_weight, 2),
            "projectileDifficulty": round(self.projectile_difficulty, 2),
            "physicalProjectileDrills": True,
            "projectileObservationFeatures": 9,
            "projectileVelocityVisible": False,
            "projectileDirectionLabelVisible": False,
            "projectileTargetVisible": False,
            "projectileTelemetryPostAttemptOnly": True,
            "perceptionLatencyMs": {
                side: round(self.perception_latency_steps[side] * self.control_seconds * 1000)
                for side in FIGHTER_SIDES
            },
            "opponentIntentVisible": False,
            "futureTrajectoryVisible": False,
            "tacticalPolicyHz": round(1.0 / (self.control_seconds * self.tactical_update_interval), 1),
            "defensiveInterruptHz": round(1.0 / self.control_seconds),
            "trainableSurvivalInstinct": True,
            "reachValidatedContacts": True,
            "replayFrames": len(self.replay),
        }
