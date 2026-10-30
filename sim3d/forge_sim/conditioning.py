"""Joint-local fatigue, recovery, and slow physical adaptation."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class ConditioningProfile:
    lower_body_power: float = 0.72
    lower_body_endurance: float = 0.70
    kinetic_chain: float = 0.68
    shoulder_endurance: float = 0.66
    adaptation_cycles: int = 0
    lifetime_work_j: float = 0.0


@dataclass
class JointFatigue:
    count: int
    fatigue: np.ndarray = field(init=False)
    mechanical_work_j: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.fatigue = np.zeros(self.count, dtype=np.float64)
        self.mechanical_work_j = np.zeros(self.count, dtype=np.float64)

    @property
    def capacity(self) -> np.ndarray:
        return np.clip(1.0 - 0.68 * self.fatigue, 0.30, 1.0)

    def reset_bout(self) -> None:
        self.fatigue.fill(0.0)
        self.mechanical_work_j.fill(0.0)

    def step(
        self,
        actuator_force: np.ndarray,
        joint_velocity: np.ndarray,
        dt: float,
        endurance: np.ndarray,
    ) -> None:
        positive_work = np.abs(actuator_force * joint_velocity) * dt
        self.mechanical_work_j += positive_work
        fatigue_gain = positive_work * (0.00130 - 0.00065 * endurance)
        recovery = dt * (0.006 + 0.012 * endurance) * np.clip(
            1.0 - fatigue_gain * 15.0,
            0.1,
            1.0,
        )
        self.fatigue = np.clip(self.fatigue + fatigue_gain - recovery, 0.0, 1.0)


@dataclass
class PhysiologyState:
    stamina: float = 1.0
    guard_stability: float = 1.0
    equilibrium: float = 1.0
    active_control: float = 1.0
    metabolic_work_j: float = 0.0
    neurological_load: float = 0.0
    body_shock: float = 0.0
    stun_seconds: float = 0.0
    knockout: bool = False
    knockout_cause: str = "none"

    @property
    def force_capacity(self) -> float:
        return 0.48 + 0.52 * self.stamina

    @property
    def speed_capacity(self) -> float:
        return 0.42 + 0.58 * self.stamina

    def reset_bout(self) -> None:
        self.stamina = 1.0
        self.guard_stability = 1.0
        self.equilibrium = 1.0
        self.active_control = 1.0
        self.metabolic_work_j = 0.0
        self.neurological_load = 0.0
        self.body_shock = 0.0
        self.stun_seconds = 0.0
        self.knockout = False
        self.knockout_cause = "none"

    def step(
        self,
        work_j: float,
        guard_impulse_ns: float,
        head_impulse_ns: float,
        body_impulse_ns: float,
        head_energy_j: float,
        guard_command: float,
        endurance: float,
        dt: float,
        rotational_impulse_nms: float = 0.0,
        neurological_load: float = 0.0,
        body_shock: float = 0.0,
        impact_zone: str = "none",
    ) -> None:
        work_j = max(0.0, work_j)
        self.metabolic_work_j += work_j
        depletion = (
            work_j * (0.00032 - 0.00016 * np.clip(endurance, 0.0, 1.0))
            + max(0.0, body_shock) * 0.014
        )
        recovery = dt * (0.009 + 0.009 * endurance) if work_j < 0.12 else 0.0
        self.stamina = float(np.clip(self.stamina + recovery - depletion, 0.0, 1.0))

        guard_drain = guard_impulse_ns * 0.008 / (0.55 + 0.45 * self.stamina)
        guard_recovery = dt * (0.012 + 0.018 * (1.0 - np.clip(guard_command, 0.0, 1.0)))
        self.guard_stability = float(np.clip(
            self.guard_stability + guard_recovery - guard_drain,
            0.0,
            1.0,
        ))

        neurological_load = max(0.0, neurological_load)
        body_shock = max(0.0, body_shock)
        neurological_recovery = dt * 0.003 if neurological_load < 0.001 else 0.0
        body_recovery = dt * 0.012 if body_shock < 0.001 else 0.0
        self.neurological_load = float(np.clip(
            self.neurological_load + neurological_load - neurological_recovery,
            0.0,
            5.0,
        ))
        self.body_shock = float(np.clip(
            self.body_shock + body_shock - body_recovery,
            0.0,
            5.0,
        ))
        self.stun_seconds = float(max(
            0.0,
            self.stun_seconds - dt,
            neurological_load * 0.72 - 0.12,
            rotational_impulse_nms * 0.20 - 0.08,
        ))
        equilibrium_loss = (
            head_impulse_ns * 0.008
            + body_impulse_ns * 0.0025
            + head_energy_j * 0.00055
            + neurological_load * 0.085
            + body_shock * 0.018
        )
        equilibrium_recovery = dt * 0.008 if head_impulse_ns + body_impulse_ns < 0.05 else 0.0
        self.equilibrium = float(np.clip(
            self.equilibrium + equilibrium_recovery - equilibrium_loss,
            0.0,
            1.0,
        ))
        critical_zone = impact_zone in ("jaw", "chin", "temple")
        clean_rotational_knockout = (
            critical_zone
            and neurological_load >= 1.50
            and rotational_impulse_nms >= 1.25
        )
        accumulated_knockout = (
            critical_zone
            and self.neurological_load >= 2.65
            and self.equilibrium <= 0.30
        )
        if clean_rotational_knockout or accumulated_knockout:
            self.knockout = True
            self.knockout_cause = f"{impact_zone} rotational impact"
        stun_control = float(np.clip(1.0 - self.stun_seconds / 3.0, 0.35, 1.0))
        self.active_control = 0.04 if self.knockout else float(np.clip(
            (0.24 + 0.76 * self.equilibrium) * stun_control,
            0.18,
            1.0,
        ))


def actuator_endurance(joint_names: list[str], profile: ConditioningProfile) -> np.ndarray:
    values = []
    for name in joint_names:
        if any(part in name for part in ("hip", "knee", "ankle", "toe")):
            values.append(profile.lower_body_endurance)
        elif any(part in name for part in ("shoulder", "elbow", "forearm", "wrist")):
            values.append(profile.shoulder_endurance)
        else:
            values.append(profile.kinetic_chain)
    return np.asarray(values, dtype=np.float64)


def adapt_conditioning(
    profile: ConditioningProfile,
    work_j: float,
    lower_body_fraction: float,
    upper_body_fraction: float,
) -> ConditioningProfile:
    """Apply one deliberately slow, bounded adaptation after a training block."""
    dose = min(1.0, max(0.0, work_j / 180_000.0))

    def gain(value: float, stimulus: float, ceiling: float = 0.96) -> float:
        return min(ceiling, value + dose * stimulus * (ceiling - value))

    return ConditioningProfile(
        lower_body_power=gain(profile.lower_body_power, 0.020 * lower_body_fraction),
        lower_body_endurance=gain(profile.lower_body_endurance, 0.028 * lower_body_fraction),
        kinetic_chain=gain(profile.kinetic_chain, 0.018 * min(1.0, lower_body_fraction + upper_body_fraction)),
        shoulder_endurance=gain(profile.shoulder_endurance, 0.026 * upper_body_fraction),
        adaptation_cycles=profile.adaptation_cycles + 1,
        lifetime_work_j=profile.lifetime_work_j + work_j,
    )
