"""Persistent native simulation worker and HTTP bridge for the Forge site."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
from typing import Any
from urllib.parse import urlparse

from .athletes import DEFAULT_ATHLETE_IDS, athlete_profile
from .environment import ForgeBoxingEnv, TacticalCommand
from .policy import RecurrentMotorPolicy, RecurrentTacticalPolicy
from .training import AUTONOMOUS_VALIDATION_STAGES, CURRICULUM, EvolutionStrategyTrainer


DEFAULT_ATHLETES = DEFAULT_ATHLETE_IDS
SCENARIO_NAMES = tuple(stage.name for stage in CURRICULUM)


class NativeTrainingRuntime:
    def __init__(self, checkpoint_root: str | Path, seed: int = 4107) -> None:
        self.checkpoint_root = Path(checkpoint_root)
        self.seed = seed
        self.env = ForgeBoxingEnv(
            seed=seed,
            max_seconds=30.0,
            athlete_profiles={
                "blue": athlete_profile(DEFAULT_ATHLETES[0]),
                "red": athlete_profile(DEFAULT_ATHLETES[1]),
            },
        )
        self.policies = {
            athlete_id: self.env.create_policy("blue", seed + index * 97)
            for index, athlete_id in enumerate(DEFAULT_ATHLETES)
        }
        self.tactical_policies = {
            athlete_id: self.env.create_tactical_policy("blue", seed + 50_000 + index * 131)
            for index, athlete_id in enumerate(DEFAULT_ATHLETES)
        }
        self.trainers = {
            athlete_id: self._create_trainer(athlete_id, index)
            for index, athlete_id in enumerate(DEFAULT_ATHLETES)
        }
        for athlete_id, policy in self.policies.items():
            checkpoint = self.checkpoint_root / "athletes" / f"{athlete_id}.npz"
            working_checkpoint = (
                self.checkpoint_root / "athletes" / f"{athlete_id}-working.npz"
            )
            load_checkpoint = (
                working_checkpoint if working_checkpoint.exists() else checkpoint
            )
            if load_checkpoint.exists():
                self.policies[athlete_id] = RecurrentMotorPolicy.load(
                    load_checkpoint,
                    observation_size=self.env.observation_size,
                    action_size=self.env.motor_count_per_athlete,
                )
                self.env.seed_locomotion_prior(self.policies[athlete_id], "blue")
            tactical_checkpoint = (
                self.checkpoint_root / "athletes" / f"{athlete_id}-tactical.npz"
            )
            tactical_working = (
                self.checkpoint_root / "athletes" / f"{athlete_id}-tactical-working.npz"
            )
            load_tactical = (
                tactical_working if tactical_working.exists() else tactical_checkpoint
            )
            if load_tactical.exists():
                self.tactical_policies[athlete_id] = RecurrentTacticalPolicy.load(
                    load_tactical,
                    observation_size=self.env.tactical_observation_size,
                )
                self.env.seed_tactical_prior(self.tactical_policies[athlete_id])
            else:
                self.tactical_policies[athlete_id].save(tactical_checkpoint)
            if not checkpoint.exists():
                self.policies[athlete_id].save(checkpoint)
        self.target_id = DEFAULT_ATHLETES[0]
        self.pinned_scenario: str | None = None
        self.status_name = "paused"
        self.last_errors: dict[str, str | None] = {
            athlete_id: None for athlete_id in self.policies
        }
        self.last_gates: dict[str, dict[str, Any] | None] = {
            athlete_id: None for athlete_id in self.policies
        }
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()

    @property
    def trainer(self) -> EvolutionStrategyTrainer:
        return self.trainers[self.target_id]

    @property
    def last_error(self) -> str | None:
        return self.last_errors[self.target_id]

    @last_error.setter
    def last_error(self, value: str | None) -> None:
        self.last_errors[self.target_id] = value

    @property
    def last_gate(self) -> dict[str, Any] | None:
        return self.last_gates[self.target_id]

    @last_gate.setter
    def last_gate(self, value: dict[str, Any] | None) -> None:
        self.last_gates[self.target_id] = value

    def _create_trainer(self, athlete_id: str, index: int) -> EvolutionStrategyTrainer:
        return EvolutionStrategyTrainer(
            self.checkpoint_root,
            seed=self.seed + index * 1_009,
            athlete_id=athlete_id,
        )

    def _save_starter_brain(self, athlete_id: str) -> None:
        policy = self.policies[athlete_id]
        tactical_policy = self.tactical_policies[athlete_id]
        for suffix in ("", "-working"):
            policy.save(
                self.checkpoint_root / "athletes" / f"{athlete_id}{suffix}.npz"
            )
            tactical_policy.save(
                self.checkpoint_root / "athletes" / f"{athlete_id}-tactical{suffix}.npz"
            )

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                self.status_name = "running"
                return
            self._stop.clear()
            self.status_name = "running"
            self._thread = threading.Thread(target=self._training_loop, name="forge-3d-training", daemon=True)
            self._thread.start()

    def pause(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=30.0)
        with self._lock:
            if self.status_name != "error":
                self.status_name = "paused"

    def _pause_for_reconfiguration(self) -> bool:
        with self._lock:
            should_resume = bool(self._thread and self._thread.is_alive())
        if should_resume:
            self.pause()
        return should_resume

    def set_target(self, athlete_id: str) -> None:
        should_resume = self._pause_for_reconfiguration()
        with self._lock:
            if athlete_id not in self.policies:
                index = len(self.policies)
                self.policies[athlete_id] = self.env.create_policy(
                    "blue",
                    self.seed + index * 97,
                )
                self.tactical_policies[athlete_id] = self.env.create_tactical_policy(
                    "blue",
                    self.seed + 50_000 + index * 131,
                )
                self.trainers[athlete_id] = self._create_trainer(athlete_id, index)
                self.trainers[athlete_id].set_pinned_stage(self.pinned_scenario)
                self.last_errors[athlete_id] = None
                self.last_gates[athlete_id] = None
                self._save_starter_brain(athlete_id)
            self.target_id = athlete_id
        if should_resume:
            self.start()

    def set_scenario(self, name: str | None) -> None:
        should_resume = self._pause_for_reconfiguration()
        with self._lock:
            self.pinned_scenario = name
            for trainer in self.trainers.values():
                trainer.set_pinned_stage(name)
        if should_resume:
            self.start()

    def reset_target(self) -> None:
        should_resume = self._pause_for_reconfiguration()
        with self._lock:
            index = list(self.policies).index(self.target_id)
            self.policies[self.target_id] = self.env.create_policy(
                "blue",
                self.seed + index * 97,
            )
            self.tactical_policies[self.target_id] = self.env.create_tactical_policy(
                "blue",
                self.seed + 50_000 + index * 131,
            )
            self._save_starter_brain(self.target_id)
            self.trainer.reset_progress(self.target_id)
            self.last_gate = None
            self.last_error = None
        if should_resume:
            self.start()

    def _training_loop(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                athlete_id = self.target_id
                policy = self.policies[athlete_id]
                tactical_policy = self.tactical_policies[athlete_id]
                trainer = self.trainers[athlete_id]
                self.status_name = "working"
            try:
                policy, tactical_policy, gate = trainer.train_generation(
                    athlete_id,
                    policy,
                    tactical_policy,
                )
                with self._lock:
                    self.policies[athlete_id] = policy
                    self.tactical_policies[athlete_id] = tactical_policy
                    self.last_gates[athlete_id] = asdict(gate)
                    self.last_errors[athlete_id] = None
                    self.status_name = "paused" if self._stop.is_set() else "running"
            except Exception as error:
                with self._lock:
                    self.last_errors[athlete_id] = str(error)
                    self.status_name = "error"
                self._stop.set()
            if self._stop.wait(0.01):
                break
        with self._lock:
            if self.status_name != "error":
                self.status_name = "paused"

    def status(self) -> dict[str, Any]:
        with self._lock:
            physics = self.env.status()
            physics["replayFrames"] = len(self.trainer.latest_replay) or len(self.env.replay)
            autonomous = self.trainer.stage.name in AUTONOMOUS_VALIDATION_STAGES
            physics["motorTeacherWeight"] = (
                0.0
                if autonomous
                else round(self.trainer._motor_teacher_weight(self.trainer.stage), 3)
            )
            physics["demonstrationTeacherWeight"] = round(
                self.trainer._motor_teacher_weight(self.trainer.stage),
                3,
            )
            physics["autonomousValidation"] = autonomous
            physics["projectileDifficulty"] = round(
                self.trainer.coach.state.challenge_scale,
                3,
            )
            return {
                "available": True,
                "status": self.status_name,
                "targetId": self.target_id,
                "pinnedScenario": self.pinned_scenario,
                "scenarios": list(SCENARIO_NAMES),
                "lastError": self.last_error,
                "lastEvaluationGate": self.last_gate,
                "training": asdict(self.trainer.metrics),
                "curriculum": asdict(self.trainer.stage),
                "coach": self.trainer.coach.status(),
                "athleteTraining": {
                    athlete_id: {
                        "generation": trainer.metrics.generation,
                        "episodes": trainer.metrics.episodes,
                        "acceptedCheckpoints": trainer.metrics.accepted_checkpoints,
                        "curriculum": trainer.stage.name,
                        "coachFocus": trainer.coach.state.focus,
                        "experienceRecords": len(trainer.coach.ledger),
                    }
                    for athlete_id, trainer in self.trainers.items()
                },
                "brains": {
                    "motor": "recurrent-64",
                    "tactical": "recurrent-threat-memory-96",
                    "liveCommands": 12,
                    "scriptedSelfPlayCommands": 0,
                    "starterArchitectureShared": True,
                    "weightsShared": False,
                    "independentVision": True,
                    "independentRecurrentMemory": True,
                    "independentLearningHistory": True,
                },
                "physics": physics,
            }

    def replay(self, count: int) -> dict[str, Any]:
        with self._lock:
            replay = self.trainer.latest_replay or self.env.replay
            limit = max(1, min(count, 600))
            if len(replay) <= limit:
                frames = replay.copy()
            elif limit == 1:
                frames = [replay[-1]]
            else:
                indexes = [
                    round(index * (len(replay) - 1) / (limit - 1))
                    for index in range(limit)
                ]
                frames = [replay[index] for index in indexes]
            return {
                "available": True,
                "coordinateSystem": "x-forward, y-left, z-up",
                "replayId": self.trainer.latest_replay_id,
                "endReason": self.trainer.latest_replay_end_reason,
                "curriculum": self.trainer.stage.name,
                "frames": frames,
            }


class ForgeRequestHandler(BaseHTTPRequestHandler):
    server_version = "ForgePhysics/0.1"

    @property
    def runtime(self) -> NativeTrainingRuntime:
        return self.server.runtime  # type: ignore[attr-defined]

    def _authorized(self) -> bool:
        expected = self.server.token  # type: ignore[attr-defined]
        if not expected:
            return True
        return self.headers.get("authorization") == f"Bearer {expected}"

    def _json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        if not self._authorized():
            self._json({"error": "Unauthorized."}, HTTPStatus.UNAUTHORIZED)
            return
        url = urlparse(self.path)
        if url.path == "/health":
            self._json({"ok": True, "engine": self.runtime.env.status()["engine"]})
            return
        if url.path == "/v1/status":
            self._json(self.runtime.status())
            return
        if url.path == "/v1/replay":
            count = 300
            if url.query.startswith("frames="):
                try:
                    count = int(url.query.removeprefix("frames="))
                except ValueError:
                    count = 300
            self._json(self.runtime.replay(count))
            return
        self._json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if not self._authorized():
            self._json({"error": "Unauthorized."}, HTTPStatus.UNAUTHORIZED)
            return
        url = urlparse(self.path)
        if url.path != "/v1/control":
            self._json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._body()
        except (ValueError, json.JSONDecodeError):
            self._json({"error": "Invalid JSON."}, HTTPStatus.BAD_REQUEST)
            return
        action = payload.get("action")
        if action == "start":
            self.runtime.start()
        elif action == "pause":
            self.runtime.pause()
        elif action == "target" and isinstance(payload.get("targetId"), str):
            self.runtime.set_target(payload["targetId"])
        elif action == "scenario":
            scenario = payload.get("scenarioName")
            if scenario is not None and scenario not in SCENARIO_NAMES:
                self._json({"error": "Unknown scenario."}, HTTPStatus.BAD_REQUEST)
                return
            self.runtime.set_scenario(scenario)
        elif action == "reset":
            self.runtime.reset_target()
        else:
            self._json({"error": "Unsupported control action."}, HTTPStatus.BAD_REQUEST)
            return
        self._json(self.runtime.status())

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


class ForgePhysicsServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        runtime: NativeTrainingRuntime,
        token: str | None,
    ) -> None:
        super().__init__(address, ForgeRequestHandler)
        self.runtime = runtime
        self.token = token


def load_dotenv(path: str | Path | None = None) -> None:
    """Populate os.environ from a project-root .env, without adding a dependency.

    Real environment variables always win, so an exported value overrides the
    file. Only simple KEY=VALUE lines are honoured; comments and blanks skipped.
    """
    env_path = Path(path) if path is not None else Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    try:
        lines = env_path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Run the Forge League native MuJoCo worker.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--checkpoints", default="sim3d/checkpoints")
    parser.add_argument("--train", action="store_true", help="Start training immediately.")
    args = parser.parse_args()
    runtime = NativeTrainingRuntime(args.checkpoints)
    if args.train:
        runtime.start()
    server = ForgePhysicsServer(
        (args.host, args.port),
        runtime,
        os.environ.get("FORGE_SIM_TOKEN"),
    )
    print(f"Forge native physics listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        runtime.pause()
        server.server_close()


if __name__ == "__main__":
    main()
