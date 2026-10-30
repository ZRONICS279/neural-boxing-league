"""Persistent learning-progress coach for one native athlete."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any

import numpy as np

from .llm_coach import COURSE_FOCUS_OPTIONS, LLMStrategyAdvisor, TRAINABLE_GROUPS


COACH_VERSION = 3


@dataclass
class CoachState:
    athlete_id: str
    reviews: int = 0
    successes: int = 0
    failures: int = 0
    consecutive_failures: int = 0
    focus: str = "establish_baseline"
    challenge_scale: float = 1.0
    exploration_scale: float = 1.0
    learning_rate_scale: float = 1.0
    skill_estimates: dict[str, float] = field(default_factory=dict)
    failure_counts: dict[str, int] = field(default_factory=dict)
    last_review: dict[str, Any] | None = None
    llm_focus: list[str] = field(default_factory=list)
    llm_rationale: str = ""
    llm_reviews: int = 0
    llm_course_focus: list[str] = field(default_factory=list)
    stagnation_breaks: int = 0


class AdaptiveTrainingCoach:
    """Diagnose measured failures and adapt the next simulation block."""

    def __init__(
        self,
        root: str | Path,
        athlete_id: str,
        advisor: LLMStrategyAdvisor | None = None,
    ) -> None:
        self.root = Path(root)
        self.athlete_id = athlete_id
        self.state_path = self.root / "coach-state.json"
        self.ledger_path = self.root / "experience-ledger.json"
        self.state = CoachState(athlete_id)
        self.ledger: list[dict[str, Any]] = []
        self.advisor = advisor if advisor is not None else LLMStrategyAdvisor()
        self.load()

    def load(self) -> None:
        if self.state_path.exists():
            try:
                payload = json.loads(self.state_path.read_text())
                if payload.get("coachVersion") == COACH_VERSION:
                    saved = payload.get("state", {})
                    self.state = CoachState(**{
                        name: saved.get(name, value)
                        for name, value in asdict(self.state).items()
                    })
                    self.state.athlete_id = self.athlete_id
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                self.state = CoachState(self.athlete_id)
        if self.ledger_path.exists():
            try:
                payload = json.loads(self.ledger_path.read_text())
                if payload.get("coachVersion") == COACH_VERSION:
                    self.ledger = list(payload.get("episodes", []))[-200:]
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                self.ledger = []

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps({
            "coachVersion": COACH_VERSION,
            "state": asdict(self.state),
        }, indent=2) + "\n")
        self.ledger_path.write_text(json.dumps({
            "coachVersion": COACH_VERSION,
            "athleteId": self.athlete_id,
            "episodes": self.ledger[-200:],
        }, indent=2) + "\n")

    def reset(self) -> None:
        self.state = CoachState(self.athlete_id)
        self.ledger = []
        self.save()

    def review(
        self,
        stage: str,
        generation: int,
        accepted: bool,
        finite_state: bool,
        reward: float,
        promotion_reward: float,
        upright_seconds: float,
        minimum_upright_seconds: float,
        commanded_distance: float,
        minimum_commanded_distance: float,
        foot_travel: float,
        minimum_foot_travel: float,
        end_reason: str,
        projectile_hits: float,
        incoming_impulse_ns: float,
        outgoing_impulse_ns: float,
        projectile_dodges: float = 0.0,
        projectile_deflections: float = 0.0,
        defense_attempts: float = 0.0,
        defense_evades: float = 0.0,
        defense_blocks: float = 0.0,
        defense_clean_hits: float = 0.0,
        clean_incoming_impulse_ns: float = 0.0,
        guard_impulse_ns: float = 0.0,
        stage_passed: bool = False,
        learning_advanced: bool = False,
        autonomous: bool = False,
        stagnant_generations: int = 0,
        footwork_goal_reached: bool = False,
        footwork_remaining_distance_m: float = 0.0,
        projectile_attempts: tuple[dict[str, object], ...] = (),
    ) -> dict[str, Any]:
        deficits: dict[str, float] = {}
        strengths: list[str] = []

        if not finite_state:
            deficits["numerical_stability"] = 1.0
        if end_reason in ("fall", "knockout"):
            deficits["balance_recovery"] = 1.0
        upright_ratio = upright_seconds / max(minimum_upright_seconds, 1e-6)
        if upright_ratio < 1.0:
            deficits["upright_control"] = 1.0 - upright_ratio
        else:
            strengths.append("upright_control")

        reward_ratio = reward / max(promotion_reward, 1e-6)
        if reward_ratio < 1.0:
            deficits["reward_efficiency"] = 1.0 - reward_ratio
        else:
            strengths.append("reward_efficiency")

        if minimum_commanded_distance > 0.0:
            distance_ratio = commanded_distance / minimum_commanded_distance
            if distance_ratio < 1.0:
                deficits["direction_control"] = 1.0 - distance_ratio
            else:
                strengths.append("direction_control")
        if minimum_foot_travel > 0.0:
            foot_ratio = foot_travel / minimum_foot_travel
            if foot_ratio < 1.0:
                deficits["step_commitment"] = 1.0 - foot_ratio
            else:
                strengths.append("step_commitment")

        if stage == "footwork":
            if footwork_goal_reached:
                strengths.append("ring_crossing")
            else:
                deficits["ring_crossing"] = float(np.clip(
                    footwork_remaining_distance_m / 4.70,
                    0.0,
                    1.0,
                ))

        projectile_analysis = self._projectile_analysis(projectile_attempts)
        if stage == "projectile_evasion":
            projectile_defenses = projectile_dodges + projectile_deflections
            if projectile_hits > 4.0:
                deficits["visual_evasion"] = min(1.0, (projectile_hits - 4.0) / 3.0)
            elif projectile_defenses >= 2.0:
                strengths.append("visual_evasion")
            else:
                deficits["visual_evasion"] = 1.0 - projectile_defenses / 2.0
            causes = projectile_analysis["failureCauses"]
            if causes:
                dominant_cause = max(causes, key=causes.get)
                if dominant_cause in (
                    "no_reaction",
                    "late_reaction",
                    "wrong_direction",
                    "insufficient_displacement",
                    "insufficient_clearance",
                ):
                    deficits[dominant_cause] = causes[dominant_cause] / max(
                        projectile_analysis["resolvedAttempts"],
                        1,
                    )
        if stage == "impact_recovery" and incoming_impulse_ns > 5.0:
            deficits["impact_bracing"] = min(1.0, incoming_impulse_ns / 30.0)
        if stage in ("moving_strikes", "self_play"):
            if outgoing_impulse_ns < 1.0:
                deficits["power_transfer"] = 1.0 - outgoing_impulse_ns
            else:
                strengths.append("power_transfer")
        if stage in ("scripted_defense", "self_play"):
            defended = defense_evades + defense_blocks
            defense_rate = defended / max(defense_attempts, 1.0)
            if defense_attempts < 4.0:
                deficits["threat_exposure"] = 1.0 - defense_attempts / 4.0
            elif defense_rate < 0.65 or clean_incoming_impulse_ns > 4.0:
                deficits["defensive_reading"] = max(
                    1.0 - defense_rate / 0.65,
                    min(1.0, clean_incoming_impulse_ns / 18.0),
                )
            else:
                strengths.append("defensive_reading")

        focus = max(deficits, key=deficits.get) if deficits else "consolidate_skill"
        succeeded = not deficits and (accepted or stage_passed)
        self.state.reviews += 1
        if succeeded:
            self.state.successes += 1
            self.state.consecutive_failures = 0
        else:
            self.state.failures += 1
            self.state.consecutive_failures += 1
            self.state.failure_counts[focus] = self.state.failure_counts.get(focus, 0) + 1
        self.state.focus = focus
        skill_score = float(np.clip(1.0 - max(deficits.values(), default=0.0), 0.0, 1.0))
        previous_skill = self.state.skill_estimates.get(stage, skill_score)
        self.state.skill_estimates[stage] = round(0.85 * previous_skill + 0.15 * skill_score, 4)
        if succeeded:
            self.state.challenge_scale = min(1.35, self.state.challenge_scale + 0.025)
            self.state.exploration_scale = max(0.60, self.state.exploration_scale - 0.015)
        elif self.state.consecutive_failures >= 3:
            self.state.challenge_scale = max(0.55, self.state.challenge_scale - 0.04)
            self.state.exploration_scale = min(1.80, self.state.exploration_scale + 0.03)

        review = {
            "generation": generation,
            "stage": stage,
            "success": succeeded,
            "checkpointAccepted": accepted,
            "learningAdvanced": learning_advanced,
            "autonomous": autonomous,
            "stagePassed": stage_passed,
            "focus": focus,
            "keep": sorted(set(strengths)),
            "change": sorted(deficits, key=deficits.get, reverse=True),
            "measurements": {
                "reward": round(reward, 4),
                "uprightSeconds": round(upright_seconds, 3),
                "commandedDistanceM": round(commanded_distance, 4),
                "footTravelM": round(foot_travel, 4),
                "projectileHits": round(projectile_hits, 3),
                "projectileDodges": round(projectile_dodges, 3),
                "projectileDeflections": round(projectile_deflections, 3),
                "incomingImpulseNs": round(incoming_impulse_ns, 3),
                "cleanIncomingImpulseNs": round(clean_incoming_impulse_ns, 3),
                "guardImpulseNs": round(guard_impulse_ns, 3),
                "outgoingImpulseNs": round(outgoing_impulse_ns, 3),
                "defenseAttempts": round(defense_attempts, 3),
                "defenseEvades": round(defense_evades, 3),
                "defenseBlocks": round(defense_blocks, 3),
                "defenseCleanHits": round(defense_clean_hits, 3),
                "endReason": end_reason,
                "footworkGoalReached": footwork_goal_reached,
                "footworkRemainingDistanceM": round(footwork_remaining_distance_m, 3),
                "projectileAnalysis": projectile_analysis,
                "projectileAttempts": list(projectile_attempts)[-18:],
            },
            "challengeScale": round(self.state.challenge_scale, 3),
            "explorationScale": round(self.state.exploration_scale, 3),
            "stagnantGenerations": stagnant_generations,
        }
        self.state.last_review = review
        self.ledger.append(review)
        self.ledger = self.ledger[-200:]
        self._consult_advisor(stage)
        self.save()
        return review

    def report_stagnation(self) -> None:
        """Widen the search after the trainer measures a flat reward run.

        Repeating a block that has stopped producing progress is the failure the
        athlete kept exhibiting, so a stall deliberately trades some course
        difficulty for a broader weight search instead of holding both knobs
        pinned at their bounds.
        """
        self.state.exploration_scale = float(np.clip(
            self.state.exploration_scale * 1.35,
            0.60,
            1.80,
        ))
        self.state.learning_rate_scale = float(np.clip(
            self.state.learning_rate_scale * 1.25,
            0.5,
            2.0,
        ))
        self.state.challenge_scale = float(np.clip(
            self.state.challenge_scale - 0.05,
            0.55,
            1.35,
        ))
        self.state.stagnation_breaks += 1
        self.save()

    @staticmethod
    def _projectile_analysis(
        attempts: tuple[dict[str, object], ...],
    ) -> dict[str, Any]:
        resolved = [attempt for attempt in attempts if attempt.get("outcome") != "active"]
        failure_causes: dict[str, int] = {}
        direction_results: dict[str, dict[str, int]] = {}
        contact_bodies: dict[str, int] = {}
        reactions: list[float] = []
        displacements: list[float] = []
        clearances: list[float] = []
        minimum_heights: list[float] = []
        for attempt in resolved:
            outcome = str(attempt.get("outcome", "unknown"))
            cause = str(attempt.get("failure_reason", "unknown"))
            direction = str(attempt.get("incoming_direction", "unknown"))
            if outcome == "hit":
                failure_causes[cause] = failure_causes.get(cause, 0) + 1
            direction_bucket = direction_results.setdefault(direction, {})
            direction_bucket[outcome] = direction_bucket.get(outcome, 0) + 1
            contact_body = str(attempt.get("contact_body", "none"))
            if contact_body != "none":
                contact_bodies[contact_body] = contact_bodies.get(contact_body, 0) + 1
            reaction = attempt.get("reaction_time_s")
            if isinstance(reaction, (int, float)):
                reactions.append(float(reaction))
            for source, destination in (
                (attempt.get("maximum_head_displacement_m"), displacements),
                (attempt.get("minimum_ball_head_distance_m"), clearances),
                (attempt.get("minimum_head_height_m"), minimum_heights),
            ):
                if isinstance(source, (int, float)):
                    destination.append(float(source))
        return {
            "resolvedAttempts": len(resolved),
            "failureCauses": failure_causes,
            "directionResults": direction_results,
            "contactBodies": contact_bodies,
            "meanReactionTimeS": round(float(np.mean(reactions)), 4) if reactions else None,
            "meanHeadDisplacementM": round(float(np.mean(displacements)), 4) if displacements else None,
            "meanClosestBallHeadDistanceM": round(float(np.mean(clearances)), 4) if clearances else None,
            "minimumHeadHeightM": round(min(minimum_heights), 4) if minimum_heights else None,
        }

    def _consult_advisor(self, stage: str) -> None:
        """Let the optional LLM advisor retune the search, within hard bounds."""
        if not self.advisor.should_consult(
            self.state.reviews,
            self.state.consecutive_failures,
        ):
            return
        advice = self.advisor.advise(
            stage,
            {
                "learning_rate_scale": self.state.learning_rate_scale,
                "exploration_scale": self.state.exploration_scale,
                "challenge_scale": self.state.challenge_scale,
                "focus": self.state.focus,
                "consecutive_failures": self.state.consecutive_failures,
            },
            self.ledger,
        )
        if advice is None:
            return
        self.state.learning_rate_scale = float(np.clip(advice["learning_rate_scale"], 0.5, 2.0))
        self.state.exploration_scale = float(np.clip(advice["exploration_scale"], 0.7, 1.6))
        self.state.challenge_scale = float(np.clip(advice["challenge_scale"], 0.6, 1.35))
        self.state.llm_focus = [
            name for name in advice["focus_parameters"] if name in TRAINABLE_GROUPS
        ]
        self.state.llm_course_focus = [
            name for name in advice.get("course_focus", []) if name in COURSE_FOCUS_OPTIONS
        ]
        self.state.llm_rationale = advice["rationale"]
        self.state.llm_reviews += 1

    def trainable_parameters(
        self,
        stage: str,
        defaults: tuple[str, ...],
    ) -> tuple[str, ...]:
        if self.state.reviews == 0:
            return defaults
        if self.state.llm_focus:
            available = tuple(name for name in self.state.llm_focus if name in defaults)
            if available:
                return available
        focus_parameters = {
            "balance_recovery": ("balance_reflex", "motor_bias"),
            "upright_control": ("balance_reflex", "motor_bias"),
            "direction_control": ("command_motor", "gait_reflex", "balance_reflex"),
            "step_commitment": ("gait_reflex", "command_motor", "motor_bias"),
            "visual_evasion": ("observation", "recurrent", "command_motor", "balance_reflex"),
            "no_reaction": ("observation", "recurrent", "motor", "command_motor"),
            "late_reaction": ("observation", "recurrent", "motor", "command_motor"),
            "wrong_direction": ("observation", "recurrent", "command_motor", "motor"),
            "insufficient_displacement": ("motor", "command_motor", "balance_reflex"),
            "insufficient_clearance": ("observation", "motor", "command_motor"),
            "ring_crossing": ("command_motor", "gait_reflex", "motor", "balance_reflex"),
            "impact_bracing": ("recurrent", "balance_reflex", "command_motor"),
            "power_transfer": ("command", "command_motor", "motor", "motor_bias"),
            "defensive_reading": ("observation", "recurrent", "command_motor"),
            "threat_exposure": ("observation", "recurrent", "command_motor"),
        }
        selected = focus_parameters.get(self.state.focus)
        if not selected:
            return defaults
        available = tuple(name for name in selected if name in defaults)
        return available or defaults

    def status(self) -> dict[str, Any]:
        return {
            **asdict(self.state),
            "experienceRecords": len(self.ledger),
            "independentState": True,
            "llmAdvisor": {
                "requested": self.advisor.requested,
                "available": self.advisor.available,
                "reviews": self.state.llm_reviews,
                "rationale": self.state.llm_rationale,
                "focus": self.state.llm_focus,
                "courseFocus": self.state.llm_course_focus,
            },
        }
