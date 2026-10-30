"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type BoutFighter,
  type BoutState,
  type Fighter,
  formatImpactZone,
  xpForNextLevel,
} from "./fight-model";
import {
  ACTION_LABELS,
  INTENT_LABELS,
  Meter,
  formatClock,
  heightLabel,
  recordLabel,
  statLabel,
} from "./site-chrome";
import { FightCanvas } from "./fight-canvas";
import { isMuted, useSound } from "./sound";
import { type VoiceSource, useAnnouncer } from "./announcer-caption";
import { primeSpeech, silenceSpeech } from "./announcer-speech";
import { ANNOUNCER_VOICE } from "./feature-flags";

/** One bout on air, drawn.
 *
 * Lifted out of the league page whole rather than copied, because there are two
 * places a fight is watched now — the league's stage, which follows the card,
 * and a single fight's own page, which follows one bout and nothing else — and
 * a second copy of the scoreboard is how two screens end up disagreeing about a
 * round. The replay itself is not here: both callers get their `BoutState` from
 * the same broadcast store, so this only ever draws what it is handed. */

/* Impact, in the units a fight broadcast actually uses.
 *
 * The model works in newtons and metres per second because that is what the
 * physics is written in, but neither reads as anything to somebody watching a
 * fight. Both of these are exact conversions of measured quantities — no
 * energy-to-speed sleight of hand, which cannot be done at all without knowing
 * the mass behind each individual punch. */
export function poundsForce(newtons: number) {
  return (newtons / 4.44822).toFixed(0);
}

export function kilometresPerHour(metresPerSecond: number) {
  return (metresPerSecond * 3.6).toFixed(0);
}

/* ------------------------------------------------------------------ scoreboard */

function CornerScore({
  fighter,
  runtime,
  corner,
}: {
  fighter: Fighter;
  runtime: BoutFighter;
  corner: "blue" | "red";
}) {
  const missed = Math.max(0, runtime.thrown - runtime.landed - runtime.blocked);
  const cleanRate = runtime.thrown
    ? Math.round((runtime.landed / runtime.thrown) * 100)
    : 0;
  return (
    <div className={`corner-score corner-score--${corner}`}>
      <div className="corner-score__identity">
        <span>{corner} corner</span>
        <strong>{fighter.firstName} {fighter.lastName}</strong>
        <small>{fighter.nickname} · {fighter.stance} · L{fighter.level}</small>
      </div>
      <div className="corner-score__meters">
        <Meter label="Condition" value={runtime.health} tone={corner} />
        <Meter label="Stamina" value={runtime.stamina} tone="amber" />
      </div>
      <div className="corner-score__numbers">
        <span><strong>{runtime.landed}/{missed}/{runtime.thrown}</strong> land/miss/thrown</span>
        <span><strong>{cleanRate}%</strong> accuracy · {runtime.blocked} blocked</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ confidence rail */

const CONFIDENCE_SAMPLES = 40;
const CONFIDENCE_SAMPLE_MS = 240;

/** A short rolling history of how sure each brain has been.
 *
 * The bout advances far faster than a viewer can read, so the trend is sampled
 * on its own clock instead of on every physics step. */
function useConfidenceTrend(bout: BoutState | null) {
  const [trend, setTrend] = useState<{ boutId: number; left: number[]; right: number[] }>({
    boutId: -1,
    left: [],
    right: [],
  });
  const boutRef = useRef(bout);

  useEffect(() => {
    boutRef.current = bout;
  }, [bout]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = boutRef.current;
      if (!current) return;
      setTrend((history) => {
        const carried =
          history.boutId === current.id ? history : { left: [], right: [] };
        return {
          boutId: current.id,
          left: [...carried.left, current.left.decisionConfidence].slice(-CONFIDENCE_SAMPLES),
          right: [...carried.right, current.right.decisionConfidence].slice(-CONFIDENCE_SAMPLES),
        };
      });
    }, CONFIDENCE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, []);

  return trend.boutId === bout?.id ? trend : { boutId: -1, left: [], right: [] };
}

function ConfidenceTrend({ samples, corner }: { samples: number[]; corner: "blue" | "red" }) {
  if (samples.length < 2) {
    return <div className="confidence-trend confidence-trend--empty" aria-hidden="true" />;
  }
  const step = 100 / (samples.length - 1);
  const points = samples
    .map((value, index) => {
      const height = Math.max(0, Math.min(100, value));
      return `${(index * step).toFixed(2)},${(28 - (height / 100) * 26).toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      className={`confidence-trend confidence-trend--${corner}`}
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
}

function ConfidenceCorner({
  fighter,
  runtime,
  corner,
  samples,
}: {
  fighter: Fighter;
  runtime: BoutFighter;
  corner: "blue" | "red";
  samples: number[];
}) {
  const previous = samples.length > 4 ? samples[samples.length - 5] : runtime.decisionConfidence;
  const drift = runtime.decisionConfidence - previous;
  const direction = drift > 2 ? "rising" : drift < -2 ? "falling" : "steady";
  return (
    <div className={`confidence-corner confidence-corner--${corner}`}>
      <div className="confidence-corner__head">
        <span>{fighter.lastName}</span>
        <strong>{runtime.decisionConfidence.toFixed(0)}<em>%</em></strong>
        <i className={`confidence-drift confidence-drift--${direction}`}>
          {direction === "rising" ? "▲" : direction === "falling" ? "▼" : "—"} {direction}
        </i>
      </div>
      <ConfidenceTrend samples={samples} corner={corner} />
      <dl className="confidence-corner__facts">
        <div><dt>Doing</dt><dd>{ACTION_LABELS[runtime.action]}</dd></div>
        <div><dt>Plan</dt><dd>{INTENT_LABELS[runtime.tacticalIntent]}</dd></div>
        <div><dt>Decisions</dt><dd>{runtime.decisionCount.toLocaleString()}</dd></div>
        <div><dt>Brain load</dt><dd>{runtime.brainActivity.toFixed(0)}%</dd></div>
      </dl>
    </div>
  );
}

/** How sure each fighter is, right now.
 *
 * Confidence is the margin the recurrent policy gave the action it just chose,
 * so a fighter who is being figured out visibly loses conviction before the
 * scorecards or the health bars show anything. */
function ConfidenceRail({
  bout,
  blue,
  red,
}: {
  bout: BoutState;
  blue: Fighter;
  red: Fighter;
}) {
  const trend = useConfidenceTrend(bout);
  const leftConfidence = bout.left.decisionConfidence;
  const rightConfidence = bout.right.decisionConfidence;
  const total = leftConfidence + rightConfidence;
  const share = total > 0 ? (leftConfidence / total) * 100 : 50;

  return (
    <aside className="rail rail--confidence" aria-label="Live fighter confidence">
      <div className="rail__head">
        <strong>How sure each fighter is</strong>
        <small>
          {bout.breakTime > 0
            ? "Between rounds. The corners are setting the next plan"
            : "How confident each brain is in what it just chose"}
        </small>
      </div>
      <div
        className="confidence-split"
        role="img"
        aria-label={`${blue.lastName} ${leftConfidence.toFixed(0)} percent confident, ${red.lastName} ${rightConfidence.toFixed(0)} percent confident`}
      >
        <span className="confidence-split__fill confidence-split__fill--blue" style={{ width: `${share}%` }} />
        <span className="confidence-split__fill confidence-split__fill--red" style={{ width: `${100 - share}%` }} />
        <em className="confidence-split__marker" style={{ left: `${share}%` }} />
      </div>
      <ConfidenceCorner fighter={blue} runtime={bout.left} corner="blue" samples={trend.left} />
      <ConfidenceCorner fighter={red} runtime={bout.right} corner="red" samples={trend.right} />
    </aside>
  );
}

/* ----------------------------------------------------------------- stats rail */

function LiveFighterFile({
  fighter,
  runtime,
  corner,
}: {
  fighter: Fighter;
  runtime: BoutFighter;
  corner: "blue" | "red";
}) {
  const missed = Math.max(0, runtime.thrown - runtime.landed - runtime.blocked);
  const cleanRate = runtime.thrown
    ? Math.round((runtime.landed / runtime.thrown) * 100)
    : 0;
  const nextLevel = xpForNextLevel(fighter.level);
  return (
    <article className={`live-file live-file--${corner}`}>
      <header>
        <div>
          <span>{corner} corner</span>
          <strong>{fighter.lastName}</strong>
        </div>
        <b>{Math.round(fighter.rating)}<small>rating</small></b>
      </header>
      <div className="live-file__level">
        <span>Level {fighter.level}</span>
        <i><b style={{ width: `${Math.min(100, (fighter.xp / nextLevel) * 100)}%` }} /></i>
        <small>{fighter.xp}/{nextLevel} xp</small>
      </div>
      {/* Paired short readings first, then the three whose labels are too long
          to sit beside a value in a 300px rail — those take a row each rather
          than being clipped. */}
      <dl className="live-file__live">
        <div><dt>Balance</dt><dd>{Math.round(runtime.balance * 100)}%</dd></div>
        <div><dt>Accuracy</dt><dd>{cleanRate}%</dd></div>
        <div><dt>Knockdowns</dt><dd>{runtime.knockdowns}</dd></div>
        <div><dt>Peak impact</dt><dd>{poundsForce(runtime.peakForceN)} lbf</dd></div>
        <div className="live-file__live--wide"><dt>Land/miss/thrown</dt><dd>{runtime.landed}/{missed}/{runtime.thrown}</dd></div>
        {/* The peak, not the instantaneous reading. A hand is only moving while
            a punch is actually out, so the live value is 0 on most frames and
            the row read as broken rather than as telemetry. */}
        <div className="live-file__live--wide"><dt>Peak hand speed</dt><dd>{kilometresPerHour(runtime.peakHandSpeed)} km/h</dd></div>
        <div className="live-file__live--wide"><dt>Last contact</dt><dd>{runtime.lastStrikeKind === "none" ? "—" : formatImpactZone(runtime.lastImpactZone)}</dd></div>
      </dl>
      <div className="live-file__ratings">
        {(Object.entries(fighter.stats) as [keyof Fighter["stats"], number][]).map(([stat, value]) => (
          <span key={stat}><small>{statLabel(stat)}</small><strong>{Math.round(value)}</strong></span>
        ))}
      </div>
      <footer>
        <span>{recordLabel(fighter)} ({fighter.record.knockouts} KO) · {fighter.archetype}</span>
        <span>{heightLabel(fighter.height)} · {fighter.weight} lb · {fighter.reach}&quot; reach</span>
      </footer>
    </article>
  );
}

function StatsRail({
  bout,
  blue,
  red,
}: {
  bout: BoutState;
  blue: Fighter;
  red: Fighter;
}) {
  return (
    <aside className="rail rail--stats" aria-label="Live fighter stats">
      <div className="rail__head">
        <strong>Fighter stats</strong>
        <small>Both athletes as they came into this fight</small>
      </div>
      <LiveFighterFile fighter={blue} runtime={bout.left} corner="blue" />
      <LiveFighterFile fighter={red} runtime={bout.right} corner="red" />
    </aside>
  );
}

/* ---------------------------------------------------------------- the stage */

/** The scoreboard, the ring, the rails and the round-by-round feed.
 *
 * `verdict` is whatever the caller wants standing between the scoreboard and
 * the ring once the fight is over — the league page counts down to the next
 * bout there, a single fight's page has nothing to count down to — because that
 * is the one part of a finished fight that is about the page and not the bout. */
/** The speaker, drawn rather than typed.
 *
 * An emoji here renders as whatever the reader's OS ships — colour on a Mac,
 * flat on Windows, something else again on Android — which is three different
 * buttons for the same control. Both states share one solid cone so only the
 * mark beside it changes when you press it. */
export function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 22 20" width="15" height="14" aria-hidden="true" focusable="false">
      <path
        d="M11.6 2.6a1 1 0 0 0-1.7-.7L5.6 6.2H3.9A1.5 1.5 0 0 0 2.4 7.7v4.6a1.5 1.5 0 0 0 1.5 1.5h1.7l4.3 4.3a1 1 0 0 0 1.7-.7z"
        fill="currentColor"
      />
      {muted ? (
        <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M15 7.4l4.6 5.2" />
          <path d="M19.6 7.4L15 12.6" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none">
          <path d="M14.7 7.1a4.4 4.4 0 0 1 0 5.8" />
          <path d="M17.5 4.7a8 8 0 0 1 0 10.6" />
        </g>
      )}
    </svg>
  );
}

/* The scoreboard right above the picture already names both men and carries
 * their bars, and at phone width the canvas's own nameplates said the same
 * thing again in glyphs too small to read. Below the breakpoint the board
 * folds at, the picture keeps only the clock — a live query rather than a
 * one-time read, so a rotated tablet gets the plates back without a reload. */
const PHONE_STAGE = "(max-width: 640px)";

function subscribeToPhoneStage(onChange: () => void) {
  const query = window.matchMedia(PHONE_STAGE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePhoneStage() {
  return useSyncExternalStore(
    subscribeToPhoneStage,
    () => window.matchMedia(PHONE_STAGE).matches,
    () => false,
  );
}

export function FightStage({
  bout,
  frames,
  blue,
  red,
  verdict,
  market,
  winnerName,
  playbackRate = 1,
  voice,
  panels = true,
}: {
  bout: BoutState;
  /** Every frame of the fight, for the canvas. Everything else on the stage is
   *  drawn from `bout`, which the store publishes at a readable rate rather
   *  than at the rate the fight actually runs. */
  frames?: { current: BoutState | null };
  blue: Fighter;
  red: Fighter;
  verdict?: React.ReactNode;
  /** The live book. It goes inside the body rather than under it so it lands
   *  directly beneath the ring at either stage size — under the rails it read
   *  as a footnote to the fight instead of part of it. */
  market?: React.ReactNode;
  /** For the screen-reader announcement of a stoppage the canvas draws. */
  winnerName: string | null;
  /** A rewatch running above 1x passes its rate through so the canvas knows to
   *  keep the punch sounds out of the fast-forward. */
  playbackRate?: number;
  /** The ringside call as the server recorded it, from whichever player is
   *  feeding `bout` — see `VoiceSource`. Absent, the stage calls the fight
   *  itself off the frames and nothing is spoken. */
  voice?: VoiceSource;
  /** The two rails and the round-by-round feed. All three are live reads — what
   *  a brain is thinking right now, what the men came in at, what just landed —
   *  and they are the reason to sit on a fight that is happening. A rewatch is
   *  not that: the result is known before it starts, so the picture and the book
   *  are the whole page and the panels come off. */
  panels?: boolean;
}) {
  const sound = useSound();
  const phone = usePhoneStage();
  // The ringside voice, gated the way the punch sounds are: true speed only —
  // a 4× broadcast or a fast-forwarded rewatch would turn the calls into a
  // drumroll of stale sentences.
  const caption = useAnnouncer(bout, blue, red, playbackRate === 1 && bout.speed === 1, voice);
  // No music anywhere inside a bout, corner breaks included. A track that
  // starts at the bell and is pulled off sixty seconds later made each round
  // feel like an interruption of the song rather than the other way round.

  return (
    <>
      <div className="scoreboard">
        <CornerScore fighter={blue} runtime={bout.left} corner="blue" />
        <div
          className="round-clock"
          aria-label={bout.breakTime > 0 ? `Corner planning before round ${bout.round}` : `Round ${bout.round}, ${formatClock(bout.roundTime)} remaining`}
        >
          <span>{bout.breakTime > 0 ? "Corner" : "Round"}</span>
          <strong>{bout.round}<small>/{bout.totalRounds}</small></strong>
          <time>{bout.breakTime > 0 ? "Instructions" : formatClock(bout.roundTime)}</time>
        </div>
        <CornerScore fighter={red} runtime={bout.right} corner="red" />
      </div>

      {verdict}

      <div className="broadcast__body">
        {panels ? <ConfidenceRail bout={bout} blue={blue} red={red} /> : null}

        <section className="ring-shell" aria-label="Live bout renderer">
          <div className="ring ring--canvas">
            <FightCanvas
              bout={bout}
              frames={frames}
              left={blue}
              right={red}
              playbackRate={playbackRate}
              hud={phone ? "clock" : "full"}
            />
            {/* The result is drawn IN the canvas. This is the announcement for
                anyone who cannot see it. */}
            {bout.finish ? (
              <span className="sr-only" role="status">
                {bout.finish === "KO" ? "Knockout" : bout.finish}.{" "}
                {winnerName ? `${winnerName} wins` : "Draw"}
              </span>
            ) : null}
          </div>

          {/* Sound lives in the corner of the ring rather than up in the page
              chrome, because what it governs is this picture: the bell, every
              clean punch, and the music that fills the gaps between rounds and
              fights. Off until asked, and the asking is also the gesture the
              browser wants before it will let the page play anything. */}
          <button
            className="ring-sound"
            type="button"
            onClick={() => {
              sound.toggle();
              // The announcer's element takes its permission on the same gesture
              // as the audio elements'; muting cuts a sentence off mid-word.
              if (!ANNOUNCER_VOICE) return;
              if (isMuted()) silenceSpeech();
              else primeSpeech();
            }}
            aria-pressed={!sound.muted}
            title={
              sound.muted
                ? ANNOUNCER_VOICE
                  ? "The bell, the punches, the announcer and the house music"
                  : "The bell, the punches and the house music"
                : "Silence the broadcast"
            }
          >
            <SpeakerIcon muted={sound.muted} />
            <span className="sr-only">{sound.muted ? "Turn sound on" : "Turn sound off"}</span>
          </button>

          {/* The lower third. Not a live region: the event feed below already
              tells a screen reader the story, and a voice that interrupts
              every few seconds is exactly what aria-live would make of this. */}
          {caption ? (
            <div
              className={[
                "ring-announcer",
                `ring-announcer--${caption.register}`,
                caption.corner ? `ring-announcer--${caption.corner}` : "",
                caption.leaving ? "ring-announcer--leaving" : "",
              ].filter(Boolean).join(" ")}
            >
              <span>Ringside</span>
              <strong>{caption.text}</strong>
            </div>
          ) : null}

          <div className="physics-readout" aria-label="Live physics telemetry">
            <span><small>Blue ground force</small><strong>{bout.left.body.rearGroundForceN.toFixed(0)} / {bout.left.body.leadGroundForceN.toFixed(0)} N</strong></span>
            <span><small>Blue hip → shoulder</small><strong>{bout.left.body.hipRotation.toFixed(0)}° → {bout.left.body.shoulderRotation.toFixed(0)}°</strong></span>
            <span>
              <small>Peak contact</small>
              <strong>
                {poundsForce(Math.max(bout.left.peakForceN, bout.right.peakForceN))} lbf
                {" · "}
                {kilometresPerHour(Math.max(bout.left.peakHandSpeed, bout.right.peakHandSpeed))} km/h
              </strong>
            </span>
            <span><small>Red hip → shoulder</small><strong>{bout.right.body.hipRotation.toFixed(0)}° → {bout.right.body.shoulderRotation.toFixed(0)}°</strong></span>
            <span><small>Red ground force</small><strong>{bout.right.body.rearGroundForceN.toFixed(0)} / {bout.right.body.leadGroundForceN.toFixed(0)} N</strong></span>
          </div>
          {bout.breakTime > 0 ? (
            <div className="corner-instructions-flash" role="status" aria-live="polite">
              <span>Corner</span>
              <strong>AI coaching for round {bout.round}</strong>
            </div>
          ) : null}
        </section>

        {market}

        {panels ? <StatsRail bout={bout} blue={blue} red={red} /> : null}
      </div>

      {/* A <details> like the card rail, open by default and pinned to one
          height whether it holds three events or three hundred: a panel that
          grows as the fight goes on shifts everything below it out from under
          whatever you were reading. */}
      {panels ? (
        <details className="fight-feed" aria-label="Bout event feed" open>
          <summary>
            <div><strong>What just happened</strong></div>
            <span>
              {bout.left.landed + bout.right.landed}/
              {Math.max(
                0,
                bout.left.thrown + bout.right.thrown -
                  bout.left.landed - bout.right.landed -
                  bout.left.blocked - bout.right.blocked,
              )}/
              {bout.left.thrown + bout.right.thrown} land/miss/thrown ·{" "}
              {/* Stays in joules on purpose. This is every clean shot of the
                  fight added up — total work done, not one punch — and peak
                  forces cannot be summed into a pounds figure that means
                  anything. */}
              {(bout.left.cleanImpactJ + bout.right.cleanImpactJ).toFixed(0)} J delivered
            </span>
          </summary>
          <ol>
            {[...bout.events].reverse().map((event) => (
              <li key={event.id} className={`fight-event fight-event--${event.tone}`}>
                <time>{event.time}</time><span>{event.text}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

/** The tale of the tape after the final bell, shared by both stages. */
export function BoutTale({ bout, blue, red }: { bout: BoutState; blue: Fighter; red: Fighter }) {
  return (
    <dl className="bout-final__tale">
      <div>
        <dt>{blue.lastName}</dt>
        <dd>
          {bout.left.landed}/
          {Math.max(0, bout.left.thrown - bout.left.landed - bout.left.blocked)}/
          {bout.left.thrown}
        </dd>
      </div>
      <div>
        <dt>{red.lastName}</dt>
        <dd>
          {bout.right.landed}/
          {Math.max(0, bout.right.thrown - bout.right.landed - bout.right.blocked)}/
          {bout.right.thrown}
        </dd>
      </div>
      <div>
        <dt>Peak</dt>
        <dd>
          {poundsForce(Math.max(bout.left.peakForceN, bout.right.peakForceN))} lbf
          {" · "}
          {kilometresPerHour(Math.max(bout.left.peakHandSpeed, bout.right.peakHandSpeed))} km/h
        </dd>
      </div>
    </dl>
  );
}
