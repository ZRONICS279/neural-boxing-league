"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BOXING_MODEL,
  Fighter,
  actionPreferencesOf,
} from "./fight-model";
import {
  useLeagueSync,
  useSim3dStatus,
} from "./league-store";
import {
  ACTION_LABELS,
  SiteFooter,
  SiteHeader,
  Ticker,
  getFighter,
  heightLabel,
  recordLabel,
  statLabel,
} from "./site-chrome";
import { Native3dViewer } from "./native-3d-viewer";
import { SHOW_NATIVE_TRAINING } from "./feature-flags";
import {
  TRAINING_CYCLE_INTERVAL_MS,
  TRAINING_TURNS_PER_ATHLETE_PER_DAY,
} from "./training-config";
import { TrainingGymFeed } from "./training-gym-feed";
import { useMusic } from "./sound";

function FairnessRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fairness-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** The two ways an athlete gets better, on one page.
 *
 * Track one is league sparring: a durable worker runs episodes of the same 2D
 * bout the ring page shows and keeps the policies that score better. Track two
 * is the native MuJoCo lab, where the same athlete learns to control a 39-DOF
 * body before any of that reaches the ring. */
export function TrainingLab() {
  const {
    league,
    trainingLoop,
    trainingTargetId,
    notice,
  } = useLeagueSync();
  const { sim3d } = useSim3dStatus();
  const [now, setNow] = useState(0);

  // The gym has music on the whole time it is open — there are no rounds to
  // stay out of the way of here, only drills. Same mute flag as the broadcast;
  // the toggle sits on the gym cam.
  useMusic("gym", true);

  const isTraining =
    trainingLoop.status === "running" || trainingLoop.status === "working";
  const trainingTarget = getFighter(league.roster, trainingTargetId);
  const rotationIndex = Math.max(
    0,
    league.roster.findIndex((fighter) => fighter.id === trainingTarget.id),
  );
  const rotationWindow = Array.from(
    { length: Math.min(6, league.roster.length) },
    (_, offset) => league.roster[(rotationIndex + offset) % league.roster.length],
  );
  const nextCycleAt = trainingLoop.updatedAt + TRAINING_CYCLE_INTERVAL_MS;
  const secondsUntilNextCycle = trainingLoop.updatedAt
    ? Math.max(0, Math.ceil((nextCycleAt - now) / 1000))
    : 0;
  const nextCycleLabel = trainingLoop.status === "working"
    ? "running now"
    : `${Math.floor(secondsUntilNextCycle / 60)}:${String(secondsUntilNextCycle % 60).padStart(2, "0")}`;
  const nativeTarget = getFighter(league.roster, sim3d.targetId ?? trainingTarget.id);
  const preferences = useMemo(
    () => actionPreferencesOf(trainingTarget),
    [trainingTarget],
  );
  const nativeAnthropometrics = sim3d.physics.anthropometrics?.blue ?? {
    athleteId: nativeTarget.id,
    heightM: nativeTarget.height * 0.0254,
    reachM: nativeTarget.reach * 0.0254,
    massKg: nativeTarget.weight * 0.453592,
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="page">
      <SiteHeader
        calendar={league}
        active="/training"
        status={{
          label: isTraining ? "Training live" : "Reconnecting",
          detail: `${TRAINING_TURNS_PER_ATHLETE_PER_DAY} turns per athlete daily`,
        }}
        action={
          <Link className="button button--amber topbar__action" href="/play">
            <span>PVM</span>
            <span aria-hidden="true">→</span>
          </Link>
        }
      />

      <main className="page__body">
        {/* <section className="orientation" aria-label="What this page does">
          <div className="orientation__lede">
            <span className="eyebrow">Training lab</span>
            <h1>The whole roster keeps learning.</h1>
            <p>
              The league trains one athlete at a time, around the clock. Whatever he improves
              here, he takes into his next fight on the <Link href="/ring">ring page</Link>.
            </p>
          </div>
          <div className="lab-target">
            <div className="training-now">
              <span>Current rotation</span>
              <strong>{trainingTarget.firstName} {trainingTarget.lastName}</strong>
              <small>
                Athlete {rotationIndex + 1} of {league.roster.length} · {trainingTarget.weightClass}
              </small>
            </div>
            <dl className="lab-target__facts">
              <div><dt>Record</dt><dd>{recordLabel(trainingTarget)}</dd></div>
              <div><dt>Rating</dt><dd>{Math.round(trainingTarget.rating)}</dd></div>
              <div><dt>Build</dt><dd>{heightLabel(trainingTarget.height)} · {trainingTarget.weight} lb</dd></div>
              <div><dt>Episodes</dt><dd>{trainingTarget.policy.evaluatedBouts.toLocaleString()}</dd></div>
            </dl>
            <div className="stat-grid">
              {(Object.entries(trainingTarget.stats) as [keyof Fighter["stats"], number][]).map(([stat, value]) => (
                <div className="compact-stat" key={stat}>
                  <span>{statLabel(stat)}</span>
                  <strong>{Math.round(value)}</strong>
                  <i><b style={{ width: `${value}%` }} /></i>
                </div>
              ))}
            </div>
          </div>
        </section> */}

        <section className="track" id="sparring" aria-label="League sparring training">
          {/* <div className="section-heading"> */}
            {/* <div> */}
              {/* {SHOW_NATIVE_TRAINING ? <span className="eyebrow">Track 01 · standard training</span> : null} */}
              {/* <strong>League sparring</strong> */}
            {/* </div> */}
            {/* <span className={`loop-state loop-state--${trainingLoop.status}`}>{trainingLoop.status}</span> */}
          {/* </div> */}
          {/* <p className="track__lede">
            Every four minutes, the gym puts another athlete through sparring in the same 2D
            bout the ring page shows, keeps a change only if it made him better, then hands
            the turn to the next boxer.
          </p> */}

          <TrainingGymFeed
            trainee={trainingTarget}
            roster={league.roster}
            isTraining={isTraining}
            cycles={trainingLoop.cycles}
            checkpoints={trainingLoop.checkpoints}
            rewardGain={trainingLoop.rewardGain}
          />

          {/* One row of numbers across the top, then two panels of six rows each
              so the columns end level with nothing left hanging under either. */}
          <div className="track__body">
            <div className="training-loop-readout" aria-live="polite">
              <div><span>Target</span><strong>{trainingTarget.lastName}</strong></div>
              <div><span>Loop cycles</span><strong>{trainingLoop.cycles}</strong></div>
              <div><span>Physics steps</span><strong>{trainingLoop.physicsSteps.toLocaleString()}</strong></div>
              <div><span>Sparring episodes</span><strong>{trainingLoop.bouts.toLocaleString()}</strong></div>
              <div><span>Policies tested</span><strong>{trainingLoop.candidates.toLocaleString()}</strong></div>
              <div><span>Checkpoints kept</span><strong>{trainingLoop.checkpoints}</strong></div>
              <div><span>Reward fitness</span><strong>{trainingLoop.currentFitness.toFixed(1)}</strong></div>
              <div><span>Session gain</span><strong>{trainingLoop.rewardGain >= 0 ? "+" : ""}{trainingLoop.rewardGain.toFixed(1)}</strong></div>
            </div>

            <div className="policy-bars" aria-label={`${trainingTarget.lastName} learned action preferences`}>
              <div className="policy-bars__head">
                <span>What the policy reaches for</span>
              </div>
              {preferences.slice(0, 6).map(({ action, value }, index) => (
                <div className="policy-bar" key={action}>
                  <span>{String(index + 1).padStart(2, "0")} {ACTION_LABELS[action]}</span>
                  <i><b style={{ width: `${Math.min(100, value * 4.4)}%` }} /></i>
                  <strong>{value}%</strong>
                </div>
              ))}
            </div>

            <div className="rotation-board" aria-label="Upcoming autonomous training rotation">
              <div className="rotation-board__head" aria-live="polite">
                <span>Up next</span>
                <span>Next turn <strong>{nextCycleLabel}</strong></span>
              </div>
              <ol>
                {rotationWindow.map((fighter, index) => (
                  <li className={index === 0 ? "rotation-board__active" : ""} key={fighter.id}>
                    <span>{index === 0 ? "Now" : `+${index}`}</span>
                    <strong>{fighter.firstName} {fighter.lastName}</strong>
                    <small>G{fighter.policy.generation} · {fighter.trainingBouts.toLocaleString()} episodes</small>
                  </li>
                ))}
              </ol>
            </div>

          
          </div>
        </section>

        {SHOW_NATIVE_TRAINING ? (
          <section className="track" id="physics-lab" aria-label="Native 3D physics training">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Track 02 · 3D training</span>
              <strong>Native physics lab</strong>
            </div>
            <span className={`loop-state loop-state--${sim3d.status}`}>
              {sim3d.available ? sim3d.status : "not connected"}
            </span>
          </div>
          <p className="track__lede">
            A separate MuJoCo worker where the athlete inhabits a free-standing 39-DOF body and
            has to learn balance, footwork, and striking from contact forces alone. The browser
            is the control room and replay viewer; the physics and training stay native.
          </p>

          <Native3dViewer
            available={sim3d.available}
            status={sim3d.status}
            targetName={nativeTarget.lastName}
            curriculum={sim3d.curriculum?.name ?? "balance"}
            episodeSeconds={sim3d.curriculum?.episode_seconds ?? 8}
            generation={sim3d.training?.generation ?? 0}
            episodes={sim3d.training?.episodes ?? 0}
            coachFocus={sim3d.coach?.focus ?? "establish_baseline"}
            evaluationGate={sim3d.lastEvaluationGate ?? null}
          />

          <div className="physics-stack">
            <div className="physics-stack__pipeline" aria-label="Hierarchical three-dimensional control rates">
              <span><small>Strategy</small><strong>Between rounds</strong></span>
              <i>→</i>
              <span><small>Tactics</small><strong>10–20 Hz</strong></span>
              <i>→</i>
              <span><small>Neural motor</small><strong>{sim3d.physics.motorHz} Hz</strong></span>
              <i>→</i>
              <span><small>Rigid body</small><strong>{sim3d.physics.physicsHz} Hz</strong></span>
            </div>
            <div className="physics-stack__readout">
              <div><span>Athlete skeleton</span><strong>{`${sim3d.physics.degreesOfFreedomPerAthlete} DOF`}</strong><small>{`${nativeAnthropometrics.heightM.toFixed(2)} m · ${nativeAnthropometrics.massKg.toFixed(1)} kg · ${nativeAnthropometrics.reachM.toFixed(2)} m reach`}</small></div>
              <div><span>Contact solver</span><strong>Active glove / head / guard</strong><small>{sim3d.physics.reachValidatedContacts ? "Measured reach gate · normal impulse · glancing angle" : "Normal impulse, glancing angle, and ground force"}</small></div>
              <div><span>Curriculum</span><strong>{sim3d.curriculum?.name.replaceAll("_", " ") ?? "7-stage ready"}</strong><small>Balance → walking → moving punches → projectile defense → self-play</small></div>
              <div><span>Evaluation</span><strong>{sim3d.training?.accepted_checkpoints ?? 0} kept</strong><small>{sim3d.training?.episodes ?? 0} native episodes</small></div>
              <div><span>Engine</span><strong>{sim3d.physics.engine ?? "MuJoCo 3.8"}</strong><small>MJX / Warp scale-out compatible</small></div>
              <div><span>Training target</span><strong>{nativeTarget.lastName}</strong><small>{sim3d.physics.trainableSurvivalInstinct ? "Trainable visual threat + survival instinct" : "Inherited from the selector above"}</small></div>
            </div>
            <small className="physics-stack__note">
              {sim3d.available
                ? `${sim3d.training?.physics_steps.toLocaleString() ?? "0"} native physics steps · ${sim3d.physics.replayFrames ?? 0} replay frames ready`
                : "The 3D engine and tests are in this project. Configure SIM3D_SERVICE_URL on the deployment after placing the native worker on persistent CPU/GPU compute."}
            </small>
          </div>
          </section>
        ) : null}

        {/* <section className="track" aria-label="How fights are decided">
          <div className="section-heading">
            <div>
              <strong>How fights are decided</strong>
            </div>
          </div>
          <p className="track__lede">
            Sparring runs on the same physics as the live ring. Nothing in a result is random.
          </p>
          <div className="fairness-grid">
            <FairnessRow label="Randomness in results" value="None" />
            <FairnessRow label="Who decides" value="The athlete's own brain" />
            <FairnessRow label="Coaching" value="Between rounds only" />
            <FairnessRow label="What a fighter sees" value="Delayed, like real reactions" />
            {SHOW_NATIVE_TRAINING ? (
              <>
                <FairnessRow label="Native body" value="39-DOF 3D" />
                <FairnessRow label="Active ragdoll" value="Fatigue-limited muscles" />
                <FairnessRow label="Strike aiming" value="Jacobian IK at 50 Hz" />
              </>
            ) : null}
            <FairnessRow label={`${trainingTarget.lastName}'s reaction time`} value={`${Math.round(Math.max(150, 400 - trainingTarget.stats.reaction * 2.35))} ms`} />
            <FairnessRow label="Judges" value="3 scorecards" />
            <FairnessRow label="Physics rate" value={`${Math.round(1 / BOXING_MODEL.physicsStepSeconds)} Hz`} />
          </div>
        </section> */}
      </main>
      <SiteFooter />

      <Ticker
        notice={isTraining ? `${trainingTarget.lastName} is in the gym now.` : notice}
        meta={`${league.roster.length} athletes · ${TRAINING_TURNS_PER_ATHLETE_PER_DAY} training turns each per day`}
      />
    </div>
  );
}
