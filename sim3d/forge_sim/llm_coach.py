"""Optional LLM strategy advisor that reads training telemetry and proposes
bounded adjustments to the reinforcement-learning search.

This is an *advisor*, not a controller: it can only nudge a handful of clamped
knobs (learning-rate scale, exploration, challenge, which weight groups to
search) and name a focus. Every value the trainer consumes is clamped again on
the receiving side, so a bad or malicious suggestion cannot destabilise
training. It runs out of the physics hot loop — only every few coaching
reviews — and is a no-op unless explicitly enabled and credentials resolve.

Backend: OpenAI. Enable with FORGE_LLM_COACH=1 and a resolvable OPENAI_API_KEY.
Override the model with FORGE_LLM_MODEL (defaults to gpt-4o).
"""

from __future__ import annotations

import json
import os
from typing import Any

MODEL = os.environ.get("FORGE_LLM_MODEL", "gpt-4o")

# Weight groups the advisor is allowed to steer the search toward. Anything it
# returns outside this set is dropped before it reaches the trainer.
TRAINABLE_GROUPS = (
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
COURSE_FOCUS_OPTIONS = (
    "left",
    "right",
    "front",
    "rear",
    "high",
    "low",
    "no_reaction",
    "late_reaction",
    "wrong_direction",
    "insufficient_displacement",
    "insufficient_clearance",
)

_ADVICE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "learning_rate_scale": {"type": "number"},
        "exploration_scale": {"type": "number"},
        "challenge_scale": {"type": "number"},
        "focus_parameters": {"type": "array", "items": {"type": "string"}},
        "course_focus": {"type": "array", "items": {"type": "string"}},
        "rationale": {"type": "string"},
    },
    "required": [
        "learning_rate_scale",
        "exploration_scale",
        "challenge_scale",
        "focus_parameters",
        "course_focus",
        "rationale",
    ],
}

_SYSTEM = (
    "You are a reinforcement-learning training coach for a physics-simulated "
    "boxing athlete learning motor control (walking, punching, dodging) via an "
    "evolution-strategy search. You are given the recent per-generation "
    "telemetry and the current search knobs. Diagnose why learning has stalled "
    "or is progressing and return adjusted knobs. Projectile attempts include "
    "the incoming direction, target height, reaction time, signed head movement, "
    "minimum clearance, exact contacted body geometry, impulse, and a measured "
    "failure reason. Cite those mechanics in the rationale; do not claim there "
    "were no dodges when the measurements show otherwise. Use course_focus to "
    "request extra examples of a measured weak direction or failure cause. "
    "Keep every number inside the "
    "stated bounds. Prefer small, decisive moves. When a stage keeps failing "
    "the same measured deficit, raise exploration and point focus_parameters at "
    "the weight groups that control that deficit. When progress is steady, calm "
    "exploration and let the learning rate do the work."
)


def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        return float(min(high, max(low, float(value))))
    except (TypeError, ValueError):
        return fallback


class LLMStrategyAdvisor:
    """Periodically consult an OpenAI model to retune the ES search. Optional."""

    def __init__(self, enabled: bool | None = None, interval: int = 12) -> None:
        env = os.environ.get("FORGE_LLM_COACH", "").strip().lower()
        self.requested = env in ("1", "true", "yes", "on") if enabled is None else enabled
        self.interval = max(1, interval)
        self._client: Any = None
        self._unavailable_reason: str | None = None
        if self.requested:
            self._init_client()

    @property
    def available(self) -> bool:
        return self._client is not None

    def _init_client(self) -> None:
        try:
            import openai
        except ImportError:
            self._unavailable_reason = "openai SDK not installed"
            return
        if not os.environ.get("OPENAI_API_KEY"):
            self._unavailable_reason = "OPENAI_API_KEY not set"
            return
        try:
            self._client = openai.OpenAI()
        except Exception as error:  # noqa: BLE001 - credential/config failures are non-fatal
            self._unavailable_reason = f"client init failed: {error}"
            self._client = None

    def should_consult(self, review_count: int, consecutive_failures: int) -> bool:
        if not self.available:
            return False
        if review_count <= 0:
            return False
        # Consult on the interval, and sooner when the athlete is clearly stuck.
        if consecutive_failures >= self.interval:
            return review_count % max(1, self.interval // 2) == 0
        return review_count % self.interval == 0

    def advise(
        self,
        stage: str,
        knobs: dict[str, float],
        recent_reviews: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        if not self.available:
            return None
        payload = {
            "stage": stage,
            "current_knobs": knobs,
            "bounds": {
                "learning_rate_scale": [0.5, 2.0],
                "exploration_scale": [0.7, 1.6],
                "challenge_scale": [0.6, 1.35],
            },
            "allowed_focus_parameters": list(TRAINABLE_GROUPS),
            "allowed_course_focus": list(COURSE_FOCUS_OPTIONS),
            "recent_generations": recent_reviews[-16:],
        }
        prompt = (
            "Here is the recent training telemetry as JSON. Return adjusted "
            "search knobs.\n\n" + json.dumps(payload, separators=(",", ":"))
        )
        try:
            response = self._client.chat.completions.create(
                model=MODEL,
                max_completion_tokens=1200,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "training_advice",
                        "strict": True,
                        "schema": _ADVICE_SCHEMA,
                    },
                },
                messages=[
                    {"role": "system", "content": _SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            )
        except Exception:  # noqa: BLE001 - any API failure falls back to heuristics
            return None
        choice = response.choices[0] if response.choices else None
        if choice is None:
            return None
        message = choice.message
        if getattr(message, "refusal", None):
            return None
        text = message.content or ""
        try:
            raw = json.loads(text)
        except (ValueError, TypeError):
            return None
        focus = [
            name for name in raw.get("focus_parameters", [])
            if name in TRAINABLE_GROUPS
        ]
        course_focus = [
            name for name in raw.get("course_focus", [])
            if name in COURSE_FOCUS_OPTIONS
        ]
        return {
            "learning_rate_scale": _clamp(raw.get("learning_rate_scale"), 0.5, 2.0, 1.0),
            "exploration_scale": _clamp(raw.get("exploration_scale"), 0.7, 1.6, 1.0),
            "challenge_scale": _clamp(raw.get("challenge_scale"), 0.6, 1.35, 1.0),
            "focus_parameters": focus,
            "course_focus": course_focus[:3],
            "rationale": str(raw.get("rationale", ""))[:600],
        }
