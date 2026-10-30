"""Recurrent neural motor policy used by each articulated athlete."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class MotorPolicyState:
    hidden: np.ndarray
    gait_phase: float = 0.0


@dataclass
class TacticalPolicyState:
    threat_memory: np.ndarray
    survival_memory: np.ndarray


class RecurrentMotorPolicy:
    """A learned recurrent controller that emits continuous joint targets."""

    stability_feature_size = 11
    gait_feature_size = 11
    control_seconds = 0.02

    def __init__(
        self,
        observation_size: int,
        action_size: int,
        command_size: int = 12,
        hidden_size: int = 64,
        seed: int = 0,
    ) -> None:
        self.observation_size = observation_size
        self.action_size = action_size
        self.command_size = command_size
        self.hidden_size = hidden_size
        self.gait_version = 0
        rng = np.random.default_rng(seed)
        self.weights = {
            "observation": rng.normal(0.0, 0.045, (hidden_size, observation_size)),
            "recurrent": rng.normal(0.0, 0.035, (hidden_size, hidden_size)),
            "command": rng.normal(0.0, 0.08, (hidden_size, command_size)),
            "hidden_bias": np.zeros(hidden_size, dtype=np.float64),
            "motor": rng.normal(0.0, 0.025, (action_size, hidden_size)),
            "motor_bias": np.zeros(action_size, dtype=np.float64),
            "balance_reflex": np.zeros(
                (action_size, self.stability_feature_size),
                dtype=np.float64,
            ),
            "command_motor": np.zeros(
                (action_size, command_size),
                dtype=np.float64,
            ),
            "gait_reflex": np.zeros(
                (action_size, self.gait_feature_size),
                dtype=np.float64,
            ),
        }
        self.state = MotorPolicyState(np.zeros(hidden_size, dtype=np.float64))
        self._last_imitation: dict[str, np.ndarray] | None = None

    def reset(self) -> None:
        self.state.hidden.fill(0.0)
        self.state.gait_phase = 0.0
        self._last_imitation = None

    def _gait_features(
        self,
        command: np.ndarray,
        foot_force: np.ndarray,
    ) -> np.ndarray:
        forward = float(np.clip(command[0] - command[1], -1.0, 1.0))
        lateral = float(np.clip(command[2], -1.0, 1.0))
        motion = max(abs(forward), abs(lateral))
        if motion > 0.04:
            urgency = float(np.clip(command[11], 0.0, 1.0))
            cadence_hz = 1.20 + 0.55 * urgency
            self.state.gait_phase = float(
                (self.state.gait_phase + 2.0 * np.pi * cadence_hz * self.control_seconds)
                % (2.0 * np.pi)
            )
        sine = float(np.sin(self.state.gait_phase))
        left_swing = max(0.0, sine)
        right_swing = max(0.0, -sine)
        left_contact = float(np.clip(4.0 * foot_force[0], 0.0, 1.0))
        right_contact = float(np.clip(4.0 * foot_force[1], 0.0, 1.0))
        return np.asarray([
            forward,
            lateral,
            motion,
            forward * left_swing,
            forward * right_swing,
            motion * left_swing,
            motion * right_swing,
            lateral * left_swing,
            lateral * right_swing,
            motion * (left_contact - right_contact),
            motion * (left_contact + right_contact - 1.0),
        ])

    def act(
        self,
        observation: np.ndarray,
        command: np.ndarray,
        exploration: float = 0.0,
        rng: np.random.Generator | None = None,
    ) -> np.ndarray:
        """Emit joint targets at full authority, whatever the teacher is doing.

        The controller must produce the same action distribution during an
        assisted demonstration and during an unassisted evaluation, otherwise
        every search step is measured in a regime the athlete is never graded
        in. Assistance is blended in the environment, not by muting the brain.
        """
        observation = np.asarray(observation, dtype=np.float64)
        command = np.asarray(command, dtype=np.float64)
        if observation.shape != (self.observation_size,):
            raise ValueError(f"Expected {self.observation_size} observations, got {observation.shape}.")
        if command.shape != (self.command_size,):
            raise ValueError(f"Expected {self.command_size} command values, got {command.shape}.")
        previous_hidden = self.state.hidden.copy()
        hidden = np.tanh(
            self.weights["observation"] @ observation
            + self.weights["recurrent"] @ previous_hidden
            + self.weights["command"] @ command
            + self.weights["hidden_bias"]
        )
        self.state.hidden = 0.78 * self.state.hidden + 0.22 * hidden
        pelvis_velocity = observation[99:105]
        upright = observation[105:108]
        foot_force = observation[120:122]
        gait = self._gait_features(command, foot_force)
        stability = np.concatenate([
            upright[:2],
            np.asarray([upright[2] - 1.0]),
            pelvis_velocity,
            np.asarray([
                foot_force[0] - foot_force[1],
                np.clip(foot_force.sum(), 0.0, 1.5),
            ]),
        ])
        motors = np.tanh(
            self.weights["motor"] @ self.state.hidden
            + self.weights["command_motor"] @ command
            + self.weights["gait_reflex"] @ gait
            + self.weights["motor_bias"]
            + self.weights["balance_reflex"] @ stability
        )
        self._last_imitation = {
            "observation": observation.copy(),
            "command": command.copy(),
            "previous_hidden": previous_hidden,
            "raw_hidden": hidden.copy(),
            "hidden": self.state.hidden.copy(),
            "gait": gait.copy(),
            "stability": stability.copy(),
        }
        if exploration > 0.0:
            rng = rng or np.random.default_rng()
            motors = motors + rng.normal(0.0, exploration, self.action_size)
        return np.clip(motors, -1.0, 1.0)

    def imitate(self, target: np.ndarray, learning_rate: float) -> float:
        """Distill one assisted motor target into the neural controller."""
        cache = self._last_imitation
        if cache is None or learning_rate <= 0.0:
            return 0.0
        target = np.clip(np.asarray(target, dtype=np.float64), -1.0, 1.0)
        if target.shape != (self.action_size,):
            raise ValueError(f"Expected {self.action_size} imitation targets, got {target.shape}.")
        hidden = cache["hidden"]
        command = cache["command"]
        gait = cache["gait"]
        stability = cache["stability"]
        preactivation = (
            self.weights["motor"] @ hidden
            + self.weights["command_motor"] @ command
            + self.weights["gait_reflex"] @ gait
            + self.weights["motor_bias"]
            + self.weights["balance_reflex"] @ stability
        )
        output = np.tanh(preactivation)
        error = output - target
        delta = np.clip(error * (1.0 - output * output), -0.35, 0.35)
        rate = float(np.clip(learning_rate, 0.0, 0.01))
        motor_before = self.weights["motor"].copy()
        self.weights["motor"] -= rate * np.outer(delta, hidden)
        self.weights["command_motor"] -= rate * np.outer(delta, command)
        self.weights["gait_reflex"] -= rate * np.outer(delta, gait)
        self.weights["motor_bias"] -= rate * delta
        self.weights["balance_reflex"] -= 0.30 * rate * np.outer(delta, stability)
        hidden_error = motor_before.T @ delta
        hidden_delta = np.clip(
            0.22 * hidden_error * (1.0 - cache["raw_hidden"] ** 2),
            -0.20,
            0.20,
        )
        hidden_rate = 0.12 * rate
        self.weights["observation"] -= hidden_rate * np.outer(
            hidden_delta,
            np.clip(cache["observation"], -3.0, 3.0),
        )
        self.weights["recurrent"] -= hidden_rate * np.outer(
            hidden_delta,
            cache["previous_hidden"],
        )
        self.weights["command"] -= hidden_rate * np.outer(hidden_delta, command)
        self.weights["hidden_bias"] -= hidden_rate * hidden_delta
        for weights in self.weights.values():
            np.clip(weights, -20.0, 20.0, out=weights)
        return float(np.mean(error * error))

    def copy(self) -> RecurrentMotorPolicy:
        clone = RecurrentMotorPolicy(
            self.observation_size,
            self.action_size,
            self.command_size,
            self.hidden_size,
        )
        clone.weights = {name: value.copy() for name, value in self.weights.items()}
        clone.gait_version = self.gait_version
        clone.state = MotorPolicyState(
            self.state.hidden.copy(),
            self.state.gait_phase,
        )
        clone._last_imitation = None
        return clone

    def perturb(self, noise: dict[str, np.ndarray], scale: float) -> RecurrentMotorPolicy:
        clone = self.copy()
        for name in clone.weights:
            clone.weights[name] += noise[name] * scale
        clone.reset()
        return clone

    def noise(
        self,
        rng: np.random.Generator,
        trainable: tuple[str, ...] | None = None,
    ) -> dict[str, np.ndarray]:
        active = set(trainable or self.weights)
        return {
            name: (
                rng.standard_normal(value.shape)
                if name in active
                else np.zeros_like(value)
            )
            for name, value in self.weights.items()
        }

    def add_scaled(self, direction: dict[str, np.ndarray], scale: float) -> None:
        for name in self.weights:
            self.weights[name] += direction[name] * scale

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            observation_size=self.observation_size,
            action_size=self.action_size,
            command_size=self.command_size,
            hidden_size=self.hidden_size,
            gait_version=self.gait_version,
            **self.weights,
        )

    @classmethod
    def load(
        cls,
        path: str | Path,
        observation_size: int | None = None,
        action_size: int | None = None,
        command_size: int | None = None,
        hidden_size: int | None = None,
    ) -> RecurrentMotorPolicy:
        with np.load(path) as checkpoint:
            policy = cls(
                int(checkpoint["observation_size"]) if observation_size is None else observation_size,
                int(checkpoint["action_size"]) if action_size is None else action_size,
                int(checkpoint["command_size"]) if command_size is None else command_size,
                int(checkpoint["hidden_size"]) if hidden_size is None else hidden_size,
            )
            migrated = {}
            for name, value in policy.weights.items():
                if name not in checkpoint.files:
                    migrated[name] = value
                    continue
                saved = checkpoint[name]
                if saved.shape == value.shape:
                    migrated[name] = saved.copy()
                    continue
                target = np.zeros_like(value)
                overlap = tuple(
                    slice(0, min(saved_size, target_size))
                    for saved_size, target_size in zip(saved.shape, target.shape, strict=True)
                )
                target[overlap] = saved[overlap]
                migrated[name] = target
            policy.weights = migrated
            policy.gait_version = (
                int(checkpoint["gait_version"])
                if "gait_version" in checkpoint.files
                else 0
            )
        return policy


class RecurrentTacticalPolicy:
    """Partial-observation recurrent brain that chooses every tactical command."""

    instinct_feature_size = 9

    def __init__(
        self,
        observation_size: int,
        action_size: int = 12,
        hidden_size: int = 96,
        seed: int = 0,
    ) -> None:
        self.observation_size = observation_size
        self.action_size = action_size
        self.hidden_size = hidden_size
        self.strategy_version = 0
        rng = np.random.default_rng(seed)
        self.weights = {
            "observation": rng.normal(0.0, 0.032, (hidden_size, observation_size)),
            "recurrent": rng.normal(0.0, 0.026, (hidden_size, hidden_size)),
            "hidden_bias": np.zeros(hidden_size, dtype=np.float64),
            "action": rng.normal(0.0, 0.035, (action_size, hidden_size)),
            "action_bias": np.zeros(action_size, dtype=np.float64),
            "interrupt": rng.normal(0.0, 0.018, (action_size, observation_size)),
            "instinct": np.zeros((action_size, self.instinct_feature_size), dtype=np.float64),
        }
        self.weights["action_bias"][4] = 0.16
        self.weights["action_bias"][11] = 0.10
        instinct = self.weights["instinct"]
        instinct[0, :] = [-0.7, -0.2, -0.8, -1.0, -0.7, -0.8, -0.8, 0.0, -0.5]
        instinct[1, :] = [1.6, 0.8, 1.8, 2.3, 1.6, 1.5, 1.4, -2.8, 0.7]
        instinct[2, 7] = 3.4
        instinct[3, 7] = 2.2
        instinct[4, :] = [1.4, 2.0, 2.3, 3.0, 2.2, 2.0, 1.1, 0.3, 1.8]
        instinct[5, :] = [0.2, 0.5, 1.0, 2.4, 1.1, 1.6, 0.8, 0.0, 2.5]
        instinct[6, :] = [0.1, 0.2, 0.6, 1.0, 1.1, 0.6, 0.5, 0.0, 1.1]
        for action_index in (7, 8, 9):
            instinct[action_index, :] = [-1.3, -0.7, -1.4, -2.0, -1.4, -1.1, -0.4, 0.0, -1.3]
        instinct[11, :] = [0.3, 0.4, 0.8, 1.5, 1.0, 1.2, 0.6, 0.0, 1.5]
        self.state = TacticalPolicyState(
            np.zeros(hidden_size, dtype=np.float64),
            np.zeros(self.instinct_feature_size, dtype=np.float64),
        )

    def reset(self) -> None:
        self.state.threat_memory.fill(0.0)
        self.state.survival_memory.fill(0.0)

    def act(
        self,
        observation: np.ndarray,
        fast_interrupt: bool = False,
        instinct_features: np.ndarray | None = None,
        exploration: float = 0.0,
        rng: np.random.Generator | None = None,
    ) -> np.ndarray:
        observation = np.asarray(observation, dtype=np.float64)
        if observation.shape != (self.observation_size,):
            raise ValueError(f"Expected {self.observation_size} tactical observations, got {observation.shape}.")
        instinct_features = (
            np.zeros(self.instinct_feature_size, dtype=np.float64)
            if instinct_features is None
            else np.asarray(instinct_features, dtype=np.float64)
        )
        if instinct_features.shape != (self.instinct_feature_size,):
            raise ValueError(
                f"Expected {self.instinct_feature_size} instinct features, got {instinct_features.shape}."
            )
        hidden = np.tanh(
            self.weights["observation"] @ observation
            + self.weights["recurrent"] @ self.state.threat_memory
            + self.weights["hidden_bias"]
        )
        memory_rate = 0.42 if fast_interrupt else 0.24
        self.state.threat_memory = (
            (1.0 - memory_rate) * self.state.threat_memory
            + memory_rate * hidden
        )
        instinct_rate = 0.48 if fast_interrupt else 0.20
        self.state.survival_memory = (
            (1.0 - instinct_rate) * self.state.survival_memory
            + instinct_rate * instinct_features
        )
        logits = (
            self.weights["action"] @ self.state.threat_memory
            + self.weights["action_bias"]
            + self.weights["instinct"] @ self.state.survival_memory
        )
        if fast_interrupt:
            logits += self.weights["interrupt"] @ observation
        actions = np.tanh(logits)
        if exploration > 0.0:
            rng = rng or np.random.default_rng()
            actions += rng.normal(0.0, exploration, self.action_size)
        return np.clip(actions, -1.0, 1.0)

    def copy(self) -> RecurrentTacticalPolicy:
        clone = RecurrentTacticalPolicy(
            self.observation_size,
            self.action_size,
            self.hidden_size,
        )
        clone.weights = {name: value.copy() for name, value in self.weights.items()}
        clone.strategy_version = self.strategy_version
        clone.state = TacticalPolicyState(
            self.state.threat_memory.copy(),
            self.state.survival_memory.copy(),
        )
        return clone

    def perturb(
        self,
        noise: dict[str, np.ndarray],
        scale: float,
    ) -> RecurrentTacticalPolicy:
        clone = self.copy()
        for name in clone.weights:
            clone.weights[name] += noise[name] * scale
        clone.reset()
        return clone

    def noise(
        self,
        rng: np.random.Generator,
        trainable: tuple[str, ...] | None = None,
    ) -> dict[str, np.ndarray]:
        active = set(trainable or self.weights)
        return {
            name: rng.standard_normal(value.shape) if name in active else np.zeros_like(value)
            for name, value in self.weights.items()
        }

    def add_scaled(self, direction: dict[str, np.ndarray], scale: float) -> None:
        for name in self.weights:
            self.weights[name] += direction[name] * scale

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            observation_size=self.observation_size,
            action_size=self.action_size,
            hidden_size=self.hidden_size,
            strategy_version=self.strategy_version,
            **self.weights,
        )

    @classmethod
    def load(
        cls,
        path: str | Path,
        observation_size: int | None = None,
        action_size: int | None = None,
        hidden_size: int | None = None,
    ) -> RecurrentTacticalPolicy:
        with np.load(path) as checkpoint:
            policy = cls(
                int(checkpoint["observation_size"]) if observation_size is None else observation_size,
                int(checkpoint["action_size"]) if action_size is None else action_size,
                int(checkpoint["hidden_size"]) if hidden_size is None else hidden_size,
            )
            migrated = {}
            for name, value in policy.weights.items():
                if name not in checkpoint.files:
                    migrated[name] = value
                    continue
                saved = checkpoint[name]
                if saved.shape == value.shape:
                    migrated[name] = saved.copy()
                    continue
                target = np.zeros_like(value)
                overlap = tuple(
                    slice(0, min(saved_size, target_size))
                    for saved_size, target_size in zip(saved.shape, target.shape, strict=True)
                )
                target[overlap] = saved[overlap]
                migrated[name] = target
            policy.weights = migrated
            policy.strategy_version = (
                int(checkpoint["strategy_version"])
                if "strategy_version" in checkpoint.files
                else 0
            )
        return policy
