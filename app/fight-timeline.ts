/** The wire format a fight travels in once the engine stays on the server.
 *
 * A timeline is everything the renderer and the stage read of a bout, and
 * nothing else — no policy, no observations, no seed. Continuous pose scalars
 * are sampled every `stride` ticks, quantized to int16 deltas and interpolated
 * on playback; anything discrete (the action being thrown, a landed punch, a
 * turned stance) rides a change-log pinned to exact ticks, because a sound cue
 * or an impact flash that arrives two ticks late reads as a miss.
 *
 * This module is the codec only, and it must stay importable by the client:
 * it may depend on fight-model and nothing heavier. The capture side that
 * steps the actual engine lives in worker/fight-timeline.ts. */
import {
  BOXING_MODEL,
  type Corner,
  type FightEvent,
  type FighterAction,
  type ImpactZone,
  type RoundCard,
} from "./fight-model.ts";

export const TIMELINE_VERSION = 1;

/** Ticks between pose samples. 1 records every joint at the full 50 Hz step —
 *  the body torque on a punch keeps its sharpest instant instead of being
 *  rebuilt from interpolation. That is the point of running the league at
 *  50 Hz, so the recording spends the extra weight (a 5 here is a 10 Hz pose
 *  track at roughly a third the size, if that trade ever needs remaking). */
export const TIMELINE_STRIDE = 1;

/** Ticks per served chunk: five seconds of fight. A fight is stored and served
 *  the way video is — as closed segments, each one immutable once written, and
 *  a viewer plays one chunk behind the live edge. Serving only whole chunks is
 *  what makes every response cacheable forever and leaves nothing to leak: a
 *  chunk either has fully aired or it does not exist to the outside. Must stay
 *  a multiple of the stride so chunk edges land on the sample grid. */
export const TIMELINE_CHUNK_TICKS = 250;

/** Continuous per-fighter scalars, interpolated between samples. */
export const FIGHTER_LERP_FIELDS = [
  "x",
  "y",
  "headLevel",
  "headOffset",
  "health",
  "stamina",
  "headTrauma",
  "hurtSeconds",
  "stunSeconds",
  "downCountSeconds",
  "handVelocity",
  "punchAimHeight",
] as const;

/** The articulated body, minus `plantedFoot` which is discrete. */
export const BODY_LERP_FIELDS = [
  "leadFootOffset",
  "rearFootOffset",
  "leadKneeFlexion",
  "rearKneeFlexion",
  "hipRotation",
  "shoulderRotation",
  "centerOfMassHeight",
  "leadGroundForceN",
  "rearGroundForceN",
  "resultantGroundForceN",
  "forwardGroundForceN",
  "lateralGroundForceN",
  "previousGroundForceN",
  "rateOfForceDevelopment",
  "kineticChainEfficiency",
  "gaitPhase",
] as const;

/** Stage readouts that step rather than glide: shown as the latest sample,
 *  never interpolated, so a peak-force figure does not count itself up. */
export const FIGHTER_HOLD_FIELDS = [
  "decisionConfidence",
  "peakHandSpeed",
  "peakForceN",
  "cleanImpactJ",
] as const;

/** Bout-level clocks. */
export const BOUT_LERP_FIELDS = ["roundTime", "breakTime", "introSeconds"] as const;

export type TimelineSide = "left" | "right";

/** One corner instruction's worth of what-is-he-doing: emitted whenever the
 *  action or any of its parameters change, or whenever the elapsed timer stops
 *  agreeing with straight-line time (capture re-syncs instead of assuming the
 *  engine never pauses a timer). */
export interface ActionRecord {
  tick: number;
  side: TimelineSide;
  kind: "action";
  action: FighterAction;
  elapsed: number;
  duration: number;
  hand: "lead" | "rear";
  zone: ImpactZone;
  extension: number;
}

/** The punch-outcome cluster: strike identity plus the running counters, all
 *  carried absolute so a viewer joining mid-round lands on true numbers. */
export interface ImpactRecord {
  tick: number;
  side: TimelineSide;
  kind: "impact";
  strike: FighterAction | "none";
  zone: ImpactZone;
  impactJ: number;
  /** Optional because archived timelines predate the counter call; a missing
   * field reads as an ordinary landing. */
  counter?: boolean;
  thrown: number;
  landed: number;
  blocked: number;
  knockdowns: number;
}

export interface FacingRecord {
  tick: number;
  side: TimelineSide;
  kind: "facing";
  value: -1 | 1;
}

export interface FootRecord {
  tick: number;
  side: TimelineSide;
  kind: "foot";
  value: "lead" | "rear" | "both";
}

export interface RoundRecord {
  tick: number;
  kind: "round";
  round: number;
}

export type TimelineRecord =
  | ActionRecord
  | ImpactRecord
  | FacingRecord
  | FootRecord
  | RoundRecord;

export interface TimelineFighterHeader {
  fighterId: string;
  corner: Corner;
  heightM: number;
  reachM: number;
}

/** What the capture hands the encoder: raw per-tick-sampled channels plus the
 *  change-log. Channel arrays all share the same sample count. */
/** One line of the ringside call, pinned to the tick it was said on.
 *
 * The announcer is a pure function of the frames it is shown, so the recording
 * pass runs it over every frame and writes the call down beside the fight; a
 * viewer then reads the same lines off the chunk instead of re-deriving them
 * from the ten-a-second frames the stage publishes. `line` is the line's place
 * in the whole fight's call, which is also how its spoken clip is named on the
 * server. */
export interface TimelineVoiceLine {
  tick: number;
  line: number;
  text: string;
  register: "call" | "alarm" | "color";
  corner: Corner | null;
  holdMs: number;
}

export interface TimelineCapture {
  tickSeconds: number;
  stride: number;
  /** First tick this capture covers: 0 for a whole fight, the chunk boundary
   *  for a slice. Channel sample 0 sits here, and carry-in records are pinned
   *  here so playback never needs an earlier chunk. */
  startTick: number;
  ticks: number;
  roundLength: number;
  totalRounds: number;
  left: TimelineFighterHeader;
  right: TimelineFighterHeader;
  channels: Record<string, number[]>;
  records: TimelineRecord[];
  feed: { tick: number; event: FightEvent }[];
  /** How many feed entries were on screen after each tick that changed it. The
   *  engine trims the visible list on some append paths and not others, so the
   *  width is recorded rather than assumed. */
  feedWindows: { tick: number; window: number }[];
  cards: { tick: number; card: RoundCard }[];
  /** The ringside call. Absent from recordings made before there was one. */
  voice?: TimelineVoiceLine[];
  result: { winnerId: string | null; finish: "KO" | "TKO" | "Decision" | "Draw" | null };
}

interface EncodedChannel {
  scale: number;
  data: string;
}

interface EncodedTimeline {
  v: number;
  tickSeconds: number;
  stride: number;
  startTick: number;
  ticks: number;
  roundLength: number;
  totalRounds: number;
  left: TimelineFighterHeader;
  right: TimelineFighterHeader;
  channels: Record<string, EncodedChannel>;
  records: TimelineRecord[];
  feed: { tick: number; event: FightEvent }[];
  feedWindows: { tick: number; window: number }[];
  cards: { tick: number; card: RoundCard }[];
  voice?: TimelineVoiceLine[];
  result: TimelineCapture["result"];
}

/** The decoded, playback-ready form: channels back to absolute floats and the
 *  change-log split per side so a frame lookup is two binary searches. */
export interface FightTimeline {
  tickSeconds: number;
  stride: number;
  startTick: number;
  ticks: number;
  roundLength: number;
  totalRounds: number;
  left: TimelineFighterHeader;
  right: TimelineFighterHeader;
  channels: Record<string, Float64Array>;
  actions: Record<TimelineSide, ActionRecord[]>;
  impacts: Record<TimelineSide, ImpactRecord[]>;
  facings: Record<TimelineSide, FacingRecord[]>;
  feet: Record<TimelineSide, FootRecord[]>;
  rounds: RoundRecord[];
  feed: { tick: number; event: FightEvent }[];
  feedWindows: { tick: number; window: number }[];
  cards: { tick: number; card: RoundCard }[];
  /** Null for a recording that predates the call — the viewer's own engine
   *  reads those fights the way it always did. */
  voice: TimelineVoiceLine[] | null;
  result: TimelineCapture["result"];
}

export interface TimelineFighterFrame {
  fighterId: string;
  corner: Corner;
  heightM: number;
  reachM: number;
  x: number;
  y: number;
  headLevel: number;
  headOffset: number;
  health: number;
  stamina: number;
  headTrauma: number;
  hurtSeconds: number;
  stunSeconds: number;
  downCountSeconds: number;
  handVelocity: number;
  punchAimHeight: number;
  decisionConfidence: number;
  peakHandSpeed: number;
  peakForceN: number;
  cleanImpactJ: number;
  body: Record<(typeof BODY_LERP_FIELDS)[number], number> & {
    plantedFoot: "lead" | "rear" | "both";
  };
  action: FighterAction;
  actionElapsed: number;
  actionDuration: number;
  punchHand: "lead" | "rear";
  punchAimZone: ImpactZone;
  punchExtensionTarget: number;
  facingDirection: -1 | 1;
  lastStrikeKind: FighterAction | "none";
  lastImpactZone: ImpactZone;
  lastImpactJ: number;
  lastImpactCounter: boolean;
  thrown: number;
  landed: number;
  blocked: number;
  knockdowns: number;
}

export interface TimelineFrame {
  tick: number;
  round: number;
  roundTime: number;
  breakTime: number;
  introSeconds: number;
  roundLength: number;
  totalRounds: number;
  left: TimelineFighterFrame;
  right: TimelineFighterFrame;
}

/** Where the action clock should be at `tick` if nothing interrupted it.
 *  Shared between capture and playback: capture emits a correction record the
 *  moment the engine disagrees, so playback applying this same line is exact. */
export function predictedElapsed(record: ActionRecord, tick: number, tickSeconds: number) {
  return record.elapsed + (tick - record.tick) * tickSeconds;
}

// Base64 by hand so the same bytes round-trip in the worker, in node's test
// runner and in a browser without touching Buffer. Explicitly little-endian
// rather than trusting the platform's Int16Array layout.
function packInt16(values: Int16Array) {
  const bytes = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] & 0xffff;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = v >> 8;
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function unpackInt16(data: string) {
  const binary = atob(data);
  const values = new Int16Array(binary.length / 2);
  for (let i = 0; i < values.length; i++) {
    const raw = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    values[i] = raw >= 0x8000 ? raw - 0x10000 : raw;
  }
  return values;
}

/** Quantizes one channel to int16 deltas. The scale starts as fine as the
 *  channel's own peak allows and halves until every step between samples fits,
 *  so a channel that swings hard trades precision instead of overflowing. */
function encodeChannel(values: number[]): EncodedChannel {
  let peak = 1e-9;
  for (const value of values) {
    const magnitude = Math.abs(Number.isFinite(value) ? value : 0);
    if (magnitude > peak) peak = magnitude;
  }
  let scale = Math.min(1000, 32000 / peak);
  for (;;) {
    const deltas = new Int16Array(values.length);
    let previous = 0;
    let overflowed = false;
    for (let i = 0; i < values.length; i++) {
      const raw = Number.isFinite(values[i]) ? values[i] : 0;
      const quantized = Math.round(raw * scale);
      const delta = quantized - previous;
      if (delta > 32767 || delta < -32768) {
        overflowed = true;
        break;
      }
      deltas[i] = delta;
      previous = quantized;
    }
    if (!overflowed) return { scale, data: packInt16(deltas) };
    scale /= 2;
  }
}

function decodeChannel(channel: EncodedChannel) {
  const deltas = unpackInt16(channel.data);
  const values = new Float64Array(deltas.length);
  let accumulated = 0;
  for (let i = 0; i < deltas.length; i++) {
    accumulated += deltas[i];
    values[i] = accumulated / channel.scale;
  }
  return values;
}

export function encodeTimeline(capture: TimelineCapture): string {
  const channels: Record<string, EncodedChannel> = {};
  for (const [name, values] of Object.entries(capture.channels)) {
    channels[name] = encodeChannel(values);
  }
  const encoded: EncodedTimeline = {
    v: TIMELINE_VERSION,
    tickSeconds: capture.tickSeconds,
    stride: capture.stride,
    startTick: capture.startTick,
    ticks: capture.ticks,
    roundLength: capture.roundLength,
    totalRounds: capture.totalRounds,
    left: capture.left,
    right: capture.right,
    channels,
    records: capture.records,
    feed: capture.feed,
    feedWindows: capture.feedWindows,
    cards: capture.cards,
    ...(capture.voice ? { voice: capture.voice } : {}),
    result: capture.result,
  };
  return JSON.stringify(encoded);
}

export function decodeTimeline(text: string): FightTimeline {
  const encoded = JSON.parse(text) as EncodedTimeline;
  if (encoded.v !== TIMELINE_VERSION) {
    throw new Error(`Unsupported fight timeline version ${encoded.v}.`);
  }
  const channels: Record<string, Float64Array> = {};
  for (const [name, channel] of Object.entries(encoded.channels)) {
    channels[name] = decodeChannel(channel);
  }
  const timeline: FightTimeline = {
    tickSeconds: encoded.tickSeconds,
    stride: encoded.stride,
    startTick: encoded.startTick,
    ticks: encoded.ticks,
    roundLength: encoded.roundLength,
    totalRounds: encoded.totalRounds,
    left: encoded.left,
    right: encoded.right,
    channels,
    actions: { left: [], right: [] },
    impacts: { left: [], right: [] },
    facings: { left: [], right: [] },
    feet: { left: [], right: [] },
    rounds: [],
    feed: encoded.feed,
    feedWindows: encoded.feedWindows,
    cards: encoded.cards,
    voice: encoded.voice ?? null,
    result: encoded.result,
  };
  for (const record of encoded.records) {
    if (record.kind === "action") timeline.actions[record.side].push(record);
    else if (record.kind === "impact") timeline.impacts[record.side].push(record);
    else if (record.kind === "facing") timeline.facings[record.side].push(record);
    else if (record.kind === "foot") timeline.feet[record.side].push(record);
    else timeline.rounds.push(record);
  }
  return timeline;
}

/** Latest record at or before `tick`. Records are appended in tick order by
 *  capture, so this is a plain binary search. */
function recordAt<T extends { tick: number }>(records: T[], tick: number): T {
  let low = 0;
  let high = records.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (records[mid].tick <= tick) low = mid;
    else high = mid - 1;
  }
  return records[low];
}

function channelValue(
  timeline: FightTimeline,
  name: string,
  tick: number,
  interpolate: boolean,
) {
  const values = timeline.channels[name];
  const position =
    (Math.min(tick, timeline.ticks) - timeline.startTick) / timeline.stride;
  const below = Math.max(0, Math.min(values.length - 1, Math.floor(position)));
  if (!interpolate) return values[below];
  const above = Math.min(values.length - 1, below + 1);
  const fraction = Math.max(0, position - below);
  return values[below] + (values[above] - values[below]) * fraction;
}

function fighterFrame(
  timeline: FightTimeline,
  side: TimelineSide,
  tick: number,
): TimelineFighterFrame {
  const header = timeline[side];
  const action = recordAt(timeline.actions[side], tick);
  const impact = recordAt(timeline.impacts[side], tick);
  const facing = recordAt(timeline.facings[side], tick);
  const foot = recordAt(timeline.feet[side], tick);

  const body = {} as TimelineFighterFrame["body"];
  for (const field of BODY_LERP_FIELDS) {
    body[field] = channelValue(timeline, `${side}.body.${field}`, tick, true);
  }
  body.plantedFoot = foot.value;

  const frame = {
    fighterId: header.fighterId,
    corner: header.corner,
    heightM: header.heightM,
    reachM: header.reachM,
    body,
    action: action.action,
    // Deliberately unclamped: capture emits a correction record whenever the
    // engine's own timer disagrees with this line, so trusting it is exact.
    actionElapsed: predictedElapsed(action, Math.min(tick, timeline.ticks), timeline.tickSeconds),
    actionDuration: action.duration,
    punchHand: action.hand,
    punchAimZone: action.zone,
    punchExtensionTarget: action.extension,
    facingDirection: facing.value,
    lastStrikeKind: impact.strike,
    lastImpactZone: impact.zone,
    lastImpactJ: impact.impactJ,
    lastImpactCounter: impact.counter ?? false,
    thrown: impact.thrown,
    landed: impact.landed,
    blocked: impact.blocked,
    knockdowns: impact.knockdowns,
  } as TimelineFighterFrame;
  for (const field of FIGHTER_LERP_FIELDS) {
    frame[field] = channelValue(timeline, `${side}.${field}`, tick, true);
  }
  for (const field of FIGHTER_HOLD_FIELDS) {
    frame[field] = channelValue(timeline, `${side}.${field}`, tick, false);
  }
  return frame;
}

/** The fight as it stood at `tick`, rebuilt from samples and the change-log.
 *  Ticks past the end clamp to the final bell rather than throwing, because a
 *  viewer's clock always runs a little past the fight it is drawing. */
export function frameAt(timeline: FightTimeline, tick: number): TimelineFrame {
  const clamped = Math.max(timeline.startTick, Math.min(tick, timeline.ticks));
  return {
    tick: clamped,
    round: recordAt(timeline.rounds, clamped).round,
    roundTime: channelValue(timeline, "bout.roundTime", clamped, true),
    breakTime: channelValue(timeline, "bout.breakTime", clamped, true),
    introSeconds: channelValue(timeline, "bout.introSeconds", clamped, true),
    roundLength: timeline.roundLength,
    totalRounds: timeline.totalRounds,
    left: fighterFrame(timeline, "left", clamped),
    right: fighterFrame(timeline, "right", clamped),
  };
}

/** The commentary feed exactly as a viewer at `tick` saw it: the newest
 *  entries first, cut to the width the engine's own screen list had then. The
 *  width recorded at the last feed-changing tick holds until the next one. */
export function feedUpTo(timeline: FightTimeline, tick: number) {
  const width = recordAt(timeline.feedWindows, Math.min(tick, timeline.ticks)).window;
  return timeline.feed
    .filter((entry) => entry.tick <= tick)
    .slice(-width)
    .map((entry) => entry.event)
    .reverse();
}

/** Scored round cards revealed so far. */
export function cardsUpTo(timeline: FightTimeline, tick: number) {
  return timeline.cards.filter((entry) => entry.tick <= tick).map((entry) => entry.card);
}

/** How many pose samples a capture of `ticks` ticks carries. */
export function sampleCount(ticks: number, stride = TIMELINE_STRIDE) {
  return Math.floor(ticks / stride) + 1;
}

/** Cuts a stored timeline down to what has actually aired.
 *
 * This is the serving side's anti-spoiler: everything past `toTick` — frames,
 * records, feed entries and above all the result — is absent from the output,
 * not hidden in it. A viewer's replay used to carry the seed, which meant the
 * whole fight was downloadable the moment the bell rang while the betting book
 * was still open; a prefix has nothing to fast-forward. Delta channels slice
 * clean because a prefix of deltas is its own valid stream. */
export function prefixTimeline(encoded: string, toTick: number): string {
  const full = JSON.parse(encoded) as EncodedTimeline;
  if (full.v !== TIMELINE_VERSION) {
    throw new Error(`Unsupported fight timeline version ${full.v}.`);
  }
  const cut = Math.max(full.startTick, Math.min(toTick, full.ticks));
  if (cut >= full.ticks) return encoded;

  const keep = sampleCount(cut - full.startTick, full.stride);
  const channels: Record<string, EncodedChannel> = {};
  for (const [name, channel] of Object.entries(full.channels)) {
    channels[name] = {
      scale: channel.scale,
      data: packInt16(unpackInt16(channel.data).slice(0, keep)),
    };
  }
  const prefix: EncodedTimeline = {
    ...full,
    ticks: cut,
    channels,
    records: full.records.filter((record) => record.tick <= cut),
    feed: full.feed.filter((entry) => entry.tick <= cut),
    feedWindows: full.feedWindows.filter((entry) => entry.tick <= cut),
    cards: full.cards.filter((entry) => entry.tick <= cut),
    ...(full.voice ? { voice: full.voice.filter((entry) => entry.tick <= cut) } : {}),
    result: { winnerId: null, finish: null },
  };
  return JSON.stringify(prefix);
}

/** Cuts one chunk out of a whole-fight capture as its own playable capture.
 *
 * The chunk stands alone: channel samples restart at the boundary, the latest
 * record of every kind is re-pinned there as a carry-in (an action's clock
 * re-based to what it read at the boundary), and just enough feed history
 * rides along to fill the window a viewer sees at the chunk's first tick.
 * Scorecards are cumulative on screen, so every card up to the chunk's end is
 * kept. The call is cut like the records — a line belongs to the chunk whose
 * span its tick falls in, and the finish call falls in the final chunk by
 * construction. The result stays empty unless this chunk contains the final bell —
 * chunks are served the moment they air, and a round-one chunk that named the
 * winner would be the seed leak all over again. */
export function sliceCapture(
  capture: TimelineCapture,
  fromTick: number,
  toTick: number,
): TimelineCapture {
  if (fromTick % capture.stride !== 0) {
    throw new Error(`Chunk boundary ${fromTick} is off the sample grid.`);
  }
  const from = Math.max(capture.startTick, fromTick);
  const to = Math.min(capture.ticks, toTick);

  const channels: Record<string, number[]> = {};
  const firstSample = (from - capture.startTick) / capture.stride;
  const lastSample = Math.floor((to - capture.startTick) / capture.stride);
  for (const [name, values] of Object.entries(capture.channels)) {
    channels[name] = values.slice(firstSample, lastSample + 1);
  }

  // Carry-ins: the newest record of each kind at or before the boundary,
  // re-pinned to it, followed by everything that happens inside the chunk.
  const records: TimelineRecord[] = [];
  const latest = new Map<string, TimelineRecord>();
  for (const record of capture.records) {
    if (record.tick > from) break;
    latest.set(record.kind + ("side" in record ? record.side : ""), record);
  }
  for (const record of latest.values()) {
    if (record.kind === "action") {
      records.push({
        ...record,
        tick: from,
        elapsed: predictedElapsed(record, from, capture.tickSeconds),
      });
    } else {
      records.push({ ...record, tick: from });
    }
  }
  for (const record of capture.records) {
    if (record.tick > from && record.tick <= to) records.push(record);
  }

  const width =
    capture.feedWindows.filter((entry) => entry.tick <= from).at(-1)?.window ?? 0;
  const before = capture.feed.filter((entry) => entry.tick <= from);
  const feed = [
    ...before.slice(before.length - width),
    ...capture.feed.filter((entry) => entry.tick > from && entry.tick <= to),
  ];
  const feedWindows = [
    { tick: from, window: width },
    ...capture.feedWindows.filter((entry) => entry.tick > from && entry.tick <= to),
  ];

  return {
    ...capture,
    startTick: from,
    ticks: to,
    channels,
    records,
    feed,
    feedWindows,
    cards: capture.cards.filter((entry) => entry.tick <= to),
    ...(capture.voice
      ? {
          voice: capture.voice.filter(
            (entry) =>
              (entry.tick > from || (from === capture.startTick && entry.tick === from)) &&
              entry.tick <= to,
          ),
        }
      : {}),
    result:
      to >= capture.ticks ? capture.result : { winnerId: null, finish: null },
  };
}

/** Splits a whole-fight capture into encoded chunks ready for storage. */
export function chunkCapture(
  capture: TimelineCapture,
  chunkTicks = TIMELINE_CHUNK_TICKS,
) {
  const chunks: {
    chunk: number;
    startTick: number;
    endTick: number;
    isFinal: boolean;
    encoded: string;
  }[] = [];
  for (let index = 0; index * chunkTicks < capture.ticks || index === 0; index++) {
    const startTick = index * chunkTicks;
    const endTick = Math.min(capture.ticks, startTick + chunkTicks);
    chunks.push({
      chunk: index,
      startTick,
      endTick,
      isFinal: endTick >= capture.ticks,
      encoded: encodeTimeline(sliceCapture(capture, startTick, endTick)),
    });
  }
  return chunks;
}

/** The default stride expressed in real seconds, for anything pacing a fetch. */
export const TIMELINE_SAMPLE_SECONDS = TIMELINE_STRIDE * BOXING_MODEL.physicsStepSeconds;
