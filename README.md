# Forge League

Forge League is a deterministic autonomous boxing environment. Every athlete owns a persistent recurrent neural policy, observes delayed ring state, remembers recent exchanges, forms tactical intent, chooses embodied actions, and learns from physics-bound sparring experience. The site provides a fast articulated 2D league, while `sim3d/` adds a native two-athlete MuJoCo world with 39 physical degrees of freedom per boxer. The rendered boxer is a view of physical state; it does not decide the motion.

## What makes the fighters AI athletes

- Each boxer has a distinct `27 → 16 ↔ 8 → 6 → 17` recurrent brain: 27 observations, 16 hidden units, 8 learned working-memory units, 6 tactical intents, and 17 legal actions. The observation now includes recent head impact, body impact, and sustained pressure, so hurt or exhausted athletes can learn to cover, retreat, circle out, and recover.
- The neural forward pass chooses every live action. Hand-authored code supplies only the physical world, legal-action mask, and initial boxing priors.
- Each athlete's neural weights, opponent dossiers, training generation, fitness, conditioning, and evaluated episodes persist as that athlete's learned experience.
- Training mutates the observation, recurrent-memory, intent, and action layers, tests complete sparring episodes, and keeps only a higher-reward brain checkpoint.
- Between rounds, a measured corner planner studies the previous round and persistent opponent dossier. An optional server-side OpenAI strategy layer can revise that bounded round directive, but it cannot select punches, damage, scores, or winners.
- A scheduled simulation worker stores the whole league checkpoint in D1 and continues bounded training cycles after the page closes. The training target can be changed without resetting any athlete.
- A separate native worker runs a 96-unit recurrent tactical brain above a 64-unit recurrent motor brain. The tactical brain observes 155 delayed, noisy perceptual features plus a recurrent nine-feature survival-instinct head and chooses all 12 live commands; the motor brain maps 148 physical observations plus those commands into 33 continuous joint targets. Both checkpoint independently and can keep training after the browser closes.
- The native worker also isolates each fighter's entire learning identity: two brain checkpoints, curriculum generation, evaluation gates, replay, and an adaptive coach ledger. A target switch never transfers one athlete's progress into another.

The neural athlete decides what to do; the deterministic simulator decides what physically happens after that decision.

## Run locally

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and set `OPENAI_API_KEY` to enable the optional language strategy layer. The key remains server-side. The recurrent fighters and deterministic between-round planner work without it.

The same key can give the ringside announcer a spoken voice. The call is recorded with each fight and, with `ANNOUNCER_VOICE` in `app/feature-flags.ts` switched on, rendered to clips ahead of the bell by the league tick (`OPENAI_VOICE_MODEL` and `OPENAI_VOICE` pick the speech model and voice), then served under the same aired-chunk gate as the fight itself. The flag ships off: nothing is rendered, stored or fetched, and the call is captions only.

To run the native 3D lane:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r sim3d/requirements.txt
npm run sim3d:serve
```

Then set `SIM3D_SERVICE_URL=http://127.0.0.1:8788` in `.env.local`. See [sim3d/README.md](./sim3d/README.md) for persistent container deployment and the secured site bridge.

## The betting book

`chain/` is a self-contained foundry project holding the on-chain half: an order book
per bout, a view companion, and a parimutuel parlay card. It is live on Robinhood
testnet against that chain's USDC — addresses and the full design are in
[chain/FIGHT_MARKET.md](./chain/FIGHT_MARKET.md), and the `FIGHT_*` keys in
`.env.example` are what wires the site to it. Leave them unset and the league runs
exactly as before, with the market panel saying so.

## Verify

```bash
npm test
npm run test:physics
npm run chain:test
```

The native suite loads the real MuJoCo engine, steps both articulated athletes, verifies contact-derived foot forces and deterministic state, exercises recurrent memory/checkpoint round trips, and runs a complete motor-learning generation through its evaluation gate.

## What decides a bout

- Fighters move across a 6.1 m × 6.1 m ring plane. Body-local propulsive and lateral ground force accelerates the center of mass; drag, balance, radial body separation, and four-sided rope limits constrain it.
- The action space includes advancing, retreating, circling both ways, pivoting both ways, slipping, ducking, weaving, guarding, recovering, and six head/body punches.
- Punches have wind-up, extension, contact, and retraction phases.
- Contact requires the three-dimensional swept glove trajectory to intersect the opponent's current head, body, or guard geometry while the target remains inside that athlete's measured arm reach. Footwork changes the angle; ducking changes head height; slips and weaves change lateral head position.
- Feet shift load, knees flex, and the hips lead the shoulders through the strike. Per-foot vertical ground force, combined propulsive/lateral force, rate of force development, and kinetic-chain efficiency influence hand speed and effective punch mass.
- Transferred energy comes from hand speed, closing body velocity, effective punch mass, ground drive, guard absorption, fatigue, and balance.
- The same state and policies always produce the same collision, damage, judge cards, and winner.
- Three deterministic judges use clean scoring blows first, then impact quality, defense, and ring control.

## How training works

Training is an explicit agent–environment loop:

1. `observeTrainingEnvironment` returns the delayed 27-feature ring observation, including recent impact and pressure memory, the athlete's recurrent working state, and the legal-action mask.
2. The athlete's neural brain updates eight learned memory units, forms one of six tactical intents, and chooses one of 17 boxing actions.
3. `stepTrainingEnvironment` advances the same collision, fatigue, balance, and judging physics used by the live bout by 100 ms.
4. The transition returns a reward from clean blows, transferred energy, defense, condition, knockdowns, and the official result.
5. Candidate policies repeat complete sparring episodes from both corners. Only a higher-reward checkpoint is retained.

The training lab can run one cycle, five cycles, or continuously until stopped. One cycle runs immediately and a server schedule claims the next durable cycle every minute. Each cycle evaluates three policy candidates against two persistent league opponents from both corners. Mutation explores policies between episodes; it never alters physics or scoring inside an episode. Every completed cycle checkpoints learned policies, dossiers, conditioning workload, fitness, and telemetry in D1.

The training-athlete selector remains active while the worker runs. A switch is stored immediately and takes effect at the next cycle boundary, so the current checkpoint is never discarded.

`stepBoutWithActions` also exposes both corners in the same physics step, so two external AI agents can observe the world, submit separate actions, and inhabit the two rendered bodies.

The optional `/api/strategy` endpoint uses the OpenAI Responses API with a strict JSON schema. Its output is normalized into a small pace/risk/target/ring-mode bias and applied only during the corner break. The recurrent motor policy remains the sole live decision-maker.

Conditioning adaptation is a bounded gameplay model: lower-body power, lower-body endurance, kinetic-chain coordination, and shoulder endurance respond gradually to simulated workload. It is not a medical, exercise-prescription, or human physiological model.

## Native 3D training lane

The native service keeps the same hierarchy but separates its rates and responsibilities:

1. The OpenAI or measured planner may revise strategy only between rounds.
2. A 96-unit recurrent tactical policy chooses all 12 movement, posture, guard, target, and punch commands at 16.7 Hz. Learned visual-threat and survival-instinct heads can revise defense at 50 Hz when perceived motion becomes threatening or fatigue, damaged guard, lost equilibrium, recent impacts, sustained pressure, and rope position demand an immediate escape response.
3. The tactical observation contains delayed, noisy glove, upper-arm, head, chest, hip, and foot position, velocity, acceleration, and angular velocity. It can learn shoulder-loading cues, combinations, and feints, but receives no opponent command, intended target, strike state, exact time-to-impact, or future trajectory.
4. Each athlete's recurrent neural motor controller maps 148 proprioceptive, delayed opponent-relative, contact, fatigue, physiological, inertial, and incoming-projectile observations to 33 continuous joint targets at 50 Hz.
5. MuJoCo integrates the free pelvis, every articulated segment, fatigue-limited active muscle actuator, floor contact, friction, and precise glove collision at 500 Hz. Each athlete's body is constructed from their own height, mass, reach, speed, force, cardio, defense, and reaction profile rather than one shared body template.
6. A lower-level Jacobian strike guide turns tactical punch intent into a perceived head/body target while the recurrent policy still controls balance and every joint. Ground reaction, hip/shoulder rotation, closing speed, effective striking mass, contact angle, active punch phase, and the attacker's physical reach determine whether and how the impact resolves.
7. Stamina limits force and speed, repeated guard impacts erode block stability, and head/body impulse erodes equilibrium. A knockout releases active muscle control, but the episode waits for the body to physically fall and settle.
8. Balance starts from a trainable vestibular ankle reflex, then locomotion adds a contact-aware stance/swing gait basis and foot-placement IK. The recurrent motor brain learns residual hip, knee, ankle, and toe corrections while every translation still comes from shoe-floor force. Straight posture, two-foot loading, center-of-mass support, and upright time all participate in checkpoint selection.
9. Training rewards balance, facing, locomotion, clean collision impulse, defense, and energy economy. Symmetric evolution strategies estimate learning directions for motor and tactical policies from complete physics episodes; a Gymnasium wrapper also supports recurrent PPO.
10. Every fighter owns separate motor and tactical weights, curriculum counters, replay, evaluation history, and coach state. Everyone begins with the same viable architecture and boxing priors but receives distinct initialized weights and learns only from that fighter's episodes.
11. After every generation, the selected fighter's adaptive coach records measured successes and failure causes. It preserves working skills, focuses the next parameter search on the largest weakness, reduces challenge after repeated failure, increases exploration when stuck, and raises challenge after consolidation.
12. Balance unlocks footwork directly, followed by moving punches, projectile evasion, impact recovery, scripted defense, and self-play. Footwork promotion requires commanded distance, physical foot travel, and 90% upright time, so motionless standing cannot pass. Projectile courses expose only delayed, noisy observed ball motion: no destination or future path is supplied. Misses reward learned evasion, while physical hits train impact recovery.
13. Scripted defense blends coaching with learned decisions. Self-play removes the coaching entirely, so both tactical brains choose every command while both motor brains control their bodies. Frozen two-brain opponent checkpoints create a growing range of learned styles and skill levels.
14. Joint mechanical work creates local fatigue and slowly updates the conditioning profile after training blocks.

The native service exposes bounded status, control, and replay-pose endpoints through `/api/sim3d`. The hosted web worker cannot execute MuJoCo itself, so an always-on CPU/GPU host is required for actual 24/7 3D training.

See [REALISM.md](./REALISM.md) for calibration data, modeled constraints, and known limitations.
