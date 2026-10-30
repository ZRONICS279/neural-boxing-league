import assert from "node:assert/strict";
import test from "node:test";
import type { BoutFighter, FighterAction } from "../app/fight-model.ts";
import type { PlayerButton } from "../app/player-controls.ts";
import {
  BLOCK_KEY,
  DIFFICULTIES,
  KEY_BINDINGS,
  TOUCH_BINDINGS,
  createPlayerController,
  keyboardButton,
  dodgeFor,
  emptySnapshot,
  movementAxes,
  namedPunchFor,
  powerPunchFor,
  resolvePlayerAction,
} from "../app/player-controls.ts";
import {
  PLAYER_FIGHTER_ID,
  advanceBout,
  createBout,
  createInitialLeague,
  exhibitionFighter,
  playerFighter,
  simulateBoutToCompletion,
} from "../app/simulation.ts";

/** Only the handful of fields the controller reads. */
function corner(overrides: Partial<BoutFighter> = {}) {
  return {
    x: 2,
    y: 3,
    reachM: 1.8,
    action: "guard",
    ...overrides,
  } as BoutFighter;
}

test("the power button picks its punch off range, not a roll", () => {
  const player = corner({ x: 2, reachM: 1.8 });

  // Inside the pocket the uppercut is the shot: a cross from here would land on
  // the shoulder, and the hook has a button of its own to be asked for by name.
  assert.equal(powerPunchFor(player, corner({ x: 3.0 }), 0), "uppercut");

  const midRange = powerPunchFor(player, corner({ x: 3.3 }), 0);
  assert.ok(midRange.startsWith("hook"), `got ${midRange}`);

  const outside = powerPunchFor(player, corner({ x: 4.2 }), 1);
  assert.ok(outside.startsWith("cross"), `got ${outside}`);
});

test("the same range and rotation always give the same punch", () => {
  const player = corner();
  const opponent = corner({ x: 3.9 });
  for (let rotation = 0; rotation < 6; rotation += 1) {
    assert.equal(
      powerPunchFor(player, opponent, rotation),
      powerPunchFor(player, opponent, rotation),
    );
  }
});

test("the rotation stops a held thumb throwing one punch forever", () => {
  const player = corner();
  // At hooking range, where the button still has more than one option. In the
  // pocket it is deliberately always the uppercut.
  const opponent = corner({ x: 3.3 });
  const thrown = new Set(
    Array.from({ length: 4 }, (_, index) => powerPunchFor(player, opponent, index)),
  );
  assert.ok(thrown.size > 1, "power button never varied its shot");
});

test("a named punch is the punch you named, and the range only picks the target", () => {
  const player = corner();

  assert.equal(namedPunchFor("hook", player, corner({ x: 2.7 })), "hookBody");
  assert.equal(namedPunchFor("hook", player, corner({ x: 3.4 })), "hookHead");
  assert.equal(namedPunchFor("cross", player, corner({ x: 3.1 })), "crossBody");
  assert.equal(namedPunchFor("cross", player, corner({ x: 4.2 })), "crossHead");

  // The jab is the range-finder and always goes upstairs, from anywhere.
  for (const x of [2.6, 3.4, 4.2]) {
    assert.equal(namedPunchFor("jab", player, corner({ x })), "jabHead");
  }
});

test("the named punches are the ones whose guard the player is choosing between", () => {
  const player = corner();
  const opponent = corner({ x: 3.4 });
  const thrown = ["jab", "hook", "cross"].map((button) =>
    namedPunchFor(button as "jab" | "hook" | "cross", player, opponent),
  );
  assert.deepEqual(thrown, ["jabHead", "hookHead", "crossHead"]);
});

test("one dodge button answers the punch that is actually coming", () => {
  assert.equal(dodgeFor(corner({ action: "hookHead" })), "duck");
  assert.equal(dodgeFor(corner({ action: "uppercut" })), "duck");
  assert.equal(dodgeFor(corner({ action: "jabHead" })), "slip");
  assert.equal(dodgeFor(corner({ action: "crossBody" })), "weave");
  // Nothing incoming falls to the shortest commitment of the three.
  assert.equal(dodgeFor(corner({ action: "advance" })), "slip");
});

test("WASD are screen directions: D right, A left, W far, S near", () => {
  assert.deepEqual(movementAxes(new Set(["d"])), { x: 1, y: 0 });
  assert.deepEqual(movementAxes(new Set(["a"])), { x: -1, y: 0 });
  assert.deepEqual(movementAxes(new Set(["w"])), { x: 0, y: -1 });
  assert.deepEqual(movementAxes(new Set(["s"])), { x: 0, y: 1 });
});

test("the controls do not flip when the fighters trade sides", () => {
  const controller = createPlayerController();
  const push = (player: BoutFighter, opponent: BoutFighter, x: number, y: number) =>
    resolvePlayerAction(controller, { ...emptySnapshot(), x, y }, player, opponent, 0);

  // Opponent to the player's right: pressing D closes on him.
  assert.equal(push(corner({ x: 2, y: 3 }), corner({ x: 4, y: 3 }), 1, 0), "advance");
  // Now the player has circled past and the opponent is on his LEFT. D still has
  // to walk him toward the right of the ring, which is now backing away.
  assert.equal(push(corner({ x: 4, y: 3 }), corner({ x: 2, y: 3 }), 1, 0), "retreat");
  // And A is always the left of the ring, on either side of him.
  assert.equal(push(corner({ x: 2, y: 3 }), corner({ x: 4, y: 3 }), -1, 0), "retreat");
  assert.equal(push(corner({ x: 4, y: 3 }), corner({ x: 2, y: 3 }), -1, 0), "advance");
});

test("W and S hold their screen direction regardless of the bearing", () => {
  const controller = createPlayerController();
  const push = (player: BoutFighter, opponent: BoutFighter, y: number) =>
    resolvePlayerAction(controller, { ...emptySnapshot(), x: 0, y }, player, opponent, 0);

  // With the opponent to the right, "up the ring" is one circling direction.
  const upRight = push(corner({ x: 2, y: 3 }), corner({ x: 4, y: 3 }), -1);
  // With the opponent to the left it is the opposite one — and W still means up.
  const upLeft = push(corner({ x: 4, y: 3 }), corner({ x: 2, y: 3 }), -1);
  assert.notEqual(upRight, upLeft, "W resolved to the same relative action on both sides");
  assert.ok(["circleLeft", "circleRight"].includes(upRight));
  assert.ok(["circleLeft", "circleRight"].includes(upLeft));
});

test("a press survives until the engine is willing to take it", () => {
  const controller = createPlayerController();
  const player = corner();
  const opponent = corner({ x: 3.4 });
  const snapshot = { ...emptySnapshot(), taps: [{ button: "jab" as const, at: 0 }] };

  const first = resolvePlayerAction(controller, snapshot, player, opponent, 0);
  assert.equal(first, "jabHead");

  // The engine is mid-action and ignored it. The next several ticks carry no
  // new input at all, and the jab has to still be on offer.
  for (const now of [20, 60, 120, 300]) {
    assert.equal(
      resolvePlayerAction(controller, emptySnapshot(), player, opponent, now),
      "jabHead",
      `buffer dropped the press at ${now} ms`,
    );
  }

  // Past the window it is a press the player has stopped waiting on, and the
  // corner falls back to the resting action rather than to nothing at all.
  assert.equal(
    resolvePlayerAction(controller, emptySnapshot(), player, opponent, 900),
    "recover",
  );
});

test("a buffered press is retired once the engine starts it", () => {
  const controller = createPlayerController();
  const opponent = corner({ x: 3.4 });
  resolvePlayerAction(
    controller,
    { ...emptySnapshot(), taps: [{ button: "jab", at: 0 }] },
    corner(),
    opponent,
    0,
  );
  const started = corner({ action: "jabHead" });
  assert.equal(resolvePlayerAction(controller, emptySnapshot(), started, opponent, 40), "recover");
  assert.equal(controller.pending, null);
});

test("two quick taps chain into a combination instead of one replacing the other", () => {
  const controller = createPlayerController();
  const player = corner();
  const opponent = corner({ x: 3.4 });
  const tap = (button: PlayerButton, at: number) =>
    resolvePlayerAction(controller, { ...emptySnapshot(), taps: [{ button, at }] }, player, opponent, at);

  // The one-two is two presses now, not a memorised double tap.
  tap("jab", 0);
  tap("cross", 90);
  assert.deepEqual(controller.queue, ["jabHead", "crossHead"]);

  // A mashing thumb cannot bank a sequence that keeps playing out after it has
  // stopped: the fourth press starts a new chain rather than lengthening this
  // one, so the queue never gets ahead of what is being asked for now.
  tap("hook", 180);
  assert.deepEqual(controller.queue, ["jabHead", "crossHead", "hookHead"]);
  tap("hook", 270);
  assert.deepEqual(controller.queue, ["hookHead"]);
});

test("a punch straight after a block leaves now rather than queueing behind the guard", () => {
  const controller = createPlayerController();
  const player = corner();
  const opponent = corner({ x: 3.4 });

  resolvePlayerAction(
    controller,
    { ...emptySnapshot(), taps: [{ button: "block", at: 0 }] },
    player,
    opponent,
    0,
  );
  assert.deepEqual(controller.queue, ["guard"]);

  const countered = resolvePlayerAction(
    controller,
    { ...emptySnapshot(), taps: [{ button: "cross", at: 90 }] },
    player,
    opponent,
    90,
  );
  assert.equal(countered, "crossHead");
  assert.deepEqual(controller.queue, ["crossHead"]);
});

test("taps too far apart stay two separate punches", () => {
  const controller = createPlayerController();
  const player = corner();
  const opponent = corner({ x: 3.4 });

  resolvePlayerAction(
    controller,
    { ...emptySnapshot(), taps: [{ button: "jab", at: 0 }] },
    player,
    opponent,
    0,
  );
  resolvePlayerAction(
    controller,
    { ...emptySnapshot(), taps: [{ button: "jab", at: 900 }] },
    player,
    opponent,
    900,
  );
  assert.equal(controller.queue.length, 1);
});

test("a resting stick resets rather than blocking, and never yields the corner", () => {
  const controller = createPlayerController();
  // An absent action is the engine's signal that no one is driving, so the
  // resolver must name one on every single tick — including this one. It must
  // not be `guard`: idling into a guard is a free permanent block.
  const action = resolvePlayerAction(
    controller,
    { ...emptySnapshot(), x: 0.2, y: -0.1 },
    corner(),
    corner({ x: 3.4 }),
    0,
  );
  assert.equal(action, "recover");
});

test("only a held B actually puts the hands up", () => {
  const controller = createPlayerController();
  const idle = resolvePlayerAction(controller, emptySnapshot(), corner(), corner({ x: 3.4 }), 0);
  const holding = resolvePlayerAction(
    createPlayerController(),
    { ...emptySnapshot(), blockHeld: true },
    corner(),
    corner({ x: 3.4 }),
    0,
  );
  assert.notEqual(idle, "guard", "a player touching nothing was blocking for free");
  assert.equal(holding, "guard");
});

test("difficulty only ever handicaps his eyes", () => {
  for (const tier of DIFFICULTIES) {
    if (tier.aiReactionSeconds === null) continue;
    assert.ok(tier.aiReactionSeconds > 0 && tier.aiReactionSeconds < 1.5);
  }
  // Pro has to sit inside the band the roster actually fights in — the stat
  // curve spans 177 to 238 ms across everybody on the card — or the tier is
  // claiming to be his league form while being something else. Championship
  // deliberately overshoots it, which is the point of that tier.
  const pro = DIFFICULTIES.find((t) => t.id === "pro")?.aiReactionSeconds ?? 0;
  assert.ok(
    pro >= 0.177 && pro <= 0.238,
    `Pro must fight inside the league's own reaction band, got ${pro}`,
  );
  const champ = DIFFICULTIES.find((t) => t.id === "championship")?.aiReactionSeconds ?? 1;
  assert.ok(champ < 0.15, "Championship must beat any real card");
  // Easier must mean slower on the draw, all the way down. A tier left on his
  // own card stands in at the roster's middle.
  const lags = DIFFICULTIES.map((t) => t.aiReactionSeconds ?? 0.21);
  for (let i = 1; i < lags.length; i += 1) {
    assert.ok(lags[i] < lags[i - 1], `tier ${i} is not sharper than the one before it`);
  }
});

test("an exhibition opponent keeps his card and loses only his learning", () => {
  const league = createInitialLeague();
  const original = league.roster[0];
  const rebuilt = exhibitionFighter(original);

  assert.deepEqual(rebuilt.stats, original.stats);
  assert.equal(rebuilt.reach, original.reach);
  assert.equal(rebuilt.seed, original.seed, "the seed drives his face and must survive");
  assert.equal(rebuilt.policy.learnedDecisions, 0);
  assert.ok(rebuilt.policy.weights.length > 0, "he needs a brain to throw a punch");
  assert.deepEqual(rebuilt.opponentDossiers, {});
});

test("a public fighter with stripped matrices is still playable after the rebuild", () => {
  const league = createInitialLeague();
  // What the browser actually receives: the card, with the learning removed.
  const stripped = {
    ...league.roster[0],
    policy: { ...league.roster[0].policy, weights: [], outputWeights: [] },
  };
  const rebuilt = exhibitionFighter(stripped);
  assert.ok(rebuilt.policy.weights.length > 0);
  assert.ok(rebuilt.policy.outputWeights.length > 0);
});

test("a forced corner throws only what the controller asked for", () => {
  const league = createInitialLeague();
  const opponent = exhibitionFighter(league.roster[0]);
  const player = playerFighter({ firstName: "You", lastName: "Challenger" }, opponent.weightClass);
  const roster = [player, opponent];
  const bout = createBout(player.id, opponent.id, 1, { totalRounds: 1 });

  assert.equal(player.id, PLAYER_FIGHTER_ID);

  // Walk out the intro so decisions are live.
  while (bout.introSeconds > 0) advanceBout(bout, roster);

  const seen = new Set<string>();
  for (let tick = 0; tick < 400; tick += 1) {
    advanceBout(bout, roster, { blue: "guard" });
    seen.add(bout.left.action);
  }

  // The player's corner never invented a punch of its own. Guard is what was
  // asked for; the engine may still slot in an interruptible defensive
  // reaction, which is the one thing a forced corner is allowed to do.
  for (const action of seen) {
    assert.ok(
      ["guard", "slip", "duck", "weave"].includes(action),
      `forced corner acted on its own: ${action}`,
    );
  }
  assert.equal(bout.left.thrown, 0, "a guarding player threw punches he never asked for");
});

test("advanceBout moves the same bout stepBoutWithActions would have cloned", () => {
  const league = createInitialLeague();
  const roster = [
    exhibitionFighter(league.roster[0]),
    exhibitionFighter(league.roster[1]),
  ];
  const bout = createBout(roster[0].id, roster[1].id, 7, { totalRounds: 1 });
  const startTick = bout.tick;
  advanceBout(bout, roster);
  assert.equal(bout.tick, startTick + 1, "the bout was not advanced in place");
});

/** The whole chain a player actually drives, with no browser in it: buttons in,
 *  controller, forced action, engine, fight out. This is the test that says the
 *  game works — the page around it only has to deliver taps. */
function playRound(
  script: (tick: number) => { button?: "jab" | "power" | "block" | "dodge"; x?: number },
  ticks = 1200,
) {
  const league = createInitialLeague();
  const opponent = exhibitionFighter(league.roster.find((f) => f.weightClass === "middleweight")!);
  const player = playerFighter({ firstName: "You", lastName: "Challenger" }, "middleweight");
  const roster = [player, opponent];
  const bout = createBout(player.id, opponent.id, 99, { totalRounds: 1 });
  const controller = createPlayerController();

  while (bout.introSeconds > 0) advanceBout(bout, roster);

  for (let tick = 0; tick < ticks && !bout.finish; tick += 1) {
    const beat = script(tick);
    const now = tick * 20;
    const snapshot = {
      ...emptySnapshot(),
      x: beat.x ?? 0,
      taps: beat.button ? [{ button: beat.button, at: now }] : [],
    };
    advanceBout(bout, roster, {
      blue: resolvePlayerAction(controller, snapshot, bout.left, bout.right, now),
    });
  }
  return bout;
}

test("a player who presses jab throws jabs and lands some of them", () => {
  // Walk him down, and jab every half second of fight time.
  const bout = playRound((tick) => ({
    x: 1,
    button: tick % 25 === 0 ? "jab" : undefined,
  }));

  assert.ok(bout.left.thrown > 15, `player only threw ${bout.left.thrown}`);
  assert.ok(bout.left.landed > 0, "the player never landed a single punch");
  assert.ok(
    bout.left.actionCounts.jabHead > 0,
    "the jab button did not produce jabs",
  );
});

test("the opponent fights back and is the one winning it", () => {
  // A player who does nothing but walk forward with his hands down. The whole
  // premise of the page is that this loses badly.
  const bout = playRound(() => ({ x: 1 }));

  // The floor is well under half the round's ticks because a player this
  // passive spends most of it on the floor, and the count is not punching
  // time. It used to sit at 20 only because the opponent stood over him
  // throwing at a man the impact model had already made untouchable.
  assert.ok(bout.right.thrown > 8, `opponent only threw ${bout.right.thrown}`);
  assert.ok(
    bout.right.landed > bout.left.landed,
    `a passive player was not outlanded: ${bout.left.landed} vs ${bout.right.landed}`,
  );
  assert.ok(bout.left.health < 100, "a passive player took no damage at all");
});

test("keeping the guard beats walking in behind nothing", () => {
  // The honest comparison: a man holding his guard against a man marching
  // forward with his hands down. Comparing against an idle corner proves
  // nothing, because idling is itself the guard.
  const walkingIn = playRound(() => ({ x: 1 }));
  const blocking = playRound((tick) => ({
    x: 0,
    button: tick % 20 === 0 ? "block" : undefined,
  }));

  assert.ok(
    blocking.left.health > walkingIn.left.health,
    `guarding (${blocking.left.health}) did not beat walking in (${walkingIn.left.health})`,
  );
});

test("the power button reaches for the shot the range allows", () => {
  const bout = playRound((tick) => ({
    x: 1,
    button: tick % 30 === 0 ? "power" : undefined,
  }));

  const heavy =
    bout.left.actionCounts.crossHead +
    bout.left.actionCounts.crossBody +
    bout.left.actionCounts.hookHead +
    bout.left.actionCounts.hookBody +
    bout.left.actionCounts.uppercut;
  assert.ok(heavy > 5, `power button produced ${heavy} power shots`);
});

test("a full exhibition reaches a verdict rather than hanging", () => {
  const bout = playRound(
    (tick) => ({ x: 1, button: tick % 25 === 0 ? "jab" : undefined }),
    12000,
  );
  assert.ok(bout.finish !== null, "the bout never finished");
  assert.ok(["KO", "TKO", "Decision", "Draw"].includes(bout.finish!));
});

/* ---- The wall between an exhibition and a real fight -------------------- */

test("the exhibition handicaps are absent on every athlete the league books", () => {
  const league = createInitialLeague();
  for (const fighter of league.roster) {
    assert.equal(
      fighter.reactionOverrideSeconds,
      undefined,
      `${fighter.lastName} carries an exhibition reaction override`,
    );
    assert.equal(
      fighter.movementScale,
      undefined,
      `${fighter.lastName} carries an exhibition stride multiplier`,
    );
  }
});

test("a league bout is tick-for-tick identical to what it was before the handicaps existed", () => {
  const league = createInitialLeague();
  const roster = league.roster.slice(0, 2);

  // The same two men, one pair carrying explicitly-undefined handicap fields.
  // If either field were read without an absent-check, these would diverge.
  const withFields = roster.map((fighter) => ({
    ...fighter,
    reactionOverrideSeconds: undefined,
    movementScale: undefined,
  }));

  const plain = simulateBoutToCompletion(roster, roster[0].id, roster[1].id, { totalRounds: 3 });
  const carrying = simulateBoutToCompletion(withFields, roster[0].id, roster[1].id, { totalRounds: 3 });

  assert.equal(carrying.tick, plain.tick);
  assert.equal(carrying.finish, plain.finish);
  assert.equal(carrying.winnerId, plain.winnerId);
  assert.equal(carrying.left.landed, plain.left.landed);
  assert.equal(carrying.right.landed, plain.right.landed);
  assert.equal(carrying.left.health, plain.left.health);
  assert.equal(carrying.right.health, plain.right.health);
});

test("a slower reaction override actually makes him easier to hit", () => {
  const league = createInitialLeague();
  const target = league.roster.find((f) => f.weightClass === "middleweight")!;

  const scoreAgainst = (reactionSeconds: number | undefined) => {
    const opponent = exhibitionFighter(target, { reactionSeconds });
    const player = playerFighter({ firstName: "You", lastName: "C" }, "middleweight", {
      movementScale: 2,
    });
    const roster = [player, opponent];
    const bout = createBout(player.id, opponent.id, 3, { totalRounds: 1, roundSeconds: 45 });
    const controller = createPlayerController();
    while (bout.introSeconds > 0) advanceBout(bout, roster);
    for (let tick = 0; tick < 2250 && !bout.finish; tick += 1) {
      const now = tick * 20;
      const snapshot = {
        ...emptySnapshot(),
        x: 1,
        taps: tick % 25 === 0 ? [{ button: "jab" as const, at: now }] : [],
      };
      advanceBout(bout, roster, {
        blue: resolvePlayerAction(controller, snapshot, bout.left, bout.right, now),
      });
    }
    return bout.left.landed;
  };

  const blind = scoreAgainst(0.62);
  const sharp = scoreAgainst(undefined);
  assert.ok(
    blind > sharp,
    `handicapping his reaction did not help the player: ${blind} landed vs ${sharp}`,
  );
});

test("a doubled stride moves a fighter further without touching his punches", () => {
  const league = createInitialLeague();
  const target = league.roster.find((f) => f.weightClass === "middleweight")!;

  const travelled = (movementScale: number | undefined) => {
    const player = playerFighter({ firstName: "You", lastName: "C" }, "middleweight", {
      movementScale,
    });
    const opponent = exhibitionFighter(target, { reactionSeconds: 0.62 });
    const roster = [player, opponent];
    const bout = createBout(player.id, opponent.id, 3, { totalRounds: 1, roundSeconds: 45 });
    while (bout.introSeconds > 0) advanceBout(bout, roster);
    const startX = bout.left.x;
    for (let tick = 0; tick < 40; tick += 1) advanceBout(bout, roster, { blue: "retreat" });
    return Math.abs(bout.left.x - startX);
  };

  assert.ok(
    travelled(2) > travelled(undefined) * 1.5,
    "the stride multiplier did not meaningfully move the fighter further",
  );
});

/* ---- Running out of air ------------------------------------------------ */

const GASSED = { gassedAt: 6, recoveredAt: 15, jabCooldownSeconds: 2, hitStaminaCost: 1.15 };

function exhibitionPair() {
  const league = createInitialLeague();
  const target = league.roster.find((f) => f.weightClass === "middleweight")!;
  const opponent = exhibitionFighter(target, { exhaustion: GASSED });
  const player = playerFighter({ firstName: "You", lastName: "C" }, "middleweight", {
    exhaustion: GASSED,
  });
  return [player, opponent];
}

/** Pins the tank at `stamina` and reports how many times the fighter managed to
 *  start `wanted`. `actionCounts` is the honest counter — watching `action`
 *  change misses every case where the same action is started twice running. */
function outputAtStamina(stamina: number, wanted: FighterAction) {
  const roster = exhibitionPair();
  const bout = createBout(roster[0].id, roster[1].id, 21, { totalRounds: 1, roundSeconds: 45 });
  while (bout.introSeconds > 0) advanceBout(bout, roster);
  for (let tick = 0; tick < 750; tick += 1) {
    bout.left.stamina = stamina;
    advanceBout(bout, roster, { blue: wanted });
  }
  return bout.left.actionCounts[wanted];
}

test("a quarter of a tank is not tired — everything still throws", () => {
  for (const stamina of [33, 28, 22, 16]) {
    for (const power of ["crossHead", "hookHead", "uppercut"] as const) {
      assert.ok(
        outputAtStamina(stamina, power) > 0,
        `a fighter on ${stamina} stamina was denied ${power}`,
      );
    }
  }
});

test("genuinely empty takes the power shots away", () => {
  for (const power of ["crossHead", "hookHead", "uppercut", "hookBody"] as const) {
    assert.equal(outputAtStamina(3, power), 0, `an empty fighter still threw ${power}`);
  }
});

test("an empty fighter gets a jab about every two seconds", () => {
  // 750 ticks is 15 seconds of fight time.
  const empty = outputAtStamina(3, "jabHead");
  const fresh = outputAtStamina(90, "jabHead");
  assert.ok(empty >= 4 && empty <= 10, `expected ~7 jabs in 15 s, got ${empty}`);
  assert.ok(fresh > empty * 2, `exhaustion did not slow the jab: ${fresh} vs ${empty}`);
});

test("an empty fighter can still cover, move his head and move his feet", () => {
  for (const survival of ["guard", "slip", "duck", "weave", "retreat", "circleLeft"] as const) {
    assert.ok(
      outputAtStamina(2, survival) > 0,
      `an empty fighter was denied ${survival}, which he must always have`,
    );
  }
});

test("the gassed state is a band, not a line", () => {
  const roster = exhibitionPair();
  const bout = createBout(roster[0].id, roster[1].id, 22, { totalRounds: 1, roundSeconds: 45 });
  while (bout.introSeconds > 0) advanceBout(bout, roster);

  // The latch is only read when an action actually starts, so each phase runs
  // long enough to reach a decision boundary rather than one lone tick.
  const hold = (stamina: number) => {
    for (let tick = 0; tick < 60; tick += 1) {
      bout.left.stamina = stamina;
      advanceBout(bout, roster, { blue: "crossHead" });
    }
  };

  hold(3);
  assert.equal(bout.left.gassed, true, "an empty fighter did not go under");

  // Climbing back past the entry threshold is not enough — he has to bank all
  // the way to `recoveredAt` or he flickers in and out every second.
  hold(9);
  assert.equal(bout.left.gassed, true, "he came back up on the entry threshold");

  hold(16);
  assert.equal(bout.left.gassed, false, "he never recovered");
});

test("wearing a punch costs wind", () => {
  // A guard regenerates, so watching one number fall proves nothing. The sim is
  // deterministic, so run the identical fight twice and change only whether
  // absorbing a punch is charged for.
  const run = (hitStaminaCost: number) => {
    const league = createInitialLeague();
    const target = league.roster.find((f) => f.weightClass === "middleweight")!;
    const rules = { ...GASSED, hitStaminaCost };
    const roster = [
      playerFighter({ firstName: "You", lastName: "C" }, "middleweight", { exhaustion: rules }),
      exhibitionFighter(target, { exhaustion: rules }),
    ];
    const bout = createBout(roster[0].id, roster[1].id, 23, { totalRounds: 1, roundSeconds: 45 });
    while (bout.introSeconds > 0) advanceBout(bout, roster);
    // Walking him down rather than guarding: a guard regenerates 1.9 a second
    // and pins the tank at 100, which hides the whole effect.
    for (let tick = 0; tick < 900; tick += 1) {
      advanceBout(bout, roster, { blue: "advance" });
    }
    return { stamina: bout.left.stamina, taken: bout.right.landed };
  };

  const free = run(0);
  const charged = run(1.15);
  assert.ok(free.taken > 0, "the AI never landed, so the test proved nothing");
  assert.ok(
    charged.stamina < free.stamina,
    `taking ${free.taken} punches cost no wind: ${charged.stamina} vs ${free.stamina}`,
  );
});

test("exhaustion is opt-in and a league bout never sees it", () => {
  const league = createInitialLeague();
  for (const fighter of league.roster) {
    assert.equal(fighter.exhaustionRules, undefined, `${fighter.lastName} carries exhaustion rules`);
  }

  const roster = league.roster.slice(0, 2);
  const withField = roster.map((f) => ({ ...f, exhaustionRules: undefined }));
  const plain = simulateBoutToCompletion(roster, roster[0].id, roster[1].id, { totalRounds: 3 });
  const carrying = simulateBoutToCompletion(withField, roster[0].id, roster[1].id, { totalRounds: 3 });
  assert.equal(carrying.tick, plain.tick);
  assert.equal(carrying.winnerId, plain.winnerId);
  assert.equal(carrying.left.landed, plain.left.landed);
});

/* ---- Covering while the feet work -------------------------------------- */

test("holding block no longer roots a fighter to the spot", () => {
  const controller = createPlayerController();
  const player = corner({ x: 2, y: 3 });
  const opponent = corner({ x: 4, y: 3 });

  // Block held and the stick pushed: the feet win the action, because the
  // guard rides along as a posture the caller applies instead.
  assert.equal(
    resolvePlayerAction(controller, { ...emptySnapshot(), x: 1, blockHeld: true }, player, opponent, 0),
    "advance",
  );
  assert.equal(
    resolvePlayerAction(controller, { ...emptySnapshot(), x: -1, blockHeld: true }, player, opponent, 0),
    "retreat",
  );
  // Block held and nothing on the stick: the guard is the action itself.
  assert.equal(
    resolvePlayerAction(controller, { ...emptySnapshot(), blockHeld: true }, player, opponent, 0),
    "guard",
  );
});

test("a guard held through footwork still blunts a punch", () => {
  const roster = exhibitionPair();

  const takeIt = (guardHeld: boolean) => {
    const bout = createBout(roster[0].id, roster[1].id, 41, { totalRounds: 1, roundSeconds: 60 });
    while (bout.introSeconds > 0) advanceBout(bout, roster);
    for (let tick = 0; tick < 1800; tick += 1) {
      advanceBout(bout, roster, { blue: "advance" }, { blue: guardHeld });
    }
    return { health: bout.left.health, blocked: bout.right.blocked };
  };

  const open = takeIt(false);
  const covered = takeIt(true);

  assert.ok(
    covered.blocked > open.blocked,
    `walking behind a held guard blocked no more than walking open: ${covered.blocked} vs ${open.blocked}`,
  );
  assert.ok(
    covered.health >= open.health,
    `covering while walking cost health: ${covered.health} vs ${open.health}`,
  );
});

test("a held guard never covers for a fighter who is punching", () => {
  // Hands cannot be both throwing and covering, so holding the posture through
  // an attack has to change nothing at all. The sim is deterministic, so the
  // two runs are comparable outright.
  const punchThrough = (guardHeld: boolean) => {
    const roster = exhibitionPair();
    const bout = createBout(roster[0].id, roster[1].id, 42, { totalRounds: 1, roundSeconds: 60 });
    while (bout.introSeconds > 0) advanceBout(bout, roster);
    for (let tick = 0; tick < 1800; tick += 1) {
      advanceBout(bout, roster, { blue: "crossHead" }, { blue: guardHeld });
    }
    return { health: bout.left.health, thrown: bout.left.thrown, taken: bout.right.landed };
  };

  const open = punchThrough(false);
  const covered = punchThrough(true);
  assert.ok(open.thrown > 0, "the player never actually threw, so nothing was tested");
  assert.ok(open.taken > 0, "the AI never landed, so nothing was tested");
  assert.equal(
    covered.health,
    open.health,
    "holding block while punching changed what the punches did",
  );
});

test("the exhibition posture is off for everybody the league books", () => {
  const league = createInitialLeague();
  const roster = league.roster.slice(0, 2);
  const bout = createBout(roster[0].id, roster[1].id, 43, { totalRounds: 1 });
  while (bout.introSeconds > 0) advanceBout(bout, roster);
  for (let tick = 0; tick < 200; tick += 1) advanceBout(bout, roster);
  assert.equal(bout.left.guardHeld, false);
  assert.equal(bout.right.guardHeld, false);
});

/* ---- The wall, pinned ---------------------------------------------------
 *
 * A golden for a real league bout. Nothing in this file's exhibition work is
 * allowed to move these numbers; if a change to the shared engine does, this
 * fails and the change has to be justified against the league rather than
 * against the game. */
test("a league bout produces byte-identical results with the exhibition code present", () => {
  const league = createInitialLeague();
  const outcomes = league.roster.slice(0, 6).map((_, index) => {
    const left = league.roster[index];
    const right = league.roster[(index + 1) % 6];
    const bout = simulateBoutToCompletion(league.roster, left.id, right.id, {
      totalRounds: 3,
    });
    return {
      tick: bout.tick,
      finish: bout.finish,
      winner: bout.winnerId,
      landed: [bout.left.landed, bout.right.landed],
      thrown: [bout.left.thrown, bout.right.thrown],
      health: [bout.left.health, bout.right.health],
    };
  });

  // Every exhibition field must be untouched throughout, on both corners.
  for (const fighter of league.roster) {
    assert.equal(fighter.reactionOverrideSeconds, undefined);
    assert.equal(fighter.movementScale, undefined);
    assert.equal(fighter.exhaustionRules, undefined);
  }

  // Re-running has to reproduce it exactly: the league has no randomness, and
  // none of the exhibition state may leak between bouts.
  const repeat = league.roster.slice(0, 6).map((_, index) => {
    const left = league.roster[index];
    const right = league.roster[(index + 1) % 6];
    const bout = simulateBoutToCompletion(league.roster, left.id, right.id, {
      totalRounds: 3,
    });
    return {
      tick: bout.tick,
      finish: bout.finish,
      winner: bout.winnerId,
      landed: [bout.left.landed, bout.right.landed],
      thrown: [bout.left.thrown, bout.right.thrown],
      health: [bout.left.health, bout.right.health],
    };
  });
  assert.deepEqual(repeat, outcomes);

  // And a bout the league runs never sets the posture or the exhaustion latch.
  for (const index of [0, 1, 2]) {
    const bout = simulateBoutToCompletion(
      league.roster,
      league.roster[index].id,
      league.roster[index + 1].id,
      { totalRounds: 1 },
    );
    for (const corner of [bout.left, bout.right]) {
      assert.equal(corner.guardHeld, false, "a league bout raised the exhibition guard posture");
      assert.equal(corner.gassed, false, "a league bout latched the exhibition exhaustion state");
      assert.equal(corner.punchLockSeconds, 0, "a league bout used the exhibition punch lock");
    }
  }
});

/* ---- One vocabulary, two schemes --------------------------------------- */

test("the keyboard speaks the same buttons the phone does", () => {
  assert.equal(keyboardButton("j"), "jab");
  assert.equal(keyboardButton("k"), "cross");
  assert.equal(keyboardButton("l"), "hook");
  assert.equal(keyboardButton("i"), "power");
  assert.equal(keyboardButton("I"), "power", "the mapping must not care about shift");
  assert.equal(keyboardButton(" "), "block");
  assert.equal(BLOCK_KEY, " ", "the space bar is what the fight loop watches for a held guard");

  // The keys the old schemes used are gone rather than quietly still working.
  for (const retired of ["h", "u", "b", "Escape"]) {
    assert.equal(keyboardButton(retired), null, `${retired} is still bound to a punch`);
  }
});

test("the keyboard legend covers movement, every fight button and pause, and nothing else", () => {
  const keys = KEY_BINDINGS.flatMap((binding) => binding.keys);
  assert.deepEqual(keys, ["A", "D", "W", "S", "J", "K", "L", "I", "Space", "Esc"]);

  // Every fight key in the legend has to actually be bound. The space bar is
  // spelled out in the legend and typed as " ", which is the one place the two
  // can drift apart without anybody noticing.
  for (const key of ["J", "K", "L", "I"]) {
    assert.ok(keyboardButton(key) !== null, `${key} is documented but not bound`);
  }
  assert.equal(keyboardButton(" "), "block", "the legend says Space but nothing is bound to it");
});

test("the phone legend names the same buttons the phone draws", () => {
  const named = TOUCH_BINDINGS.flatMap((binding) => binding.keys);
  assert.deepEqual(named, ["Stick", "Jab", "Hook", "Cross", "Power", "Block"]);

  // Both legends have to describe the same five fight controls, whatever each
  // scheme calls the key. This is the check that stops the phone and the
  // keyboard quietly becoming two different games. Movement and pause are the
  // two that legitimately differ: a stick is one control and WASD is two, and
  // there is nothing to pause on a phone that is already in your hands.
  const notFightControls = ["Move", "Left / right", "Far / near", "Pause"];
  const fightControls = (bindings: { label: string }[]) =>
    bindings.map((binding) => binding.label).filter((label) => !notFightControls.includes(label)).sort();
  assert.deepEqual(fightControls(TOUCH_BINDINGS), fightControls(KEY_BINDINGS));
});

test("a keyboard combination behaves exactly like the same combination on a phone", () => {
  const player = corner();
  const opponent = corner({ x: 3.4 });

  const runTaps = (buttons: PlayerButton[]) => {
    const controller = createPlayerController();
    buttons.forEach((button, index) => {
      resolvePlayerAction(
        controller,
        { ...emptySnapshot(), taps: [{ button, at: index * 90 }] },
        player,
        opponent,
        index * 90,
      );
    });
    return controller.queue;
  };

  // K then L on a keyboard is the phone's jab into cross, punch for punch.
  assert.deepEqual(runTaps(["jab", "cross"]), ["jabHead", "crossHead"]);
  assert.deepEqual(runTaps(["jab", "hook"]), ["jabHead", "hookHead"]);
  assert.deepEqual(runTaps(["jab", "jab"]), ["jabHead", "jabHead"]);
});
