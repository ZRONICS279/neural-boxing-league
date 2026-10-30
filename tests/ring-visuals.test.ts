import assert from "node:assert/strict";
import test from "node:test";

import {
  BOXING_MODEL,
  createBout,
  createInitialLeague,
  ringDistance,
  stepBoutWithActions,
  type BoutState,
  type Fighter,
  type FighterAction,
  type ImpactZone,
} from "../app/simulation.ts";

/** Mirrors the geometry the Boxer component uses to aim a drawn punch. */
const SHOULDER_HEIGHT_FRACTION = 0.82;
const HEAD_ZONES = new Set<ImpactZone>([
  "jaw",
  "chin",
  "nose",
  "temple",
  "forehead",
  "cheek",
]);

function aimPitchDegrees(bout: BoutState) {
  const attacker = bout.left;
  const shoulderHeightM = attacker.heightM * SHOULDER_HEIGHT_FRACTION;
  const separationM = Math.max(0.18, ringDistance(attacker, bout.right));
  return (
    (Math.atan2(shoulderHeightM - attacker.punchAimHeight, separationM) * 180) / Math.PI
  );
}

function throwPunch(
  roster: Fighter[],
  attack: FighterAction,
  defend: FighterAction,
  // 1.4 s of exchange whatever the tick rate — the punches these aim lines
  // are measured on take the same wall-clock time at any physics step.
  ticks = Math.round(1.4 / BOXING_MODEL.physicsStepSeconds),
  fromTick = 0,
) {
  // Fixed staging distances below only read correctly against the build these
  // aim lines were measured on, so name the pair instead of taking whoever
  // happens to sit at the top of a now three-division roster.
  let bout = createBout("malik-okoro", "jonah-vale", 1);
  bout.running = true;
  bout.left.x = 2.65;
  bout.right.x = 3.45;
  let peak = { extension: -1, pitch: 0, zone: "guard" as ImpactZone, bout };
  for (let tick = 0; tick < ticks; tick += 1) {
    bout = stepBoutWithActions(bout, roster, { blue: attack, red: defend });
    if (tick >= fromTick && bout.left.handExtension > peak.extension) {
      peak = {
        extension: bout.left.handExtension,
        pitch: aimPitchDegrees(bout),
        zone: bout.left.punchAimZone,
        bout,
      };
    }
  }
  return peak;
}

test("head punches angle up and body punches angle down", () => {
  const roster = createInitialLeague().roster;

  for (const attack of ["jabHead", "crossHead", "hookHead"] as FighterAction[]) {
    const shot = throwPunch(roster, attack, "guard");
    assert.ok(HEAD_ZONES.has(shot.zone), `${attack} aims at a head zone, got ${shot.zone}`);
    assert.ok(shot.pitch < 0, `${attack} angles up, got ${shot.pitch.toFixed(1)}deg`);
    assert.ok(shot.extension > 0, `${attack} actually extends the hand`);
  }

  for (const attack of ["jabBody", "crossBody", "hookBody"] as FighterAction[]) {
    const shot = throwPunch(roster, attack, "guard");
    assert.ok(!HEAD_ZONES.has(shot.zone), `${attack} aims at a body zone, got ${shot.zone}`);
    assert.ok(shot.pitch > 15, `${attack} angles down, got ${shot.pitch.toFixed(1)}deg`);
  }
});

test("the drawn aim follows the defender's head when it moves", () => {
  const roster = createInitialLeague().roster;
  // The opening cross launches off a read taken before the weave has dropped
  // the head — at any tick rate — so measure a cross thrown once the weave is
  // established, with room in the window for a whole punch after that point.
  const settled = Math.round(0.9 / BOXING_MODEL.physicsStepSeconds);
  const window = Math.round(1.8 / BOXING_MODEL.physicsStepSeconds);
  const standing = throwPunch(roster, "crossHead", "guard", window, settled);
  const weaving = throwPunch(roster, "crossHead", "weave", window, settled);

  // A weave drops the head below the shoulder line, so the same cross has to
  // travel downward instead of upward to reach it.
  assert.ok(weaving.bout.right.headLevel < standing.bout.right.headLevel);
  assert.ok(
    weaving.pitch > standing.pitch + 5,
    `weave should lower the aim line: ${standing.pitch.toFixed(1)} -> ${weaving.pitch.toFixed(1)}`,
  );
});

test("each anatomical zone gets its own aim line", () => {
  const roster = createInitialLeague().roster;
  const jab = throwPunch(roster, "jabHead", "guard");
  const cross = throwPunch(roster, "crossHead", "guard");

  // jab and cross select different zones, and the per-zone anatomical offset
  // has to survive into the angle the arm is drawn at.
  assert.notEqual(jab.zone, cross.zone);
  assert.ok(
    Math.abs(jab.pitch - cross.pitch) > 1,
    `zones should not share one aim line: ${jab.zone} ${jab.pitch.toFixed(1)} vs ${cross.zone} ${cross.pitch.toFixed(1)}`,
  );
});

test("a guarding defender blocks the punch it is actually covering", () => {
  const roster = createInitialLeague().roster;
  const head = throwPunch(roster, "crossHead", "guard");

  // The renderer raises the guard from the attacker's own aim zone, so that
  // read has to be available on the attacker while the hand is out.
  assert.ok(head.bout.left.handExtension >= 0);
  assert.ok(HEAD_ZONES.has(head.bout.left.punchAimZone));
  assert.equal(head.bout.right.action, "guard");
  assert.ok(
    head.bout.left.blocked + head.bout.left.landed > 0,
    "the exchange resolves to a block or a landing",
  );
});
