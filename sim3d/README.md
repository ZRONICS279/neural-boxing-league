# Forge native 3D simulator

This service is the native rigid-body lane behind Forge League's live 2D broadcast. It runs two free-standing MuJoCo athletes, exposes replay poses and telemetry, and trains persistent recurrent tactical and motor policies independently of the browser.

## What is implemented

- Two 39-DOF athletes: six free-root DOF plus 33 powered joints per athlete.
- Toes, ankles, knees, three-axis hips, lumbar spine, neck, shoulders, elbows, forearm rotation, wrists, and gloves.
- Per-athlete height, mass, reach, speed, power, cardio, defense, and reaction profiles scale segment geometry, inertia, actuator capacity, conditioning, and perception latency. Joint limits, shoe-floor friction, precise glove/head/body/guard collision, foot contact sensors, and head inertial sensors remain fully physical.
- MuJoCo at 500 Hz, recurrent continuous motor control at 50 Hz, a recurrent tactical policy at 16.7 Hz, and learned defensive interrupts at 50 Hz.
- The tactical policy chooses all 12 movement, posture, guard, target, and strike commands. Its 96-unit threat memory carries combinations, feints, and recent motion across decisions, while a separate recurrent survival memory learns how fatigue, guard damage, equilibrium loss, recent impacts, sustained pressure, close range, ropes, and live threat should change its response.
- Tactical perception contains delayed, noisy opponent glove, upper-arm, head, chest, hip, and foot kinematics. It never receives the opponent's selected command, intended target, strike state, or future trajectory.
- Fatigue-limited active muscle control, joint-local torque/work fatigue, whole-body stamina, recovery, and bounded conditioning adaptation.
- A trainable vestibular ankle reflex gives balance learning a viable standing foundation; deterministic lateral and forward shoves test corrective control.
- A trainable contact-aware gait basis alternates stance and swing legs. Joint-space residuals and foot-placement IK drive the hips, knees, ankles, and toes against the floor; no external pelvis propulsion is applied.
- Ground-up punch torque through the ankle, hip, lumbar spine, and shoulder with live Jacobian head/body targeting.
- Normal-relative contact speed, effective striking mass, glancing angle, ground-reaction transfer, active strike phase, exact collider contact, and the attacker's measured physical reach resolve each impact. Passive glove contact and out-of-reach overlaps cannot score a punch.
- Guard stability and equilibrium degrade from physical impulse; a knockout releases active control and ends only after the body falls and settles.
- Four physical padded reflex balls can be launched from changing angles. The recurrent brain receives only delayed, noisy visual position, bearing, apparent size, and visibility. It receives no velocity vector, approach direction, target, or time-to-contact, so it must infer motion from successive observations. MuJoCo contacts deliver real impulse to the articulated body.
- Balance, footwork, moving-strike, projectile-evasion, impact-recovery, scripted-defense, and self-play curricula with consecutive-pass promotion gates. Footwork starts at one rope and cannot pass until the athlete travels at least 4.0 m toward the opposite rope, produces at least 4.5 m of physical foot travel, reaches the goal, and stays upright for at least 90% of the 28-second horizon. Scripted defense separately counts completed attacks, evasions, blocks, clean hits, clean incoming impulse, and guard impulse so a successful block is never diagnosed as damage.
- **Every stage is graded with the scripted assist switched off.** The assist exists only inside a separate demonstration episode that distills joint targets into the recurrent motor policy, and it anneals to zero as unassisted skill is measured. The athlete's own controller always runs at full authority, so the policy that is searched is the policy that is scored. Frames after a demonstrator loses its posture are never cloned. Incremental autonomous improvements save a working brain; only autonomous task completion can replace the verified checkpoint or enter the opponent pool.
- The search is a mirrored-sampling evolution strategy: every population member in a generation runs the same course (common random numbers), advantages are shaped by signed rank so one lucky episode cannot dominate the step, the estimate is normalized by population and noise scale, and Adam applies it per parameter. Baseline and candidate are compared on a fixed held-out course bank so a reward change means a policy change rather than a different task. The step is applied every generation — an evolution strategy is a stochastic gradient method, and gating each step on a noisy single-episode comparison turns it into a random walk.
- Promotion is decided by measured skill — the stage's behaviour gate, upright time, travel, and surviving the horizon — not by an absolute reward number. A reward bar above where reward plateaus resets the streak every generation and a stage never ends.
- A flat reward run is detected and answered by widening the search and dropping stale gradient history, instead of repeating a block that has stopped producing progress.
- Every athlete owns separate motor weights, tactical weights, curriculum progress, recurrent-learning history, replay stream, evaluation results, and a persistent experience ledger. Selecting another fighter switches the entire training identity rather than renaming one shared learner.
- A per-athlete adaptive coach reviews every generation's reward, upright time, ring progress, foot travel, fall state, and incoming/outgoing impulse. For every reflex ball it also records direction, height, reaction time, signed forward/lateral/vertical head motion, minimum head height, closest ball-to-head distance, exact contacted geometry and point, impulse, and a measured failure cause. The optional LLM advisor receives that bounded ledger, focuses the next neural-weight search and course sampling on measured weaknesses, and cannot directly control the athlete.
- A Gymnasium tactical boundary and `sb3-contrib` recurrent-PPO entry point support longer batched tactical training. Self-play supplies zero scripted live decisions; the preceding defense curriculum fades from coaching toward autonomy.
- A persistent HTTP worker with start, pause, target-switch, status, and pose-replay endpoints.

MuJoCo's official Python package includes the engine runtime. MJX or MuJoCo Warp can later batch the same MJCF model for high-throughput training; they are deliberately optional in this first native service. See the official [Python bindings](https://mujoco.readthedocs.io/en/stable/python.html) and [MJX guide](https://mujoco.readthedocs.io/en/latest/mjx.html).

## Install and verify

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r sim3d/requirements.txt
npm run test:physics
```

## Run locally

```bash
npm run sim3d:serve
```

The service listens on `127.0.0.1:8788`. Put these values in `.env.local` so the web worker can reach it:

```dotenv
SIM3D_SERVICE_URL=http://127.0.0.1:8788
SIM3D_SERVICE_TOKEN=
```

Use `npm run sim3d:train` to start continuous training immediately. Closing the site does not stop that process. Checkpoints are stored under `sim3d/checkpoints/` by default.

Each fighter's two neural checkpoints live under `sim3d/checkpoints/athletes/`. Its curriculum metrics, coach state, and bounded experience ledger live under `sim3d/checkpoints/athlete_training/<athlete-id>/`. The frozen opponent league remains shared so independently trained athletes can encounter a growing population instead of overfitting to one rival.

For the recurrent-PPO tactical trainer, install the optional training dependencies and launch a run:

```bash
.venv/bin/python -m pip install -r sim3d/requirements-ppo.txt
npm run sim3d:ppo -- --athlete malik-okoro --timesteps 250000
```

This path trains the 12-command tactical brain through the same MuJoCo world and saves its checkpoint under `sim3d/checkpoints/ppo/`. The persistent service currently uses its built-in evolution-strategy learner; PPO is an explicit high-throughput training path, not an LLM call inside the fight loop.

The learning loop is in the same family as simulated robot training: observe, act through joints, advance rigid-body contacts, measure the outcome, update the policy, and repeat. It is not yet NVIDIA-scale GPU-parallel robotics training. Reaching that throughput requires batching this MJCF world with MJX or MuJoCo Warp and moving the motor learner to vectorized recurrent PPO.

## Run persistently

Build the included container from the repository root and attach a persistent volume at `/data`:

```bash
docker build -f sim3d/Dockerfile -t forge-sim3d .
docker run --restart unless-stopped -p 8788:8788 -v forge-checkpoints:/data -e FORGE_SIM_TOKEN=change-me forge-sim3d
```

Place TLS in front of that service, then configure the hosted site with its HTTPS `SIM3D_SERVICE_URL` and the same `SIM3D_SERVICE_TOKEN`. The browser never receives the token.

## HTTP boundary

- `GET /health`
- `GET /v1/status`
- `GET /v1/replay?frames=120`
- `POST /v1/control` with `start`, `pause`, `target`, or `reset`

This is a real articulated rigid-body and learned-motor foundation, but it is not yet a motion-capture-calibrated human digital twin. The current segment parameters are plausible engineering values that still require synchronized motion capture, dual force plates, and expert review.

## Known defect: the scripted footwork gait cannot walk

`_locomotion_guidance` topples forward in about two seconds and this blocks the
footwork stage. Measured with the learner silenced completely (every motor
weight zero), so the fall is the scripted gait's own:

| assist | upright | travel | outcome |
| --- | --- | --- | --- |
| 1.0 | 1.96 s | 1.43 m | fall |
| 0.8 | 1.90 s | 1.46 m | fall |
| 0.6 | 1.90 s | 1.44 m | fall |
| 0.4 | 1.92 s | 1.37 m | fall |

The centre of mass runs ahead of the support polygon monotonically — 0.03 m at
0.24 s to 0.49 m at 1.92 s, with both feet off the floor by then. The swing foot
is never placed far enough forward to catch it. Sweeping `cadence_base` across
0.48–1.9 Hz and `step_base` across 0.13–0.30 m does not recover it, so this is a
controller defect in the swing-leg placement and propulsion phase rather than a
tuning value.

Consequences while this stands: footwork cannot be promoted, so the stages
behind it are unreachable by auto-rotation, and the demonstration episode has no
competent walk to distill. Balance is unaffected and trains normally. Pin a
stage from the viewer to work on the later drills directly.
