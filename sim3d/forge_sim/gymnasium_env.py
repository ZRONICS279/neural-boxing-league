"""Gymnasium boundary for recurrent tactical reinforcement learning."""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import numpy as np

from .environment import FighterSide, ForgeBoxingEnv, TacticalCommand
from .policy import RecurrentMotorPolicy, RecurrentTacticalPolicy


class ForgeTacticalGymEnv(gym.Env[np.ndarray, np.ndarray]):
    """Train one tactical brain while both recurrent motor brains inhabit MuJoCo."""

    metadata = {"render_modes": ["state"], "render_fps": 17}
    observation_limit = np.float32(10_000.0)

    def __init__(
        self,
        seed: int = 4107,
        side: FighterSide = "blue",
        episode_seconds: float = 18.0,
        domain_randomization: float = 0.30,
        render_mode: str | None = None,
    ) -> None:
        super().__init__()
        self.base_seed = seed
        self.side = side
        self.opponent: FighterSide = "red" if side == "blue" else "blue"
        self.episode_seconds = episode_seconds
        self.domain_randomization = domain_randomization
        self.render_mode = render_mode
        self.episode_index = 0
        self.env: ForgeBoxingEnv
        self.motor_policies: dict[FighterSide, RecurrentMotorPolicy]
        self.tactical_policies: dict[FighterSide, RecurrentTacticalPolicy]
        self._build_world(seed)
        self.observation_space = gym.spaces.Box(
            low=-self.observation_limit,
            high=self.observation_limit,
            shape=(self.env.tactical_observation_size,),
            dtype=np.float32,
        )
        self.action_space = gym.spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(12,),
            dtype=np.float32,
        )

    def _build_world(self, seed: int) -> None:
        self.env = ForgeBoxingEnv(
            seed=seed,
            max_seconds=self.episode_seconds,
            domain_randomization=self.domain_randomization,
            training_stage="self_play",
            termination_sides=(self.side,),
        )
        self.motor_policies = {
            side: self.env.create_policy(side, seed + 100 + index)
            for index, side in enumerate(("blue", "red"))
        }
        self.tactical_policies = {
            side: self.env.create_tactical_policy(side, seed + 200 + index)
            for index, side in enumerate(("blue", "red"))
        }

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        episode_seed = self.base_seed + self.episode_index if seed is None else seed
        self.episode_index += 1
        self._build_world(episode_seed)
        for policy in (*self.motor_policies.values(), *self.tactical_policies.values()):
            policy.reset()
        return self._observation(), {
            "perceptionLatencyMs": self.env.status()["perceptionLatencyMs"],
            "opponentIntentVisible": False,
            "futureTrajectoryVisible": False,
        }

    def step(
        self,
        action: np.ndarray,
    ) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        target_command = TacticalCommand.from_policy_output(action)
        total_reward = 0.0
        info: dict[str, Any] = {}
        done = False
        for _ in range(self.env.tactical_update_interval):
            autonomous = self.env.autonomous_commands(self.tactical_policies)
            autonomous[self.side] = target_command
            _, rewards, done, info = self.env.step(
                self.motor_policies,
                autonomous,
            )
            total_reward += rewards[self.side]
            if done:
                break
        end_reason = info.get("endReason")
        terminated = bool(done and end_reason in ("fall", "knockout"))
        truncated = bool(done and not terminated)
        info = {
            **info,
            "fastInterrupt": self.env.tactical_interrupt[self.opponent],
            "perceivedThreat": self.env.tactical_salience[self.side],
        }
        return (
            self._observation(),
            float(total_reward),
            terminated,
            truncated,
            info,
        )

    def render(self) -> dict[str, object] | None:
        return self.env.pose_frame() if self.render_mode == "state" else None

    def _observation(self) -> np.ndarray:
        return np.clip(
            self.env.tactical_observe(self.side),
            -self.observation_limit,
            self.observation_limit,
        ).astype(np.float32)

    def close(self) -> None:
        return None
