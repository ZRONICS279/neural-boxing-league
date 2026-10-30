import assert from "node:assert/strict";
import test from "node:test";
import {
  BETWEEN_CARDS_MS,
  CARD_BOUTS,
  INTERMISSION_MS,
  POST_FIGHT_MS,
  RESET_CARD_DELAY_MS,
  TITLE_SHOT_ROTATION,
  WEEK_MS,
  advanceBroadcast,
  airtimeEnd,
  applyLadderResult,
  createBroadcast,
  currentBout,
  isAftermath,
  leagueNow,
  nextChallenger,
  openDoorsNow,
  pairKey,
  reanchorClock,
  resetCardNow,
  replayBout,
  tickForTime,
  upgradeBroadcast,
  type DivisionState,
  type ScheduledBout,
} from "../app/broadcast.ts";
import { createInitialLeague } from "../app/simulation.ts";

const START = 1_700_000_000_000;

/** A broadcast advanced far enough to have a full card and a bout on air. */
async function bootedBroadcast() {
  const league = createInitialLeague();
  const state = createBroadcast(league, START);
  return advanceBroadcast(state, league, { realNow: START, maxSimulate: 1 });
}

test("the league clock is a shared function of wall time, rate, and pause", () => {
  const clock = { anchorRealMs: START, anchorLeagueMs: 0, rate: 1 };
  assert.equal(leagueNow(clock, START + 5_000), 5_000);

  const fast = reanchorClock(clock, START + 5_000, 4);
  assert.equal(leagueNow(fast, START + 5_000), 5_000, "re-anchoring never jumps the clock");
  assert.equal(leagueNow(fast, START + 6_000), 9_000, "4x covers four seconds of league time");

  const paused = reanchorClock(fast, START + 6_000, 0);
  assert.equal(leagueNow(paused, START + 60_000), 9_000, "a paused broadcast stops for everyone");
});

test("every viewer replays the same bout from any join point", async () => {
  const { state } = await bootedBroadcast();
  const bout = state.card.find((entry) => entry.result && entry.profiles);
  assert.ok(bout, "the imminent bout is simulated up front");

  const target = Math.floor(bout.result!.ticks * 0.6);

  // Someone who has watched from the opening bell, versus someone who just
  // opened the page and caught up in one burst.
  const watched = replayBout(bout, target);
  const joinedLate = replayBout(bout, target);
  assert.deepEqual(watched, joinedLate);

  // And someone who stepped away and came back mid-fight resumes rather than
  // restarting, landing on that identical frame.
  const resumed = replayBout(bout, target, replayBout(bout, Math.floor(target / 3)));
  assert.deepEqual(resumed, watched, "a tab-away must not fork the fight");
});

test("the replay clock never runs a bout past its own final bell", async () => {
  const { state } = await bootedBroadcast();
  const bout = state.card.find((entry) => entry.result && entry.profiles)!;

  assert.equal(tickForTime(bout, bout.startsAt), 0);
  assert.equal(
    tickForTime(bout, bout.endsAt + POST_FIGHT_MS * 10),
    bout.result!.ticks,
    "the held result sits on the last frame instead of simulating into nothing",
  );
});

test("a finished bout holds the stage for thirty seconds before the card moves on", async () => {
  const { state } = await bootedBroadcast();
  const bout = state.card.find((entry) => entry.result)!;

  assert.equal(currentBout(state, bout.endsAt - 1)?.id, bout.id);
  assert.equal(isAftermath(bout, bout.endsAt - 1), false);

  assert.equal(currentBout(state, bout.endsAt + 1)?.id, bout.id, "the verdict stays up");
  assert.equal(isAftermath(bout, bout.endsAt + 1), true);
  assert.equal(isAftermath(bout, bout.endsAt + POST_FIGHT_MS - 1), true);

  assert.equal(currentBout(state, airtimeEnd(bout) + 1), null, "then it clears");
  assert.equal(airtimeEnd(bout) - bout.endsAt, POST_FIGHT_MS);
});

test("the day's card is announced ahead, in order, with no fight booked twice", async () => {
  const { state } = await bootedBroadcast();

  assert.equal(state.card.length, CARD_BOUTS, "a whole night is on the board");

  const seen = new Set<string>();
  for (const bout of state.card) {
    const key = pairKey(bout.blueId, bout.redId);
    assert.ok(!seen.has(key), `${key} was booked twice on one card`);
    seen.add(key);
    assert.notEqual(bout.blueId, bout.redId);
  }

  for (let index = 1; index < state.card.length; index += 1) {
    const previous = state.card[index - 1];
    const bout = state.card[index];
    assert.ok(bout.startsAt > previous.startsAt, "slots run forwards");
    assert.equal(
      bout.startsAt,
      airtimeEnd(previous) + INTERMISSION_MS,
      "each slot queues behind the previous result's hold",
    );
  }

  // Divisions take turns rather than one weight class going dark.
  const rotation = state.card.slice(0, 3).map((bout) => bout.division);
  assert.equal(new Set(rotation).size, 3);
});

test("nobody is booked twice on one night's card", async () => {
  // Fifteen bouts is thirty corners, and every one of them is a different man.
  // A division carries a champion plus eleven contenders and gets five slots,
  // so the planner has exactly enough people and no slack to reuse anyone.
  const league = createInitialLeague();
  const { state } = await advanceBroadcast(createBroadcast(league, START), league, {
    realNow: START,
    maxSimulate: 0,
  });

  assert.equal(state.card.length, CARD_BOUTS, "a full card, not a short one");
  const corners = state.card.flatMap((bout) => [bout.blueId, bout.redId]);
  assert.equal(corners.length, CARD_BOUTS * 2);

  const twice = corners.filter((id, index) => corners.indexOf(id) !== index);
  assert.deepEqual([...new Set(twice)], [], "these men were booked twice in one night");
});

test("a title week books one belt fight per division, not six", async () => {
  // `titleFightThisWeek` is only raised when a title bout is *fought*, and the
  // whole card is planned before any of it is — so on the night the week turns
  // over, the belt branch fired for every slot its division got and the night
  // came out as the same three fights booked six times each. It reached the
  // chain that way: eighteen markets on three real matchups.
  const league = createInitialLeague();
  const state = createBroadcast(league, START);
  // Stand the league a week on, with the card still to be drawn up.
  const titleWeek = { ...state, weekStartedAt: -WEEK_MS };

  const { state: carded } = await advanceBroadcast(titleWeek, league, {
    realNow: START,
    maxSimulate: 0,
  });

  assert.equal(carded.card.length, CARD_BOUTS);
  const seen = new Set<string>();
  for (const bout of carded.card) {
    const key = pairKey(bout.blueId, bout.redId);
    assert.ok(!seen.has(key), `${key} was booked twice on a title-week card`);
    seen.add(key);
  }

  // The belt still goes up — once per division, which is the whole point of
  // the branch. Suppressing it entirely would be the other way to pass this.
  const titles = carded.card.filter((bout) => bout.kind === "title");
  assert.equal(titles.length, carded.divisions.length, "every division defends once");
  assert.equal(
    new Set(titles.map((bout) => bout.division)).size,
    titles.length,
    "and no division defends twice",
  );
});

/** A division standing on its own, so the rotation can be run off week by week
 *  without a whole card around it. */
function standingDivision(contenders: number): DivisionState {
  return {
    id: "middleweight",
    championId: "champ",
    ladder: Array.from({ length: contenders }, (_, rank) => `rank-${rank + 1}`),
    titleDefences: 0,
    lastFought: {},
    recentChallengers: [],
    titleFightThisWeek: false,
  };
}

/** The division's belt on the line against one of its contenders. */
function boutOf(division: DivisionState, week: number, challenger: string): ScheduledBout {
  return {
    id: week,
    seed: week,
    division: division.id,
    kind: "title",
    blueId: division.championId!,
    redId: challenger,
    startsAt: week * WEEK_MS,
    endsAt: week * WEEK_MS + 1,
    totalRounds: 5,
    roundSeconds: 180,
    result: null,
    directives: [],
    committed: false,
  };
}

/** Puts the belt up and returns the division as it stands after the verdict. */
function defend(division: DivisionState, week: number, winner: "champion" | "challenger") {
  const challenger = nextChallenger(division);
  assert.ok(challenger, "a division with contenders always has a mandatory");
  const bout = boutOf(division, week, challenger);
  const winnerId = winner === "champion" ? bout.blueId : bout.redId;
  const result = { winnerId, finish: "UD" as const, round: 5, ticks: 1, blueLanded: 0, redLanded: 0 };
  return { challenger, next: applyLadderResult(division, bout, result, bout.endsAt) };
}

test("the belt goes round the top of the ladder instead of the same two men", () => {
  // It used to be `ladder[0]` every week. A beaten challenger was put back in at
  // number two and the man he lost to was still champion, so the belt bounced
  // between the same two names indefinitely and the other nine contenders in
  // the division were never in the picture.
  let division = standingDivision(11);
  const challengers: string[] = [];
  for (let week = 1; week <= TITLE_SHOT_ROTATION + 1; week += 1) {
    const defence = defend(division, week, "champion");
    challengers.push(defence.challenger);
    division = defence.next;
  }

  assert.equal(
    new Set(challengers).size,
    challengers.length,
    `the same man challenged twice inside ${TITLE_SHOT_ROTATION} defences: ${challengers.join(", ")}`,
  );
  // And the rotation is the top of the division, not a lap of all of it: the
  // eleventh-ranked man never came into it.
  assert.deepEqual(challengers, [
    "rank-1", "rank-2", "rank-3", "rank-4", "rank-5",
    "rank-6", "rank-7", "rank-8", "rank-9", "rank-10",
  ]);

  // Once his shot has aged out, the best-ranked man is due again.
  assert.equal(defend(division, 12, "champion").challenger, "rank-1");
});

test("a beaten champion does not walk straight back into the rematch", () => {
  let division = standingDivision(11);
  const taken = defend(division, 1, "challenger");
  division = taken.next;
  assert.equal(division.championId, taken.challenger, "the belt changed hands");
  assert.equal(division.ladder[0], "champ", "and the old champion tops the ladder");

  // Top of the ladder, and still not the mandatory: he has just had the belt.
  // This is the case the old matchmaker got exactly backwards — losing it made
  // him first in the queue to win it back.
  const rematches: number[] = [];
  for (let week = 2; week <= TITLE_SHOT_ROTATION + 2; week += 1) {
    const defence = defend(division, week, "champion");
    if (defence.challenger === "champ") rematches.push(week);
    division = defence.next;
  }
  assert.deepEqual(
    rematches,
    [TITLE_SHOT_ROTATION + 2],
    "the deposed champion should wait out the rotation, then go straight up",
  );
});

test("an upgraded card remembers the title shot it has just aired", () => {
  // A league saved before the rotation existed carries no list of who the belt
  // has been round to, and the man at the top of its ladder is very often the
  // champion it just deposed. Reading the night on air is what stops the change
  // shipping the rematch it was made to prevent.
  const league = createInitialLeague();
  const standing = standingDivision(11);
  const bout = {
    ...boutOf(standing, 1, "rank-1"),
    result: { winnerId: "rank-1", finish: "KO" as const, round: 3, ticks: 1, blueLanded: 0, redLanded: 0 },
  };
  // The night is committed, so the division on the saved state is the one the
  // fight left behind: a new champion, and the old one back on the ladder.
  const division = applyLadderResult(standing, bout, bout.result, bout.endsAt);
  const saved = {
    ...createBroadcast(league, START),
    divisions: [{ ...division, recentChallengers: undefined }],
    card: [{ ...bout, committed: true }],
  };

  const upgraded = upgradeBroadcast(JSON.parse(JSON.stringify(saved)));
  assert.ok(upgraded);
  // "rank-1" left that fight with the belt, so the man he took it from is the
  // one whose shot is spent — and he is the one sitting at the top of the
  // ladder, first in line under the old rule.
  assert.deepEqual(upgraded.divisions[0].recentChallengers, ["champ"]);
  assert.equal(
    nextChallenger(upgraded.divisions[0]),
    "rank-2",
    "so the belt moves on instead of going straight back to the man who lost it",
  );
});

test("a division too small for the rotation still defends every week", () => {
  // The calendar only rolls once every division has fought for its belt. A
  // division with fewer contenders than the rotation is wide would run out of
  // fresh names and, if that meant no title fight, stop the league's week dead.
  let division = standingDivision(3);
  const challengers: string[] = [];
  for (let week = 1; week <= 8; week += 1) {
    const defence = defend(division, week, "champion");
    challengers.push(defence.challenger);
    division = defence.next;
  }
  assert.equal(challengers.length, 8, "every week found a challenger");
  assert.deepEqual(
    challengers.slice(3),
    ["rank-1", "rank-2", "rank-3", "rank-1", "rank-2"],
    "and once everyone has had one it goes back to whoever has waited longest",
  );
});

test("only the imminent bout is fought, so later slots use final careers", async () => {
  const { state } = await bootedBroadcast();
  const fought = state.card.filter((bout) => bout.result);
  const booked = state.card.filter((bout) => !bout.result);

  assert.ok(fought.length >= 1, "the fight on air is real");
  assert.ok(booked.length > 0, "the rest of the night is billing only");
  assert.ok(
    booked.every((bout) => !bout.profiles),
    "an unfought slot carries no athlete snapshot",
  );
});

test("a fully fought card rolls over into a fresh night", async () => {
  const league = createInitialLeague();
  let state = createBroadcast(league, START);
  let carried = league;
  let realNow = START;

  const opening = await advanceBroadcast(state, carried, { realNow, maxSimulate: 20 });
  state = opening.state;
  carried = opening.league;
  const firstNight = new Set(state.card.map((bout) => bout.id));
  assert.equal(firstNight.size, CARD_BOUTS);

  // Run the whole night off, jumping the wall clock past each bout as it airs.
  let rolled = false;
  for (let pass = 0; pass < 60 && !rolled; pass += 1) {
    const last = state.card[state.card.length - 1];
    const ahead = airtimeEnd(last) + 1_000 - leagueNow(state.clock, realNow);
    if (ahead > 0) realNow += ahead;
    const step = await advanceBroadcast(state, carried, { realNow, maxSimulate: 20 });
    state = step.state;
    carried = step.league;
    rolled = state.card.every((bout) => !firstNight.has(bout.id));
  }

  assert.ok(rolled, "the card eventually rolls over");
  assert.equal(state.card.length, CARD_BOUTS, "the next night is a full card again");
  assert.ok(
    state.card.every((bout) => !bout.committed),
    "a rolled card carries none of the previous night's results",
  );
  assert.ok(
    carried.boutsCompleted >= CARD_BOUTS,
    `every fight on the finished card was paid into careers (got ${carried.boutsCompleted})`,
  );
});

/** A broadcast run all the way through one night, so what is on the board is the
 *  next card and the league is in the dark hours before it. */
async function betweenCards() {
  const league = createInitialLeague();
  let state = createBroadcast(league, START);
  let carried = league;
  let realNow = START;

  const opening = await advanceBroadcast(state, carried, { realNow, maxSimulate: 20 });
  state = opening.state;
  carried = opening.league;
  const firstNight = new Set(state.card.map((bout) => bout.id));
  const night = state.night;

  // Run the whole night off, and hold on to the moment its last result cleared.
  for (let pass = 0; pass < 60; pass += 1) {
    const last = state.card[state.card.length - 1];
    const lastBell = airtimeEnd(last);
    const ahead = lastBell + 1_000 - leagueNow(state.clock, realNow);
    if (ahead > 0) realNow += ahead;
    const step = await advanceBroadcast(state, carried, { realNow, maxSimulate: 20 });
    state = step.state;
    carried = step.league;
    if (state.card.every((bout) => !firstNight.has(bout.id))) {
      return { state, league: carried, realNow, lastBell, night };
    }
  }
  throw new Error("the card never rolled over");
}

test("the next card goes up in full, six hours before its first bell", async () => {
  const { state, league: carried, realNow, lastBell, night } = await betweenCards();

  assert.equal(state.night, night + 1, "the new card is billed as the next night");
  assert.equal(state.card.length, CARD_BOUTS, "the whole line-up is announced at once");
  assert.equal(
    state.card[0].startsAt,
    lastBell + BETWEEN_CARDS_MS,
    "the first bell is six hours after the previous night cleared",
  );
  assert.ok(
    state.card.every((bout) => !bout.result && !bout.profiles),
    "nothing on the next card has been fought yet",
  );

  // An hour into the dark, the card is still only billing: careers must stay
  // final right up to the night itself.
  const waiting = await advanceBroadcast(state, carried, {
    realNow: realNow + 60 * 60 * 1000,
    maxSimulate: 20,
  });
  assert.ok(
    waiting.state.card.every((bout) => !bout.result),
    "no fight is run during the gap between cards",
  );
  assert.equal(
    waiting.league.boutsCompleted,
    carried.boutsCompleted,
    "no career moves during the gap either",
  );

  // And when the doors do open, the night that was posted is the night fought.
  const opened = await advanceBroadcast(state, carried, {
    realNow: START + state.card[0].startsAt,
    maxSimulate: 1,
  });
  assert.ok(opened.state.card[0].result, "the first bout is fought when its slot comes up");
  assert.equal(
    opened.state.card[0].id,
    state.card[0].id,
    "the fight that airs is the one that was on the board all evening",
  );
});

test("a sleeping league catches up on the billed six-hour cadence", async () => {
  const league = createInitialLeague();
  const opening = await advanceBroadcast(createBroadcast(league, START), league, {
    realNow: START,
    maxSimulate: 0,
  });
  // The calendar only needs the cleared airtimes here. Results and careers are
  // covered above; keeping this fixture light makes the schedule regression a
  // clock test rather than another fifty-second fight-night simulation.
  const finished = {
    ...opening.state,
    card: opening.state.card.map((bout) => ({ ...bout, committed: true })),
  };
  const lastBell = airtimeEnd(finished.card[finished.card.length - 1]);
  const wokeAt = START + lastBell + BETWEEN_CARDS_MS + 4 * 60 * 60 * 1000;
  const rolled = await advanceBroadcast(finished, opening.league, {
    realNow: wokeAt,
    maxSimulate: 0,
  });
  assert.equal(rolled.state.night, finished.night + 1, "the old night is cleared");
  assert.equal(
    rolled.state.card[0].startsAt,
    lastBell + BETWEEN_CARDS_MS,
    "the missed card keeps the bell billed from the prior night's finish",
  );
  assert.ok(
    rolled.state.card[0].startsAt < leagueNow(rolled.state.clock, wokeAt),
    "waking the worker does not reset an overdue opening bell to now",
  );
});

test("an operator can call the night on without waiting out the gap", async () => {
  const { state, league, realNow } = await betweenCards();
  const spacing = state.card[1].startsAt - state.card[0].startsAt;

  const opened = openDoorsNow(state, realNow);
  assert.equal(
    opened.card[0].startsAt,
    leagueNow(opened.clock, realNow),
    "the opening bell is right now",
  );
  assert.deepEqual(
    opened.card.map((bout) => bout.id),
    state.card.map((bout) => bout.id),
    "the same fights, in the same order",
  );
  assert.equal(
    opened.card[1].startsAt - opened.card[0].startsAt,
    spacing,
    "the running order keeps the spacing it was billed with",
  );

  const advanced = await advanceBroadcast(opened, league, { realNow, maxSimulate: 1 });
  assert.ok(advanced.state.card[0].result, "the first bout goes ahead once the doors open");

  // And it refuses on a night already under way rather than stacking a bout on
  // top of the one on air.
  assert.equal(
    openDoorsNow(advanced.state, realNow + 60_000),
    advanced.state,
    "a running card is left alone",
  );
});

test("an operator can replace the current card with a five-minute countdown", async () => {
  const league = createInitialLeague();
  const opening = await advanceBroadcast(createBroadcast(league, START), league, {
    realNow: START,
    maxSimulate: 1,
  });
  const old = opening.state;
  const realNow = START + 90_000;
  const reset = resetCardNow(
    { ...old, clock: reanchorClock(old.clock, realNow, 0) },
    realNow,
  );
  const prepared = await advanceBroadcast(reset, opening.league, {
    realNow,
    maxSimulate: 0,
    firstBell: leagueNow(reset.clock, realNow) + RESET_CARD_DELAY_MS,
  });

  assert.equal(prepared.state.night, old.night + 1);
  assert.equal(prepared.state.clock.rate, 1, "a reset returns the broadcast to live speed");
  assert.equal(prepared.state.card.length, CARD_BOUTS);
  assert.equal(
    prepared.state.card[0].startsAt,
    leagueNow(prepared.state.clock, realNow) + RESET_CARD_DELAY_MS,
    "the replacement card has a five-minute countdown instead of the six-hour wait",
  );
  assert.ok(
    prepared.state.card.every((bout) => !bout.result && !bout.profiles),
    "the card is completely set up before its first fight is simulated",
  );
  assert.deepEqual(prepared.state.divisions, old.divisions, "rankings carry into the new card");
  assert.ok(
    prepared.state.card.every((bout) => !old.card.some((entry) => entry.id === bout.id)),
    "nothing running or scheduled on the discarded card survives",
  );
});

test("results move the ladder and are committed to careers once", async () => {
  const league = createInitialLeague();
  let state = createBroadcast(league, START);
  let carried = league;

  const first = await advanceBroadcast(state, carried, { realNow: START, maxSimulate: 1 });
  state = first.state;
  carried = first.league;

  const bout = state.card.find((entry) => entry.result)!;
  const before = carried.roster.find((f) => f.id === bout.result!.winnerId!)!;

  // Jump the wall clock past the final bell so the result is committed.
  const after = await advanceBroadcast(state, carried, {
    realNow: START + (bout.endsAt - leagueNow(state.clock, START)) + 1_000,
    maxSimulate: 0,
  });

  const winner = after.league.roster.find((f) => f.id === before.id)!;
  assert.equal(winner.record.wins, before.record.wins + 1);
  assert.ok(winner.xp > 0 || winner.level > before.level, "the night is worth experience");

  const committed = after.state.card.find((entry) => entry.id === bout.id)!;
  assert.equal(committed.committed, true);

  // Advancing again must not pay the same result out a second time.
  const repeat = await advanceBroadcast(after.state, after.league, {
    realNow: START + (bout.endsAt - leagueNow(state.clock, START)) + 2_000,
    maxSimulate: 0,
  });
  const twice = repeat.league.roster.find((f) => f.id === before.id)!;
  assert.equal(twice.record.wins, winner.record.wins, "a result commits exactly once");
});

test("an aired result teaches the two brains that fought it", async () => {
  const league = createInitialLeague();
  const state = createBroadcast(league, START);
  let carried = league;
  let card = state;
  let realNow = START;

  // Run the night until results start being committed to careers.
  for (let step = 0; step < 12 && carried.boutsCompleted === 0; step += 1) {
    const advanced = await advanceBroadcast(card, carried, {
      realNow,
      maxSimulate: 4,
    });
    card = advanced.state;
    carried = advanced.league;
    realNow += 6 * 60 * 1000;
  }

  const taught = carried.roster.filter(
    (fighter) => fighter.policy.learnedDecisions > 0,
  );
  const untouched = carried.roster.filter(
    (fighter) => fighter.policy.learnedDecisions === 0,
  );

  assert.ok(carried.boutsCompleted > 0);
  // Two brains per committed fight, and nobody else's.
  assert.equal(taught.length, carried.boutsCompleted * 2);
  for (const fighter of taught) {
    const debut = league.roster.find((entry) => entry.id === fighter.id)!;
    assert.ok(fighter.record.wins + fighter.record.losses + fighter.record.draws > 0);
    assert.notDeepEqual(fighter.policy.outputWeights, debut.policy.outputWeights);
  }
  for (const fighter of untouched) {
    const debut = league.roster.find((entry) => entry.id === fighter.id)!;
    assert.deepEqual(fighter.policy, debut.policy);
  }
});
