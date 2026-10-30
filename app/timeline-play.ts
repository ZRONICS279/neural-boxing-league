/** Plays a fight back from served chunks instead of running the engine.
 *
 * The player owns fetching: it walks the chunk index forward as the league
 * clock airs them, backs off politely when the next one has not aired yet, and
 * never lets a slow response take the picture down — playback holds the last
 * loaded frame until coverage catches up. `boutAt` then dresses a decoded
 * frame up as the `BoutState` the canvas and the stage have always drawn, with
 * every field the renderer reads coming from the timeline and everything it
 * ignores set to a quiet default. The engine fields that used to fill those —
 * working memory, sensory history, combo plans — no longer exist on this side
 * of the wire, which is the point. */
import {
  ACTIONS,
  type BoutFighter,
  type BoutState,
  type FighterAction,
  type RoundMetrics,
  type TacticalIntent,
} from "./fight-model.ts";
import type { StrategyDirective } from "./strategy.ts";
import {
  TIMELINE_CHUNK_TICKS,
  cardsUpTo,
  decodeTimeline,
  feedUpTo,
  frameAt,
  type FightTimeline,
  type TimelineFighterFrame,
  type TimelineVoiceLine,
} from "./fight-timeline.ts";

/** How long to sit on a not-aired 404 before asking for the same chunk again.
 *  The next chunk airs every five seconds; hammering the route buys nothing. */
const RETRY_MS = 1500;
/** How quickly a FAILED request is retried. A radio blip fails in
 *  milliseconds, and the buffered runway is only seconds deep — sitting out
 *  the full courtesy interval spent most of the runway standing still.
 *  Doubles per consecutive failure until it reaches the courtesy interval. */
const RETRY_ERROR_MS = 350;
/** How long a request may hang before it is abandoned and retried. Phones
 *  strand sockets when the network changes under them, and a hung request
 *  used to hold the only fetch slot until the OS gave up on it — half a
 *  minute of frozen picture. Three seconds moves a few kilobytes on any
 *  connection that is alive at all. */
const FETCH_TIMEOUT_MS = 3000;

export interface TimelinePlayer {
  boutId: number;
  /** Kicks the fetch loop toward `targetTick`. `airedTick` is where the bell
   *  clock actually is — read-ahead waits for it, so the player only asks for
   *  chunks the server can already serve. Cheap to call every frame. */
  ensure(targetTick: number, airedTick: number): void;
  /** The bout as it stood at `tick`, clamped to what has loaded. */
  boutAt(tick: number): BoutState | null;
  /** The ringside call across every loaded chunk, in order. Null until a
   *  chunk that carries one has landed — which, for a fight recorded before
   *  the call was written down with it, is never: the stage's own engine
   *  calls those the way it always did. */
  voice(): TimelineVoiceLine[] | null;
  /** Abandons the fetch loop; a stopped player never touches the network. */
  stop(): void;
}

export function createTimelinePlayer(boutId: number): TimelinePlayer {
  const chunks = new Map<number, FightTimeline>();
  let finalIndex: number | null = null;
  let voiceLines: TimelineVoiceLine[] | null = null;
  let stopped = false;
  /** Requests on the wire, by chunk index — the playhead's chunk and its
   *  read-ahead load side by side, so a tab rejoining from the background
   *  rebuilds its whole runway in one round trip instead of two. */
  const inFlight = new Map<number, AbortController>();
  /** Chunks that last answered badly, and when to ask again. A chunk that has
   *  not aired waits the courtesy interval; a failure only a beat. */
  const misses = new Map<number, { until: number; streak: number }>();

  const missed = (index: number, notAired: boolean) => {
    const streak = (misses.get(index)?.streak ?? 0) + 1;
    const wait = notAired
      ? RETRY_MS
      : Math.min(RETRY_MS, RETRY_ERROR_MS * 2 ** (streak - 1));
    misses.set(index, { until: Date.now() + wait, streak });
  };

  const request = (index: number) => {
    const abort = new AbortController();
    inFlight.set(index, abort);
    const deadline = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    void fetch(`/api/timeline?bout=${boutId}&chunk=${index}`, {
      cache: "force-cache",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (stopped) return;
        if (!response.ok) {
          missed(index, response.status === 404);
          return;
        }
        const decoded = decodeTimeline(await response.text());
        chunks.set(index, decoded);
        misses.delete(index);
        // Chunks land out of order — the read-ahead runs beside the playhead's
        // own — so the call is kept sorted rather than appended.
        if (decoded.voice) {
          const known = new Set((voiceLines ?? []).map((line) => line.line));
          voiceLines = [...(voiceLines ?? []), ...decoded.voice.filter((line) => !known.has(line.line))]
            .sort((a, b) => a.tick - b.tick || a.line - b.line);
        }
        // Only the closing chunk carries a verdict; its arrival is how the
        // player learns where the fight ends.
        if (decoded.result.finish !== null) finalIndex = index;
      })
      .catch(() => {
        if (!stopped) missed(index, false);
      })
      .finally(() => {
        clearTimeout(deadline);
        inFlight.delete(index);
      });
  };

  const ensure = (targetTick: number, airedTick: number) => {
    if (stopped) return;
    // Chunks stand alone, so a viewer joining in round three fetches the chunk
    // the clock is IN and lands at the live edge — never a speed-run through
    // everything they missed. Read-ahead only asks once the bell clock says
    // the whole span has aired: asking earlier is a guaranteed 404, since
    // "not aired" and "does not exist" answer identically on purpose.
    let wanted = Math.floor(Math.max(0, targetTick) / TIMELINE_CHUNK_TICKS);
    if (finalIndex !== null) wanted = Math.min(wanted, finalIndex);
    for (const index of [wanted, wanted + 1]) {
      if (chunks.has(index) || inFlight.has(index)) continue;
      if (finalIndex !== null && index > finalIndex) continue;
      if (index > wanted && (index + 1) * TIMELINE_CHUNK_TICKS > airedTick) continue;
      if (Date.now() < (misses.get(index)?.until ?? 0)) continue;
      request(index);
    }
  };

  const boutAt = (tick: number): BoutState | null => {
    if (chunks.size === 0) return null;
    const finale = finalIndex !== null ? chunks.get(finalIndex)! : null;
    let playable = Math.max(0, finale ? Math.min(tick, finale.ticks) : tick);
    let owner = Math.floor(playable / TIMELINE_CHUNK_TICKS);
    if (finalIndex !== null) owner = Math.min(owner, finalIndex);
    let chunk = chunks.get(owner);
    if (!chunk) {
      // The owner has not landed yet: hold on the newest loaded frame behind
      // it rather than going dark while the fetch is in flight.
      for (const [index, held] of chunks) {
        if (index < owner && (!chunk || held.ticks > chunk.ticks)) chunk = held;
      }
      if (!chunk) return null;
      playable = chunk.ticks;
    }
    return boutFromTimeline(chunk, playable, boutId, finale);
  };

  return {
    boutId,
    ensure,
    boutAt,
    voice: () => voiceLines,
    stop: () => {
      stopped = true;
      for (const abort of inFlight.values()) abort.abort();
    },
  };
}

/** One decoded timeline frame wearing the full `BoutState` the stage draws.
 *
 * `finale` is the closing chunk once it is known — it supplies the verdict for
 * ticks at or past the final bell. Passing null keeps the bout permanently
 * "running", which is exactly right for footage meant to loop. */
export function boutFromTimeline(
  chunk: FightTimeline,
  tick: number,
  boutId: number,
  finale: FightTimeline | null,
): BoutState {
  const frame = frameAt(chunk, tick);
  const over = finale !== null && tick >= finale.ticks;
  return {
    id: boutId,
    seed: 0,
    tick: frame.tick,
    round: frame.round,
    roundTime: frame.roundTime,
    roundLength: frame.roundLength,
    totalRounds: frame.totalRounds,
    breakTime: frame.breakTime,
    introSeconds: frame.introSeconds,
    running: !over,
    speed: 1,
    left: timelineFighter(frame.left),
    right: timelineFighter(frame.right),
    roundCards: cardsUpTo(chunk, tick),
    events: feedUpTo(chunk, tick),
    winnerId: over ? finale.result.winnerId : null,
    finish: over ? finale.result.finish : null,
    careerCommitted: over,
  };
}

function zeroRound(): RoundMetrics {
  return { cleanBlows: 0, impactEnergy: 0, defense: 0, control: 0, knockdowns: 0 };
}

function zeroActionCounts() {
  return Object.fromEntries(ACTIONS.map((action) => [action, 0])) as Record<
    FighterAction,
    number
  >;
}

function restingPlan(): StrategyDirective {
  return {
    focus: "pressure" as TacticalIntent,
    pace: 0.5,
    risk: 0.5,
    target: "mixed",
    ringMode: "center",
    confidence: 0.5,
    note: "",
    source: "opening",
    issuedRound: 0,
  };
}

/** A timeline frame wearing the `BoutFighter` shape the renderer draws.
 *
 * Everything the canvas or the stage reads is real, straight off the wire.
 * The rest of the interface belongs to the engine's inner life and defaults
 * to resting values nobody looks at. */
function timelineFighter(frame: TimelineFighterFrame): BoutFighter {
  return {
    fighterId: frame.fighterId,
    corner: frame.corner,
    x: frame.x,
    y: frame.y,
    facingDirection: frame.facingDirection,
    velocity: 0,
    velocityY: 0,
    health: frame.health,
    stamina: frame.stamina,
    freshness: 1,
    balance: 1,
    body: frame.body,
    headTrauma: frame.headTrauma,
    bodyTrauma: 0,
    neurologicalLoad: 0,
    bodyShock: 0,
    stunSeconds: frame.stunSeconds,
    hurtSeconds: frame.hurtSeconds,
    chinIntegrity: 1,
    comboPlan: [],
    comboIndex: 0,
    guardStreak: 0,
    pocketSeconds: 0,
    downCountSeconds: frame.downCountSeconds,
    recoveryTargetSeconds: 0,
    knockout: false,
    knockoutCause: "",
    score: 0,
    judgePoints: [],
    action: frame.action,
    lastAction: frame.action,
    actionRecency: [],
    tacticalIntent: "pressure" as TacticalIntent,
    decisionConfidence: frame.decisionConfidence,
    decisionMargin: 0,
    decisionCount: 0,
    brainActivity: 0,
    workingMemory: [],
    memoryActivity: 0,
    memoryUpdates: 0,
    currentPlan: restingPlan(),
    planRevision: 0,
    attackSequence: 0,
    actionElapsed: frame.actionElapsed,
    actionDuration: frame.actionDuration,
    previousHandExtension: 0,
    handExtension: 0,
    handVelocity: frame.handVelocity,
    headOffset: frame.headOffset,
    headLevel: frame.headLevel,
    punchAimOffset: 0,
    punchAimHeight: frame.punchAimHeight,
    punchAimZone: frame.punchAimZone,
    punchHand: frame.punchHand,
    punchSide: 0,
    punchDirectionX: 0,
    punchDirectionY: 0,
    punchExtensionTarget: frame.punchExtensionTarget,
    punchResolved: true,
    evadeDirection: 0,
    landed: frame.landed,
    thrown: frame.thrown,
    blocked: frame.blocked,
    knockdowns: frame.knockdowns,
    cleanImpactJ: frame.cleanImpactJ,
    absorbedImpactJ: 0,
    lastImpactJ: frame.lastImpactJ,
    peakImpactJ: 0,
    peakHandSpeed: frame.peakHandSpeed,
    peakForceN: frame.peakForceN,
    lastImpactZone: frame.lastImpactZone,
    lastStrikeKind: frame.lastStrikeKind,
    lastImpactSpeed: 0,
    lastRotationalImpulse: 0,
    lastPowerShot: false,
    lastImpactCounter: frame.lastImpactCounter,
    recentHeadImpact: 0,
    recentBodyImpact: 0,
    sustainedPressure: 0,
    heightM: frame.heightM,
    reachM: frame.reachM,
    massKg: 80,
    round: zeroRound(),
    lastRound: zeroRound(),
    actionCounts: zeroActionCounts(),
    rangeSampleTotal: 0,
    rangeSamples: 0,
    sensoryHistory: [],
    punchLockSeconds: 0,
    gassed: false,
    guardHeld: false,
  };
}
