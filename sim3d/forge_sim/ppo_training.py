"""Recurrent PPO entry point for the autonomous tactical brain."""

from __future__ import annotations

import argparse
from pathlib import Path

from .gymnasium_env import ForgeTacticalGymEnv


def train_recurrent_ppo(
    athlete_id: str,
    total_timesteps: int,
    checkpoint_root: str | Path,
    seed: int = 4107,
) -> Path:
    try:
        from sb3_contrib import RecurrentPPO
    except ImportError as error:
        raise RuntimeError(
            "Install sim3d/requirements-ppo.txt before running recurrent PPO training."
        ) from error

    checkpoint_root = Path(checkpoint_root)
    checkpoint_root.mkdir(parents=True, exist_ok=True)
    checkpoint = checkpoint_root / f"{athlete_id}-recurrent-ppo"
    env = ForgeTacticalGymEnv(seed=seed)
    model = RecurrentPPO(
        "MlpLstmPolicy",
        env,
        learning_rate=3e-4,
        n_steps=512,
        batch_size=128,
        gamma=0.995,
        gae_lambda=0.95,
        clip_range=0.20,
        ent_coef=0.01,
        verbose=1,
        seed=seed,
        device="auto",
    )
    model.learn(total_timesteps=total_timesteps, progress_bar=True)
    model.save(checkpoint)
    env.close()
    return checkpoint.with_suffix(".zip")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train an autonomous Forge tactical brain with recurrent PPO.")
    parser.add_argument("--athlete", default="malik-okoro")
    parser.add_argument("--timesteps", type=int, default=250_000)
    parser.add_argument("--seed", type=int, default=4107)
    parser.add_argument("--checkpoints", default="sim3d/checkpoints/ppo")
    args = parser.parse_args()
    path = train_recurrent_ppo(
        args.athlete,
        args.timesteps,
        args.checkpoints,
        args.seed,
    )
    print(f"Saved recurrent PPO tactical checkpoint to {path}")


if __name__ == "__main__":
    main()
