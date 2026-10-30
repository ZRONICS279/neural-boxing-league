import {
  BOXING_MODEL,
  type BoutState,
  type Corner,
  type DecisionLedger,
  type Fighter,
  type LeagueState,
  WEIGHT_CLASSES,
  type WeightClassId,
  applyStrategyDirective,
  commitBout,
  createBout,
  createDecisionLedger,
  learnFromBout,
  sealDecisionLedger,
  stepBout,
} from "./simulation.ts";
import type { StrategyDirective } from "./strategy.ts";

/** The league as a broadcast rather than as a toy.
 *
 * Everything in here is pure: the worker uses it to run the card forward on the
 * server, and the browser uses the very same functions to replay whatever is
 * currently on air. That shared code is the whole trick — because `stepBout` is
 * deterministic, the server never has to stream fight state. It publishes who
 * is fighting, from which seed, and at what moment the opening bell rang, and
 * every viewer independently arrives at an identical frame. A reload, a
 * backgrounded tab, or a viewer who shows up in round three all converge on the
 * same fight instead of starting a private one. */

import {
  BETWEEN_CARDS_MS,
  CARD_BOUTS,
  CONTENDER_ROUNDS,
  INTERMISSION_MS,
  SIMULATE_LEAD_MS,
  TITLE_ROUNDS,
  TITLE_SHOT_ROTATION,
  WEEK_MS,
  airtimeEnd,
  estimatedDuration,
  leagueNow,
  nextChallenger,
  reanchorClock,
  type BoutKind,
  type BoutResult,
  type BroadcastState,
  type DivisionState,
  type ScheduledBout,
  type TimedDirective,
} from "./broadcast-model.ts";

export * from "./broadcast-model.ts";

/** Seeds a division from scouting ratings: best man holds the belt, the rest
 * queue up behind him in rating order. */
function seedDivision(league: LeagueState, id: WeightClassId): DivisionState {
  const ranked = league.roster
    .filter((fighter) => fighter.weightClass === id)
    .sort((a, b) => b.rating - a.rating);
  const [champion, ...contenders] = ranked;
  return {
    id,
    championId: champion?.id ?? null,
    ladder: contenders.map((fighter) => fighter.id),
    titleDefences: 0,
    lastFought: {},
    recentChallengers: [],
    titleFightThisWeek: false,
  };
}

export function createBroadcast(league: LeagueState, realNow: number): BroadcastState {
  return {
    version: 1,
    clock: { anchorRealMs: realNow, anchorLeagueMs: 0, rate: 1 },
    weekStartedAt: 0,
    season: league.season,
    week: league.week,
    night: 1,
    divisions: WEIGHT_CLASSES.map((division) => seedDivision(league, division.id)),
    card: [],
    nextBoutId: 1,
    nextDivisionIndex: 0,
    rosterVersion: 1,
    updatedAt: realNow,
  };
}

/** Who this division's belt has already been round to, recovered from the card
 * on air for a state saved before the rotation was kept.
 *
 * Only tonight is on the card, so this comes back with one name at most — but
 * it is the name that matters. Left empty, the first week after the change
 * would put the belt straight back in front of the man who has just lost it,
 * which is the whole thing the rotation exists to stop. */
function spentShots(card: ScheduledBout[], division: DivisionState) {
  return card
    .filter((bout) => bout.division === division.id && bout.kind === "title" && bout.result)
    .flatMap((bout) =>
      // The beaten challenger — or, if he took the belt, the man he took it
      // from, who is back on the ladder and at the top of it.
      bout.result!.winnerId === bout.redId ? division.ladder.slice(0, 1) : [bout.redId],
    );
}

/** Adopts a stored card, or null if it is not one.
 *
 * A card written by an older deployment is still the night that is on air, so
 * it is filled in rather than thrown away — restarting the league because a
 * field was added would put every result on the board back to nothing. */
export function upgradeBroadcast(value: unknown): BroadcastState | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<BroadcastState>;
  // Divisions are read the same way as the card: a state that has lost them is
  // not a card to adopt, and saying so hands the caller its existing "reseed"
  // path instead of leaving a league that can never book a fight again.
  if (saved.version !== 1 || !Array.isArray(saved.card) || !Array.isArray(saved.divisions)) {
    return null;
  }
  return {
    ...(saved as BroadcastState),
    night: saved.night ?? 1,
    // A stoppage used to be filed as "RSC". Bouts already fought on the card
    // that is on air keep whichever word they were written with, so they are
    // renamed on the way in rather than left reading two ways on one board.
    card: (saved.card as ScheduledBout[]).map((bout) =>
      bout.result && (bout.result.finish as string) === "RSC"
        ? { ...bout, result: { ...bout.result, finish: "TKO" } }
        : bout,
    ),
    // A division saved before the belt kept a rotation has no list of who it has
    // already been round to, so it is read back off the night that is on air.
    divisions: saved.divisions.map((division) => ({
      ...division,
      recentChallengers: division.recentChallengers ?? spentShots(saved.card as ScheduledBout[], division),
    })),
  };
}

/** Stable identity for a pairing, whichever corner each man is in. */
export function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Who fights next in this division.
 *
 * The ladder is a queue with a memory: the man who has waited longest gets the
 * call, and he is matched against a neighbour within striking distance of his
 * own ranking, so the card stays competitive without becoming a fixed rotation.
 * Once a week the queue is set aside and the champion defends against whoever
 * {@link nextChallenger} says is due. */
export function pickMatchup(
  state: BroadcastState,
  division: DivisionState,
  now: number,
  /** Pairings already on tonight's card, so the same fight is not booked twice. */
  avoid: Set<string> = new Set(),
  /** Fighters already on tonight's card. Nobody works twice in one night —
   *  every division carries twelve men for exactly the six slots it gets. */
  resting: Set<string> = new Set(),
): { blueId: string; redId: string; kind: BoutKind } | null {
  const free = (id: string) => !resting.has(id);
  const weekIsUp = now - state.weekStartedAt >= WEEK_MS;
  if (weekIsUp && !division.titleFightThisWeek && division.championId && free(division.championId)) {
    const champion = division.championId;
    // `titleFightThisWeek` is only raised when a title bout is *fought*, and a
    // whole card is planned before any of it is. Without the `avoid` test the
    // branch fired for every slot the division got, and a night came out as the
    // same belt fight booked six times over.
    const challenger = nextChallenger(
      division,
      (id) => free(id) && !avoid.has(pairKey(champion, id)),
    );
    if (challenger) return { blueId: champion, redId: challenger, kind: "title" };
  }

  // A champion only appears on the card to defend, so the contender pool is the
  // ladder alone. Eleven men is five bouts a division, which is what sets the
  // size of a card.
  const rankOf = (id: string) => division.ladder.indexOf(id);

  // Whoever is already booked tonight is out — including the champion's
  // challenger, on a night the belt is up.
  const available = division.ladder.filter(free);
  if (available.length < 2) return null;

  const restedFirst = [...available].sort(
    (a, b) =>
      (division.lastFought[a] ?? -Infinity) - (division.lastFought[b] ?? -Infinity) ||
      rankOf(a) - rankOf(b),
  );
  const challenger = restedFirst[0];
  const rank = rankOf(challenger);
  const neighbours = available.filter((id) => {
    if (id === challenger) return false;
    return Math.abs(rankOf(id) - rank) <= 2;
  });
  const everyoneElse = available.filter((id) => id !== challenger);
  // Nearby ranks first, then anyone still free, then — only if the division has
  // genuinely run out of fresh pairings — a repeat of a fight, though never of a
  // fighter.
  const pool =
    [neighbours, everyoneElse]
      .map((candidates) =>
        candidates.filter((id) => !avoid.has(pairKey(challenger, id))),
      )
      .find((candidates) => candidates.length > 0) ??
    (neighbours.length > 0 ? neighbours : everyoneElse);
  if (pool.length === 0) return null;
  const opponent = pool.reduce((rested, id) =>
    (division.lastFought[id] ?? -Infinity) < (division.lastFought[rested] ?? -Infinity)
      ? id
      : rested,
  );
  // The better-ranked man works out of the blue corner.
  const challengerRanksHigher = rank < rankOf(opponent);
  return {
    blueId: challengerRanksHigher ? challenger : opponent,
    redId: challengerRanksHigher ? opponent : challenger,
    kind: "contender",
  };
}

/** Moves the ladder after a verdict.
 *
 * A contender who beats a man ranked above him takes that man's place outright
 * and everyone between slides down — a real challenge ladder, not a points
 * table. Losing to someone below you costs you the position. */
export function applyLadderResult(
  division: DivisionState,
  bout: ScheduledBout,
  result: BoutResult,
  now: number,
): DivisionState {
  const next: DivisionState = {
    ...division,
    ladder: [...division.ladder],
    lastFought: { ...division.lastFought, [bout.blueId]: now, [bout.redId]: now },
  };

  if (bout.kind === "title") {
    next.titleFightThisWeek = true;
    const challenger = bout.redId;
    // Whichever of the two the belt has just sent back down the ladder. He has
    // had his shot, and the rotation is what stops him taking the next one as
    // well — a deposed champion lands at number one on the way down, which used
    // to make him the mandatory the following week.
    let spent = challenger;
    if (result.winnerId === challenger) {
      const deposed = next.championId;
      next.championId = challenger;
      next.ladder = next.ladder.filter((id) => id !== challenger);
      if (deposed) {
        next.ladder.unshift(deposed);
        spent = deposed;
      }
      next.titleDefences = 0;
    } else {
      next.titleDefences += 1;
    }
    next.recentChallengers = [
      spent,
      ...division.recentChallengers.filter((id) => id !== spent),
    ].slice(0, TITLE_SHOT_ROTATION);
    return next;
  }

  if (!result.winnerId) return next;
  const loserId = result.winnerId === bout.blueId ? bout.redId : bout.blueId;
  const winnerRank = next.ladder.indexOf(result.winnerId);
  const loserRank = next.ladder.indexOf(loserId);
  if (winnerRank > loserRank && loserRank >= 0) {
    next.ladder.splice(winnerRank, 1);
    next.ladder.splice(loserRank, 0, result.winnerId);
  }
  return next;
}

function boutResultOf(bout: BoutState): BoutResult {
  if (!bout.finish) {
    // Every stepping loop below is capped so an engine bug cannot pin the
    // worker, and a cap that trips leaves a fight standing with no verdict.
    // That is not a draw, and calling it one is worse than stopping: it
    // fabricates a result the card, the book and both careers then believe.
    throw new Error(
      `Bout ${bout.id} was still running at tick ${bout.tick}; it has no result to publish.`,
    );
  }
  return {
    winnerId: bout.winnerId,
    finish: bout.finish,
    round: bout.round,
    ticks: bout.tick,
    blueLanded: bout.left.landed,
    redLanded: bout.right.landed,
  };
}

/** The most ticks a fight can possibly take: every round in full, plus the
 *  round calls and the stools between them.
 *
 * The stepping loops are guarded so a bug in the engine cannot spin forever,
 * but a guard has to sit above a fight that is merely long or it stops good
 * ones. This used to be a flat 40,000, which was over an hour of slack at the
 * 10 Hz tick it was written for. At 50 Hz it is 800 seconds — and a five-round
 * title fight is 932 — so every title fight that went the distance was cut off
 * at 2:12 of the last round and published as a draw. */
export function boutTickCeiling(
  bout: Pick<ScheduledBout, "totalRounds" | "roundSeconds">,
) {
  const seconds =
    bout.totalRounds * (bout.roundSeconds + BOXING_MODEL.roundIntroSeconds) +
    (bout.totalRounds - 1) * BOXING_MODEL.cornerBreakSeconds;
  return Math.ceil((seconds + 1) / BOXING_MODEL.physicsStepSeconds);
}

/** The roster a replay must use: exactly the two men who were scheduled. */
export function boutRoster(bout: ScheduledBout): Fighter[] {
  return bout.profiles ? [...bout.profiles] : [];
}

export interface CoachRequest {
  bout: BoutState;
  corner: Corner;
  self: Fighter;
  opponent: Fighter;
}

/** Runs a scheduled bout to its final bell on the server.
 *
 * This is what turns a matchup into a broadcast: the exact tick count becomes
 * the fight's airtime, and any corner instruction the coach produced is written
 * down against the tick it landed on so every browser can reproduce it. */
export async function simulateScheduledBout(
  bout: ScheduledBout,
  coach?: (request: CoachRequest) => Promise<StrategyDirective | null>,
): Promise<{ result: BoutResult; directives: TimedDirective[] }> {
  const roster = boutRoster(bout);
  const blue = roster.find((fighter) => fighter.id === bout.blueId);
  const red = roster.find((fighter) => fighter.id === bout.redId);
  if (!blue || !red) throw new Error("The scheduled bout is missing its athletes.");

  let state = createBout(bout.blueId, bout.redId, bout.id, {
    seed: bout.seed,
    totalRounds: bout.totalRounds,
    roundSeconds: bout.roundSeconds,
  });
  const directives: TimedDirective[] = [];
  let wasBreaking = false;
  let guard = 0;
  const ceiling = boutTickCeiling(bout);

  while (state.running && !state.finish && guard < ceiling) {
    state = stepBout(state, roster);
    guard += 1;
    const breaking = state.breakTime > 0;
    if (coach && breaking && !wasBreaking && state.round > 1) {
      for (const corner of ["blue", "red"] as const) {
        const directive = await coach({
          bout: state,
          corner,
          self: corner === "blue" ? blue : red,
          opponent: corner === "blue" ? red : blue,
        });
        if (!directive) continue;
        const applied = applyStrategyDirective(state, corner, directive);
        if (applied === state) continue;
        state = applied;
        directives.push({ tick: state.tick, corner, directive });
      }
    }
    wasBreaking = breaking;
  }

  return { result: boutResultOf(state), directives };
}

/** Replays an airing bout forward to a given tick.
 *
 * `from` lets a browser that is already watching advance only the handful of
 * steps that have elapsed since the last frame, while a viewer who just arrived
 * passes nothing and rebuilds the fight from the opening bell — a few hundred
 * milliseconds of work for a whole fight. */
export function replayBout(
  bout: ScheduledBout,
  targetTick: number,
  from?: BoutState,
  ledger?: DecisionLedger,
): BoutState {
  const roster = boutRoster(bout);
  let state =
    from && from.id === bout.id && from.tick <= targetTick
      ? from
      : createBout(bout.blueId, bout.redId, bout.id, {
          seed: bout.seed,
          totalRounds: bout.totalRounds,
          roundSeconds: bout.roundSeconds,
        });

  while (state.tick < targetTick && state.running && !state.finish) {
    state = stepBout(state, roster, ledger);
    for (const timed of bout.directives) {
      if (timed.tick !== state.tick) continue;
      state = applyStrategyDirective(state, timed.corner, timed.directive);
    }
  }
  return state;
}

function stripOldProfiles(card: ScheduledBout[], liveIndex: number) {
  // Only the fight on air, the one after it, and the one just finished can still
  // be replayed by somebody. Everything older keeps its result and drops the two
  // athlete snapshots, which are by far the heaviest part of the card.
  //
  // An uncommitted bout is never stripped, whatever its age: `commitScheduledBout`
  // replays the fight from these snapshots to score it, and without them the
  // result would be silently dropped instead of paid into careers. That happens
  // for real whenever the worker goes quiet long enough for several fights to
  // air before anything advances the broadcast.
  const keepFrom = Math.max(0, (liveIndex < 0 ? card.length : liveIndex) - 1);
  return card.map((bout, index) =>
    index >= keepFrom || !bout.committed
      ? bout
      : { ...bout, profiles: undefined, directives: [] },
  );
}

/** Re-flows every slot after `fromIndex` so they queue up back to back.
 *
 * Called whenever a real duration replaces an estimate — a main event that ends
 * in the first round pulls the rest of the night forward, which is exactly what
 * the announced times should do. */
function retimeCard(card: ScheduledBout[], fromIndex: number): ScheduledBout[] {
  const next = [...card];
  for (let index = Math.max(1, fromIndex); index < next.length; index += 1) {
    const previous = next[index - 1];
    const bout = next[index];
    // A bout that has already been fought owns its slot; only pending ones move.
    if (bout.result) continue;
    const startsAt = airtimeEnd(previous) + INTERMISSION_MS;
    next[index] = {
      ...bout,
      startsAt,
      endsAt: startsAt + estimatedDuration(bout.kind),
    };
  }
  return next;
}

/** Announces one more slot on tonight's card.
 *
 * No simulation and no athlete snapshots here — just who is booked and roughly
 * when. `projected` stands in for the ladder's `lastFought` as the card is laid
 * out, so booking six fights in a row does not keep picking the same rested man.
 */
function planNextSlot(
  state: BroadcastState,
  startsAt: number,
  projected: Map<WeightClassId, Record<string, number>>,
  booked: Set<string>,
  working: Set<string>,
): ScheduledBout | { divisionIndex: number } | null {
  for (let attempt = 0; attempt < state.divisions.length; attempt += 1) {
    const index = (state.nextDivisionIndex + attempt) % state.divisions.length;
    const division = state.divisions[index];
    const overlay = projected.get(division.id) ?? division.lastFought;
    const matchup = pickMatchup(
      state,
      { ...division, lastFought: overlay },
      startsAt,
      booked,
      working,
    );
    if (!matchup) continue;

    projected.set(division.id, {
      ...overlay,
      [matchup.blueId]: startsAt,
      [matchup.redId]: startsAt,
    });
    booked.add(pairKey(matchup.blueId, matchup.redId));
    working.add(matchup.blueId);
    working.add(matchup.redId);
    const kind = matchup.kind;
    return Object.assign(
      {
        id: state.nextBoutId,
        seed: state.nextBoutId * 7919 + division.ladder.length * 13 + 1,
        division: division.id,
        kind,
        blueId: matchup.blueId,
        redId: matchup.redId,
        startsAt,
        endsAt: startsAt + estimatedDuration(kind),
        totalRounds: kind === "title" ? TITLE_ROUNDS : CONTENDER_ROUNDS,
        roundSeconds: BOXING_MODEL.roundSeconds,
        result: null,
        directives: [],
        committed: false,
      } satisfies ScheduledBout,
      { divisionIndex: index },
    );
  }
  return null;
}

export interface AdvanceOptions {
  realNow: number;
  coach?: (request: CoachRequest) => Promise<StrategyDirective | null>;
  /** Bouts to actually simulate in one pass, so a cold start is not a whole day. */
  maxSimulate?: number;
  /** League-clock opening bell when filling an empty card. Defaults to now. */
  firstBell?: number;
}

/** Brings the broadcast up to date with the wall clock.
 *
 * Three separate jobs, in order: commit what has finished, announce the rest of
 * tonight's card, and simulate whichever booked fight is next up. Announcing and
 * simulating are deliberately split — a viewer should be able to see the whole
 * night's line-up and start times, but a bout must not be fought until the
 * careers going into it are final, so only the imminent one is actually run. */
export async function advanceBroadcast(
  state: BroadcastState,
  league: LeagueState,
  options: AdvanceOptions,
): Promise<{ state: BroadcastState; league: LeagueState; changed: boolean }> {
  const next: BroadcastState = {
    ...state,
    divisions: state.divisions.map((division) => ({ ...division })),
    card: [...state.card],
  };
  let carriedLeague = league;
  let changed = false;
  const now = leagueNow(next.clock, options.realNow);
  const maxSimulate = options.maxSimulate ?? 2;

  // 1. Everything whose final bell has gone becomes career history. This happens
  //    at the bell, not when the result leaves the screen, so the ladder is
  //    right even while the verdict is still being shown.
  for (let index = 0; index < next.card.length; index += 1) {
    const bout = next.card[index];
    if (bout.committed || !bout.result || bout.endsAt > now) continue;
    carriedLeague = commitScheduledBout(carriedLeague, bout);
    const division = next.divisions.findIndex((entry) => entry.id === bout.division);
    if (division >= 0) {
      next.divisions[division] = applyLadderResult(
        next.divisions[division],
        bout,
        bout.result,
        bout.endsAt,
      );
    }
    next.card[index] = { ...bout, committed: true };
    next.rosterVersion += 1;
    changed = true;
  }

  // 2. Roll the calendar once every division has had its title fight.
  if (
    now - next.weekStartedAt >= WEEK_MS &&
    next.divisions.every((division) => division.titleFightThisWeek)
  ) {
    next.weekStartedAt = now;
    next.week = next.week >= 12 ? 1 : next.week + 1;
    next.season = next.week === 1 ? next.season + 1 : next.season;
    next.divisions = next.divisions.map((division) => ({
      ...division,
      titleFightThisWeek: false,
    }));
    carriedLeague = { ...carriedLeague, week: next.week, season: next.season };
    changed = true;
  }

  // 3. Once the whole night has aired, tear the card down and draw up the next.
  //    Records, ladders and titles are already committed by this point, so the
  //    only thing being cleared is the listing.
  //
  //    The next card goes straight back up, but its first bell is six hours out.
  //    Announcing it now and fighting it later is the whole point: the matchups
  //    are made off ladders that are final, and there is a long, quiet evening
  //    in which the line-up can be read — and eventually bet on — before anyone
  //    steps through the ropes. The bell belongs to the league clock rather
  //    than the worker that happens to wake it: if a host misses its timer, the
  //    overdue night is fought at its billed times and the next card still goes
  //    up on the original six-hour cadence.
  let firstBell = options.firstBell ?? now;
  if (
    next.card.length >= CARD_BOUTS &&
    next.card.every((bout) => bout.committed && airtimeEnd(bout) <= now)
  ) {
    firstBell = airtimeEnd(next.card[next.card.length - 1]) + BETWEEN_CARDS_MS;
    next.card = [];
    next.night += 1;
    changed = true;
  }

  // 4. Anyone on the roster who is not yet in the queue joins the back of it.
  //
  //    A fighter the league has signed but no division has heard of can never
  //    be matched — `pickMatchup` only ever reads the ladder — so a new name
  //    would sit on the roster page forever, drawing a wage and no opponents.
  //    Cheap to check every pass and it only ever fires the once.
  for (let index = 0; index < next.divisions.length; index += 1) {
    const division = next.divisions[index];
    const known = new Set([division.championId, ...division.ladder]);
    const debutants = carriedLeague.roster
      .filter((fighter) => fighter.weightClass === division.id && !known.has(fighter.id))
      // Best of the new intake goes in highest, the same way the ladder was
      // seeded — a signing does not start below someone he outclasses.
      .sort((a, b) => b.rating - a.rating)
      .map((fighter) => fighter.id);
    // The champion queues for nobody. He can end up back on the ladder in an
    // old save, and then he is both the man to beat and a contender waiting to
    // beat him — so the queue is straightened here rather than trusted.
    const queue = division.ladder.filter((id) => id !== division.championId);
    if (debutants.length === 0 && queue.length === division.ladder.length) continue;
    next.divisions[index] = { ...division, ladder: [...queue, ...debutants] };
    next.rosterVersion += 1;
    changed = true;
  }

  // 5. Announce enough slots to fill out the night's card.
  const projected = new Map<WeightClassId, Record<string, number>>();
  for (const division of next.divisions) {
    projected.set(division.id, { ...division.lastFought });
  }
  // Everything already on tonight's card counts as booked, so the planner keeps
  // finding fresh pairings instead of cycling the same ones round again.
  const booked = new Set(next.card.map((bout) => pairKey(bout.blueId, bout.redId)));
  // And everybody on it is working tonight, so no later slot can call on them
  // again. Eighteen bouts is thirty-six corners and the roster is thirty-six
  // men — the card uses every one of them exactly once.
  const working = new Set(next.card.flatMap((bout) => [bout.blueId, bout.redId]));
  for (const bout of next.card) {
    if (bout.result) continue;
    const overlay = projected.get(bout.division);
    if (overlay) {
      overlay[bout.blueId] = bout.startsAt;
      overlay[bout.redId] = bout.startsAt;
    }
  }
  while (next.card.length < CARD_BOUTS) {
    const last = next.card[next.card.length - 1];
    const startsAt = last ? airtimeEnd(last) + INTERMISSION_MS : firstBell;
    const planned = planNextSlot(next, startsAt, projected, booked, working);
    if (!planned || !("id" in planned)) break;
    const { divisionIndex, ...bout } = planned as ScheduledBout & { divisionIndex: number };
    next.card = [...next.card, bout];
    next.nextBoutId += 1;
    next.nextDivisionIndex = (divisionIndex + 1) % next.divisions.length;
    changed = true;
  }

  // Belts close the show. The planner takes each division's title fight the
  // first chance it gets, so a card came out with every belt on it up top and
  // the contenders left to play out the evening; a night should build to them
  // instead. Only slots that have not been fought are moved — a result owns its
  // airtime — and the pending ones keep their order among themselves.
  const firstPending = next.card.findIndex((bout) => !bout.result);
  if (firstPending >= 0) {
    const pending = next.card.slice(firstPending);
    const reordered = [
      ...pending.filter((bout) => bout.kind !== "title"),
      ...pending.filter((bout) => bout.kind === "title"),
    ];
    if (reordered.some((bout, at) => bout.id !== pending[at].id)) {
      next.card = retimeCard(
        [...next.card.slice(0, firstPending), ...reordered],
        firstPending,
      );
      changed = true;
    }
  }

  // 4. Fight whichever booked slot is imminent, and re-time the rest around its
  //    real duration.
  for (let run = 0; run < maxSimulate; run += 1) {
    const index = next.card.findIndex(
      (bout) => !bout.result && bout.startsAt <= now + SIMULATE_LEAD_MS,
    );
    if (index < 0) break;
    const booked = next.card[index];
    const blue = carriedLeague.roster.find((fighter) => fighter.id === booked.blueId);
    const red = carriedLeague.roster.find((fighter) => fighter.id === booked.redId);
    if (!blue || !red) {
      next.card = next.card.filter((_, at) => at !== index);
      changed = true;
      continue;
    }
    const staged: ScheduledBout = {
      ...booked,
      profiles: [structuredClone(blue), structuredClone(red)],
    };
    const { result, directives } = await simulateScheduledBout(staged, options.coach);
    next.card = [...next.card];
    next.card[index] = {
      ...staged,
      result,
      directives,
      endsAt: staged.startsAt + result.ticks * BOXING_MODEL.physicsStepSeconds * 1000,
    };
    next.card = retimeCard(next.card, index + 1);
    changed = true;
  }

  if (changed) {
    const liveIndex = next.card.findIndex(
      (bout) => bout.startsAt <= now && now < airtimeEnd(bout),
    );
    // The card itself is never trimmed — a night is all eighteen fights, and a
    // finished one keeps its slot with the result in it. Only the heavy athlete
    // snapshots are dropped once nobody can still be replaying them.
    next.card = stripOldProfiles(next.card, liveIndex);
    next.updatedAt = options.realNow;
  }
  return { state: next, league: carriedLeague, changed };
}

/** Folds an aired result into careers by replaying it into a real BoutState.
 *
 * `commitBout` wants the finished fight, not a summary, so the bout is rerun to
 * its final bell — cheap, and it keeps one single scoring path instead of a
 * second reimplementation of what a win is worth.
 *
 * That replay is also where both men learn from the fight. The decisions are
 * traced as they go past and turned into one small policy step each, so every
 * bout on the card teaches the two brains that fought it without simulating
 * anything twice or storing a single row. The athlete snapshots the card
 * carries are what viewers replay from, so a policy that moves here cannot
 * change a fight anybody is watching. */
export function commitScheduledBout(league: LeagueState, bout: ScheduledBout): LeagueState {
  if (!bout.result || !bout.profiles) return league;
  const ledger = createDecisionLedger([bout.blueId, bout.redId]);
  const finished = replayBout(bout, bout.result.ticks, undefined, ledger);
  if (!finished.finish) return league;
  return learnFromBout(
    commitBout(league, finished),
    sealDecisionLedger(ledger, finished),
  );
}

/** An operator calling the night on early.
 *
 * The six dark hours are a schedule rather than a rule, so the whole booked
 * card is pulled forward by the same amount instead of only its opening bout:
 * the running order, the gaps between fights and the billing all survive the
 * move, and what airs is exactly the night that was posted. Anything already
 * fought keeps the slot it was fought in. */
export function openDoorsNow(
  state: BroadcastState,
  realNow: number,
): BroadcastState {
  const now = leagueNow(state.clock, realNow);
  // Only a card that has not opened yet. Pulling the rest of a night forward
  // while it is running would stack the next bout on top of the one on air.
  const first = state.card[0];
  if (!first || first.result || first.startsAt <= now) return state;
  const shift = first.startsAt - now;
  return {
    ...state,
    card: state.card.map((bout) =>
      bout.result
        ? bout
        : { ...bout, startsAt: bout.startsAt - shift, endsAt: bout.endsAt - shift },
    ),
  };
}

/** Tears down whatever is on the board and prepares a fresh fight night.
 *
 * Careers, ladders and the calendar belong to the league, not to one card, so
 * they carry through untouched. The clock returns to live speed and the night
 * number moves on, giving the replacement card its own market identity. The
 * worker fills the empty card before it lets any bout be simulated. */
export function resetCardNow(
  state: BroadcastState,
  realNow: number,
): BroadcastState {
  return {
    ...state,
    clock: reanchorClock(state.clock, realNow, 1),
    night: state.night + 1,
    card: [],
    updatedAt: realNow,
  };
}

/** An admin forcing a matchup on air right now.
 *
 * The fight currently on air is cut short at the present moment rather than
 * deleted, so viewers see it stop instead of having the page yank underneath
 * them, and nothing already committed is rewritten. Slots still booked for
 * later tonight keep their place and simply shift back behind the new bout. */
export async function stageBoutNow(
  state: BroadcastState,
  league: LeagueState,
  request: { blueId: string; redId: string; kind: BoutKind; realNow: number },
  coach?: (request: CoachRequest) => Promise<StrategyDirective | null>,
): Promise<BroadcastState> {
  const now = leagueNow(state.clock, request.realNow);
  const blue = league.roster.find((fighter) => fighter.id === request.blueId);
  const red = league.roster.find((fighter) => fighter.id === request.redId);
  if (!blue || !red || blue.id === red.id) return state;

  // Anything already under way is stopped here; anything merely booked keeps
  // its billing and gets re-timed once the forced bout has a real duration.
  const aired = state.card
    .filter((bout) => bout.startsAt <= now)
    .map((bout) =>
      bout.endsAt > now && bout.result ? { ...bout, endsAt: now } : bout,
    );
  const booked = state.card.filter((bout) => bout.startsAt > now && !bout.result);

  const bout: ScheduledBout = {
    id: state.nextBoutId,
    seed: state.nextBoutId * 7919 + Math.floor(now / 1000) % 4093 + 1,
    division: blue.weightClass,
    kind: request.kind,
    blueId: blue.id,
    redId: red.id,
    startsAt: now + 4000,
    endsAt: now + 4000,
    totalRounds: request.kind === "title" ? TITLE_ROUNDS : CONTENDER_ROUNDS,
    roundSeconds: BOXING_MODEL.roundSeconds,
    result: null,
    directives: [],
    committed: false,
    profiles: [structuredClone(blue), structuredClone(red)],
  };
  const { result, directives } = await simulateScheduledBout(bout, coach);

  const card = [
    ...aired,
    {
      ...bout,
      result,
      directives,
      endsAt: bout.startsAt + result.ticks * BOXING_MODEL.physicsStepSeconds * 1000,
    },
    ...booked,
  ];

  return {
    ...state,
    card: retimeCard(card, aired.length + 1),
    nextBoutId: state.nextBoutId + 1,
  };
}
