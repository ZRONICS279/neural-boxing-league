import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CAMERA_DEFAULT,
  arcadeCamera,
  createEffects,
  drawWorld,
  easeCamera,
  trackImpacts,
  type PoseFrame,
} from "../app/arcade-renderer.ts";

const frame = JSON.parse(
  readFileSync(new URL("./fixtures-pose-frame.json", import.meta.url), "utf8"),
) as PoseFrame;

interface RecordedCall {
  name: string;
  args: unknown[];
}

/** A 2D context that records what it was asked to draw. */
function recordingContext(calls: RecordedCall[]) {
  const gradient = {
    addColorStop(...args: unknown[]) {
      calls.push({ name: "addColorStop", args });
    },
  };
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
  };
  return {
    canvas: { width: 960, height: 540 },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 40 }),
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    quadraticCurveTo: record("quadraticCurveTo"),
    arc: record("arc"),
    ellipse: record("ellipse"),
    rect: record("rect"),
    clip: record("clip"),
    fill: record("fill"),
    stroke: record("stroke"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    fillText: record("fillText"),
    strokeText: record("strokeText"),
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
  } as unknown as CanvasRenderingContext2D;
}

function shifted(athlete: PoseFrame["bodies"]["red"], metres: number) {
  return Object.fromEntries(
    Object.entries(athlete).map(([name, segment]) => [
      name,
      { ...segment, position: [segment.position[0] + metres, segment.position[1], segment.position[2]] },
    ]),
  ) as PoseFrame["bodies"]["red"];
}

function render(pose: PoseFrame | null, curriculum: string) {
  const calls: RecordedCall[] = [];
  const effects = createEffects();
  trackImpacts(effects, pose, 1000);
  drawWorld(
    recordingContext(calls),
    960,
    540,
    pose,
    arcadeCamera(pose, curriculum),
    curriculum,
    effects,
    { blue: "Okoro", red: "Vale" },
    14,
    "horizon",
    1000,
  );
  return { calls, effects };
}

test("the arcade renderer draws a full fight scene from one real pose frame", () => {
  const { calls } = render(frame, "moving_strikes");
  const names = calls.map((call) => call.name);

  // Ring, mat grid, and ropes.
  assert.ok(names.filter((name) => name === "quadraticCurveTo").length >= 8, "ropes are drawn");
  assert.ok(names.includes("clip"), "the mat clips its grid and logo");

  // Both athletes: 15 limbs each plus head and gloves, drawn as filled shapes.
  const arcs = calls.filter((call) => call.name === "arc").length;
  assert.ok(arcs >= 60, `limb capsules and balls drawn, saw ${arcs} arcs`);
  assert.ok(names.filter((name) => name === "ellipse").length >= 6, "ground shadows drawn");

  // HUD: name plates, meters, and the round clock.
  const text = calls.filter((call) => call.name === "fillText").map((call) => String(call.args[0]));
  assert.ok(text.includes("OKORO"), "blue name plate");
  assert.ok(text.includes("VALE"), "red name plate");
  assert.ok(text.some((entry) => /^\d\d$/.test(entry)), "round clock");
  assert.ok(
    calls.filter((call) => call.name === "strokeRect").length >= 6,
    "health, stamina, and guard meters for both fighters",
  );
});

test("a scored contact produces a spark, a shake, and a combo", () => {
  const effects = createEffects();
  trackImpacts(effects, frame, 1000);

  assert.equal(effects.sparks.length, 1);
  assert.ok(effects.shake > 0, "the camera is kicked");
  assert.equal(effects.combo, 1);

  // The same contact must not fire twice, but a later one extends the combo.
  trackImpacts(effects, frame, 1016);
  assert.equal(effects.combo, 1);

  const second = structuredClone(frame) as PoseFrame;
  second.impacts!.blue.impact_point = [0.1, 0.2, 1.3];
  trackImpacts(effects, second, 1200);
  assert.equal(effects.combo, 2);
  assert.equal(effects.sparks.length, 2);
});

test("the fight camera frames the exchange and a solo drill differently", () => {
  const contact = arcadeCamera(frame, "moving_strikes");
  const solo = arcadeCamera(frame, "balance");
  // The camera frames each athlete on its pelvis/chest midpoint, so compare
  // against the same point rather than the pelvis alone.
  const center = (athlete: PoseFrame["bodies"]["red"]) =>
    athlete.pelvis.position.map(
      (value, axis) => (value + athlete.chest.position[axis]) / 2,
    ) as [number, number, number];
  const blue = center(frame.bodies.blue);
  const red = center(frame.bodies.red);

  // A contact drill watches from the side of the exchange: the camera looks
  // down the axis between the fighters and holds the midpoint between them.
  assert.ok(Math.abs(contact.target[0] - (blue[0] + red[0]) / 2) < 0.35);
  assert.ok(Math.abs(contact.target[1] - (blue[1] + red[1]) / 2) < 0.35);
  const axis = Math.atan2(red[1] - blue[1], red[0] - blue[0]);
  assert.ok(Math.abs(Math.abs(axis - contact.yaw) - Math.PI / 2) < 1e-9, "camera is side-on");

  // Distance follows how far apart they are, so a clinch pushes in and a wide
  // ring pulls back. A solo drill just sits on the one athlete.
  const apart = arcadeCamera(
    { ...frame, bodies: { blue: frame.bodies.blue, red: shifted(frame.bodies.red, 2.5) } },
    "moving_strikes",
  );
  assert.ok(apart.distance > contact.distance + 1.5, "wider stance pulls the camera back");
  assert.equal(solo.distance, 5.4);
  assert.ok(Math.abs(solo.target[0] - blue[0]) < 0.35);

  // Easing never snaps and never takes the long way around the circle.
  const eased = easeCamera(
    { ...CAMERA_DEFAULT, yaw: -Math.PI + 0.05 },
    { ...CAMERA_DEFAULT, yaw: Math.PI - 0.05 },
    0.5,
  );
  assert.ok(Math.abs(eased.yaw) > Math.PI - 0.1, `took the short way, got ${eased.yaw}`);
});

test("the renderer survives an empty replay and a solo curriculum", () => {
  assert.doesNotThrow(() => render(null, "balance"));
  const { calls } = render(frame, "projectile_evasion");
  const text = calls.filter((call) => call.name === "fillText").map((call) => String(call.args[0]));
  assert.ok(text.includes("OKORO"));
  assert.ok(!text.includes("VALE"), "no rival plate during a solo drill");
});
