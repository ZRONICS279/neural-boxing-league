from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import mujoco
import numpy as np

from forge_sim.athletes import ATHLETE_PROFILES
from forge_sim.coach import AdaptiveTrainingCoach
from forge_sim.conditioning import ConditioningProfile, JointFatigue, PhysiologyState, adapt_conditioning
from forge_sim.environment import BodyMotion, ForgeBoxingEnv, StrikeState, TacticalCommand
from forge_sim.gymnasium_env import ForgeTacticalGymEnv
from forge_sim.policy import RecurrentMotorPolicy, RecurrentTacticalPolicy
from forge_sim.service import DEFAULT_ATHLETES, NativeTrainingRuntime
from forge_sim.training import (
    AUTONOMOUS_VALIDATION_STAGES,
    CURRICULUM,
    SOLO_STAGES,
    AdamOptimizer,
    EpisodeResult,
    EvolutionStrategyTrainer,
    behavior_gate,
    behavior_preserved,
    curriculum_command,
    projectile_skill_score,
)


def neutral_policy(env: ForgeBoxingEnv, side: str) -> RecurrentMotorPolicy:
    policy = env.create_policy(side, seed=42)
    for weights in policy.weights.values():
        weights.fill(0.0)
    return policy


class ForgeBoxingPhysicsTests(unittest.TestCase):
    def test_model_has_two_independent_articulated_athletes(self) -> None:
        env = ForgeBoxingEnv(seed=7)

        self.assertEqual(env.degrees_of_freedom_per_athlete, 39)
        self.assertEqual(env.motor_count_per_athlete, 33)
        self.assertEqual(env.model.nu, 66)
        self.assertEqual(env.status()["physicsHz"], 500)
        self.assertEqual(env.status()["motorHz"], 50)
        self.assertEqual(env.observe("blue").shape, (148,))
        self.assertTrue(env.status()["activeRagdollMuscles"])
        self.assertTrue(env.status()["jacobianStrikeGuidance"])
        self.assertTrue(env.status()["physicalProjectileDrills"])
        self.assertTrue(env.status()["anatomicalImpactZones"])
        self.assertTrue(env.status()["rotationalKnockoutModel"])

    def test_ground_reaction_force_comes_from_shoe_floor_contact(self) -> None:
        env = ForgeBoxingEnv(seed=8, max_seconds=2.0)
        policies = {
            "blue": neutral_policy(env, "blue"),
            "red": neutral_policy(env, "red"),
        }
        commands = {
            "blue": TacticalCommand(),
            "red": TacticalCommand(),
        }
        for _ in range(30):
            env.step(policies, commands)

        for side in ("blue", "red"):
            left = float(env._sensor(f"{side}_left_foot_force")[0])
            right = float(env._sensor(f"{side}_right_foot_force")[0])
            self.assertGreater(left + right, 300.0)
            self.assertTrue(np.isfinite(env.data.qpos).all())
            frame = env.pose_frame()
            forces = frame["contacts"][side]["groundForces"]
            self.assertAlmostEqual(forces["left"] + forces["right"], left + right, places=3)

    def test_striking_curriculum_can_start_inside_measured_punch_range(self) -> None:
        env = ForgeBoxingEnv(seed=9, starting_separation_m=1.02)
        separation = float(np.linalg.norm(
            env._body_position("red_pelvis")[:2]
            - env._body_position("blue_pelvis")[:2]
        ))

        self.assertAlmostEqual(separation, 1.02, places=2)
        self.assertTrue(env._strike_contact_within_reach(
            "blue",
            env.model.geom("red_head_target").id,
            env.model.geom("blue_left_glove_geom").id,
        ))

    def test_footwork_commands_create_joint_driven_body_and_foot_travel(self) -> None:
        env = ForgeBoxingEnv(
            seed=31,
            max_seconds=3.0,
            training_stage="footwork",
            termination_sides=("blue",),
            solo_side="blue",
            motor_teacher_weight=1.0,
        )
        policies = {
            "blue": env.create_policy("blue", seed=32),
            "red": neutral_policy(env, "red"),
        }
        command = {
            "blue": TacticalCommand(advance=0.65, urgency=0.30),
            "red": TacticalCommand(),
        }
        pelvis_start = env._body_position("blue_pelvis")
        feet = {
            leg: env._body_position(f"blue_{leg}_foot")
            for leg in ("left", "right")
        }
        foot_travel = 0.0
        maximum_ground_force = 0.0
        for _ in range(150):
            env.step(policies, command)
            for leg in ("left", "right"):
                position = env._body_position(f"blue_{leg}_foot")
                foot_travel += float(np.linalg.norm(position - feet[leg]))
                feet[leg] = position
            maximum_ground_force = max(
                maximum_ground_force,
                sum(
                    float(env._sensor(f"blue_{leg}_foot_force")[0])
                    for leg in ("left", "right")
                ),
            )

        pelvis_travel = float(np.linalg.norm(
            env._body_position("blue_pelvis")[:2] - pelvis_start[:2]
        ))
        self.assertGreater(pelvis_travel, 0.04)
        self.assertGreater(foot_travel, 0.08)
        self.assertGreater(maximum_ground_force, 300.0)
        self.assertGreater(env._body_position("blue_head")[2], 1.15)
        self.assertTrue(np.allclose(env.data.xfrc_applied, 0.0))

    def test_moving_strike_curriculum_steps_punches_and_recovers_between_shots(self) -> None:
        env = ForgeBoxingEnv(
            seed=51,
            max_seconds=6.0,
            training_stage="moving_strikes",
            termination_sides=("blue",),
            starting_separation_m=0.82,
            motor_teacher_weight=1.0,
        )
        policies = {
            "blue": env.create_policy("blue", seed=52),
            "red": env.create_policy("red", seed=53),
        }
        outgoing_impulse = 0.0
        strike_kinds = set()
        info: dict[str, object] = {}
        done = False
        while not done:
            command = curriculum_command(CURRICULUM[2], float(env.data.time), "blue")
            _, _, done, info = env.step(
                policies,
                {"blue": command, "red": TacticalCommand()},
            )
            impact = info["impacts"]["blue"]  # type: ignore[index]
            outgoing_impulse += float(
                impact["head_impulse_ns"]
                + impact["body_impulse_ns"]
                + impact["guard_impulse_ns"]
            )
            strike_kinds.add(env.strike_state["blue"].kind)

        self.assertEqual(info["endReason"], "horizon")
        self.assertGreater(env._body_position("blue_head")[2], 1.15)
        self.assertGreater(outgoing_impulse, 1.0)
        self.assertEqual(strike_kinds, {"jab", "cross", "hook"})

    def test_scripted_defense_counts_resolved_strike_outcomes(self) -> None:
        env = ForgeBoxingEnv(
            seed=54,
            max_seconds=6.0,
            training_stage="scripted_defense",
            termination_sides=("blue",),
            starting_separation_m=0.82,
            motor_teacher_weight=0.7,
        )
        policies = {
            "blue": env.create_policy("blue", seed=55),
            "red": env.create_policy("red", seed=56),
        }
        info: dict[str, object] = {}
        done = False
        while not done:
            time_seconds = float(env.data.time)
            _, _, done, info = env.step(
                policies,
                {
                    "blue": curriculum_command(CURRICULUM[5], time_seconds, "blue"),
                    "red": curriculum_command(CURRICULUM[2], time_seconds + 0.4, "red"),
                },
            )

        defense = info["defenseTotals"]["blue"]  # type: ignore[index]
        self.assertGreater(defense["attacks"], 0)
        self.assertEqual(
            defense["attacks"],
            defense["evades"] + defense["blocks"] + defense["clean_hits"],
        )

    def test_identical_state_and_neural_policies_are_deterministic(self) -> None:
        first = ForgeBoxingEnv(seed=10, max_seconds=1.0)
        second = ForgeBoxingEnv(seed=10, max_seconds=1.0)
        first_policies = {
            side: first.create_policy(side, seed=20 + index)
            for index, side in enumerate(("blue", "red"))
        }
        second_policies = {
            side: second.create_policy(side, seed=20 + index)
            for index, side in enumerate(("blue", "red"))
        }
        commands = {
            "blue": TacticalCommand(advance=0.5, jab=0.7),
            "red": TacticalCommand(retreat=0.3, guard=0.9),
        }
        for _ in range(8):
            first.step(first_policies, commands)
            second.step(second_policies, commands)

        np.testing.assert_allclose(first.data.qpos, second.data.qpos, atol=1e-12)
        np.testing.assert_allclose(first.data.qvel, second.data.qvel, atol=1e-12)

    def test_solo_curricula_have_no_strike_commands_or_opponent_termination(self) -> None:
        for stage in (stage for stage in CURRICULUM if stage.name in SOLO_STAGES):
            command = curriculum_command(stage, 2.4, "blue")
            self.assertEqual(command.jab, 0.0)
            self.assertEqual(command.cross, 0.0)
            self.assertEqual(command.hook, 0.0)

        self.assertEqual(
            [stage.name for stage in CURRICULUM],
            [
                "balance",
                "footwork",
                "moving_strikes",
                "projectile_evasion",
                "impact_recovery",
                "scripted_defense",
                "self_play",
            ],
        )
        moving_command = curriculum_command(CURRICULUM[2], 0.8, "blue")
        self.assertGreater(moving_command.advance + moving_command.retreat + abs(moving_command.circle), 0.0)
        self.assertGreater(moving_command.jab + moving_command.cross + moving_command.hook, 0.0)
        projectile_command = curriculum_command(CURRICULUM[3], 2.4, "blue")
        self.assertEqual(
            projectile_command.advance
            + projectile_command.retreat
            + abs(projectile_command.circle),
            0.0,
        )
        self.assertEqual(projectile_command.head_movement, 0.0)
        self.assertEqual(projectile_command.level_change, 0.0)

        env = ForgeBoxingEnv(
            seed=17,
            max_seconds=3.0,
            training_stage="balance",
            termination_sides=("blue",),
            solo_side="blue",
        )
        policies = {
            "blue": neutral_policy(env, "blue"),
            "red": neutral_policy(env, "red"),
        }
        red_root = env.model.joint("red_root_free").id
        red_root_address = int(env.model.jnt_qposadr[red_root])
        env.data.qpos[red_root_address + 2] = 0.12
        env.data.qpos[red_root_address + 3:red_root_address + 7] = [0.7071, 0.0, 0.7071, 0.0]
        for _ in range(35):
            _, _, done, info = env.step(policies)

        self.assertTrue(info["fallenSides"]["red"])
        self.assertFalse(info["fallenSides"]["blue"])
        self.assertFalse(done)

    def test_recurrent_motor_memory_and_checkpoints_are_real_neural_state(self) -> None:
        env = ForgeBoxingEnv(seed=11)
        policy = env.create_policy("blue", seed=12)
        observation = env.observe("blue")
        command = TacticalCommand(jab=0.8).as_array()
        first = policy.act(observation, command)
        memory_after_first = policy.state.hidden.copy()
        second = policy.act(observation, command)

        self.assertTrue(np.any(np.abs(memory_after_first) > 0.0))
        self.assertFalse(np.allclose(first, second))
        with tempfile.TemporaryDirectory() as root:
            path = f"{root}/motor-policy.npz"
            policy.save(path)
            restored = RecurrentMotorPolicy.load(path)
            policy.reset()
            restored.reset()
            np.testing.assert_allclose(
                policy.act(observation, command),
                restored.act(observation, command),
                atol=1e-12,
            )
            legacy = RecurrentMotorPolicy(134, env.motor_count_per_athlete, seed=33)
            legacy.save(path)
            migrated = RecurrentMotorPolicy.load(path, observation_size=env.observation_size)
            self.assertEqual(migrated.weights["observation"].shape[1], 148)
            np.testing.assert_allclose(
                migrated.weights["observation"][:, :134],
                legacy.weights["observation"],
            )
            np.testing.assert_allclose(migrated.weights["observation"][:, 134:], 0.0)

    def test_projectile_course_is_seen_by_the_policy_and_resolves_physical_hits(self) -> None:
        env = ForgeBoxingEnv(
            seed=18,
            max_seconds=4.0,
            training_stage="impact_recovery",
            termination_sides=("blue",),
            solo_side="blue",
        )
        policies = {
            "blue": env.create_policy("blue", seed=19),
            "red": neutral_policy(env, "red"),
        }
        saw_projectile = False
        maximum_impulse = 0.0
        minimum_equilibrium = 1.0
        info: dict[str, object] = {}
        done = False
        while not done:
            observations, _, done, info = env.step(policies)
            saw_projectile = saw_projectile or observations["blue"][-1] == 1.0
            maximum_impulse = max(
                maximum_impulse,
                float(info["projectiles"]["blue"]["hit_impulse_ns"]),
            )
            minimum_equilibrium = min(
                minimum_equilibrium,
                env.physiology["blue"].equilibrium,
            )

        self.assertTrue(saw_projectile)
        self.assertGreater(info["projectileTotals"]["blue"]["hits"], 0)
        self.assertGreater(info["projectileTotals"]["blue"]["hit_impulse_ns"], 1.0)
        self.assertGreater(maximum_impulse, 0.01)
        self.assertLess(minimum_equilibrium, 1.0)
        self.assertTrue(any(frame["projectiles"] for frame in env.replay))
        attempts = info["projectileAttempts"]["blue"]
        self.assertGreater(len(attempts), 0)
        self.assertEqual(attempts[0]["outcome"], "hit")
        self.assertNotEqual(attempts[0]["contact_body"], "none")
        self.assertIn("incoming_direction", attempts[0])
        self.assertIn("reaction_time_s", attempts[0])
        self.assertIn("maximum_head_displacement_m", attempts[0])
        self.assertIn("minimum_ball_head_distance_m", attempts[0])

    def test_projectile_courses_vary_by_seed_but_remain_reproducible(self) -> None:
        def first_launch(
            seed: int,
            difficulty: float = 1.0,
            focus: tuple[str, ...] = (),
        ) -> tuple[np.ndarray, np.ndarray]:
            env = ForgeBoxingEnv(
                seed=seed,
                training_stage="projectile_evasion",
                termination_sides=("blue",),
                solo_side="blue",
                projectile_difficulty=difficulty,
                projectile_focus=focus,
            )
            state = next(iter(env.projectile_states.values()))
            env._launch_projectile(state, "blue")
            qpos = env.projectile_qpos_addresses[state.name]
            qvel = env.projectile_qvel_addresses[state.name]
            return (
                env.data.qpos[qpos:qpos + 3].copy(),
                env.data.qvel[qvel:qvel + 3].copy(),
            )

        first_position, first_velocity = first_launch(901)
        repeated_position, repeated_velocity = first_launch(901)
        different_position, different_velocity = first_launch(902)
        _, easier_velocity = first_launch(901, 0.6)
        _, harder_velocity = first_launch(901, 1.4)
        _, scaffolded_velocity = first_launch(901, focus=("no_reaction",))

        np.testing.assert_allclose(first_position, repeated_position, atol=1e-12)
        np.testing.assert_allclose(first_velocity, repeated_velocity, atol=1e-12)
        self.assertFalse(np.allclose(first_position, different_position))
        self.assertFalse(np.allclose(first_velocity, different_velocity))
        self.assertGreater(
            float(np.linalg.norm(harder_velocity)),
            float(np.linalg.norm(easier_velocity)),
        )
        self.assertLess(
            float(np.linalg.norm(scaffolded_velocity)),
            float(np.linalg.norm(first_velocity)),
        )

    def test_projectile_brain_sees_positions_but_not_supplied_motion_or_direction(self) -> None:
        env = ForgeBoxingEnv(
            seed=4107,
            training_stage="projectile_evasion",
            termination_sides=("blue",),
            solo_side="blue",
        )
        projectile = env.perceived_motion["blue"].projectiles[0]
        projectile.active = True
        projectile.position = env._body_position("blue_head") + np.asarray([1.8, 0.4, 0.1])
        projectile.velocity = np.asarray([-8.0, 2.0, -1.0])
        approaching = env._projectile_observation("blue")
        projectile.velocity = np.asarray([8.0, -2.0, 1.0])
        departing = env._projectile_observation("blue")
        projectile.position += np.asarray([0.0, 0.5, 0.0])
        moved = env._projectile_observation("blue")

        np.testing.assert_allclose(approaching, departing)
        self.assertFalse(np.allclose(approaching, moved))
        self.assertEqual(approaching[-1], 1.0)
        status = env.status()
        self.assertFalse(status["projectileVelocityVisible"])
        self.assertFalse(status["projectileDirectionLabelVisible"])
        self.assertFalse(status["projectileTargetVisible"])
        self.assertTrue(status["projectileTelemetryPostAttemptOnly"])

    def test_joint_fatigue_reduces_capacity_and_conditioning_adapts(self) -> None:
        fatigue = JointFatigue(4)
        endurance = np.full(4, 0.65)
        for _ in range(800):
            fatigue.step(
                np.full(4, 240.0),
                np.full(4, 5.0),
                0.002,
                endurance,
            )
        capacity = fatigue.capacity.copy()
        self.assertTrue(np.all(capacity < 1.0))
        profile = ConditioningProfile()
        adapted = adapt_conditioning(profile, 150_000.0, 0.75, 0.55)
        self.assertGreater(adapted.lower_body_endurance, profile.lower_body_endurance)
        self.assertGreater(adapted.shoulder_endurance, profile.shoulder_endurance)

    def test_stamina_guard_and_equilibrium_limit_active_muscle_control(self) -> None:
        physiology = PhysiologyState()
        for _ in range(500):
            physiology.step(2.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.70, 0.02)

        self.assertLess(physiology.stamina, 0.85)
        self.assertLess(physiology.force_capacity, 0.95)
        self.assertLess(physiology.speed_capacity, 0.95)
        physiology.step(0.0, 18.0, 0.0, 0.0, 0.0, 1.0, 0.70, 0.02)
        self.assertLess(physiology.guard_stability, 0.90)
        physiology.step(
            0.0,
            0.0,
            23.0,
            0.0,
            95.0,
            0.0,
            0.70,
            0.02,
            rotational_impulse_nms=1.40,
            neurological_load=1.60,
            impact_zone="jaw",
        )
        self.assertTrue(physiology.knockout)
        self.assertEqual(physiology.active_control, 0.04)
        self.assertIn("jaw", physiology.knockout_cause)

        env = ForgeBoxingEnv(seed=19)
        env.physiology["blue"] = physiology
        env._apply_motor_targets(
            "blue",
            np.zeros(env.motor_count_per_athlete),
            TacticalCommand(),
        )
        force = np.abs(env.model.actuator_forcerange[env.actuator_ids["blue"], 1])
        base = np.abs(env.force_limits["blue"][:, 1])
        self.assertLess(float(np.max(force / base)), 0.05)

    def test_dynamic_strike_guidance_tracks_target_height_and_uses_body_mass(self) -> None:
        env = ForgeBoxingEnv(seed=20)
        command = TacticalCommand(jab=0.9, urgency=0.8)
        strike = StrikeState(kind="jab", arm="left", phase=0.5, drive=1.0)
        head_guidance = env._strike_guidance("blue", command, strike)
        red_root = env.model.joint("red_root_free").id
        red_root_address = int(env.model.jnt_qposadr[red_root])
        env.data.qpos[red_root_address + 2] -= 0.30
        mujoco.mj_forward(env.model, env.data)
        for _ in range(env.perception_latency_steps["blue"] + 1):
            env._refresh_perception()
        ducked_guidance = env._strike_guidance("blue", command, strike)

        self.assertGreater(float(np.linalg.norm(head_guidance - ducked_guidance)), 0.01)
        light = ForgeBoxingEnv(body_mass_kg={"blue": 60.0, "red": 60.0})
        heavy = ForgeBoxingEnv(body_mass_kg={"blue": 95.0, "red": 95.0})
        self.assertGreater(
            heavy._effective_striking_mass("blue", "left", 0.8),
            light._effective_striking_mass("blue", "left", 0.8),
        )

    def test_contact_points_resolve_to_anatomical_zones(self) -> None:
        env = ForgeBoxingEnv(seed=20)

        def world_point(body_name: str, local: tuple[float, float, float]) -> np.ndarray:
            body = env.model.body(body_name).id
            matrix = np.asarray(env.data.xmat[body]).reshape(3, 3)
            return np.asarray(env.data.xpos[body]) + matrix @ np.asarray(local)

        head_body = env.model.body("red_head").id
        abdomen_body = env.model.body("red_abdomen").id
        self.assertEqual(
            env._anatomical_zone(
                "red_head_target",
                head_body,
                world_point("red_head", (-0.08, -0.055, -0.055)),
            ),
            "jaw",
        )
        self.assertEqual(
            env._anatomical_zone(
                "red_head_target",
                head_body,
                world_point("red_head", (-0.08, 0.0, 0.0)),
            ),
            "nose",
        )
        self.assertEqual(
            env._anatomical_zone(
                "red_abdomen_target",
                abdomen_body,
                world_point("red_abdomen", (-0.08, -0.065, 0.0)),
            ),
            "liver",
        )

    def test_precise_guard_contacts_drain_block_stability(self) -> None:
        env = ForgeBoxingEnv(seed=21, max_seconds=4.0)
        policies = {
            "blue": neutral_policy(env, "blue"),
            "red": neutral_policy(env, "red"),
        }
        for side, position in (("blue", -0.35), ("red", 0.35)):
            root_id = env.model.joint(f"{side}_root_free").id
            root_address = int(env.model.jnt_qposadr[root_id])
            env.data.qpos[root_address] = position
        mujoco.mj_forward(env.model, env.data)
        guard_before = env.physiology["red"].guard_stability
        minimum_guard = guard_before
        guard_impulse = 0.0
        kinetic_energy = 0.0
        for _ in range(120):
            _, _, _, info = env.step(
                policies,
                {
                    "blue": TacticalCommand(jab=0.9, urgency=0.8),
                    "red": TacticalCommand(guard=0.9),
                },
            )
            guard_impulse += info["impacts"]["blue"]["guard_impulse_ns"]
            kinetic_energy = max(
                kinetic_energy,
                info["impacts"]["blue"]["kinetic_energy_j"],
            )
            minimum_guard = min(
                minimum_guard,
                env.physiology["red"].guard_stability,
            )

        self.assertGreater(guard_impulse, 1.0)
        self.assertGreater(kinetic_energy, 0.002)
        self.assertLess(minimum_guard, guard_before)

    def test_native_anthropometrics_change_body_size_mass_reach_and_reaction(self) -> None:
        env = ForgeBoxingEnv(
            athlete_profiles={
                "blue": ATHLETE_PROFILES["malik-okoro"],
                "red": ATHLETE_PROFILES["jonah-vale"],
            },
        )

        self.assertGreater(
            env._body_position("blue_head")[2],
            env._body_position("red_head")[2],
        )
        self.assertGreater(
            env.athlete_profiles["blue"].reach_m,
            env.athlete_profiles["red"].reach_m,
        )
        self.assertGreater(
            env.status()["bodyMassKg"]["blue"],
            env.status()["bodyMassKg"]["red"],
        )
        self.assertLessEqual(
            env.status()["perceptionLatencyMs"]["blue"],
            env.status()["perceptionLatencyMs"]["red"],
        )
        target_id = env.model.geom("red_head_target").id
        glove_id = env.model.geom("blue_left_glove_geom").id
        self.assertFalse(env._strike_contact_within_reach("blue", target_id, glove_id))
        red_root = env.model.joint("red_root_free").id
        red_root_address = int(env.model.jnt_qposadr[red_root])
        env.data.qpos[red_root_address] = 0.30
        mujoco.mj_forward(env.model, env.data)
        self.assertTrue(env._strike_contact_within_reach("blue", target_id, glove_id))

    def test_survival_instinct_interrupts_to_cover_and_escape_after_damage(self) -> None:
        env = ForgeBoxingEnv(
            athlete_profiles={
                "blue": ATHLETE_PROFILES["malik-okoro"],
                "red": ATHLETE_PROFILES["jonah-vale"],
            },
        )
        policies = {
            "blue": env.create_tactical_policy("blue", seed=101),
            "red": env.create_tactical_policy("red", seed=102),
        }
        env.physiology["blue"].stamina = 0.18
        env.physiology["blue"].guard_stability = 0.48
        env.physiology["blue"].equilibrium = 0.62
        env.recent_impact_memory["blue"][:] = [0.90, 0.65, 0.85]
        env.tactical_tick = 1

        command = env.autonomous_commands(policies)["blue"]

        self.assertTrue(env.tactical_interrupt["blue"])
        self.assertGreater(env.instinct_salience["blue"], 0.8)
        self.assertGreater(command.guard, 0.9)
        self.assertGreater(command.retreat, 0.9)
        self.assertEqual(command.jab + command.cross + command.hook, 0.0)

    def test_trainable_balance_prior_stands_straight_and_recovers_from_a_shove(self) -> None:
        env = ForgeBoxingEnv(
            seed=22,
            max_seconds=8.0,
            training_stage="balance",
            termination_sides=("blue",),
            solo_side="blue",
        )
        policies = {
            "blue": env.create_policy("blue", seed=23),
            "red": neutral_policy(env, "red"),
        }
        pelvis_id = env.model.body("blue_pelvis").id
        maximum_lean = 0.0
        minimum_head_height = float("inf")
        done = False
        info: dict[str, object] = {}
        while not done:
            env.data.xfrc_applied[:] = 0.0
            if 2.0 <= env.data.time < 2.12:
                env.data.xfrc_applied[pelvis_id, 1] = 65.0
            _, _, done, info = env.step(policies)
            maximum_lean = max(
                maximum_lean,
                float(np.linalg.norm(env._body_matrix("blue_pelvis")[:2, 2])),
            )
            minimum_head_height = min(
                minimum_head_height,
                float(env._body_position("blue_head")[2]),
            )

        self.assertEqual(info["endReason"], "horizon")
        self.assertGreaterEqual(env.data.time, 8.0)
        self.assertLess(maximum_lean, 0.18)
        self.assertGreater(minimum_head_height, 1.45)
        self.assertTrue(env.status()["trainableVestibularBalance"])

    def test_knockout_releases_muscles_until_the_body_settles(self) -> None:
        env = ForgeBoxingEnv(
            seed=22,
            max_seconds=4.0,
            termination_sides=("blue",),
            solo_side="blue",
        )
        policies = {
            "blue": neutral_policy(env, "blue"),
            "red": neutral_policy(env, "red"),
        }
        env.physiology["blue"].knockout = True
        env.physiology["blue"].active_control = 0.04
        info: dict[str, object] = {}
        done = False
        while not done:
            _, _, done, info = env.step(policies)

        self.assertEqual(info["endReason"], "knockout")
        self.assertTrue(info["fallenSides"]["blue"])
        self.assertGreaterEqual(env.fall_seconds["blue"], 0.45)
        self.assertLess(env._body_position("blue_pelvis")[2], 0.34)
        self.assertLess(env._body_position("blue_head")[2], 0.62)

    def test_evolution_strategy_runs_physics_episodes_and_an_evaluation_gate(self) -> None:
        env = ForgeBoxingEnv(seed=13)
        policy = env.create_policy("blue", seed=14)
        tactical_policy = env.create_tactical_policy("blue", seed=16)
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(
                root,
                seed=15,
                population_pairs=1,
            )
            trained, tactical, gate = trainer.train_generation(
                "malik-okoro",
                policy,
                tactical_policy,
            )

            self.assertIsInstance(trained, RecurrentMotorPolicy)
            self.assertIsInstance(tactical, RecurrentTacticalPolicy)
            self.assertEqual(trainer.metrics.generation, 1)
            # Two held-out baseline courses, one mirrored search pair over the
            # generation's shared course, two candidate courses, one showcase.
            self.assertEqual(trainer.metrics.episodes, 7)
            self.assertGreater(trainer.metrics.physics_steps, 0)
            self.assertGreater(len(trainer.latest_replay), 10)
            self.assertEqual(trainer.latest_replay_id, 1)
            self.assertTrue(gate.finite_state)

    def test_evolution_strategy_keeps_signed_signal_and_zeroes_ties(self) -> None:
        np.testing.assert_allclose(
            EvolutionStrategyTrainer._rank_weights([0.0, 0.0, 0.0]),
            0.0,
        )
        weights = EvolutionStrategyTrainer._rank_weights([-2.0, 0.5, 1.0])
        self.assertLess(weights[0], 0.0)
        self.assertGreater(weights[1], 0.0)
        self.assertGreater(weights[2], weights[1])

    def test_footwork_distillation_advances_the_brain_but_not_the_verified_gate(self) -> None:
        env = ForgeBoxingEnv(seed=13)
        policy = env.create_policy("blue", seed=14)
        tactical_policy = env.create_tactical_policy("blue", seed=16)
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(
                root,
                seed=15,
                population_pairs=1,
                athlete_id="malik-okoro",
            )
            trainer.set_pinned_stage("footwork")
            _, _, gate = trainer.train_generation(
                "malik-okoro",
                policy,
                tactical_policy,
            )

            self.assertTrue(gate.learning_advanced)
            self.assertFalse(gate.accepted)
            self.assertTrue(gate.autonomous)
            # The assist exists only inside the demonstration episode; the
            # athlete is always graded on what it does unassisted.
            self.assertEqual(gate.teacher_weight, 0.9)
            self.assertEqual(gate.validation_teacher_weight, 0.0)
            self.assertGreater(gate.commanded_distance, 0.1)
            self.assertEqual(gate.minimum_commanded_distance, 4.0)
            self.assertEqual(trainer.metrics.demonstration_episodes, 1)
            self.assertEqual(trainer.metrics.autonomous_episodes, 7)
            self.assertEqual(trainer.metrics.learning_updates, 1)
            self.assertEqual(trainer.metrics.verified_checkpoints, 0)
            self.assertTrue((Path(root) / "athletes" / "malik-okoro-working.npz").exists())
            self.assertFalse((Path(root) / "athletes" / "malik-okoro.npz").exists())

    def test_self_play_has_no_scripted_motor_support(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")
            self.assertEqual(trainer._motor_teacher_weight(CURRICULUM[6]), 0.0)
            trainer.coach.state.skill_estimates["self_play"] = 1.0
            self.assertEqual(trainer._motor_teacher_weight(CURRICULUM[6]), 0.0)

    def test_projectile_learning_has_no_online_teacher(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")
            trainer.set_pinned_stage("projectile_evasion")
            self.assertEqual(trainer._motor_teacher_weight(CURRICULUM[3]), 0.0)
            trainer.coach.state.skill_estimates["projectile_evasion"] = 1.0
            self.assertEqual(trainer._motor_teacher_weight(CURRICULUM[3]), 0.0)

    def test_the_brain_keeps_full_authority_whatever_the_assist_is_doing(self) -> None:
        """The controller must behave identically assisted and unassisted.

        The motor output used to be multiplied by 1 - 0.95 * assist, so a stage
        with a full assist searched a controller running at 5% authority and
        then graded it at 100%. The athlete was never optimized in the regime it
        was scored in, and a checkpoint that stood 8 s assisted fell in 1.5 s on
        its own.
        """
        env = ForgeBoxingEnv(seed=64)
        policy = env.create_policy("blue", seed=65)
        observation = env.observe("blue")
        command = TacticalCommand(advance=0.8, jab=0.6).as_array()

        policy.reset()
        unassisted = policy.act(observation, command)
        policy.reset()
        repeated = policy.act(observation, command)
        np.testing.assert_allclose(unassisted, repeated, atol=1e-12)

        # The assist only ever adds to the athlete's own targets.
        quiet = ForgeBoxingEnv(seed=64, training_stage="footwork", motor_teacher_weight=0.0)
        loud = ForgeBoxingEnv(seed=64, training_stage="footwork", motor_teacher_weight=0.9)
        action = np.full(env.motor_count_per_athlete, 0.4)
        moving = TacticalCommand(advance=0.9, urgency=0.6)
        quiet._apply_motor_targets("blue", action, moving)
        loud._apply_motor_targets("blue", action, moving)
        self.assertFalse(np.allclose(
            quiet.last_motor_targets["blue"],
            loud.last_motor_targets["blue"],
        ))

    def test_every_stage_is_graded_with_the_assist_switched_off(self) -> None:
        self.assertEqual(
            set(AUTONOMOUS_VALIDATION_STAGES),
            {stage.name for stage in CURRICULUM},
        )
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")
            for stage in CURRICULUM:
                trainer.set_pinned_stage(stage.name)
                # An assist is only ever offered inside a demonstration, and it
                # retreats to nothing as unassisted skill is measured.
                trainer.coach.state.skill_estimates[stage.name] = 0.0
                self.assertLessEqual(
                    trainer._motor_teacher_weight(stage),
                    stage.teacher_weight,
                )
                trainer.coach.state.skill_estimates[stage.name] = 1.0
                self.assertEqual(trainer._motor_teacher_weight(stage), 0.0)

    def test_the_balance_drill_has_no_assist_because_it_has_nothing_to_teach(self) -> None:
        """The scripted teacher emits no balance targets, so an assist there only
        muted the athlete and handed distillation a target of "output nothing"."""
        env = ForgeBoxingEnv(
            seed=66,
            training_stage="balance",
            termination_sides=("blue",),
            solo_side="blue",
            motor_teacher_weight=1.0,
        )
        policies = {side: env.create_policy(side, seed=67) for side in ("blue", "red")}
        for _ in range(40):
            env.step(policies, {"blue": TacticalCommand(), "red": TacticalCommand()})

        np.testing.assert_allclose(env.teacher_actions["blue"], 0.0, atol=1e-12)
        self.assertEqual(CURRICULUM[0].teacher_weight, 0.0)

    def test_distillation_never_clones_a_demonstrator_that_has_fallen(self) -> None:
        env = ForgeBoxingEnv(
            seed=68,
            max_seconds=4.0,
            training_stage="footwork",
            termination_sides=("blue",),
            solo_side="blue",
            motor_teacher_weight=0.9,
        )
        policies = {side: env.create_policy(side, seed=69) for side in ("blue", "red")}
        command = {"blue": TacticalCommand(advance=0.88, urgency=0.68), "red": TacticalCommand()}
        env.step(policies, command, imitation_learning_rate=0.003)
        self.assertTrue(env.upright("blue"))

        root = env.model.joint("blue_root_free").id
        address = int(env.model.jnt_qposadr[root])
        env.data.qpos[address + 2] = 0.12
        env.data.qpos[address + 3:address + 7] = [0.7071, 0.0, 0.7071, 0.0]
        mujoco.mj_forward(env.model, env.data)
        self.assertFalse(env.upright("blue"))

        before = policies["blue"].weights["motor"].copy()
        env.step(policies, command, imitation_learning_rate=0.003)
        np.testing.assert_allclose(policies["blue"].weights["motor"], before, atol=1e-12)

    def test_promotion_is_decided_by_measured_skill_not_a_fixed_reward_number(self) -> None:
        """Absolute reward bars sat above where reward plateaus, so the streak
        reset every generation and a stage could never end."""
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")
            trainer.set_pinned_stage("projectile_evasion")
            stage = trainer.stage
            skilled = EpisodeResult(
                reward=stage.promotion_reward - 40.0,
                upright_seconds=stage.episode_seconds,
                physics_steps=7500,
                commanded_distance=1.0,
                foot_travel=1.0,
                end_reason="horizon",
                projectile_hits=1.0,
                projectile_dodges=3.0,
                projectile_deflections=2.0,
            )

            self.assertTrue(behavior_gate("projectile_evasion", skilled))
            self.assertLess(skilled.reward, stage.promotion_reward)

    def test_a_flat_reward_run_widens_the_search_instead_of_repeating_it(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")
            trainer.motor_optimizer.first["motor"] = np.full((4, 4), 3.0)
            exploration_before = trainer.coach.state.exploration_scale
            for _ in range(40):
                trainer._track_progress(50.0)

            self.assertGreater(trainer.coach.state.exploration_scale, exploration_before)
            self.assertGreater(trainer.coach.state.stagnation_breaks, 0)
            self.assertLess(float(np.max(trainer.motor_optimizer.first["motor"])), 3.0)

    def test_the_search_step_is_normalized_by_population_and_noise(self) -> None:
        optimizer = AdamOptimizer(0.01)
        gradient = {"motor": np.asarray([[2.0, -0.001]])}
        first = optimizer.step(gradient, 0.01)
        for _ in range(30):
            optimizer.step(gradient, 0.01)
        settled = optimizer.step(gradient, 0.01)

        # Adam normalizes per parameter, so a large and a tiny gradient in the
        # same group converge on comparable step sizes. A single fixed scale
        # cannot serve a 148-wide matrix and a 33-element bias at once.
        self.assertAlmostEqual(abs(settled["motor"][0][0]), abs(settled["motor"][0][1]), places=4)
        self.assertTrue(np.all(np.isfinite(first["motor"])))

    def test_projectile_skill_score_requires_real_defensive_progress(self) -> None:
        baseline = EpisodeResult(
            115.0,
            15.0,
            7500,
            0.14,
            0.32,
            projectile_hits=2.0,
            incoming_impulse_ns=5.5,
            projectile_dodges=1.0,
            projectile_deflections=4.0,
        )
        reward_only = EpisodeResult(
            116.0,
            15.0,
            7500,
            0.14,
            0.32,
            projectile_hits=2.0,
            incoming_impulse_ns=5.5,
            projectile_dodges=1.0,
            projectile_deflections=4.0,
        )
        softer_hit = EpisodeResult(
            115.2,
            15.0,
            7500,
            0.14,
            0.32,
            projectile_hits=2.0,
            incoming_impulse_ns=4.5,
            projectile_dodges=1.0,
            projectile_deflections=4.0,
        )

        self.assertEqual(projectile_skill_score(reward_only), projectile_skill_score(baseline))
        self.assertGreater(projectile_skill_score(softer_hit), projectile_skill_score(baseline))

    def test_behavior_gate_allows_incremental_defense_learning_before_promotion(self) -> None:
        baseline = EpisodeResult(
            90.0,
            15.0,
            7500,
            0.1,
            0.2,
            defense_attempts=5.0,
            defense_evades=1.0,
            defense_clean_hits=4.0,
            incoming_impulse_ns=8.0,
        )
        candidate = EpisodeResult(
            92.0,
            15.0,
            7500,
            0.1,
            0.2,
            defense_attempts=5.0,
            defense_evades=2.0,
            defense_clean_hits=3.0,
            incoming_impulse_ns=7.0,
        )

        self.assertTrue(behavior_preserved("scripted_defense", baseline, candidate))
        self.assertFalse(behavior_gate("scripted_defense", candidate))

    def test_adaptive_coach_records_failure_causes_and_changes_the_next_block(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            coach = AdaptiveTrainingCoach(root, "jonah-vale")
            for generation in range(1, 4):
                review = coach.review(
                    stage="footwork",
                    generation=generation,
                    accepted=False,
                    finite_state=True,
                    reward=82.0,
                    promotion_reward=90.0,
                    upright_seconds=11.2,
                    minimum_upright_seconds=10.8,
                    commanded_distance=0.22,
                    minimum_commanded_distance=0.25,
                    foot_travel=0.08,
                    minimum_foot_travel=0.75,
                    end_reason="horizon",
                    projectile_hits=0.0,
                    incoming_impulse_ns=0.0,
                    outgoing_impulse_ns=0.0,
                )

            self.assertEqual(review["focus"], "step_commitment")
            self.assertIn("upright_control", review["keep"])
            self.assertIn("step_commitment", review["change"])
            self.assertLess(coach.state.challenge_scale, 1.0)
            self.assertGreater(coach.state.exploration_scale, 1.0)
            self.assertEqual(len(coach.ledger), 3)
            restored = AdaptiveTrainingCoach(root, "jonah-vale")
            self.assertEqual(restored.state.focus, "step_commitment")
            self.assertEqual(len(restored.ledger), 3)

    def test_llm_advisor_receives_per_ball_mechanics_and_can_focus_the_course(self) -> None:
        class RecordingAdvisor:
            requested = True
            available = True

            def __init__(self) -> None:
                self.reviews: list[dict[str, object]] = []

            def should_consult(self, review_count: int, consecutive_failures: int) -> bool:
                return True

            def advise(
                self,
                stage: str,
                knobs: dict[str, float],
                recent_reviews: list[dict[str, object]],
            ) -> dict[str, object]:
                self.reviews = recent_reviews
                return {
                    "learning_rate_scale": 1.0,
                    "exploration_scale": 1.2,
                    "challenge_scale": 0.8,
                    "focus_parameters": ["observation", "recurrent"],
                    "course_focus": ["left", "late_reaction"],
                    "rationale": "Late left-side reaction measured at 0.48 seconds.",
                }

        advisor = RecordingAdvisor()
        attempt = {
            "outcome": "hit",
            "failure_reason": "late_reaction",
            "incoming_direction": "left",
            "reaction_time_s": 0.48,
            "signed_lateral_displacement_m": 0.03,
            "vertical_displacement_m": -0.12,
            "maximum_head_displacement_m": 0.13,
            "minimum_ball_head_distance_m": 0.07,
            "minimum_head_height_m": 1.42,
            "contact_body": "blue_head_geom",
            "contact_impulse_ns": 2.7,
        }
        with tempfile.TemporaryDirectory() as root:
            coach = AdaptiveTrainingCoach(root, "malik-okoro", advisor=advisor)
            review = coach.review(
                stage="projectile_evasion",
                generation=1,
                accepted=False,
                finite_state=True,
                reward=80.0,
                promotion_reward=112.0,
                upright_seconds=15.0,
                minimum_upright_seconds=11.25,
                commanded_distance=0.2,
                minimum_commanded_distance=0.12,
                foot_travel=0.3,
                minimum_foot_travel=0.2,
                end_reason="horizon",
                projectile_hits=1.0,
                incoming_impulse_ns=2.7,
                outgoing_impulse_ns=0.0,
                projectile_attempts=(attempt,),
                autonomous=True,
            )

            analysis = review["measurements"]["projectileAnalysis"]
            self.assertEqual(analysis["failureCauses"], {"late_reaction": 1})
            self.assertEqual(analysis["meanReactionTimeS"], 0.48)
            forwarded = advisor.reviews[-1]["measurements"]["projectileAttempts"][0]
            self.assertEqual(forwarded["signed_lateral_displacement_m"], 0.03)
            self.assertEqual(forwarded["contact_body"], "blue_head_geom")
            self.assertEqual(coach.state.llm_course_focus, ["left", "late_reaction"])

    def test_assisted_legacy_results_are_not_migrated_as_verified_learning(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state_root = Path(root) / "athlete_training" / "malik-okoro"
            state_root.mkdir(parents=True)
            (state_root / "training-status.json").write_text(json.dumps({
                "trainingVersion": 12,
                "metrics": {
                    "generation": 1100,
                    "episodes": 16841,
                    "checkpoint_reward": 101.6,
                    "accepted_checkpoints": 149,
                    "autonomous_episodes": 1245,
                    "curriculum_index": 3,
                },
            }))
            (state_root / "coach-state.json").write_text(json.dumps({
                "coachVersion": 1,
                "state": {
                    "athlete_id": "malik-okoro",
                    "reviews": 896,
                    "successes": 95,
                    "skill_estimates": {"projectile_evasion": 0.9},
                },
            }))
            (state_root / "experience-ledger.json").write_text(json.dumps({
                "coachVersion": 1,
                "episodes": [{"generation": 1100}],
            }))

            trainer = EvolutionStrategyTrainer(root, athlete_id="malik-okoro")

            self.assertEqual(trainer.metrics.generation, 1100)
            self.assertEqual(trainer.metrics.episodes, 16841)
            self.assertEqual(trainer.metrics.accepted_checkpoints, 0)
            self.assertEqual(trainer.metrics.verified_checkpoints, 0)
            self.assertEqual(trainer.metrics.autonomous_episodes, 0)
            self.assertEqual(trainer.metrics.checkpoint_reward, 0.0)
            self.assertEqual(trainer.coach.state.reviews, 0)
            self.assertEqual(trainer.coach.state.skill_estimates, {})
            self.assertEqual(trainer.coach.ledger, [])

    def test_native_runtime_gives_every_fighter_an_independent_persistent_brain(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            runtime = NativeTrainingRuntime(root, seed=41)
            malik, jonah = DEFAULT_ATHLETES[:2]

            self.assertIsNot(runtime.trainers[malik], runtime.trainers[jonah])
            self.assertNotEqual(
                runtime.trainers[malik].state_root,
                runtime.trainers[jonah].state_root,
            )
            self.assertFalse(np.allclose(
                runtime.policies[malik].weights["observation"],
                runtime.policies[jonah].weights["observation"],
            ))
            for athlete_id in DEFAULT_ATHLETES:
                self.assertTrue(
                    (runtime.checkpoint_root / "athletes" / f"{athlete_id}.npz").exists()
                )
                self.assertTrue(
                    (runtime.checkpoint_root / "athletes" / f"{athlete_id}-tactical.npz").exists()
                )

            runtime.trainers[malik].metrics.generation = 7
            runtime.trainers[malik].metrics.curriculum_index = 5
            runtime.trainers[malik]._save_metrics(malik)
            runtime.trainers[malik].coach.state.focus = "upright_control"
            runtime.trainers[malik].coach.save()
            runtime.set_target(jonah)
            self.assertEqual(runtime.trainer.metrics.generation, 0)
            self.assertEqual(runtime.trainer.coach.state.focus, "establish_baseline")
            runtime.reset_target()
            self.assertEqual(runtime.trainers[malik].metrics.generation, 7)

            runtime.set_target(malik)
            runtime.set_scenario("footwork")
            self.assertEqual(runtime.trainer.stage.name, "footwork")
            self.assertEqual(runtime.trainer.metrics.curriculum_index, 5)
            runtime.set_scenario(None)
            self.assertEqual(runtime.trainer.stage.name, "scripted_defense")
            self.assertEqual(runtime.trainer.metrics.curriculum_index, 5)

            restored = NativeTrainingRuntime(root, seed=41)
            self.assertEqual(restored.trainers[malik].metrics.generation, 7)
            self.assertEqual(restored.trainers[malik].coach.state.focus, "upright_control")
            self.assertEqual(restored.trainers[jonah].metrics.generation, 0)
            status = restored.status()
            self.assertFalse(status["brains"]["weightsShared"])
            self.assertTrue(status["brains"]["independentVision"])
            self.assertEqual(len(status["athleteTraining"]), len(DEFAULT_ATHLETES))

    def test_partial_perception_exposes_motion_but_not_opponent_intent(self) -> None:
        env = ForgeBoxingEnv(seed=27)
        observation = env.tactical_observe("blue")
        env.last_commands["red"] = TacticalCommand(hook=1.0, body_target=1.0)
        env.strike_state["red"] = StrikeState(kind="hook", arm="left", phase=0.4, drive=1.0)

        np.testing.assert_allclose(env.tactical_observe("blue"), observation)
        self.assertEqual(observation.shape, (155,))
        self.assertFalse(env.status()["opponentIntentVisible"])
        self.assertFalse(env.status()["futureTrajectoryVisible"])
        self.assertIn(env.status()["perceptionLatencyMs"]["blue"], (80, 100))

    def test_delayed_shoulder_motion_becomes_a_visible_pre_punch_cue(self) -> None:
        env = ForgeBoxingEnv(seed=28)
        before = env._perceived_body_motion(
            "blue",
            "red",
            "left_upper_arm",
        ).angular_velocity.copy()
        shoulder = env.model.joint("red_left_shoulder_pitch").id
        shoulder_address = int(env.model.jnt_dofadr[shoulder])
        env.data.qvel[shoulder_address] = 3.0
        mujoco.mj_forward(env.model, env.data)

        env._refresh_perception()
        immediate = env._perceived_body_motion(
            "blue",
            "red",
            "left_upper_arm",
        ).angular_velocity.copy()
        for _ in range(env.perception_latency_steps["blue"]):
            env._refresh_perception()
        delayed = env._perceived_body_motion(
            "blue",
            "red",
            "left_upper_arm",
        ).angular_velocity.copy()

        self.assertLess(float(np.linalg.norm(immediate - before)), 0.25)
        self.assertGreater(float(np.linalg.norm(delayed - before)), 2.0)

    def test_recurrent_tactical_brain_owns_commands_and_fast_interrupts(self) -> None:
        env = ForgeBoxingEnv(seed=29)
        tactical = {
            "blue": env.create_tactical_policy("blue", seed=30),
            "red": env.create_tactical_policy("red", seed=31),
        }
        observation = env.tactical_observe("blue")
        first = tactical["blue"].act(observation)
        memory = tactical["blue"].state.threat_memory.copy()
        second = tactical["blue"].act(observation)

        self.assertTrue(np.any(np.abs(memory) > 0.0))
        self.assertFalse(np.allclose(first, second))
        own_head = env._body_position("blue_head")
        motion = env._perceived_body_motion("blue", "red", "left_glove")
        env.perceived_motion["blue"].bodies["red"]["left_glove"] = BodyMotion(
            own_head - np.asarray([0.30, 0.0, 0.0]),
            np.asarray([6.0, 0.0, 0.0]),
            motion.acceleration,
            motion.angular_velocity,
        )
        env.tactical_tick = 1
        commands = env.autonomous_commands(tactical)

        self.assertTrue(env.tactical_interrupt["blue"])
        self.assertGreater(env.tactical_salience["blue"], 0.34)
        self.assertIsInstance(commands["blue"], TacticalCommand)
        self.assertEqual(CURRICULUM[-1].teacher_weight, 0.0)

    def test_supported_self_play_walks_and_lands_physical_strikes(self) -> None:
        env = ForgeBoxingEnv(
            seed=61,
            max_seconds=6.0,
            training_stage="self_play",
            termination_sides=("blue",),
            starting_separation_m=0.68,
            motor_teacher_weight=0.35,
        )
        motor_policies = {
            side: env.create_policy(side, seed=62 + index)
            for index, side in enumerate(("blue", "red"))
        }
        tactical_policies = {
            side: env.create_tactical_policy(side, seed=72 + index)
            for index, side in enumerate(("blue", "red"))
        }
        outgoing_impulse = 0.0
        commanded_movement = 0.0
        info: dict[str, object] = {}
        done = False
        while not done:
            commands = env.autonomous_commands(tactical_policies)
            commanded_movement = max(
                commanded_movement,
                commands["blue"].advance
                + commands["blue"].retreat
                + abs(commands["blue"].circle),
            )
            _, _, done, info = env.step(motor_policies, commands)
            impact = info["impacts"]["blue"]  # type: ignore[index]
            outgoing_impulse += float(
                impact["head_impulse_ns"]
                + impact["body_impulse_ns"]
                + impact["guard_impulse_ns"]
            )

        self.assertEqual(info["endReason"], "horizon")
        self.assertGreater(commanded_movement, 0.20)
        self.assertGreater(outgoing_impulse, 0.50)
        self.assertGreater(env._body_position("blue_head")[2], 1.15)

    def test_gymnasium_boundary_runs_partial_observation_tactical_steps(self) -> None:
        gym_env = ForgeTacticalGymEnv(seed=32, episode_seconds=1.0)
        observation, info = gym_env.reset(seed=33)
        action = np.zeros(12, dtype=np.float32)
        next_observation, reward, terminated, truncated, transition = gym_env.step(action)

        self.assertTrue(gym_env.observation_space.contains(observation))
        self.assertTrue(gym_env.action_space.contains(action))
        self.assertTrue(gym_env.observation_space.contains(next_observation))
        self.assertTrue(np.isfinite(reward))
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        self.assertFalse(info["opponentIntentVisible"])
        self.assertIn("perceivedThreat", transition)
        gym_env.close()


if __name__ == "__main__":
    unittest.main()
