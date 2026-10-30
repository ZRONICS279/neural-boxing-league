"""Physical and athletic profiles shared by native training environments."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AthleteProfile:
    athlete_id: str
    height_m: float
    mass_kg: float
    reach_m: float
    power: float
    speed: float
    cardio: float
    defense: float
    reaction: float


ATHLETE_PROFILES = {
    profile.athlete_id: profile
    for profile in (
        AthleteProfile("malik-okoro", 1.803, 72.57, 1.880, 0.78, 0.91, 0.84, 0.88, 0.94),
        AthleteProfile("jonah-vale", 1.753, 72.12, 1.803, 0.91, 0.78, 0.90, 0.72, 0.76),
        AthleteProfile("mateo-silva", 1.829, 71.67, 1.930, 0.72, 0.94, 0.86, 0.83, 0.90),
        AthleteProfile("darius-cole", 1.778, 72.57, 1.829, 0.87, 0.70, 0.82, 0.86, 0.74),
        AthleteProfile("ren-ito", 1.778, 71.21, 1.854, 0.68, 0.89, 0.93, 0.80, 0.87),
        AthleteProfile("andre-bishop", 1.727, 72.57, 1.778, 0.97, 0.74, 0.69, 0.67, 0.79),
    )
}

DEFAULT_ATHLETE_IDS = tuple(ATHLETE_PROFILES)
BASELINE_PROFILE = AthleteProfile(
    "baseline",
    1.800,
    72.60,
    1.830,
    0.78,
    0.82,
    0.82,
    0.80,
    0.82,
)


def athlete_profile(athlete_id: str | None) -> AthleteProfile:
    if athlete_id in ATHLETE_PROFILES:
        return ATHLETE_PROFILES[athlete_id]
    return AthleteProfile(
        athlete_id or BASELINE_PROFILE.athlete_id,
        BASELINE_PROFILE.height_m,
        BASELINE_PROFILE.mass_kg,
        BASELINE_PROFILE.reach_m,
        BASELINE_PROFILE.power,
        BASELINE_PROFILE.speed,
        BASELINE_PROFILE.cardio,
        BASELINE_PROFILE.defense,
        BASELINE_PROFILE.reaction,
    )
