import assert from "node:assert/strict";
import test from "node:test";
import type { BroadcastClock, ScheduledBout } from "../app/broadcast.ts";
import {
  BODY_LERP_FIELDS,
  type TimelineFighterFrame,
  type TimelineFrame,
} from "../app/fight-timeline.ts";
import {
  MAX_INPLAY_LINE,
  MIN_INPLAY_LINE,
  inPlayLine,
} from "../worker/inplay-line.ts";
import { CLOSE_LEAD_MS, bookCloseDue, staleRestingOrders } from "../worker/market-operator.ts";
import type { RoundCard } from "../app/fight-model.ts";

/* ------------------------------------------------------- the in-play line */

/** A fighter frame at the opening bell: fresh, upright, nothing thrown. */
function freshFighter(corner: "blue" | "red"): TimelineFighterFrame {
  const body = {} as TimelineFighterFrame["body"];
  for (const field of BODY_LERP_FIELDS) body[field] = 0;
  body.plantedFoot = "both";
  return {
    fighterId: corner === "blue" ? "fl-blue" : "fl-red",
    corner,
    heightM: 1.8,
    reachM: 1.85,
    x: 2,
    y: 3,
    headLevel: 0,
    headOffset: 0,
    health: 100,
    stamina: 100,
    headTrauma: 0,
    hurtSeconds: 0,
    stunSeconds: 0,
    downCountSeconds: 0,
    handVelocity: 0,
    punchAimHeight: 0,
    decisionConfidence: 0,
    peakHandSpeed: 0,
    peakForceN: 0,
    cleanImpactJ: 0,
    body,
    action: "guard",
    actionElapsed: 0,
    actionDuration: 0.5,
    punchHand: "lead",
    punchAimZone: "guard",
    punchExtensionTarget: 0,
    facingDirection: 1,
    lastStrikeKind: "none",
    lastImpactZone: "guard",
    lastImpactJ: 0,
    lastImpactCounter: false,
    thrown: 0,
    landed: 0,
    blocked: 0,
    knockdowns: 0,
  };
}

function frameWith(
  left: Partial<TimelineFighterFrame>,
  right: Partial<TimelineFighterFrame>,
  bout: Partial<Pick<TimelineFrame, "round" | "roundTime">> = {},
): TimelineFrame {
  return {
    tick: 0,
    round: bout.round ?? 1,
    roundTime: bout.roundTime ?? 180,
    breakTime: 0,
    introSeconds: 0,
    roundLength: 180,
    totalRounds: 3,
    left: { ...freshFighter("blue"), ...left },
    right: { ...freshFighter("red"), ...right },
  };
}

/** One revealed round, scored unanimously for the given side. */
function roundFor(side: "left" | "right", round: number): RoundCard {
  return {
    round,
    judges: [0, 1, 2].map((judge) => ({
      judge,
      left: side === "left" ? 10 : 9,
      right: side === "right" ? 10 : 9,
    })),
    leftCleanBlows: 0,
    rightCleanBlows: 0,
    leftImpactJ: 0,
    rightImpactJ: 0,
  };
}

test("the in-play line opens on the opening line", () => {
  const line = inPlayLine(58, frameWith({}, {}), []);
  assert.equal(Math.round(line), 58);
});

test("winning the damage fight moves the line toward the man winning it", () => {
  const even = inPlayLine(50, frameWith({}, {}), []);
  const blueAhead = inPlayLine(50, frameWith({ health: 90 }, { health: 55 }), []);
  const redAhead = inPlayLine(50, frameWith({ health: 55 }, { health: 90 }), []);
  assert.ok(blueAhead > even + 5, `blue ahead reads ${blueAhead}`);
  assert.ok(redAhead < even - 5, `red ahead reads ${redAhead}`);
  // The two mirror: swapping the damage swaps the price.
  assert.ok(Math.abs(blueAhead + redAhead - 100) < 0.01);
});

test("a man on the canvas is a spike, and it subsides when he beats the count", () => {
  const before = inPlayLine(50, frameWith({}, {}), []);
  const down = inPlayLine(
    50,
    frameWith({}, { downCountSeconds: 3, health: 62, knockdowns: 0 }),
    [],
  );
  const survived = inPlayLine(50, frameWith({}, { health: 62 }), []);
  assert.ok(down > 75, `count in progress reads ${down}`);
  assert.ok(survived < down - 10, `back on his feet reads ${survived}`);
  assert.ok(survived > before, "the damage that put him down still counts");
});

test("a lead is not a verdict: the same edge prices harder late than early", () => {
  // A round banked and a solid health edge — the Ito–Vale shape that read 87
  // midway through round two. Early it should hold a clear but honest lead;
  // by the last round the same picture is most of the fight.
  const early = inPlayLine(
    55,
    frameWith({ health: 87 }, { health: 55 }, { round: 2, roundTime: 61 }),
    [roundFor("left", 1)],
  );
  const late = inPlayLine(
    55,
    frameWith({ health: 87 }, { health: 55 }, { round: 3, roundTime: 20 }),
    [roundFor("left", 1), roundFor("left", 2)],
  );
  assert.ok(early > 65, `mid-fight lead reads ${early}`);
  assert.ok(early < 82, `mid-fight lead reads ${early}, calling it early`);
  assert.ok(late > early + 8, `the same lead in the final minute reads ${late}`);
});

test("an early massacre still prices like one", () => {
  // Round one, but one man has been dropped twice and beaten half to death —
  // the obvious beating punches through the early temper, and the danger and
  // peril terms never tempered at all.
  const buried = inPlayLine(
    50,
    frameWith({ knockdowns: 2 }, { health: 30, hurtSeconds: 1.5 }, { round: 1, roundTime: 40 }),
    [],
  );
  assert.ok(buried > 80, `a round-one beating reads ${buried}`);
});

test("rounds banked are worth more the deeper the fight goes", () => {
  const cards: RoundCard[] = [roundFor("left", 1), roundFor("left", 2)];
  const early = inPlayLine(50, frameWith({}, {}, { round: 2, roundTime: 175 }), [cards[0]]);
  const late = inPlayLine(50, frameWith({}, {}, { round: 3, roundTime: 30 }), cards);
  assert.ok(early > 50, `one round up early reads ${early}`);
  assert.ok(late > early + 8, `two up entering the last minute reads ${late}`);
});

test("the line never calls the fight before the referee does", () => {
  const buried = inPlayLine(
    75,
    frameWith(
      { knockdowns: 3 },
      { health: 4, stunSeconds: 2, hurtSeconds: 2, downCountSeconds: 5 },
    ),
    [roundFor("left", 1), roundFor("left", 2)],
  );
  assert.ok(buried <= MAX_INPLAY_LINE);
  const drowning = inPlayLine(
    25,
    frameWith(
      { health: 4, stunSeconds: 2, hurtSeconds: 2, downCountSeconds: 5 },
      { knockdowns: 3 },
    ),
    [roundFor("right", 1), roundFor("right", 2)],
  );
  assert.ok(drowning >= MIN_INPLAY_LINE);
});

/* ------------------------------------------------------------- the close */

const RESULT = {
  winnerId: "fl-blue",
  finish: "KO" as const,
  round: 2,
  ticks: 15_000,
  blueLanded: 30,
  redLanded: 22,
};

function boutEnding(startsAt: number, endsAt: number, fought = true): ScheduledBout {
  return {
    id: 700,
    seed: fought ? 4242 : 0,
    division: "middleweight",
    kind: "contender",
    blueId: "fl-blue",
    redId: "fl-red",
    startsAt,
    endsAt,
    totalRounds: 3,
    roundSeconds: 180,
    result: fought ? RESULT : null,
    directives: [],
    committed: fought,
  };
}

/** A clock whose league time equals real time, anchored at zero. */
function clockAt(rate: number): BroadcastClock {
  return { anchorRealMs: 0, anchorLeagueMs: 0, rate };
}

test("the book rides the whole fight and shuts at the finish, never before", () => {
  const bout = boutEnding(0, 600_000);
  const clock = clockAt(1);
  // Open at the bell, open mid-fight, open one second from the finish. The
  // lead is zero: a book that shuts early is an announcement that the finish
  // is booked, so the close waits for the final bell itself and
  // `ensureBoutClosed` holds the reveal until it has landed.
  assert.equal(bookCloseDue(bout, clock, 0), false);
  assert.equal(bookCloseDue(bout, clock, 300_000), false);
  assert.equal(bookCloseDue(bout, clock, 600_000 - CLOSE_LEAD_MS - 1_000), false);
  // Shut at the bell and after it.
  assert.equal(bookCloseDue(bout, clock, 600_000), true);
  assert.equal(bookCloseDue(bout, clock, 900_000), true);
});

test("the close tracks the aired finish, whatever speed the broadcast runs at", () => {
  const bout = boutEnding(0, 600_000);
  const fast = clockAt(4);
  // At 4x the final bell lands at real ms 150_000, and that is the moment the
  // book is due to shut — not a league-time 600_000 that never arrives on the
  // wall clock.
  assert.equal(bookCloseDue(bout, fast, 149_000), false);
  assert.equal(bookCloseDue(bout, fast, 150_000), true);
});

test("a paused broadcast airs nothing, so nothing needs closing", () => {
  const bout = boutEnding(0, 600_000);
  const paused: BroadcastClock = { anchorRealMs: 0, anchorLeagueMs: 590_000, rate: 0 };
  assert.equal(bookCloseDue(bout, paused, 1_000_000), false);
  // Unless the finish already aired before the pause landed.
  const pausedLate: BroadcastClock = { anchorRealMs: 0, anchorLeagueMs: 600_000, rate: 0 };
  assert.equal(bookCloseDue(bout, pausedLate, 1_000_000), true);
});

test("a slot with no simulated result falls back to closing at the bell", () => {
  const bout = boutEnding(100_000, 700_000, false);
  const clock = clockAt(1);
  assert.equal(bookCloseDue(bout, clock, 99_000), false);
  assert.equal(bookCloseDue(bout, clock, 100_000), true);
});

test("reclaim cancels orders on scored bouts and rollover strays, never live quotes", () => {
  const onChain = [
    { boutId: 100n, resolved: true },
    { boutId: 101n, resolved: false },
  ];
  const open = [
    { boutId: 100n },  // scored tonight — cancel
    { boutId: 101n },  // the maker's own quote on an open bout — keep
    { boutId: 42n },   // a night that rolled over weeks ago — cancel
  ];
  assert.deepEqual(
    staleRestingOrders(open, onChain).map((order) => order.boutId),
    [100n, 42n],
  );
  // The wedge that filled the operator's 500 order slots: every stray was on
  // an off-card bout, and none of tonight's bouts were scored yet. The strays
  // must still be stale.
  assert.deepEqual(
    staleRestingOrders([{ boutId: 42n }, { boutId: 43n }], [{ boutId: 101n, resolved: false }])
      .map((order) => order.boutId),
    [42n, 43n],
  );
});
