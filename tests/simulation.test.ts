import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONS,
  BOXING_MODEL,
  TACTICAL_INTENTS,
  adaptConditioning,
  calculateImpact,
  calibratedHandSpeed,
  classifyImpactZone,
  commitBout,
  createBout,
  createDecisionLedger,
  createInitialLeague,
  createTrainingEnvironment,
  evaluateNeurologicalKnockout,
  exhibitionFighter,
  getActionPreferences,
  getPolicyDecision,
  learnFromBout,
  neuralInfluence,
  neutralObservation,
  observeTrainingEnvironment,
  punchExposure,
  sealDecisionLedger,
  selectPolicyAction,
  simulateBoutToCompletion,
  stepBoutWithActions,
  stepTrainingEnvironment,
  trainAthlete,
  upgradeLeagueState,
} from "../app/simulation.ts";
import { EXHAUSTION } from "../app/player-controls.ts";
import type { FighterAction } from "../app/fight-model.ts";

/** Staged exchanges below are timed in wall-clock seconds, not ticks, so the
 * stagings read the same at any physics step — 14 ticks meant 1.4 s only on
 * the 10 Hz build they were calibrated against. */
function secondsAsTicks(seconds: number) {
  return Math.round(seconds / BOXING_MODEL.physicsStepSeconds);
}

test("impact is a deterministic function of effective mass, velocity, and guard", () => {
  const clean = calculateImpact({
    effectiveMassKg: 2.9,
    closingVelocityMps: 9.14,
  });
  const repeated = calculateImpact({
    effectiveMassKg: 2.9,
    closingVelocityMps: 9.14,
  });
  const guarded = calculateImpact({
    effectiveMassKg: 2.9,
    closingVelocityMps: 9.14,
    guardAbsorption: 0.75,
  });

  assert.deepEqual(clean, repeated);
  assert.ok(Math.abs(clean.impactEnergyJ - 121.13) < 0.01);
  assert.equal(clean.impulseNs, 26.506);
  assert.ok(
    Math.abs(guarded.transmittedEnergyJ - clean.transmittedEnergyJ * 0.25) < 0.01,
  );
});

test("anatomical contact location changes rotational and neurological load", () => {
  const jaw = calculateImpact({
    effectiveMassKg: 2.9,
    closingVelocityMps: 9.14,
    rotationalFactor: 1.22,
    momentArmMeters: 0.068,
    anatomicalVulnerability: 1.32,
  });
  const nose = calculateImpact({
    effectiveMassKg: 2.9,
    closingVelocityMps: 9.14,
    rotationalFactor: 1,
    momentArmMeters: 0.026,
    anatomicalVulnerability: 0.76,
  });

  assert.ok(jaw.rotationalImpulseNms > nose.rotationalImpulseNms);
  assert.ok(jaw.neurologicalLoad > nose.neurologicalLoad);
  assert.equal(classifyImpactZone("head", -0.055, -0.055), "jaw");
  assert.equal(classifyImpactZone("head", 0, 0), "nose");
  assert.equal(classifyImpactZone("body", -0.08, -0.04), "liver");
  assert.equal(evaluateNeurologicalKnockout({
    zone: "jaw",
    blocked: false,
    singleImpactLoad: jaw.neurologicalLoad,
    accumulatedLoad: jaw.neurologicalLoad,
    balance: 0.8,
    powerScore: jaw.powerScore,
  }), true);
  assert.equal(evaluateNeurologicalKnockout({
    zone: "nose",
    blocked: false,
    singleImpactLoad: nose.neurologicalLoad,
    accumulatedLoad: nose.neurologicalLoad,
    balance: 0.8,
    powerScore: nose.powerScore,
  }), false);
});

test("fatigue and loss of balance reduce calibrated hand speed", () => {
  const fighter = createInitialLeague().roster[0];
  const fresh = calibratedHandSpeed(fighter, "crossHead", 100, 1);
  const exhausted = calibratedHandSpeed(fighter, "crossHead", 18, 0.42);

  assert.ok(fresh > exhausted);
  assert.ok(fresh >= 6 && fresh <= 12);
  assert.ok(exhausted > 0);
});

test("a knocked-out fighter remains down through the referee's ten count", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 30,
    totalRounds: 1,
  });
  bout.introSeconds = 0;
  bout.left.downCountSeconds = 0.1;
  bout.left.recoveryTargetSeconds = 10;
  bout.left.knockout = true;
  bout.left.knockoutCause = "test knockdown";

  for (let tick = 0; tick < secondsAsTicks(8.5); tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "recover", red: "guard" });
  }
  assert.equal(bout.running, true);
  assert.ok(bout.left.downCountSeconds >= 8);

  for (let tick = 0; tick < secondsAsTicks(2) && bout.running; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "recover", red: "guard" });
  }
  assert.equal(bout.finish, "KO");
  assert.ok(bout.left.downCountSeconds >= 10);
});

test("the standing fighter backs off and waits out the count", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 30,
    totalRounds: 1,
  });
  bout.introSeconds = 0;
  // In the pocket when the knockdown lands, which is where he used to stand
  // and keep throwing.
  bout.left.x = 3;
  bout.right.x = 3.7;
  bout.right.stamina = 60;
  bout.left.downCountSeconds = 0.1;
  bout.left.recoveryTargetSeconds = 6;

  const openingDistance = Math.abs(bout.right.x - bout.left.x);
  const staminaAtDrop = bout.right.stamina;
  const thrownAtDrop = bout.right.thrown;
  // The corner is named every tick, so an ignored override is the only thing
  // that can keep him off the man on the floor.
  for (let tick = 0; tick < secondsAsTicks(5) && bout.left.downCountSeconds > 0; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { red: "crossHead" });
    assert.ok(
      bout.right.action === "guard" || bout.right.action === "retreat",
      `stood over a downed opponent in a ${bout.right.action}`,
    );
  }

  assert.equal(bout.right.thrown, thrownAtDrop);
  assert.ok(
    Math.abs(bout.right.x - bout.left.x) > openingDistance,
    "the standing fighter never stepped off the body",
  );
  // Stepping away and standing there is a breather, not a self-inflicted tax.
  assert.ok(bout.right.stamina > staminaAtDrop);
});

test("the same fighters and policies produce the same complete bout", () => {
  const league = createInitialLeague();
  const first = simulateBoutToCompletion(
    league.roster,
    "malik-okoro",
    "jonah-vale",
    { roundSeconds: 45, totalRounds: 1 },
  );
  const second = simulateBoutToCompletion(
    league.roster,
    "malik-okoro",
    "jonah-vale",
    { roundSeconds: 45, totalRounds: 1 },
  );

  assert.deepEqual(
    {
      winnerId: first.winnerId,
      finish: first.finish,
      cards: first.roundCards,
      left: [first.left.health, first.left.cleanImpactJ, first.left.landed],
      right: [first.right.health, first.right.cleanImpactJ, first.right.landed],
    },
    {
      winnerId: second.winnerId,
      finish: second.finish,
      cards: second.roundCards,
      left: [second.left.health, second.left.cleanImpactJ, second.left.landed],
      right: [second.right.health, second.right.cleanImpactJ, second.right.landed],
    },
  );
});

test("switching corners preserves the winner and comparable physical totals", () => {
  const roster = createInitialLeague().roster;
  // One short fight is too small a sample for the totals: the decision jitter
  // resolves close calls differently per corner, and a single flipped exchange
  // moves a 60-second bout's numbers by a quarter. Aggregating a few pairings
  // is what actually distinguishes a biased corner from ordinary variance.
  // Pairings picked to be decisive at this length: about 30% of all 60-second
  // swaps flip their winner on ordinary decision jitter (measured at both the
  // pre- and post-exposure engines, with corner lean under 3% both times), so
  // the winner assertion needs matchups with actual daylight between the men.
  const pairings: [string, string][] = [
    ["malik-okoro", "jonah-vale"],
    ["mateo-silva", "andre-bishop"],
    ["ren-ito", "andre-bishop"],
  ];
  let blueFirstLanded = 0;
  let redFirstLanded = 0;
  let blueFirstImpactJ = 0;
  let redFirstImpactJ = 0;
  for (const [first, second] of pairings) {
    const blueFirst = simulateBoutToCompletion(roster, first, second, {
      roundSeconds: 60,
      totalRounds: 1,
    });
    const redFirst = simulateBoutToCompletion(roster, second, first, {
      roundSeconds: 60,
      totalRounds: 1,
    });

    assert.equal(blueFirst.winnerId, redFirst.winnerId);
    blueFirstLanded += blueFirst.left.landed + blueFirst.right.landed;
    redFirstLanded += redFirst.left.landed + redFirst.right.landed;
    blueFirstImpactJ += blueFirst.left.cleanImpactJ + blueFirst.right.cleanImpactJ;
    redFirstImpactJ += redFirst.left.cleanImpactJ + redFirst.right.cleanImpactJ;
  }

  // Ordinary swap variance in landed counts is ~15% per pairing, measured over
  // all 198 same-division swaps at both 10 Hz and 50 Hz with no lean toward
  // either corner — a 15% line on this aggregate had no margin at all. A
  // corner that actually favoured one side would blow through 25% and lean.
  assert.ok(
    Math.abs(blueFirstLanded - redFirstLanded) <=
      Math.ceil(Math.max(blueFirstLanded, redFirstLanded) * 0.25),
  );
  assert.ok(
    Math.abs(blueFirstImpactJ - redFirstImpactJ) <=
      Math.max(blueFirstImpactJ, redFirstImpactJ) * 0.15,
  );
});

test("fight-state invariants hold through a complete bout", () => {
  const bout = simulateBoutToCompletion(
    createInitialLeague().roster,
    "mateo-silva",
    "darius-cole",
  );

  for (const fighter of [bout.left, bout.right]) {
    assert.ok(fighter.landed + fighter.blocked <= fighter.thrown);
    assert.ok(fighter.health >= 0 && fighter.health <= 100);
    assert.ok(fighter.stamina >= 0 && fighter.stamina <= 100);
    assert.ok(fighter.balance >= 0 && fighter.balance <= 1);
    assert.ok(fighter.x >= 0.45 && fighter.x <= BOXING_MODEL.ringLengthMeters - 0.45);
    assert.ok(fighter.y >= 0.45 && fighter.y <= BOXING_MODEL.ringDepthMeters - 0.45);
    assert.ok(fighter.headLevel >= 0.62 && fighter.headLevel <= 1);
    assert.ok(fighter.body.leadKneeFlexion >= 8 && fighter.body.leadKneeFlexion <= 62);
    assert.ok(fighter.body.rearKneeFlexion >= 8 && fighter.body.rearKneeFlexion <= 62);
    assert.ok(fighter.body.centerOfMassHeight >= 0.74 && fighter.body.centerOfMassHeight <= 1);
    assert.ok(fighter.body.leadGroundForceN >= 0);
    assert.ok(fighter.body.rearGroundForceN >= 0);
    assert.ok(Math.abs(fighter.body.rateOfForceDevelopment) <= 4500);
    assert.ok(fighter.body.kineticChainEfficiency >= 0.45 && fighter.body.kineticChainEfficiency <= 1);
    assert.ok(fighter.facingDirection === -1 || fighter.facingDirection === 1);
    assert.equal(fighter.judgePoints.length, 3);
  }
});

test("an external agent can observe, act, step physics, and receive reward", () => {
  const roster = createInitialLeague().roster;
  const fighter = roster[0];
  let environment = createTrainingEnvironment(
    fighter.id,
    roster[1].id,
    { roundSeconds: 10, totalRounds: 1 },
  );
  let observation = observeTrainingEnvironment(environment, roster);

  assert.equal(observation.features.length, BOXING_MODEL.observationFeatures);
  assert.equal(observation.actionMask.length, ACTIONS.length);
  while (!observation.actionReady) {
    environment = stepTrainingEnvironment(environment, roster).environment;
    observation = observeTrainingEnvironment(environment, roster);
  }

  const action = selectPolicyAction(fighter, observation);
  const first = stepTrainingEnvironment(environment, roster, action);
  const repeated = stepTrainingEnvironment(environment, roster, action);

  assert.equal(first.observation.tick, observation.tick + 1);
  assert.equal(typeof first.reward, "number");
  assert.deepEqual(first, repeated);
});

test("each athlete owns a distinct recurrent neural brain", () => {
  const roster = createInitialLeague().roster;
  const environment = createTrainingEnvironment(roster[0].id, roster[1].id);
  const observation = observeTrainingEnvironment(environment, roster);
  const first = getPolicyDecision(roster[0], observation);
  const repeated = getPolicyDecision(roster[0], observation);
  const liveBout = simulateBoutToCompletion(
    roster,
    roster[0].id,
    roster[1].id,
    { roundSeconds: 15, totalRounds: 1 },
  );

  assert.equal(roster[0].policy.architecture, "recurrent-28x16x8x6x18");
  assert.equal(roster[0].policy.hiddenWeights.length, 16);
  assert.equal(roster[0].policy.recurrentHiddenWeights.length, 16);
  assert.equal(roster[0].policy.recurrentHiddenWeights[0].length, 8);
  assert.equal(roster[0].policy.memoryInputWeights.length, 8);
  assert.equal(roster[0].policy.memoryWeights.length, 8);
  assert.equal(roster[0].policy.intentWeights.length, 6);
  assert.equal(roster[0].policy.outputWeights.length, ACTIONS.length);
  assert.notDeepEqual(
    roster[0].policy.hiddenWeights,
    roster[1].policy.hiddenWeights,
  );
  assert.ok(ACTIONS.includes(first.action));
  assert.ok(TACTICAL_INTENTS.includes(first.intent));
  assert.ok(first.confidence >= 0 && first.confidence <= 100);
  assert.deepEqual(first, repeated);
  assert.ok(liveBout.left.decisionCount > 0);
  assert.ok(liveBout.right.decisionCount > 0);
  assert.ok(TACTICAL_INTENTS.includes(liveBout.left.tacticalIntent));
  assert.ok(TACTICAL_INTENTS.includes(liveBout.right.tacticalIntent));
  assert.ok(liveBout.left.memoryUpdates > 0);
  assert.ok(liveBout.right.memoryUpdates > 0);
  assert.ok(liveBout.left.workingMemory.some((value) => Math.abs(value) > 0));
});

test("working memory changes the recurrent policy state deterministically", () => {
  const roster = createInitialLeague().roster;
  const environment = createTrainingEnvironment(roster[0].id, roster[1].id);
  const observation = observeTrainingEnvironment(environment, roster);
  const emptyMemory = getPolicyDecision(roster[0], observation);
  const primedMemory = getPolicyDecision(roster[0], {
    ...observation,
    workingMemory: Array(BOXING_MODEL.recurrentUnits).fill(0.75),
  });
  const repeated = getPolicyDecision(roster[0], {
    ...observation,
    workingMemory: Array(BOXING_MODEL.recurrentUnits).fill(0.75),
  });

  assert.notDeepEqual(emptyMemory.nextMemory, primedMemory.nextMemory);
  assert.notDeepEqual(emptyMemory.actionScores, primedMemory.actionScores);
  assert.deepEqual(primedMemory, repeated);
});

test("round breaks preserve memory and issue measured next-round plans", () => {
  const roster = createInitialLeague().roster;
  const bout = simulateBoutToCompletion(
    roster,
    roster[0].id,
    roster[1].id,
    { roundSeconds: 2, totalRounds: 2 },
  );

  assert.equal(bout.round, 2);
  assert.equal(bout.left.currentPlan.issuedRound, 2);
  assert.equal(bout.right.currentPlan.issuedRound, 2);
  assert.equal(bout.left.currentPlan.source, "between-round");
  assert.ok(bout.left.planRevision > 0);
  assert.ok(bout.left.memoryUpdates > 0);
  assert.ok(bout.left.lastRound.control >= 0);
});

test("completed career bouts create persistent measured opponent dossiers", () => {
  const league = createInitialLeague();
  const bout = simulateBoutToCompletion(
    league.roster,
    league.roster[0].id,
    league.roster[1].id,
    { roundSeconds: 8, totalRounds: 1 },
  );
  const committed = commitBout(league, bout);
  const blue = committed.roster[0];
  const dossier = blue.opponentDossiers[league.roster[1].id];

  assert.equal(dossier.boutsObserved, 1);
  assert.ok(dossier.roundsObserved >= 1);
  assert.ok(dossier.pressureRate >= 0 && dossier.pressureRate <= 1);
  assert.ok(dossier.evasionRate >= 0 && dossier.evasionRate <= 1);
  assert.ok(dossier.averageRangeMeters > 0);
});

test("version four saves upgrade without discarding learned feed-forward weights", () => {
  const original = createInitialLeague();
  const saved = structuredClone(original) as unknown as {
    version: number;
    roster: Array<{
      height?: number;
      policy: Record<string, unknown> & { weights: number[][] };
    }>;
  };
  saved.version = 4;
  for (const fighter of saved.roster) {
    delete fighter.height;
    fighter.policy.weights = fighter.policy.weights.map((row) => row.slice(0, 24));
    delete fighter.policy.recurrentHiddenWeights;
    delete fighter.policy.memoryInputWeights;
    delete fighter.policy.memoryWeights;
    delete fighter.policy.memoryBias;
    delete fighter.policy.intentMemoryWeights;
    delete fighter.policy.outputMemoryWeights;
  }
  const upgraded = upgradeLeagueState(saved);

  assert.equal(upgraded?.version, 10);
  assert.deepEqual(upgraded?.roster[0].policy.weights, original.roster[0].policy.weights);
  assert.equal(upgraded?.roster[0].height, original.roster[0].height);
  assert.equal(upgraded?.roster[0].policy.weights[0].length, 28);
  assert.equal(upgraded?.roster[0].policy.memoryWeights.length, 8);
  assert.deepEqual(upgraded?.roster[0].opponentDossiers, {});
  assert.ok((upgraded?.roster[0].conditioning.lowerBodyPower ?? 0) > 0);
});

test("a version nine save gains the exposure column without losing its learning", () => {
  const original = createInitialLeague();
  const saved = structuredClone(original) as unknown as {
    version: number;
    roster: Array<{ policy: { weights: number[][] } }>;
  };
  saved.version = 9;
  for (const fighter of saved.roster) {
    // A v9 matrix is 27 wide, and a veteran's values are learned, not seeded.
    fighter.policy.weights = fighter.policy.weights.map((row) => row.slice(0, 27));
  }
  saved.roster[0].policy.weights[0][5] = 9.99;

  const upgraded = upgradeLeagueState(saved);

  assert.equal(upgraded?.version, 10);
  const weights = upgraded?.roster[0].policy.weights ?? [];
  // The learned value survives, every row grows the appended column, and the
  // new column arrives holding the seeded counter prior rather than zero.
  assert.equal(weights[0][5], 9.99);
  assert.ok(weights.every((row) => row.length === 28));
  const crossRow = ACTIONS.indexOf("crossHead");
  assert.equal(weights[crossRow][27], original.roster[0].policy.weights[crossRow][27]);
  assert.notEqual(weights[crossRow][27], 0);
});

test("the exposure read is a window: shut before commitment, open through the recoil", () => {
  // Before the commit line a punch can still be cancelled into a cover, so
  // nothing about it is an opening yet.
  assert.equal(punchExposure("uppercut", 0.2), 0);
  assert.equal(punchExposure("guard", 0.6), 0);
  // Committed, the openings rank exactly by what each punch pays for: the jab
  // barely opens a man, the uppercut leaves him naked.
  const committed = (action: FighterAction) => punchExposure(action, 0.6);
  assert.ok(committed("jabHead") < committed("hookHead"));
  assert.ok(committed("hookHead") < committed("crossHead"));
  assert.ok(committed("crossHead") < committed("uppercut"));
  // The recoil stays open — that is the beat a counter actually lands on —
  // and the window has closed by the time the hand is home.
  assert.ok(punchExposure("uppercut", 0.75) > 0.9);
  assert.ok(punchExposure("uppercut", 0.9) > 0.3);
  assert.equal(punchExposure("uppercut", 1), 0);
});

test("a driven corner strikes on the press instead of waiting out its animation", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 30,
    totalRounds: 1,
  });
  bout.introSeconds = 0;
  bout.left.x = 3.0;
  bout.right.x = 3.72;
  bout.left.y = bout.right.y;

  // Walk until the stride has actually begun (the opening guard has to reach
  // its boundary first), then three more ticks so the tap arrives mid-stride,
  // nowhere near the next boundary.
  for (let tick = 0; tick < 60 && bout.left.action !== "advance"; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "advance", red: "guard" });
  }
  assert.equal(bout.left.action, "advance");
  for (let tick = 0; tick < 3; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "advance", red: "guard" });
  }
  assert.equal(bout.left.action, "advance");
  assert.ok(
    bout.left.actionElapsed < bout.left.actionDuration,
    "still mid-stride when the tap lands",
  );

  // The press: the very next step must be the punch, not the rest of the walk.
  bout = stepBoutWithActions(bout, roster, { blue: "crossHead", red: "guard" });
  assert.equal(bout.left.action, "crossHead");

  // A punch in the air stays committed: a second press cannot cancel it, or a
  // buffered combination would eat its own first punch.
  bout = stepBoutWithActions(bout, roster, { blue: "jabHead", red: "guard" });
  assert.equal(bout.left.action, "crossHead");

  // The undriven corner keeps the old contract: its brain finishes what it
  // started unless a genuine defensive interrupt fires.
  assert.equal(bout.right.action, "guard");
});

test("a driven guard comes up on the press instead of waiting out the stride", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 30,
    totalRounds: 1,
  });
  bout.introSeconds = 0;
  bout.left.x = 3.0;
  bout.right.x = 3.72;
  bout.left.y = bout.right.y;

  // Same staging as the strike above: get the stride genuinely running, then
  // press block mid-commitment, nowhere near a boundary.
  for (let tick = 0; tick < 60 && bout.left.action !== "advance"; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "advance", red: "guard" });
  }
  assert.equal(bout.left.action, "advance");
  for (let tick = 0; tick < 3; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "advance", red: "guard" });
  }
  assert.ok(
    bout.left.actionElapsed < bout.left.actionDuration,
    "still mid-stride when the block lands",
  );

  // The press: hands up on the very next step, not after the walk finishes.
  bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  assert.equal(bout.left.action, "guard");

  // A held block is not restarted every tick — the guard runs, it does not
  // stutter at elapsed zero forever.
  const elapsed = bout.left.actionElapsed;
  bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  assert.equal(bout.left.action, "guard");
  assert.ok(bout.left.actionElapsed > elapsed, "the held guard keeps running");

  // And it cannot abort the player's own punch: a cross in the air stays
  // committed even with block pressed under it.
  bout = stepBoutWithActions(bout, roster, { blue: "crossHead", red: "guard" });
  assert.equal(bout.left.action, "crossHead");
  bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  assert.equal(bout.left.action, "crossHead");
});

test("a punch shields its thrower by its coverage, and never counts as a block", () => {
  const roster = createInitialLeague().roster;
  const measure = (defence: FighterAction) => {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 30,
      totalRounds: 1,
    });
    bout.introSeconds = 0;
    bout.left.x = 3.0;
    bout.right.x = 3.72;
    bout.left.y = bout.right.y;
    // The defender starts his own action three ticks early, so the attacker's
    // cross arrives while that action is deep in its committed window.
    for (let tick = 0; tick < secondsAsTicks(1.2) && bout.running; tick += 1) {
      const actions =
        tick < 3 ? { red: defence } : ({ blue: "crossHead", red: defence } as const);
      bout = stepBoutWithActions(bout, roster, actions);
    }
    return { trauma: bout.right.headTrauma, attackerBlocked: bout.left.blocked };
  };

  const jabbing = measure("jabHead");
  const upperCutting = measure("uppercut");
  // The jab keeps most of the shell home mid-punch; the uppercut keeps none.
  assert.ok(jabbing.trauma < upperCutting.trauma * 0.85);
  // Partial mid-punch coverage must stay below the clean-block line: a thrown
  // jab that registered as a block would teach the argmax to jab as defence.
  assert.equal(jabbing.attackerBlocked, 0);
});

test("fresh legs are spent by fight time: full at the bell, gone by round three", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 8,
    totalRounds: 3,
  });
  bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  assert.ok(bout.left.freshness > 0.97);
  while (bout.round < 2 && bout.running) {
    bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  }
  // Half the freshness is gone with the first of the two spending rounds.
  assert.ok(bout.left.freshness > 0.45 && bout.left.freshness < 0.55);
  while (bout.round < 3 && bout.running) {
    bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  }
  // From round three the fight costs exactly what it always has, and the
  // freshness never comes back inside a bout.
  assert.ok(bout.left.freshness <= 0.01);
  for (let tick = 0; tick < secondsAsTicks(2); tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
  }
  assert.equal(bout.left.freshness, 0);
});

test("an exhibition prices fresh legs; a booked bout prices every round the same", () => {
  // The corners stay in their own halves, so every measured jab is a whiff —
  // pure wind cost, with no impact physics in the reading.
  const jabByRound = (roster: ReturnType<typeof createInitialLeague>["roster"]) => {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 8,
      totalRounds: 3,
    });
    const measureJab = () => {
      const before = bout.left.stamina;
      bout = stepBoutWithActions(bout, roster, { blue: "jabHead", red: "guard" });
      assert.equal(bout.left.action, "jabHead");
      for (let tick = 0; tick < 60 && bout.left.action === "jabHead"; tick += 1) {
        bout = stepBoutWithActions(bout, roster, { blue: "guard", red: "guard" });
      }
      return before - bout.left.stamina;
    };
    // The round call only counts down while nobody is driving — a driven bout
    // owns its own timeline — so the hold is stepped through undriven.
    const idle = () =>
      bout.introSeconds > 0 ? {} : ({ blue: "guard", red: "guard" } as const);
    while (bout.introSeconds > 0) {
      bout = stepBoutWithActions(bout, roster, idle());
    }
    const openingBell = measureJab();
    while ((bout.round < 3 || bout.introSeconds > 0) && bout.running) {
      bout = stepBoutWithActions(bout, roster, idle());
    }
    return { openingBell, championship: measureJab() };
  };

  // The exhibition engine reads the freshness ramp through its exhaustion
  // rules: the same jab is cheaper at the opening bell than in round three.
  const league = createInitialLeague().roster;
  const exhibition = league.map((fighter) =>
    exhibitionFighter(fighter, { exhaustion: EXHAUSTION }),
  );
  const played = jabByRound(exhibition);
  assert.ok(played.openingBell > 0.2, "a fresh jab still costs real wind");
  assert.ok(
    played.openingBell < played.championship * 0.85,
    `fresh legs must pay less: ${played.openingBell} vs ${played.championship}`,
  );

  // A booked bout never reads it: the league measured freshness relief and it
  // bought double-digit stoppage jumps, so a broadcast jab costs the same
  // wind in round one as in round three.
  const booked = jabByRound(league);
  assert.ok(booked.openingBell > 0, "a booked jab still costs wind");
  assert.ok(
    Math.abs(booked.openingBell - booked.championship) < booked.openingBell * 0.05,
    `league wind must not ramp: ${booked.openingBell} vs ${booked.championship}`,
  );
  // What makes a league fighter last is the size of his tank: the same jab
  // takes a far smaller share of it than it takes of an exhibition's.
  assert.ok(
    booked.championship < played.championship / 4,
    `a booked jab is priced against the tank: ${booked.championship} vs ${played.championship}`,
  );
});

test("a slip is work, never rest, and cheaper wind than the punch it beats", () => {
  const roster = createInitialLeague().roster;
  const measure = (press: FighterAction) => {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 30,
      totalRounds: 1,
    });
    bout.introSeconds = 0;
    // A forced punch fires at once, but a forced defence waits for the action
    // boundary, so the press is held until it actually starts.
    let before = bout.right.stamina;
    for (let tick = 0; tick < 60 && bout.right.action !== press; tick += 1) {
      before = bout.right.stamina;
      bout = stepBoutWithActions(bout, roster, { blue: "guard", red: press });
    }
    assert.equal(bout.right.action, press);
    let after = bout.right.stamina;
    for (let tick = 0; tick < 60 && bout.right.action === press; tick += 1) {
      after = bout.right.stamina;
      bout = stepBoutWithActions(bout, roster, { blue: "guard", red: press });
    }
    return before - after;
  };
  const slip = measure("slip");
  const jab = measure("jabHead");
  // Making a man dodge must never be a cheaper way to empty his tank than
  // actually hitting him — and dodging must never read as a breather, or the
  // argmax discovers slipping as rest.
  assert.ok(slip > 0, `a slip costs something: ${slip}`);
  assert.ok(slip < jab, `a slip under-prices a jab: ${slip} vs ${jab}`);
});

test("the stool refills a fresh man faster, but only in an exhibition", () => {
  const stoolGains = (roster: ReturnType<typeof createInitialLeague>["roster"]) => {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 8,
      totalRounds: 3,
    });
    // Start both tanks low so the refill is never hidden by the 100 clamp, and
    // keep both men circling so no punch is ever thrown.
    bout.left.stamina = 30;
    bout.right.stamina = 30;
    const gains: number[] = [];
    let lastRound = 1;
    let preBell = bout.left.stamina;
    while (bout.running && bout.round <= 3) {
      if (bout.roundTime <= 0.04 && bout.round === lastRound) {
        preBell = bout.left.stamina;
      }
      bout = stepBoutWithActions(bout, roster, {
        blue: "circleLeft",
        red: "circleLeft",
      });
      if (bout.round !== lastRound) {
        gains.push(bout.left.stamina - preBell);
        lastRound = bout.round;
      }
      if (gains.length === 2) break;
    }
    assert.equal(gains.length, 2);
    return gains;
  };

  // Exhibition: the corner after round one refills faster than the one after
  // round two. League: the minute is worth exactly the same at both breaks.
  const league = createInitialLeague().roster;
  const played = stoolGains(
    league.map((fighter) => exhibitionFighter(fighter, { exhaustion: EXHAUSTION })),
  );
  assert.ok(
    played[0] > played[1] + 1,
    `exhibition stool gains should fade with freshness: ${played.join(", ")}`,
  );
  const booked = stoolGains(league);
  assert.ok(
    Math.abs(booked[0] - booked[1]) < 0.5,
    `league stool gains must not ramp: ${booked.join(", ")}`,
  );
});

test("crosses sequence rear-leg drive through hips and shoulders", () => {
  const roster = createInitialLeague().roster;
  const profile = roster[0];
  const bodyWeightN = profile.weight * 0.453592 * 9.81;
  let bout = createBout(profile.id, roster[1].id, 1, {
    roundSeconds: 10,
    totalRounds: 1,
  });
  bout.left.x = 2.65;
  bout.right.x = 3.45;
  let rearForcePeak = 0;
  let rfdPeak = 0;
  let hipLedShoulder = false;
  let shoulderPeak = 0;
  let forwardForcePeak = 0;

  for (let tick = 0; tick < secondsAsTicks(1.2); tick += 1) {
    bout = stepBoutWithActions(bout, roster, {
      blue: "crossHead",
      red: "guard",
    });
    rearForcePeak = Math.max(rearForcePeak, bout.left.body.rearGroundForceN);
    rfdPeak = Math.max(rfdPeak, bout.left.body.rateOfForceDevelopment);
    shoulderPeak = Math.max(shoulderPeak, Math.abs(bout.left.body.shoulderRotation));
    forwardForcePeak = Math.max(forwardForcePeak, bout.left.body.forwardGroundForceN);
    if (
      bout.left.body.hipRotation > 5 &&
      Math.abs(bout.left.body.hipRotation) > Math.abs(bout.left.body.shoulderRotation)
    ) {
      hipLedShoulder = true;
    }
  }

  assert.ok(rearForcePeak > bodyWeightN * 1.25);
  assert.ok(rearForcePeak < bodyWeightN * 1.65);
  assert.ok(rfdPeak >= 3000 && rfdPeak <= 4500);
  assert.ok(hipLedShoulder);
  assert.ok(shoulderPeak > 30);
  assert.ok(forwardForcePeak > bodyWeightN * 0.08);
});

test("conditioned kinetic chains produce faster, harder punches", () => {
  function stagedCross(conditioning: number) {
    const roster = structuredClone(createInitialLeague().roster);
    Object.assign(roster[0].conditioning, {
      lowerBodyPower: conditioning,
      kineticChain: conditioning,
      shoulderEndurance: conditioning,
    });
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 10,
      totalRounds: 1,
    });
    bout.left.x = 2.65;
    bout.right.x = 3.45;
    for (let tick = 0; tick < secondsAsTicks(1.1); tick += 1) {
      bout = stepBoutWithActions(bout, roster, {
        blue: "crossHead",
        red: "guard",
      });
    }
    return bout.left;
  }

  const developing = stagedCross(55);
  const conditioned = stagedCross(98);
  assert.ok(conditioned.peakHandSpeed > developing.peakHandSpeed);
  assert.ok(conditioned.peakImpactJ > developing.peakImpactJ);
  assert.ok(
    conditioned.body.kineticChainEfficiency >
      developing.body.kineticChainEfficiency,
  );
});

test("physical workload creates bounded conditioning adaptation", () => {
  const initial = createInitialLeague().roster[0].conditioning;
  const adapted = adaptConditioning(initial, 12, 8000, 3.5, 1);
  const repeated = adaptConditioning(adapted, 240, 180000, 12, 20);

  assert.ok(adapted.lowerBodyPower > initial.lowerBodyPower);
  assert.ok(adapted.lowerBodyEndurance > initial.lowerBodyEndurance);
  assert.ok(adapted.kineticChain > initial.kineticChain);
  assert.ok(adapted.shoulderEndurance > initial.shoulderEndurance);
  assert.equal(adapted.workloadSteps, 8000);
  assert.equal(adapted.adaptationCycles, 1);
  assert.ok(repeated.lowerBodyPower <= 100);
  assert.ok(repeated.lowerBodyEndurance <= 100);
  assert.ok(repeated.kineticChain <= 100);
  assert.ok(repeated.shoulderEndurance <= 100);
});

test("an agent can circle on the ring plane instead of moving on a single line", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 10,
    totalRounds: 1,
  });
  const startX = bout.left.x;
  const startY = bout.left.y;

  for (let tick = 0; tick < secondsAsTicks(1); tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: "circleLeft" });
  }

  assert.ok(Math.abs(bout.left.y - startY) > 0.2);
  assert.ok(Math.abs(bout.left.x - startX) < Math.abs(bout.left.y - startY));
  assert.ok(
    bout.left.action === "circleLeft" || bout.left.lastAction === "circleLeft",
  );
});

test("fighters turn and punch toward each other after crossing sides", () => {
  const roster = createInitialLeague().roster;
  let bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 10,
    totalRounds: 1,
  });
  bout.left.x = 4.15;
  bout.right.x = 1.95;
  bout.left.y = 3.2;
  bout.right.y = 2.9;
  bout.left.sensoryHistory.forEach((snapshot) => {
    snapshot.x = bout.left.x;
    snapshot.y = bout.left.y;
  });
  bout.right.sensoryHistory.forEach((snapshot) => {
    snapshot.x = bout.right.x;
    snapshot.y = bout.right.y;
  });

  bout = stepBoutWithActions(bout, roster, {
    blue: "guard",
    red: "guard",
  });
  assert.equal(bout.left.facingDirection, -1);
  assert.equal(bout.right.facingDirection, 1);

  for (let tick = 0; tick < secondsAsTicks(0.6); tick += 1) {
    bout = stepBoutWithActions(bout, roster, {
      blue: "crossHead",
      red: "crossHead",
    });
  }
  assert.equal(bout.left.action, "crossHead");
  assert.equal(bout.right.action, "crossHead");
  assert.ok(bout.left.punchDirectionX < 0);
  assert.ok(bout.right.punchDirectionX > 0);
});

test("ducking moves the head target below a previously aimed head punch", () => {
  const roster = createInitialLeague().roster;

  function stageDefense(action: "guard" | "duck") {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 10,
      totalRounds: 1,
    });
    bout.left.x = 2.65;
    bout.right.x = 3.45;
    bout.left.sensoryHistory.forEach((snapshot) => {
      snapshot.x = bout.left.x;
      snapshot.y = bout.left.y;
    });
    bout.right.sensoryHistory.forEach((snapshot) => {
      snapshot.x = bout.right.x;
      snapshot.y = bout.right.y;
    });
    // The defence starts FIRST, at its own boundary, while the attacker holds.
    // A driven corner now punches on the press instead of the next boundary,
    // so forcing both from tick zero no longer lines them up — the cross would
    // launch instantly at a man whose duck was still waiting on the threat
    // read. Holding the press until the defence is underway restores the
    // staging's whole point: the cross is aimed off the read taken before the
    // duck moved anything.
    for (let tick = 0; tick < 60 && bout.right.action !== action; tick += 1) {
      bout = stepBoutWithActions(bout, roster, { blue: "guard", red: action });
    }
    // One exchange only. The first cross is aimed off a read taken before the
    // duck, and that punch has to miss. Any longer a window and the attacker
    // re-aims his next cross at the ducked head he can now see — that punch
    // landing is the model being right, not the duck failing. Half a second,
    // not three quarters: the press launches instantly now, so the old window
    // had room for that second, correctly re-aimed cross.
    for (let tick = 0; tick < secondsAsTicks(0.5); tick += 1) {
      bout = stepBoutWithActions(bout, roster, {
        blue: "crossHead",
        red: action,
      });
    }
    return bout;
  }

  const guarded = stageDefense("guard");
  const ducked = stageDefense("duck");
  assert.ok(guarded.left.landed + guarded.left.blocked > 0);
  assert.equal(ducked.left.landed + ducked.left.blocked, 0);
  assert.ok(ducked.right.headLevel < 0.75);
});

test("head movement answers the incoming shot instead of its recoil", () => {
  const roster = createInitialLeague().roster;
  const fighter = roster[0];

  function stagedRead(
    action: "guard" | "crossHead" | "hookHead" | "crossBody",
    actionProgress: number,
    recentHeadImpact = 0,
    punchResolved = false,
    perceivedAction = action,
    opponentX = 3.48,
  ) {
    const environment = createTrainingEnvironment(fighter.id, roster[1].id);
    environment.bout.left.x = 2.7;
    environment.bout.right.x = opponentX;
    environment.bout.left.y = 2.7;
    environment.bout.right.y = 2.7;
    environment.bout.left.recentHeadImpact = recentHeadImpact;
    environment.bout.left.sustainedPressure = recentHeadImpact;
    environment.bout.right.action = action;
    environment.bout.right.actionDuration = 0.4;
    environment.bout.right.actionElapsed = actionProgress * 0.4;
    environment.bout.right.punchResolved = punchResolved;
    environment.bout.right.sensoryHistory.forEach((snapshot) => {
      snapshot.x = environment.bout.right.x;
      snapshot.y = environment.bout.right.y;
      snapshot.action = perceivedAction;
      snapshot.actionProgress = actionProgress;
      snapshot.handExtension = perceivedAction === "guard" ? 0 : 0.18;
      snapshot.punchSide = perceivedAction === "guard" ? 0 : -1;
    });
    return observeTrainingEnvironment(environment, roster);
  }

  const idle = stagedRead("guard", 0);
  const outOfPocket = stagedRead("guard", 0, 0, false, "guard", 5.4);
  const straight = stagedRead("crossHead", 0.3);
  const hook = stagedRead("hookHead", 0.3);
  const body = stagedRead("crossBody", 0.3);
  const liveStraight = stagedRead("crossHead", 0.3, 0, false, "guard");
  const late = stagedRead("crossHead", 0.8, 0.95);
  const alreadyLanded = stagedRead("crossHead", 0.3, 0.95, true);
  const evasionIndexes = (["slip", "duck", "weave"] as const).map((action) =>
    ACTIONS.indexOf(action),
  );

  // In the pocket the head may move before anything is thrown — anticipation is
  // the only defence that beats a jab — but out of range there is nothing to
  // anticipate and the gate stays shut.
  assert.ok(idle.incomingThreat === 0);
  assert.ok(evasionIndexes.every((index) => idle.actionMask[index]));
  assert.ok(outOfPocket.incomingThreat === 0);
  assert.ok(evasionIndexes.every((index) => !outOfPocket.actionMask[index]));

  assert.ok(straight.incomingThreat > 0);
  assert.equal(straight.actionReady, true);
  assert.equal(straight.actionMask[ACTIONS.indexOf("crossHead")], false);
  assert.equal(straight.actionMask[ACTIONS.indexOf("slip")], true);
  assert.equal(straight.actionMask[ACTIONS.indexOf("duck")], true);
  assert.equal(straight.actionMask[ACTIONS.indexOf("weave")], true);

  assert.ok(hook.incomingThreat > 0);
  assert.equal(hook.actionMask[ACTIONS.indexOf("slip")], false);
  assert.equal(hook.actionMask[ACTIONS.indexOf("duck")], true);
  assert.equal(hook.actionMask[ACTIONS.indexOf("weave")], true);

  // A live body-shot read never opens the head-movement gate: ducking into a
  // body punch is the wrong lesson, and the pocket habit yields to the read.
  assert.ok(body.incomingThreat > 0);
  assert.ok(evasionIndexes.every((index) => !body.actionMask[index]));

  assert.equal(liveStraight.opponentAction, "crossHead");
  assert.ok(liveStraight.incomingThreat > 0);
  assert.equal(liveStraight.actionMask[ACTIONS.indexOf("slip")], true);
  assert.equal(getPolicyDecision(fighter, liveStraight).action, "slip");
  assert.ok(["duck", "weave"].includes(getPolicyDecision(fighter, hook).action));

  // Once the shot has passed its contact beat there is no read left to answer —
  // the threat is gone, so any head movement now is the pocket habit, not a
  // reaction to a punch that already missed or landed.
  assert.equal(late.incomingThreat, 0);
  assert.equal(alreadyLanded.incomingThreat, 0);
});

test("a readable punch can interrupt an uncommitted attack for defense", () => {
  const roster = createInitialLeague().roster;
  const environment = createTrainingEnvironment(roster[0].id, roster[1].id);
  environment.bout.left.x = 2.7;
  environment.bout.right.x = 3.48;
  environment.bout.left.y = 2.7;
  environment.bout.right.y = 2.7;
  environment.bout.left.action = "crossHead";
  environment.bout.left.actionDuration = 0.4;
  environment.bout.left.actionElapsed = 0.05;
  environment.bout.left.punchExtensionTarget = 0.8;
  environment.bout.left.handExtension = 0;
  environment.bout.left.thrown = 1;
  environment.bout.left.actionCounts.crossHead = 1;
  environment.bout.right.action = "crossHead";
  environment.bout.right.actionDuration = 0.4;
  environment.bout.right.actionElapsed = 0.12;
  environment.bout.right.sensoryHistory.forEach((snapshot) => {
    snapshot.x = environment.bout.right.x;
    snapshot.y = environment.bout.right.y;
    snapshot.action = "crossHead";
    snapshot.actionProgress = 0.3;
    snapshot.handExtension = 0.18;
    snapshot.punchSide = -1;
  });

  const observation = observeTrainingEnvironment(environment, roster);
  assert.equal(observation.actionReady, true);
  assert.equal(observation.actionMask[ACTIONS.indexOf("slip")], true);

  const transition = stepTrainingEnvironment(environment, roster, "slip");
  assert.equal(transition.environment.bout.left.action, "slip");
  assert.equal(transition.environment.bout.left.thrown, 0);
  assert.equal(transition.environment.bout.left.actionCounts.crossHead, 0);
});

test("tired fighters under sustained impact instinctively cover and create space", () => {
  const roster = createInitialLeague().roster;
  const fighter = roster[0];
  const environment = createTrainingEnvironment(fighter.id, roster[1].id);
  environment.bout.left.stamina = 18;
  environment.bout.left.balance = 0.58;
  environment.bout.left.recentHeadImpact = 0.9;
  environment.bout.left.recentBodyImpact = 0.7;
  environment.bout.left.sustainedPressure = 0.95;

  const decision = getPolicyDecision(
    fighter,
    observeTrainingEnvironment(environment, roster),
  );
  const guard = decision.actionScores[ACTIONS.indexOf("guard")];
  const retreat = decision.actionScores[ACTIONS.indexOf("retreat")];
  const cross = decision.actionScores[ACTIONS.indexOf("crossHead")];

  assert.ok(["guard", "retreat", "circleLeft", "circleRight"].includes(decision.action));
  assert.ok(guard > cross);
  assert.ok(retreat > cross);
});

test("punch contact is impossible outside the attacker's physical reach", () => {
  const roster = createInitialLeague().roster;

  function stagedCross(distance: number) {
    let bout = createBout(roster[0].id, roster[1].id, 1, {
      roundSeconds: 10,
      totalRounds: 1,
    });
    bout.left.x = 2.1;
    bout.right.x = bout.left.x + distance;
    bout.left.sensoryHistory.forEach((snapshot) => {
      snapshot.x = bout.left.x;
      snapshot.y = bout.left.y;
    });
    bout.right.sensoryHistory.forEach((snapshot) => {
      snapshot.x = bout.right.x;
      snapshot.y = bout.right.y;
    });
    for (let tick = 0; tick < secondsAsTicks(0.9); tick += 1) {
      bout = stepBoutWithActions(bout, roster, {
        blue: "crossHead",
        red: "guard",
      });
    }
    return bout.left.landed + bout.left.blocked;
  }

  assert.equal(stagedCross(1.8), 0);
  assert.ok(stagedCross(0.8) > 0);
});

test("training evaluates policy candidates in real simulated bouts", () => {
  const league = createInitialLeague();
  const config = {
    generations: 1,
    population: 5,
    opponents: 1,
    evaluationSeconds: 20,
  };
  // Kaito, not Malik: the accept gate keeps the incumbent unless a candidate
  // genuinely sparred better, and under the exposure model Malik's one-opponent
  // spar saturates — none of five candidates separates from his baseline at any
  // evaluation length, which the gate honestly reports as zero gain. That is
  // the gate working, but this test is about the search moving a brain, so it
  // trains a man with something left to find.
  const first = trainAthlete(league, "kaito-mori", config);
  const second = trainAthlete(league, "kaito-mori", config);
  const trained = first.league.roster.find((fighter) => fighter.id === "kaito-mori");
  // The same athlete before the session, which is what every comparison below
  // is actually against — the league now spans three divisions, so the roster
  // no longer happens to start with him.
  const untrained = league.roster.find((fighter) => fighter.id === "kaito-mori")!;

  assert.equal(first.bouts, 12);
  assert.ok(first.physicsSteps > 0);
  assert.equal(first.candidates, 5);
  assert.ok(first.fitnessAfter >= first.fitnessBefore);
  assert.equal(trained?.policy.generation, 1);
  assert.equal(trained?.policy.evaluatedBouts, 12);
  assert.notDeepEqual(
    trained?.policy.hiddenWeights,
    untrained.policy.hiddenWeights,
  );
  assert.notDeepEqual(
    trained?.policy.outputWeights,
    untrained.policy.outputWeights,
  );
  assert.notDeepEqual(
    trained?.policy.memoryWeights,
    untrained.policy.memoryWeights,
  );
  assert.ok((trained?.conditioning.workloadSteps ?? 0) > 0);
  assert.equal(trained?.conditioning.adaptationCycles, 1);
  assert.ok(
    (trained?.conditioning.lowerBodyEndurance ?? 0) >
      untrained.conditioning.lowerBodyEndurance,
  );
  assert.deepEqual(first, second);
});

test("a finished fight is what teaches the two brains that fought it", () => {
  const league = createInitialLeague();
  const [blue, red] = league.roster.filter(
    (fighter) => fighter.weightClass === "middleweight",
  );
  const ledger = createDecisionLedger([blue.id, red.id]);
  const bout = simulateBoutToCompletion(
    league.roster,
    blue.id,
    red.id,
    { roundSeconds: 60, totalRounds: 1 },
    ledger,
  );
  const episodes = sealDecisionLedger(ledger, bout);
  const learned = learnFromBout(league, episodes);
  const taught = learned.roster.find((fighter) => fighter.id === blue.id)!;
  const bystander = league.roster.find(
    (fighter) => fighter.id !== blue.id && fighter.id !== red.id,
  )!;

  // Both men in the ring, and only them.
  assert.equal(episodes.length, 2);
  assert.ok(taught.policy.learnedDecisions > 0);
  assert.notDeepEqual(taught.policy.outputWeights, blue.policy.outputWeights);
  assert.notDeepEqual(taught.policy.hiddenWeights, blue.policy.hiddenWeights);
  assert.deepEqual(
    learned.roster.find((fighter) => fighter.id === bystander.id)?.policy,
    bystander.policy,
  );

  // Credit lands on decisions, not on ticks: a fighter cannot be credited for
  // more choices than the bout gave him the chance to make.
  const decisions = episodes.find(
    (episode) => episode.fighterId === blue.id,
  )!.records.length;
  assert.equal(taught.policy.learnedDecisions, decisions);
  assert.ok(decisions < bout.tick);

  // Every weight stays rounded, or the roster JSON persisted on each league
  // write would balloon with full-precision floats.
  const weights = [
    ...taught.policy.outputWeights.flat(),
    ...taught.policy.hiddenWeights.flat(),
    ...taught.policy.memoryWeights.flat(),
  ];
  assert.ok(weights.every((weight) => Number(weight.toFixed(4)) === weight));
  assert.ok(weights.every((weight) => Math.abs(weight) <= 4));
});

test("the neural influence dial opens at the floor and climbs with credited decisions", () => {
  const debutant = createInitialLeague().roster[0].policy;
  const seasoned = { ...debutant, learnedDecisions: 25000 };
  const veteran = { ...debutant, learnedDecisions: 250000 };

  // A brain nobody has rewarded for anything only ever flavours the choice.
  assert.equal(debutant.learnedDecisions, 0);
  assert.equal(neuralInfluence(debutant), 0.3);
  assert.equal(neuralInfluence(seasoned), 0.75);
  assert.ok(neuralInfluence(veteran) > neuralInfluence(seasoned));
  assert.ok(neuralInfluence(veteran) < 1.2);
});

test("the scouting snapshot covers every feature the brain is wired for", () => {
  const fighter = createInitialLeague().roster[0];
  const snapshot = neutralObservation();

  // The snapshot had drifted three short of the vector the net consumes. It
  // read as zeros rather than breaking, so nothing complained — this is the
  // assertion that would have.
  assert.equal(snapshot.length, BOXING_MODEL.observationFeatures);
  assert.equal(snapshot.length, fighter.policy.weights[0].length);
  assert.ok(snapshot.every((value) => Number.isFinite(value)));

  const preferences = getActionPreferences(fighter);
  assert.equal(preferences.length, ACTIONS.length);
  assert.ok(preferences.every((entry) => entry.value >= 0 && entry.value <= 100));
});
