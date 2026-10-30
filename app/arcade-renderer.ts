/** Arcade fight renderer for the native MuJoCo pose replay.

Kept apart from the React component so the drawing can be exercised against a
recording 2D context in the test suite instead of only in a browser.
*/

export type Vector3 = [number, number, number];

export interface PoseSegment {
  position: Vector3;
  quaternion: [number, number, number, number];
}

export interface ContactTelemetry {
  groundForces: { left: number; right: number };
  gloveForces: { left: number; right: number };
  headForce: number;
  bodyForce: number;
  centerOfMass: Vector3;
}

export interface PhysiologyTelemetry {
  stamina: number;
  guardStability: number;
  equilibrium: number;
  activeControl: number;
  jointFatigue: number;
  neurologicalLoad: number;
  bodyShock: number;
  stunSeconds: number;
  knockout: boolean;
  knockoutCause: string;
}

export interface ImpactTelemetry {
  kinetic_energy_j: number;
  head_energy_j: number;
  body_energy_j: number;
  closing_velocity_mps: number;
  effective_mass_kg: number;
  directness: number;
  rotational_transfer: number;
  rotational_impulse_nms: number;
  neurological_load: number;
  body_shock: number;
  guard_absorption: number;
  power_shot: boolean;
  target: string;
  anatomical_zone: string;
  strike_kind: string;
  impact_point: Vector3;
  trajectory: Vector3;
}

export interface ProjectilePose {
  id: string;
  position: Vector3;
  velocity: Vector3;
  active: boolean;
  targetSide: "blue" | "red";
  hit: boolean;
}

export interface ProjectileDrillTelemetry {
  hits: number;
  dodges: number;
  deflections: number;
  hit_impulse_ns: number;
  peak_force_n: number;
  incoming_speed_mps: number;
  recoverySeconds: number;
}

export interface TacticsTelemetry {
  command: {
    jab: number;
    cross: number;
    hook: number;
    guard: number;
  };
  perceivedThreat: number;
  fastInterrupt: boolean;
}

export interface PoseFrame {
  time: number;
  bodies: {
    blue: Record<string, PoseSegment>;
    red: Record<string, PoseSegment>;
  };
  contacts?: {
    blue: ContactTelemetry;
    red: ContactTelemetry;
  };
  physiology?: {
    blue: PhysiologyTelemetry;
    red: PhysiologyTelemetry;
  };
  impacts?: {
    blue: ImpactTelemetry;
    red: ImpactTelemetry;
  };
  projectiles?: ProjectilePose[];
  projectileDrill?: {
    blue: ProjectileDrillTelemetry;
    red: ProjectileDrillTelemetry;
  };
  tactics?: {
    blue: TacticsTelemetry;
    red: TacticsTelemetry;
  };
}

export interface ReplayPayload {
  available: boolean;
  replayId: number;
  endReason: "waiting" | "fall" | "knockout" | "damage" | "horizon";
  curriculum: string;
  frames: PoseFrame[];
}

export interface CameraState {
  yaw: number;
  pitch: number;
  distance: number;
  target: Vector3;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
}

export const CAMERA_DEFAULT: CameraState = {
  yaw: -Math.PI / 2,
  pitch: 0.12,
  distance: 6.4,
  target: [0, 0, 1.0],
};

export const SOLO_CURRICULA = new Set([
  "balance",
  "footwork",
  "projectile_evasion",
  "impact_recovery",
]);
const DISPLAY_FONT = '"DIN Condensed", "Arial Narrow", "Roboto Condensed", Impact, sans-serif';
const MONO_FONT = "SFMono-Regular, Consolas, monospace";

function add(first: Vector3, second: Vector3): Vector3 {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function subtract(first: Vector3, second: Vector3): Vector3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function scale(vector: Vector3, amount: number): Vector3 {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function dot(first: Vector3, second: Vector3) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first: Vector3, second: Vector3): Vector3 {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return scale(vector, 1 / length);
}

const LIMBS: Array<{ start: string; end: string; startRadius: number; endRadius: number }> = [
  { start: "pelvis", end: "abdomen", startRadius: 0.15, endRadius: 0.14 },
  { start: "abdomen", end: "chest", startRadius: 0.14, endRadius: 0.17 },
  { start: "chest", end: "head", startRadius: 0.09, endRadius: 0.07 },
  { start: "chest", end: "left_upper_arm", startRadius: 0.09, endRadius: 0.075 },
  { start: "left_upper_arm", end: "left_forearm", startRadius: 0.075, endRadius: 0.062 },
  { start: "left_forearm", end: "left_glove", startRadius: 0.062, endRadius: 0.07 },
  { start: "chest", end: "right_upper_arm", startRadius: 0.09, endRadius: 0.075 },
  { start: "right_upper_arm", end: "right_forearm", startRadius: 0.075, endRadius: 0.062 },
  { start: "right_forearm", end: "right_glove", startRadius: 0.062, endRadius: 0.07 },
  { start: "pelvis", end: "left_thigh", startRadius: 0.13, endRadius: 0.11 },
  { start: "left_thigh", end: "left_shin", startRadius: 0.11, endRadius: 0.08 },
  { start: "left_shin", end: "left_foot", startRadius: 0.08, endRadius: 0.06 },
  { start: "pelvis", end: "right_thigh", startRadius: 0.13, endRadius: 0.11 },
  { start: "right_thigh", end: "right_shin", startRadius: 0.11, endRadius: 0.08 },
  { start: "right_shin", end: "right_foot", startRadius: 0.08, endRadius: 0.06 },
];

const SHADOW_PARTS = ["pelvis", "chest", "left_foot", "right_foot", "left_glove", "right_glove"];
const RING_HALF = 3.05;
const ROPE_HEIGHTS = [0.5, 0.92, 1.34, 1.76];
const CORNER_OFFSETS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const SPARK_LIFE_MS = 460;
const COMBO_WINDOW_MS = 1400;

interface Spark {
  position: Vector3;
  born: number;
  power: number;
  tone: string;
}

interface DrawCommand {
  depth: number;
  draw: () => void;
}

export interface SceneEffects {
  sparks: Spark[];
  shake: number;
  flash: number;
  combo: number;
  comboShownAt: number;
  lastImpactKey: string;
  hitFlash: { blue: number; red: number };
}

export function createEffects(): SceneEffects {
  return {
    sparks: [],
    shake: 0,
    flash: 0,
    combo: 0,
    comboShownAt: 0,
    lastImpactKey: "",
    hitFlash: { blue: 0, red: 0 },
  };
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function shade(color: string, amount: number) {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((part) => part + part).join("") : hex;
  const value = Number.parseInt(full, 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) =>
    Math.max(0, Math.min(255, Math.round(
      amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount,
    ))),
  );
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function fighterCenter(athlete: Record<string, PoseSegment>): Vector3 {
  const pelvis = athlete.pelvis?.position;
  const chest = athlete.chest?.position;
  if (!pelvis) return [0, 0, 0.95];
  if (!chest) return pelvis;
  return scale(add(pelvis, chest), 0.5);
}

// A fighting game watches the bout from the side of the exchange rather than
// from a fixed compass bearing, so the camera rides the axis between the two
// athletes and pulls back to whatever their separation currently is.
export function arcadeCamera(
  frame: PoseFrame | null,
  curriculum: string,
): CameraState {
  if (!frame) return CAMERA_DEFAULT;
  const blue = fighterCenter(frame.bodies.blue);
  if (SOLO_CURRICULA.has(curriculum)) {
    return { yaw: -Math.PI / 2, pitch: 0.13, distance: 5.4, target: [blue[0], blue[1], 1.0] };
  }
  const red = fighterCenter(frame.bodies.red);
  const separation = Math.hypot(red[0] - blue[0], red[1] - blue[1]);
  return {
    yaw: Math.atan2(red[1] - blue[1], red[0] - blue[0]) - Math.PI / 2,
    pitch: 0.11,
    distance: 4.5 + separation * 0.85,
    target: [(blue[0] + red[0]) / 2, (blue[1] + red[1]) / 2, 1.0],
  };
}

export function easeCamera(current: CameraState, wanted: CameraState, amount: number): CameraState {
  let yawDelta = wanted.yaw - current.yaw;
  while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
  while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
  return {
    yaw: current.yaw + yawDelta * amount,
    pitch: lerp(current.pitch, wanted.pitch, amount),
    distance: lerp(current.distance, wanted.distance, amount),
    target: [
      lerp(current.target[0], wanted.target[0], amount),
      lerp(current.target[1], wanted.target[1], amount),
      lerp(current.target[2], wanted.target[2], amount),
    ],
  };
}

function projector(
  width: number,
  height: number,
  camera: CameraState,
  shakeX: number,
  shakeY: number,
) {
  const target = camera.target;
  const horizontal = Math.cos(camera.pitch) * camera.distance;
  const position: Vector3 = [
    target[0] + Math.cos(camera.yaw) * horizontal,
    target[1] + Math.sin(camera.yaw) * horizontal,
    target[2] + Math.sin(camera.pitch) * camera.distance,
  ];
  const forward = normalize(subtract(target, position));
  const right = normalize(cross(forward, [0, 0, 1]));
  const up = normalize(cross(right, forward));
  const focalLength = Math.min(width * 0.82, height * 1.35);

  return (point: Vector3): ProjectedPoint | null => {
    const relative = subtract(point, position);
    const depth = dot(relative, forward);
    if (depth <= 0.12) return null;
    return {
      x: width / 2 + shakeX + (dot(relative, right) * focalLength) / depth,
      y: height / 2 + shakeY - (dot(relative, up) * focalLength) / depth,
      depth,
    };
  };
}

type Project = ReturnType<typeof projector>;

function drawBackdrop(context: CanvasRenderingContext2D, width: number, height: number) {
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#04070c");
  sky.addColorStop(0.42, "#0b1a2a");
  sky.addColorStop(1, "#05090e");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  [0.3, 0.7].forEach((position, index) => {
    const originX = width * position;
    const cone = context.createRadialGradient(originX, -height * 0.15, 0, originX, height * 0.62, height * 0.95);
    cone.addColorStop(0, index === 0 ? "rgba(120, 190, 255, 0.20)" : "rgba(255, 205, 140, 0.17)");
    cone.addColorStop(0.55, "rgba(120, 170, 220, 0.05)");
    cone.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = cone;
    context.beginPath();
    context.moveTo(originX, -height * 0.1);
    context.lineTo(originX + width * 0.42, height);
    context.lineTo(originX - width * 0.42, height);
    context.closePath();
    context.fill();
  });
}

// Seeded from the row and column so the crowd holds still between frames and
// only the sway animates.
function drawCrowd(context: CanvasRenderingContext2D, width: number, height: number, time: number) {
  const horizon = height * 0.5;
  context.save();
  context.beginPath();
  context.rect(0, 0, width, horizon + 6);
  context.clip();
  for (let row = 0; row < 5; row += 1) {
    const depth = row / 4;
    const rowY = horizon - 4 - depth * horizon * 0.44;
    const size = 9 - depth * 5.2;
    const spacing = size * 2.1;
    context.fillStyle = `rgba(${10 + depth * 12}, ${16 + depth * 16}, ${26 + depth * 20}, ${0.95 - depth * 0.35})`;
    for (let index = 0; index * spacing < width + spacing; index += 1) {
      const seed = Math.sin(index * 12.9898 + row * 78.233) * 43758.5453;
      const jitter = seed - Math.floor(seed) - 0.5;
      const sway = Math.sin(time * 0.0011 + index * 0.7 + row) * (1.6 - depth);
      const x = index * spacing + jitter * spacing * 0.4;
      context.beginPath();
      context.arc(x, rowY + jitter * 2 + sway, size * 0.5, 0, Math.PI * 2);
      context.fill();
      context.fillRect(x - size * 0.5, rowY + size * 0.4 + sway, size, size);
    }
  }
  const haze = context.createLinearGradient(0, horizon * 0.2, 0, horizon + 6);
  haze.addColorStop(0, "rgba(6, 12, 20, 0)");
  haze.addColorStop(1, "rgba(6, 14, 24, 0.92)");
  context.fillStyle = haze;
  context.fillRect(0, 0, width, horizon + 6);
  context.restore();
}

function drawCanvasMat(context: CanvasRenderingContext2D, project: Project) {
  const corners = CORNER_OFFSETS.map(([x, y]) => project([x * RING_HALF, y * RING_HALF, 0]));
  if (!corners.every((corner) => corner)) return;
  const points = corners as ProjectedPoint[];
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
  context.closePath();
  const middle = points.reduce((total, point) => total + point.y, 0) / points.length;
  const mat = context.createLinearGradient(0, middle - 220, 0, middle + 220);
  mat.addColorStop(0, "#123a56");
  mat.addColorStop(0.5, "#0d2c43");
  mat.addColorStop(1, "#081d2c");
  context.fillStyle = mat;
  context.fill();

  context.save();
  context.clip();
  context.strokeStyle = "rgba(120, 190, 240, 0.1)";
  context.lineWidth = 1;
  for (let position = -3; position <= 3.01; position += 0.5) {
    [
      [project([position, -RING_HALF, 0.002]), project([position, RING_HALF, 0.002])],
      [project([-RING_HALF, position, 0.002]), project([RING_HALF, position, 0.002])],
    ].forEach(([from, to]) => {
      if (!from || !to) return;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    });
  }
  const logo = project([0, 0, 0.003]);
  if (logo) {
    context.globalAlpha = 0.14;
    context.fillStyle = "#9fd8ff";
    context.font = `700 ${Math.max(14, 420 / logo.depth)}px ${DISPLAY_FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("FORGE", logo.x, logo.y);
    context.globalAlpha = 1;
  }
  context.restore();
}

// Ropes and posts are split into the half behind the fighters and the half in
// front of them so the athletes sit inside the ring instead of on top of it.
function drawRopes(
  context: CanvasRenderingContext2D,
  project: Project,
  camera: CameraState,
  front: boolean,
) {
  const cameraDirection: Vector3 = [Math.cos(camera.yaw), Math.sin(camera.yaw), 0];
  CORNER_OFFSETS.forEach(([x, y], index) => {
    const [nextX, nextY] = CORNER_OFFSETS[(index + 1) % CORNER_OFFSETS.length];
    const midpoint: Vector3 = [((x + nextX) / 2) * RING_HALF, ((y + nextY) / 2) * RING_HALF, 0];
    if (dot(normalize(midpoint), cameraDirection) > 0 !== front) return;
    ROPE_HEIGHTS.forEach((ropeHeight, ropeIndex) => {
      const from = project([x * RING_HALF, y * RING_HALF, ropeHeight]);
      const to = project([nextX * RING_HALF, nextY * RING_HALF, ropeHeight]);
      if (!from || !to) return;
      const depth = (from.depth + to.depth) / 2;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 + 5 / Math.max(0.5, depth), to.x, to.y);
      context.strokeStyle = ropeIndex % 2 === 0 ? "rgba(226, 232, 240, 0.62)" : "rgba(225, 61, 50, 0.55)";
      context.lineWidth = Math.max(1.2, 11 / depth);
      context.lineCap = "round";
      context.stroke();
    });
  });

  CORNER_OFFSETS.forEach(([x, y]) => {
    const post: Vector3 = [x * RING_HALF, y * RING_HALF, 0];
    if (dot(normalize(post), cameraDirection) > 0 !== front) return;
    const base = project(post);
    const cap = project([post[0], post[1], 1.95]);
    if (!base || !cap) return;
    const thickness = Math.max(2, 26 / base.depth);
    const metal = context.createLinearGradient(base.x - thickness, 0, base.x + thickness, 0);
    metal.addColorStop(0, "#1b2a36");
    metal.addColorStop(0.42, "#43596b");
    metal.addColorStop(1, "#16222c");
    context.beginPath();
    context.moveTo(base.x, base.y);
    context.lineTo(cap.x, cap.y);
    context.strokeStyle = metal;
    context.lineWidth = thickness;
    context.lineCap = "round";
    context.stroke();
  });
}

function drawShadows(
  context: CanvasRenderingContext2D,
  project: Project,
  athlete: Record<string, PoseSegment>,
) {
  SHADOW_PARTS.forEach((name) => {
    const segment = athlete[name];
    if (!segment) return;
    const ground = project([segment.position[0], segment.position[1], 0.004]);
    if (!ground) return;
    const softness = Math.max(0.12, 1 - segment.position[2] * 0.42);
    const radius = Math.max(3, (name === "pelvis" ? 62 : 34) / ground.depth) * (0.55 + softness);
    context.save();
    context.globalAlpha = 0.34 * softness;
    context.fillStyle = "#01060b";
    context.beginPath();
    context.ellipse(ground.x, ground.y, radius, radius * 0.36, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  });
}

// Limbs are tapered capsules lit down one edge. The cross-limb gradient is what
// separates a fighter with volume from a stick figure.
function queueLimb(
  commands: DrawCommand[],
  context: CanvasRenderingContext2D,
  project: Project,
  start: Vector3,
  end: Vector3,
  startRadius: number,
  endRadius: number,
  color: string,
  damageFlash: number,
) {
  const from = project(start);
  const to = project(end);
  if (!from || !to) return;
  const depth = (from.depth + to.depth) / 2;
  const startPixels = Math.max(1.6, (startRadius * 210) / from.depth);
  const endPixels = Math.max(1.4, (endRadius * 210) / to.depth);
  commands.push({
    depth,
    draw: () => {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const normalX = Math.cos(angle - Math.PI / 2);
      const normalY = Math.sin(angle - Math.PI / 2);
      context.beginPath();
      context.arc(from.x, from.y, startPixels, angle + Math.PI / 2, angle - Math.PI / 2);
      context.arc(to.x, to.y, endPixels, angle - Math.PI / 2, angle + Math.PI / 2);
      context.closePath();
      const gradient = context.createLinearGradient(
        from.x + normalX * startPixels,
        from.y + normalY * startPixels,
        from.x - normalX * startPixels,
        from.y - normalY * startPixels,
      );
      gradient.addColorStop(0, shade(color, 0.34 + damageFlash * 0.5));
      gradient.addColorStop(0.44, damageFlash > 0.01 ? shade(color, damageFlash * 0.6) : color);
      gradient.addColorStop(1, shade(color, -0.62));
      context.fillStyle = gradient;
      context.fill();
      context.strokeStyle = "rgba(3, 7, 12, 0.85)";
      context.lineWidth = Math.max(0.8, 5 / depth);
      context.stroke();
    },
  });
}

function queueBall(
  commands: DrawCommand[],
  context: CanvasRenderingContext2D,
  project: Project,
  position: Vector3,
  radius: number,
  color: string,
  highlight: string,
  outline = "rgba(3, 7, 12, 0.85)",
) {
  const point = project(position);
  if (!point) return;
  const pixels = Math.max(2, (radius * 210) / point.depth);
  commands.push({
    depth: point.depth - 0.02,
    draw: () => {
      const gradient = context.createRadialGradient(
        point.x - pixels * 0.36,
        point.y - pixels * 0.4,
        pixels * 0.1,
        point.x,
        point.y,
        pixels,
      );
      gradient.addColorStop(0, highlight);
      gradient.addColorStop(0.55, color);
      gradient.addColorStop(1, shade(color, -0.55));
      context.beginPath();
      context.arc(point.x, point.y, pixels, 0, Math.PI * 2);
      context.fillStyle = gradient;
      context.fill();
      context.strokeStyle = outline;
      context.lineWidth = Math.max(0.8, 5 / point.depth);
      context.stroke();
    },
  });
}

function queueFighter(
  commands: DrawCommand[],
  context: CanvasRenderingContext2D,
  project: Project,
  athlete: Record<string, PoseSegment>,
  color: string,
  damageFlash: number,
  glowGloves: boolean,
) {
  LIMBS.forEach((limb) => {
    const start = athlete[limb.start]?.position;
    const end = athlete[limb.end]?.position;
    if (!start || !end) return;
    queueLimb(commands, context, project, start, end, limb.startRadius, limb.endRadius, color, damageFlash);
  });
  const head = athlete.head?.position;
  if (head) {
    queueBall(commands, context, project, head, 0.115, shade("#8e5d45", damageFlash * 0.7), "#c69277");
  }
  (["left", "right"] as const).forEach((side) => {
    const glove = athlete[`${side}_glove`]?.position;
    if (!glove) return;
    queueBall(
      commands,
      context,
      project,
      glove,
      0.108,
      color,
      shade(color, 0.55),
      glowGloves ? "rgba(255, 226, 150, 0.95)" : "rgba(3, 7, 12, 0.85)",
    );
  });
}

function drawSparks(
  context: CanvasRenderingContext2D,
  project: Project,
  effects: SceneEffects,
  time: number,
) {
  effects.sparks = effects.sparks.filter((spark) => time - spark.born < SPARK_LIFE_MS);
  effects.sparks.forEach((spark) => {
    const point = project(spark.position);
    if (!point) return;
    const life = (time - spark.born) / SPARK_LIFE_MS;
    const fade = 1 - life;
    const ring = (0.18 + life * 0.75) * (210 / point.depth) * (0.6 + spark.power);
    context.save();
    context.globalCompositeOperation = "lighter";

    context.beginPath();
    context.arc(point.x, point.y, ring, 0, Math.PI * 2);
    context.strokeStyle = spark.tone;
    context.globalAlpha = fade * 0.75;
    context.lineWidth = Math.max(1, 6 * fade * (0.6 + spark.power));
    context.stroke();

    context.globalAlpha = fade;
    context.lineWidth = Math.max(1, 4 * fade);
    context.strokeStyle = "#fff4d0";
    for (let index = 0; index < 9; index += 1) {
      const angle = (index / 9) * Math.PI * 2 + spark.born * 0.001;
      context.beginPath();
      context.moveTo(point.x + Math.cos(angle) * ring * 0.35, point.y + Math.sin(angle) * ring * 0.35);
      const reach = ring * (0.85 + (index % 3) * 0.22);
      context.lineTo(point.x + Math.cos(angle) * reach, point.y + Math.sin(angle) * reach);
      context.stroke();
    }

    context.globalAlpha = fade * 0.9;
    const core = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, ring * 0.6);
    core.addColorStop(0, "rgba(255, 255, 240, 0.95)");
    core.addColorStop(1, "rgba(255, 190, 90, 0)");
    context.fillStyle = core;
    context.beginPath();
    context.arc(point.x, point.y, ring * 0.6, 0, Math.PI * 2);
    context.fill();
    context.restore();
  });
}

function meterBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number,
  color: string,
  mirrored: boolean,
) {
  context.fillStyle = "rgba(4, 8, 12, 0.82)";
  context.fillRect(x, y, width, height);
  const amount = Math.max(0, Math.min(1, fill)) * width;
  const gradient = context.createLinearGradient(0, y, 0, y + height);
  gradient.addColorStop(0, shade(color, 0.45));
  gradient.addColorStop(0.5, color);
  gradient.addColorStop(1, shade(color, -0.35));
  context.fillStyle = gradient;
  context.fillRect(mirrored ? x + width - amount : x, y, amount, height);
  context.strokeStyle = "rgba(210, 232, 255, 0.5)";
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
}

function drawHud(
  context: CanvasRenderingContext2D,
  width: number,
  frame: PoseFrame | null,
  effects: SceneEffects,
  labels: { blue: string; red: string },
  solo: boolean,
  episodeSeconds: number,
  endReason: ReplayPayload["endReason"],
  time: number,
) {
  const margin = 16;
  const barWidth = solo ? Math.min(300, width - margin * 2) : Math.min(238, width / 2 - 58);
  const blue = frame?.physiology?.blue;
  const red = frame?.physiology?.red;

  const plate = (
    x: number,
    name: string,
    physiology: PhysiologyTelemetry | undefined,
    color: string,
    mirrored: boolean,
  ) => {
    context.font = `700 13px ${DISPLAY_FONT}`;
    context.textBaseline = "alphabetic";
    context.textAlign = mirrored ? "right" : "left";
    context.fillStyle = "rgba(226, 240, 255, 0.94)";
    context.fillText(name.toUpperCase(), mirrored ? x + barWidth : x, margin + 10);
    meterBar(context, x, margin + 15, barWidth, 11, physiology?.equilibrium ?? 1, color, mirrored);
    meterBar(context, x, margin + 28, barWidth, 5, physiology?.stamina ?? 1, "#ffc247", mirrored);
    meterBar(context, x, margin + 35, barWidth, 4, physiology?.guardStability ?? 1, "#54d397", mirrored);
  };

  plate(margin, labels.blue, blue, "#26a7ff", false);
  if (!solo) plate(width - margin - barWidth, labels.red, red, "#e13d32", true);

  const remaining = Math.max(0, episodeSeconds - (frame?.time ?? 0));
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = `700 30px ${DISPLAY_FONT}`;
  context.fillStyle = remaining < 5 ? "#ff6b5a" : "rgba(255, 236, 190, 0.96)";
  context.fillText(String(Math.ceil(remaining)).padStart(2, "0"), width / 2, margin + 30);

  if (effects.combo >= 2 && time - effects.comboShownAt < 1300) {
    const life = (time - effects.comboShownAt) / 1300;
    context.save();
    context.globalAlpha = 1 - life * life;
    context.textAlign = "left";
    context.font = `700 ${26 + (1 - life) * 8}px ${DISPLAY_FONT}`;
    context.fillStyle = "#ffc247";
    context.fillText(`${effects.combo} HIT COMBO`, margin, margin + 76);
    context.restore();
  }

  const knockout = Boolean(blue?.knockout || red?.knockout);
  if (knockout || endReason === "fall" || endReason === "knockout") {
    context.save();
    context.textAlign = "center";
    context.font = `700 58px ${DISPLAY_FONT}`;
    const banner = knockout ? "K.O." : "DOWN";
    context.lineWidth = 6;
    context.strokeStyle = "rgba(6, 10, 16, 0.9)";
    context.strokeText(banner, width / 2, 128);
    const gradient = context.createLinearGradient(0, 96, 0, 136);
    gradient.addColorStop(0, "#fff0c2");
    gradient.addColorStop(1, "#e13d32");
    context.fillStyle = gradient;
    context.fillText(banner, width / 2, 128);
    context.restore();
  }
}

// Impacts arrive as replay telemetry rather than as events, so a new contact is
// recognised by its zone, strike, and contact point changing.
export function trackImpacts(effects: SceneEffects, frame: PoseFrame | null, time: number) {
  effects.shake *= 0.86;
  effects.flash *= 0.84;
  effects.hitFlash.blue *= 0.88;
  effects.hitFlash.red *= 0.88;
  if (!frame?.impacts) return;
  (["blue", "red"] as const).forEach((side) => {
    const impact = frame.impacts?.[side];
    if (!impact || impact.anatomical_zone === "none") return;
    const key = `${side}:${impact.anatomical_zone}:${impact.strike_kind}:${impact.impact_point.join(",")}`;
    if (key === effects.lastImpactKey) return;
    effects.lastImpactKey = key;
    const power = Math.min(1.6, 0.35 + impact.kinetic_energy_j * 0.02 + (impact.power_shot ? 0.7 : 0));
    effects.sparks.push({
      position: impact.impact_point,
      born: time,
      power,
      tone: impact.power_shot ? "#ffd166" : "#9fe8ff",
    });
    effects.shake = Math.min(16, effects.shake + power * 7);
    effects.flash = Math.min(0.5, effects.flash + (impact.power_shot ? 0.34 : 0.1));
    effects.hitFlash[side === "blue" ? "red" : "blue"] = 1;
    effects.combo = time - effects.comboShownAt < COMBO_WINDOW_MS ? effects.combo + 1 : 1;
    effects.comboShownAt = time;
  });
}

export function drawWorld(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: PoseFrame | null,
  camera: CameraState,
  curriculum: string,
  effects: SceneEffects,
  labels: { blue: string; red: string },
  episodeSeconds: number,
  endReason: ReplayPayload["endReason"],
  time: number,
) {
  const project = projector(
    width,
    height,
    camera,
    (Math.random() - 0.5) * effects.shake,
    (Math.random() - 0.5) * effects.shake,
  );
  const solo = SOLO_CURRICULA.has(curriculum);
  const commands: DrawCommand[] = [];

  drawBackdrop(context, width, height);
  drawCrowd(context, width, height, time);
  drawCanvasMat(context, project);
  drawRopes(context, project, camera, false);

  if (frame) {
    const sides = solo ? (["blue"] as const) : (["blue", "red"] as const);
    sides.forEach((side) => drawShadows(context, project, frame.bodies[side]));
    sides.forEach((side) => {
      const command = frame.tactics?.[side]?.command;
      const punching = Math.max(command?.jab ?? 0, command?.cross ?? 0, command?.hook ?? 0) > 0.4;
      queueFighter(
        commands,
        context,
        project,
        frame.bodies[side],
        side === "blue" ? "#2b6fb8" : "#b8382f",
        effects.hitFlash[side],
        punching,
      );
      const contact = frame.contacts?.[side];
      if (!contact) return;
      (["left", "right"] as const).forEach((foot) => {
        const force = contact.groundForces[foot];
        const position = frame.bodies[side][`${foot}_foot`]?.position;
        if (!position || force < 40) return;
        const from = project([position[0], position[1], 0.02]);
        const to = project([position[0], position[1], 0.12 + Math.min(0.6, force / 1200)]);
        if (!from || !to) return;
        commands.push({
          depth: from.depth - 0.05,
          draw: () => {
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.strokeStyle = "rgba(255, 194, 71, 0.65)";
            context.lineWidth = Math.max(1, 14 / from.depth);
            context.lineCap = "round";
            context.stroke();
          },
        });
      });
    });

    frame.projectiles?.filter((ball) => ball.active).forEach((ball) => {
      const from = project(subtract(ball.position, scale(ball.velocity, 0.07)));
      const to = project(ball.position);
      if (from && to) {
        commands.push({
          depth: to.depth + 0.01,
          draw: () => {
            const streak = context.createLinearGradient(from.x, from.y, to.x, to.y);
            streak.addColorStop(0, "rgba(84, 211, 151, 0)");
            streak.addColorStop(1, "rgba(140, 255, 200, 0.8)");
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.strokeStyle = streak;
            context.lineWidth = Math.max(1.5, 20 / to.depth);
            context.lineCap = "round";
            context.stroke();
          },
        });
      }
      queueBall(commands, context, project, ball.position, 0.1, ball.hit ? "#e13d32" : "#3fbf85", "#d9ffe9");
    });
  }

  commands.sort((first, second) => second.depth - first.depth);
  commands.forEach((command) => command.draw());

  if (frame) drawSparks(context, project, effects, time);
  drawRopes(context, project, camera, true);

  if (effects.flash > 0.01) {
    context.fillStyle = `rgba(255, 245, 220, ${effects.flash})`;
    context.fillRect(0, 0, width, height);
  }

  const vignette = context.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.32,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.78,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.62)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);

  drawHud(context, width, frame, effects, labels, solo, episodeSeconds, endReason, time);

  context.fillStyle = "rgba(137, 150, 162, 0.65)";
  context.font = `9px ${MONO_FONT}`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText("DRAG: ORBIT · WHEEL: ZOOM · DOUBLE-CLICK: AUTO CAMERA", 16, height - 14);
}

