# Realism baseline

Forge League now has two deterministic, testable simulation lanes: the v7 articulated 2D league used by the live page and a native MuJoCo 3D training foundation. Neither is a validated human digital twin, medical injury model, or substitute for motion-capture and force-plate calibration.

## Native 3D rigid-body foundation

Each native athlete has a free six-axis pelvis and 33 powered joints: bilateral toes, ankle pitch/roll, knees, three-axis hips, lumbar yaw/pitch/roll, neck yaw/pitch, three-axis shoulders, elbows, forearm rotation, and wrist pitch/yaw. Height and reach scale their articulated geometry; weight scales segment mass and inertia; physical and reaction stats scale actuator capacity, conditioning, and perception delay. Shoes collide with the floor using frictional contact; gloves collide with the opponent's articulated head and trunk. Per-foot forces are MuJoCo touch-sensor outputs from resolved contacts rather than estimated values.

The native control hierarchy is deliberately rate-separated:

1. Between-round strategy remains the only language-model boundary.
2. Tactical commands run at 10–20 Hz.
3. A 96-unit recurrent tactical policy consumes 155 delayed, noisy visual features plus recurrent threat and survival-instinct memory at 16.7 Hz, with learned interrupts at 50 Hz. A 64-unit recurrent motor policy consumes 148 observations and emits 33 continuous motor targets at 50 Hz.
4. MuJoCo integrates rigid bodies, constraints, contact, friction, and actuator force at 500 Hz.

The motor learner uses symmetric evolution-strategy rollouts rather than scripted punch animation. It evaluates perturbed recurrent weights in complete physics episodes, estimates a reward gradient, and accepts a candidate only when state remains finite, upright time clears the current curriculum gate, and reward does not regress. A frozen opponent pool supplies self-play. Domain randomization varies segment mass and floor friction. Joint torque × angular velocity creates local fatigue, reduces available actuator force, and feeds slow conditioning adaptation.

The seven implemented curriculum stages are balance, footwork, moving strikes, projectile evasion, impact recovery, scripted defense, and self-play. The native service persists separate compressed motor and tactical checkpoints plus coach history for every athlete and exposes joint/body pose frames for an independent renderer.

## Calibrated quantities

- Straight-punch velocity and effective mass are centered around published Olympic-boxer measurements. Walilko et al. reported mean hand velocity of 9.14 m/s, effective punch mass of 2.9 kg, and mean punch force of 3,427 N. [Biomechanics of the head for Olympic boxer punches to the face](https://pmc.ncbi.nlm.nih.gov/articles/PMC1725037/)
- The model allows lower contact velocities for less explosive or fatigued athletes. A motion-capture study of the lead straight reported elite contact velocity around 5.56 m/s and emphasized lower-limb contribution and effective-mass transfer. [Biomechanics of the lead straight punch of different level boxers](https://pmc.ncbi.nlm.nih.gov/articles/PMC9798280/)
- Force-platform measurements reported the greatest force transfer for crosses, with cross ground-reaction force around 948 N and rate of force development around 3,973 N/s in the measured cohort. The v6 rear-foot drive and RFD bounds are calibrated toward that order of magnitude, not fitted to an individual athlete. [Kinetic and electromyographic analysis of boxing punches](https://pmc.ncbi.nlm.nih.gov/articles/PMC12729554/)
- Lead-straight testing found a strong relationship between rear-leg force and punch velocity, supporting the model's rear-drive contribution to hand speed and effective mass. [Biomechanics of the lead straight punch of different level boxers](https://pmc.ncbi.nlm.nih.gov/articles/PMC9798280/)
- Elite-boxer testing describes force initiation at the lower limb and transfer through the knee and trunk, with the front leg contributing to braking and momentum transfer. [Knee strength in elite and amateur boxers](https://pmc.ncbi.nlm.nih.gov/articles/PMC9399400/)
- Hooks receive a higher rotational-transfer factor than straight punches. Published Olympic-boxer measurements found the hook produced the greatest hand-velocity change and punch force of the tested punches. [Comparison with boxing head impacts](https://pubmed.ncbi.nlm.nih.gov/16331164/)
- Round scoring follows the World Boxing priority order: scoring blows, technical/tactical superiority, then competitiveness. A scoring blow must connect cleanly to a legal target with body or shoulder weight behind it. [World Boxing Competition Rules](https://worldboxing.org/wp-content/uploads/2025/09/World-Boxing-Competition-Rules-Nov-2024-Approved-4.pdf)

## Deterministic fight model

1. A policy receives only delayed and quantized observable state.
2. Footwork actions generate body-local propulsive and lateral ground force. Fighter mass integrates that force into x/y acceleration while drag, speed capacity, radial body separation, and four-sided ring boundaries constrain motion.
3. Each stance tracks lead and rear foot displacement, knee flexion, center-of-mass height, hip rotation, shoulder rotation, per-foot vertical ground force, combined horizontal ground force, and resultant vertical RFD.
4. A punch stores its planar direction and vertical aim from a delayed opponent snapshot, then advances through a timed glove trajectory.
5. Advances and retreats alter range; circling and pivots alter angle; slips and weaves move the head laterally; ducks lower the head target after a punch has committed.
6. Punch drive shifts force through the rear and lead legs, then sequences hip and shoulder rotation. Measured ground drive and sequence efficiency scale hand speed and effective mass.
7. Contact occurs only when an active outgoing three-dimensional glove segment sweeps through the current head, body, or guard geometry inside that attacker's measured physical reach.
8. Effective mass and closing velocity produce impulse and kinetic energy (`½mv²`).
9. Guard geometry absorbs a deterministic fraction based on defensive skill, target, and fatigue. A fighter caught mid-punch keeps only what his own shot leaves in place — most of a guard survives a jab, none survives an uppercut — scaled down through the punch's committed window, so timing a counter into a committed shot is worth real transmitted energy.
10. Transmitted energy changes head trauma, body trauma, stamina, balance, and knockdown state.
11. Three sealed judge cards score each round from measured events.

There is no live hit chance, damage roll, judge roll, or winner roll.

## Agent training loop

The simulator exposes a public reinforcement-learning boundary:

1. Observe a delayed and quantized 28-feature state plus an 18-action legality mask. Recent head impact, body impact, sustained pressure, and how open the opponent's current punch leaves him provide learnable context without exposing the opponent's hidden command.
2. Submit an action only when the current movement or punch has completed.
3. Advance the deterministic environment by one 100 ms physics step.
4. Receive dense reward from clean blows, transferred energy, defense, condition, and knockdowns, followed by a terminal win/loss reward.
5. Reset into complete sparring episodes against persistent opponents from both corners.
6. Evaluate bounded policy mutations and retain only a higher-reward checkpoint.

A durable Cloudflare worker runs one cycle immediately, stores the full league and telemetry checkpoint in D1, and is scheduled to claim another cycle every minute while the job remains active. The page polls that checkpoint but is not the training process, so closing it does not stop the worker. A compare-and-claim status prevents two worker invocations from training the same checkpoint simultaneously. Target changes apply between cycles, and pause requests preserve the latest accepted checkpoint.

The only exploratory signal is policy mutation between episodes. Once an episode starts, its action, collision, reward, score, and result sequence is deterministic.

## Physical conditioning adaptation

Completed training cycles accumulate force-integrated physics workload and slowly adapt four bounded attributes: lower-body power, lower-body endurance, kinetic-chain coordination, and shoulder endurance. Those attributes feed movement force, fatigue cost, joint transfer, hand speed, and effective mass. Gains diminish as an athlete approaches the model ceiling. These are gameplay abstractions, not biological tissue, recovery, overtraining, nutrition, or medical models.

## Recurrent neural athlete architecture

Every fighter owns a distinct hierarchical recurrent neural policy:

1. Twenty-seven delayed and quantized observations combine with the previous recurrent state to activate a 16-unit `tanh` hidden layer.
2. Hidden activity and the previous state update eight learned working-memory units. That state persists across decisions and decays, rather than disappearing, at the bell.
3. Hidden and memory activity select among pressure, counter, body-work, outside, recovery, and evasive tactical intents.
4. Hidden activity, working memory, tactical intent, direct observation pathways, a bounded round-plan bias, recent-impact survival signals, and the legal-action mask produce scores for 17 boxing actions, including bidirectional circling and pivots plus slips, ducks, and weaves. Tired or hurt fighters can learn to cover, retreat, circle away, or recover instead of continuing a blind exchange.
5. The highest-scoring legal action becomes the fighter's live decision and enters the physics engine.
6. Neuroevolution updates the observation, recurrent-memory, intent, and action layers together from measured sparring reward.

The neural network runs the athlete. Deterministic algorithms remain responsible for ring boundaries, collision resolution, energy transfer, judging, and training evaluation—not for selecting a scripted winner or combo sequence.

## Opponent modeling and round planning

- Career bouts produce persistent opponent dossiers from measured action rates, preferred range, guard and evasion use, pressure, and transferred-energy danger. Training episodes do not alter career dossiers.
- A deterministic planner compares the completed round's clean blows, impact energy, condition, stamina, and observed tendencies before issuing a bounded next-round focus, pace, risk, target, and ring-mode directive.
- When configured, a slower OpenAI strategy layer receives that same limited context during the corner break and returns a strict structured directive. It has no interface for individual actions, collisions, damage, judging, or results.
- A strategy directive adds at most a small bounded bias to action scores. Physics legality and the recurrent policy can override it on every decision.

## Known limitations and next calibration work

- The live site bout is still the articulated 2D simulation. The native 3D service is a separate training and replay backend until a production compute host and a full 3D renderer are connected.
- The MuJoCo athlete is a constrained multibody skeleton with segment mass, contact, and joint actuation, but it does not yet model individual muscles, tendons, ligaments, soft tissue, skin, glove deformation, or inverse-dynamics-fitted human torque curves.
- Hooks use a calibrated rotational multiplier rather than explicit transverse head rotation.
- The live 2D guard remains a geometric plane. The 3D guard uses articulated forearms and gloves, but its dimensions and compliance still need calibration.
- Trauma values are gameplay-normalized and must not be interpreted clinically.
- Live 2D ground force and RFD remain estimated. Native 3D ground force comes from the contact solver, but neither lane has been fitted to synchronized force-plate and motion-capture data for these fictional athletes.
- Conditioning adapts from simulated workload without explicit rest, supercompensation, injury, or detraining. A serious longitudinal conditioning model still needs those mechanisms.
- Stance switching, clinching, referee commands, fouls, cuts, and recovery counts need dedicated models.
- Working memory is a compact learned recurrent state, not human autobiographical memory or general reasoning.
- Opponent dossiers summarize measured bout tendencies; they do not yet learn opponent-specific latent embeddings or predict full sequences.
- The optional language layer is a slow strategy adviser, not an LLM controlling the body. Better evaluation is needed before expanding its authority or context window.
- The next fidelity milestone is synchronized motion-capture and dual-force-plate calibration of the existing 3D joint trajectories, segment parameters, friction, and contact forces, followed by OpenSim comparison and batch training through MJX or MuJoCo Warp.
