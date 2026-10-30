/** The broadcast's vocabulary and clock, split out from the machinery.
 *
 * Everything here reads a card or a clock and computes; nothing in here can
 * simulate, schedule or commit a fight. The machinery in broadcast.ts imports
 * this file, never the other way around, so a browser that only needs to know
 * what time it is on the league clock does not pull the engine with it. */
import { BOXING_MODEL, type Corner, type Fighter, type WeightClassId } from "./fight-model.ts";
import { TIMELINE_CHUNK_TICKS, TIMELINE_SAMPLE_SECONDS } from "./fight-timeline.ts";
import type { StrategyDirective } from "./strategy.ts";

/** The result stays on the stage after the final bell.
 *
 * A fight that cuts to the intermission the instant it is scored gives nobody
 * time to read who won and how, so the last frame — with the verdict on it —
 * holds here before the card moves on. */
export const POST_FIGHT_MS = 30_000;
/** How long the walk-outs take once the previous result has cleared. */
export const INTERMISSION_MS = 20_000;
/** The viewer's distance behind the bell: two whole chunks and a sample.
 *
 * One chunk is the floor — the server only serves fully-aired chunks — but at
 * exactly one chunk the next fetch could not start until the moment its first
 * frame was due, so the picture froze for a round trip at every boundary. The
 * second chunk is the network budget: the chunk ahead is always servable the
 * moment the current one starts playing, and a fetch has five whole seconds to
 * land. Everything the viewer is shown runs this far behind the league clock —
 * countdowns, verdicts, card results, and the maker's in-play quotes, which
 * price the frame the viewer is looking at rather than the newest fetchable
 * one, because odds walking toward the winner ahead of the picture are a
 * spoiler all of their own. It lives here rather than in the client store so
 * the worker can read it too. */
export const PLAYBACK_DELAY_MS =
  2 * TIMELINE_CHUNK_TICKS * BOXING_MODEL.physicsStepSeconds * 1000 +
  TIMELINE_SAMPLE_SECONDS * 1000;
/** A league week in league-clock milliseconds. Title fights land on this beat. */
export const WEEK_MS = 24 * 60 * 60 * 1000;
/** Fights on one night's card, start to finish.
 *
 * A card is a fixed set, not a rolling window: all fifteen are announced up
 * front and turn into results one by one as the night runs, so the schedule the
 * viewer is reading never changes shape under them. When the last one has aired
 * the card rolls over and the next night is drawn up.
 *
 * Fifteen because nobody fights twice in a night and each division carries a
 * champion plus eleven contenders: five bouts a division, three divisions. Take
 * it higher and the planner runs out of men and quietly books a short card. */
export const CARD_BOUTS = 15;
/** Dark hours between the end of one fight night and the first bell of the next.
 *
 * A card is an event rather than a treadmill, so the league goes quiet in
 * between — and the moment a night is over the next one is drawn up in full and
 * put on the board, six hours out. That gap is what makes the card worth
 * reading before it happens: the whole line-up is public, the matchups are
 * settled, and there is an evening to look at them in. Measured on the league
 * clock like everything else, so speeding the broadcast up runs the dark hours
 * off at the same rate as the fights. */
export const BETWEEN_CARDS_MS = 6 * 60 * 60 * 1000;
/** Short market-and-billing window after an operator replaces the current card. */
export const RESET_CARD_DELAY_MS = 5 * 60 * 1000;
/** A bout is only actually simulated once it is this close to its slot. */
export const SIMULATE_LEAD_MS = 3 * 60 * 1000;
export const CONTENDER_ROUNDS = 3;
export const TITLE_ROUNDS = 5;

/** How many defences a man sits out after the belt has sent him back down the
 * ladder — a beaten challenger, or a champion who has just lost it.
 *
 * A division carries eleven contenders, so nine keeps the shot moving around
 * the top ten of them instead of settling on the one or two names at the head
 * of the queue. Raising it widens the rotation; at eleven every contender in
 * the division gets a turn before anyone gets a second. */
export const TITLE_SHOT_ROTATION = 9;

/** Rough airtime used to lay out slots that have not been fought yet.
 *
 * Only ever a placeholder: as soon as a bout is simulated its real duration is
 * known and everything after it on the card is re-timed, exactly the way a real
 * fight night slides when a main event ends in the first round. */
export function estimatedDuration(kind: BoutKind) {
  return kind === "title" ? 7.5 * 60 * 1000 : 4.5 * 60 * 1000;
}

export type BoutKind = "contender" | "title";

export interface BoutResult {
  winnerId: string | null;
  finish: "KO" | "TKO" | "Decision" | "Draw";
  round: number;
  ticks: number;
  blueLanded: number;
  redLanded: number;
}

/** A corner instruction, pinned to the exact tick the server applied it on.
 *
 * The between-rounds coach is the one part of a bout that is not a pure
 * function of the fighters, so its output is captured once on the server and
 * replayed verbatim. Without the tick, two viewers could apply the same
 * directive a step apart and drift into different fights. */
export interface TimedDirective {
  tick: number;
  corner: Corner;
  directive: StrategyDirective;
}

export interface ScheduledBout {
  id: number;
  seed: number;
  division: WeightClassId;
  kind: BoutKind;
  blueId: string;
  redId: string;
  /** Opening bell, on the league clock. Provisional until the bout is simulated. */
  startsAt: number;
  /** Final bell. Exact once `result` exists; an estimate for a slot on the card
   *  that has not been fought yet. */
  endsAt: number;
  totalRounds: number;
  roundSeconds: number;
  /** Null while this is still just an announced slot on tonight's card. */
  result: BoutResult | null;
  directives: TimedDirective[];
  committed: boolean;
  /** The two athletes exactly as they were when this bout was simulated.
   *
   * Frozen deliberately: careers move between fights, and a viewer replaying
   * tonight's bout must use the men who actually stepped through the ropes, not
   * the levelled-up versions the league is carrying now. Stripped from bouts
   * old enough that nobody can still be watching them. */
  profiles?: [Fighter, Fighter];
}

export interface DivisionState {
  id: WeightClassId;
  championId: string | null;
  /** Contenders, best first. The champion is not on it. */
  ladder: string[];
  titleDefences: number;
  /** League time each athlete last fought, so the card does not repeat itself. */
  lastFought: Record<string, number>;
  /** The men the belt has already sent back down the ladder, most recent first
   *  and capped at {@link TITLE_SHOT_ROTATION}. Nobody on it can be matched for
   *  the title, which is what keeps the same two names out of it week on week. */
  recentChallengers: string[];
  titleFightThisWeek: boolean;
}

/** The mandatory: who the belt is next defended against.
 *
 * Not the top of the ladder, which is what this used to be. A beaten challenger
 * was put back in at number two and a deposed champion at number one, so the
 * belt bounced between the same two names week after week and a man who lost it
 * was first in the queue to win it straight back. Everyone below them could
 * fight all season without ever being in the picture.
 *
 * So a title shot is spent: the man the belt sends back down the ladder waits
 * out {@link TITLE_SHOT_ROTATION} more defences before he can be matched for it
 * again. Ranking still decides the order — the best of the men who are due goes
 * up — but it decides among ten of them rather than one. */
export function nextChallenger(
  division: DivisionState,
  /** Anyone unavailable for the slot being filled: already working tonight, or
   *  already booked against this champion. */
  bookable: (id: string) => boolean = () => true,
): string | null {
  const available = division.ladder.filter(bookable);
  const due = available.find((id) => !division.recentChallengers.includes(id));
  if (due) return due;
  // Nobody is due — a division small enough that the rotation covers all of it,
  // or one that has just been reseeded. It still defends, against whoever has
  // waited longest: a week with no title fight is a week the calendar cannot
  // roll past, and the belt would sit there forever.
  const waited = (id: string) => division.recentChallengers.indexOf(id);
  return available.reduce<string | null>(
    (longest, id) => (!longest || waited(id) > waited(longest) ? id : longest),
    null,
  );
}

/** Maps real wall-clock time onto the league's own timeline.
 *
 * Kept as an anchor plus a rate so pausing and fast-forwarding are shared by
 * every viewer instead of being a private control on one browser. */
export interface BroadcastClock {
  anchorRealMs: number;
  anchorLeagueMs: number;
  rate: number;
}

export interface BroadcastState {
  version: 1;
  clock: BroadcastClock;
  weekStartedAt: number;
  season: number;
  week: number;
  /** Which fight night the card on the board is. Counts up on every rollover,
   *  so a card can be billed and referred to before it has been fought. */
  night: number;
  divisions: DivisionState[];
  card: ScheduledBout[];
  nextBoutId: number;
  nextDivisionIndex: number;
  rosterVersion: number;
  updatedAt: number;
}

export function leagueNow(clock: BroadcastClock, realNow: number) {
  return clock.anchorLeagueMs + (realNow - clock.anchorRealMs) * clock.rate;
}

/** Re-pins the clock at the current instant, optionally at a new rate.
 *
 * Anchoring before changing the rate is what keeps a pause or a fast-forward
 * from teleporting the fight that is already on air. */
export function reanchorClock(
  clock: BroadcastClock,
  realNow: number,
  rate = clock.rate,
): BroadcastClock {
  return {
    anchorRealMs: realNow,
    anchorLeagueMs: leagueNow(clock, realNow),
    rate,
  };
}

export function divisionOf(state: BroadcastState, id: WeightClassId) {
  return state.divisions.find((division) => division.id === id);
}

/** When a bout finally leaves the stage — the final bell plus the hold that
 *  keeps the verdict up long enough to read. */
export function airtimeEnd(bout: ScheduledBout) {
  return bout.endsAt + POST_FIGHT_MS;
}

export function currentBout(state: BroadcastState, now: number) {
  return (
    state.card.find((bout) => bout.startsAt <= now && now < airtimeEnd(bout)) ?? null
  );
}

/** True once the final bell has gone but the result is still on screen. */
export function isAftermath(bout: ScheduledBout, now: number) {
  return Boolean(bout.result) && now >= bout.endsAt && now < airtimeEnd(bout);
}

export function nextBout(state: BroadcastState, now: number) {
  return state.card.find((bout) => bout.startsAt > now) ?? null;
}

export function recentResults(state: BroadcastState, now: number) {
  return state.card.filter((bout) => airtimeEnd(bout) <= now).reverse();
}

/** Converts a league-clock instant back to wall time, so the card can be shown
 *  in the viewer's own clock. Null while the broadcast is paused, when league
 *  time no longer maps onto any real moment. */
export function realTimeFor(clock: BroadcastClock, leagueMs: number) {
  if (clock.rate === 0) return null;
  return clock.anchorRealMs + (leagueMs - clock.anchorLeagueMs) / clock.rate;
}

/** How many physics steps into a bout the league clock currently is. */
export function tickForTime(bout: ScheduledBout, now: number) {
  const elapsed = Math.max(0, now - bout.startsAt);
  return Math.min(
    bout.result?.ticks ?? Number.MAX_SAFE_INTEGER,
    Math.floor(elapsed / (BOXING_MODEL.physicsStepSeconds * 1000)),
  );
}
