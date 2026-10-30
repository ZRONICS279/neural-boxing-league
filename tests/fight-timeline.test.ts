import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { replayBout, type ScheduledBout } from "../app/broadcast.ts";
import {
  BODY_LERP_FIELDS,
  BOUT_LERP_FIELDS,
  FIGHTER_HOLD_FIELDS,
  FIGHTER_LERP_FIELDS,
  TIMELINE_CHUNK_TICKS,
  cardsUpTo,
  chunkCapture,
  decodeTimeline,
  encodeTimeline,
  feedUpTo,
  frameAt,
  prefixTimeline,
} from "../app/fight-timeline.ts";
import { captureBout } from "../worker/fight-timeline.ts";
import { BOXING_MODEL, createInitialLeague } from "../app/simulation.ts";

function scheduledBout(): ScheduledBout {
  const roster = createInitialLeague().roster;
  const blue = roster[0];
  const red = roster.find(
    (fighter) => fighter.id !== blue.id && fighter.weightClass === blue.weightClass,
  )!;
  return {
    id: 7001,
    seed: 987654321,
    division: blue.weightClass,
    kind: "contender",
    blueId: blue.id,
    redId: red.id,
    startsAt: 0,
    endsAt: 0,
    totalRounds: BOXING_MODEL.totalRounds,
    roundSeconds: BOXING_MODEL.roundSeconds,
    result: null,
    directives: [],
    committed: false,
    profiles: [blue, red],
  };
}

// One fight, stepped once, shared by every test below.
const bout = scheduledBout();
const capture = captureBout(bout);
const encoded = encodeTimeline(capture);

// The golden gate for the whole streaming plan: a decoded timeline must agree
// with the engine's own replay on every field the renderer and the stage read.
// Discrete state is checked at EVERY tick — a punch cue that lands a tick off
// is a codec bug, not a rounding error. Sampled pose channels are checked on
// their sample ticks against each channel's own quantization step.
test("a decoded timeline replays the fight the engine fought", () => {
  const timeline = decodeTimeline(encoded);

  // Quantization tolerance comes from the wire format itself: half a step of
  // each channel's published scale, plus float dust.
  const wire = JSON.parse(encoded) as {
    channels: Record<string, { scale: number }>;
    ticks: number;
  };
  const tolerance = (channel: string) => 0.5 / wire.channels[channel].scale + 1e-9;

  let state = replayBout(bout, 0);
  for (let tick = 0; ; tick++) {
    if (tick > 0) {
      const next = replayBout(bout, tick, state);
      if (next.tick === state.tick) break;
      state = next;
    }
    const frame = frameAt(timeline, tick);

    assert.equal(frame.round, state.round, `round at tick ${tick}`);
    for (const side of ["left", "right"] as const) {
      const truth = state[side];
      const decoded = frame[side];
      const at = `${side} at tick ${tick}`;

      assert.equal(decoded.action, truth.action, `action ${at}`);
      assert.equal(decoded.actionDuration, truth.actionDuration, `duration ${at}`);
      assert.ok(
        Math.abs(decoded.actionElapsed - truth.actionElapsed) <= 1e-6,
        `elapsed ${at}: ${decoded.actionElapsed} vs ${truth.actionElapsed}`,
      );
      assert.equal(decoded.punchHand, truth.punchHand, `hand ${at}`);
      assert.equal(decoded.punchAimZone, truth.punchAimZone, `aim zone ${at}`);
      assert.equal(decoded.punchExtensionTarget, truth.punchExtensionTarget, `extension ${at}`);
      assert.equal(decoded.facingDirection, truth.facingDirection, `facing ${at}`);
      assert.equal(decoded.body.plantedFoot, truth.body.plantedFoot, `planted foot ${at}`);
      assert.equal(decoded.lastStrikeKind, truth.lastStrikeKind, `strike ${at}`);
      assert.equal(decoded.lastImpactZone, truth.lastImpactZone, `impact zone ${at}`);
      assert.equal(decoded.lastImpactJ, truth.lastImpactJ, `impact J ${at}`);
      assert.equal(
        decoded.lastImpactCounter,
        truth.lastImpactCounter,
        `counter ${at}`,
      );
      assert.equal(decoded.thrown, truth.thrown, `thrown ${at}`);
      assert.equal(decoded.landed, truth.landed, `landed ${at}`);
      assert.equal(decoded.blocked, truth.blocked, `blocked ${at}`);
      assert.equal(decoded.knockdowns, truth.knockdowns, `knockdowns ${at}`);

      if (tick % timeline.stride === 0) {
        for (const field of [...FIGHTER_LERP_FIELDS, ...FIGHTER_HOLD_FIELDS]) {
          assert.ok(
            Math.abs(decoded[field] - truth[field]) <= tolerance(`${side}.${field}`),
            `${field} ${at}: ${decoded[field]} vs ${truth[field]}`,
          );
        }
        for (const field of BODY_LERP_FIELDS) {
          assert.ok(
            Math.abs(decoded.body[field] - truth.body[field]) <=
              tolerance(`${side}.body.${field}`),
            `body.${field} ${at}: ${decoded.body[field]} vs ${truth.body[field]}`,
          );
        }
      }
    }
    if (tick % timeline.stride === 0) {
      for (const field of BOUT_LERP_FIELDS) {
        assert.ok(
          Math.abs(frame[field] - state[field]) <= tolerance(`bout.${field}`),
          `${field} at tick ${tick}: ${frame[field]} vs ${state[field]}`,
        );
      }
    }
    assert.deepEqual(feedUpTo(timeline, tick), state.events, `feed at tick ${tick}`);
  }

  assert.equal(timeline.ticks, state.tick, "timeline covers the whole fight");
  assert.deepEqual(feedUpTo(timeline, timeline.ticks), state.events, "final feed window");
  assert.deepEqual(cardsUpTo(timeline, timeline.ticks), state.roundCards, "all round cards");
  assert.equal(timeline.result.winnerId, state.winnerId, "winner");
  assert.equal(timeline.result.finish, state.finish, "finish");

  const gzipped = gzipSync(encoded).length;
  console.log(
    `timeline: ${timeline.ticks} ticks, ${(encoded.length / 1024).toFixed(1)} KB raw, ` +
      `${(gzipped / 1024).toFixed(1)} KB gzipped`,
  );
  // Full 50 Hz pose channels measured ~785 KB for a decision fight — chosen
  // deliberately so a punch's body torque keeps its sharpest instant. If a
  // codec change pushes past a megabyte, stop and reconsider before shipping.
  assert.ok(gzipped < 1024 * 1024, `timeline gzips to ${gzipped} bytes`);
});

test("a viewer's clock past the final bell holds the last frame", () => {
  const timeline = decodeTimeline(encoded);
  const last = frameAt(timeline, timeline.ticks);
  const beyond = frameAt(timeline, timeline.ticks + 900);
  assert.deepEqual(beyond, { ...last, tick: timeline.ticks });
  assert.deepEqual(feedUpTo(timeline, timeline.ticks + 900), feedUpTo(timeline, timeline.ticks));
});

// The counter call must survive the wire whether or not any given fight
// happens to produce one — fights are unscripted, so this is authored data
// through the real codec rather than a demand on the fighters. An absent flag
// (every archived timeline predates it) must read as an ordinary landing.
test("the counter flag rides the codec, and its absence reads as false", () => {
  const forced = structuredClone(capture);
  const impacts = forced.records.filter(
    (record) => record.kind === "impact" && record.side === "left",
  );
  assert.ok(impacts.length > 0, "the capture records impacts");
  const last = impacts[impacts.length - 1] as { tick: number; counter?: boolean };
  last.counter = true;
  const timeline = decodeTimeline(encodeTimeline(forced));
  assert.equal(frameAt(timeline, last.tick).left.lastImpactCounter, true);

  // The archive case: strip the field everywhere and the frame reads false.
  const legacy = structuredClone(capture);
  for (const record of legacy.records) {
    if (record.kind === "impact") delete (record as { counter?: boolean }).counter;
  }
  const archived = decodeTimeline(encodeTimeline(legacy));
  assert.equal(frameAt(archived, archived.ticks).left.lastImpactCounter, false);
  assert.equal(frameAt(archived, archived.ticks).right.lastImpactCounter, false);
});

// The anti-spoiler property the market depends on: an aired prefix must play
// back identically up to the cut, and must not contain the future in any form.
test("an aired prefix replays what aired and carries nothing else", () => {
  const full = decodeTimeline(encoded);

  const cut = 9377; // deliberately off the sample grid
  const prefix = decodeTimeline(prefixTimeline(encoded, cut));

  assert.equal(prefix.ticks, cut);
  assert.equal(prefix.result.winnerId, null, "no winner before the fight ends");
  assert.equal(prefix.result.finish, null, "no finish before the fight ends");
  assert.ok(
    prefix.feed.every((entry) => entry.tick <= cut),
    "no future commentary",
  );

  // Identical playback up to the last kept pose sample; the few ticks between
  // that sample and the cut merely hold instead of leaning on a sample that
  // has not aired yet.
  const lastSample = Math.floor(cut / prefix.stride) * prefix.stride;
  for (const tick of [0, 1, 500, 4321, lastSample]) {
    assert.deepEqual(frameAt(prefix, tick), frameAt(full, tick), `frame at tick ${tick}`);
  }
  for (const tick of [lastSample + 1, cut]) {
    const held = frameAt(prefix, tick);
    const truth = frameAt(full, tick);
    for (const side of ["left", "right"] as const) {
      assert.equal(held[side].action, truth[side].action, `action at tick ${tick}`);
      assert.equal(held[side].thrown, truth[side].thrown, `thrown at tick ${tick}`);
      assert.equal(held[side].landed, truth[side].landed, `landed at tick ${tick}`);
    }
  }
  assert.deepEqual(feedUpTo(prefix, cut), feedUpTo(full, cut), "feed at the cut");

  // Asking for a prefix at or past the final bell is the whole fight again.
  assert.equal(prefixTimeline(encoded, full.ticks), encoded);
  assert.equal(prefixTimeline(encoded, full.ticks + 500), encoded);
});

// The chunks are what actually gets stored and served, so they carry the same
// burden the whole timeline does: identical playback, and no future anywhere.
// Chunk pose channels are re-quantized against their own peaks, so continuous
// fields are compared within the two wires' combined step.
test("stored chunks replay the same fight and leak nothing early", () => {
  const chunks = chunkCapture(capture);
  const full = decodeTimeline(encoded);

  assert.ok(chunks.length > 100, `a full fight is many chunks, got ${chunks.length}`);
  assert.ok(chunks.at(-1)!.isFinal, "last chunk is final");
  assert.equal(chunks.at(-1)!.endTick, full.ticks, "chunks cover the whole fight");
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunk, index, "chunk indices are dense");
    if (!chunk.isFinal) {
      const wire = JSON.parse(chunk.encoded) as { result: { winnerId: unknown; finish: unknown } };
      assert.equal(wire.result.winnerId, null, `chunk ${index} names no winner`);
      assert.equal(wire.result.finish, null, `chunk ${index} names no finish`);
    }
  }

  const fullWire = JSON.parse(encoded) as { channels: Record<string, { scale: number }> };
  const decoded = chunks.map((chunk) => decodeTimeline(chunk.encoded));
  const wires = chunks.map(
    (chunk) => JSON.parse(chunk.encoded) as { channels: Record<string, { scale: number }> },
  );
  const owner = (tick: number) =>
    Math.min(Math.floor(tick / TIMELINE_CHUNK_TICKS), chunks.length - 1);

  for (let tick = 0; tick <= full.ticks; tick++) {
    const piece = decoded[owner(tick)];
    const wire = wires[owner(tick)];
    const whole = frameAt(full, tick);
    const part = frameAt(piece, tick);

    assert.equal(part.round, whole.round, `round at tick ${tick}`);
    for (const side of ["left", "right"] as const) {
      const at = `${side} at tick ${tick}`;
      assert.equal(part[side].action, whole[side].action, `action ${at}`);
      assert.equal(part[side].actionDuration, whole[side].actionDuration, `duration ${at}`);
      // A carried-in action clock is re-based at the boundary, which reorders
      // the float arithmetic without changing what it measures.
      assert.ok(
        Math.abs(part[side].actionElapsed - whole[side].actionElapsed) <= 1e-6,
        `elapsed ${at}`,
      );
      assert.equal(part[side].punchHand, whole[side].punchHand, `hand ${at}`);
      assert.equal(part[side].punchAimZone, whole[side].punchAimZone, `aim zone ${at}`);
      assert.equal(part[side].facingDirection, whole[side].facingDirection, `facing ${at}`);
      assert.equal(part[side].lastStrikeKind, whole[side].lastStrikeKind, `strike ${at}`);
      assert.equal(part[side].lastImpactJ, whole[side].lastImpactJ, `impact J ${at}`);
      assert.equal(part[side].thrown, whole[side].thrown, `thrown ${at}`);
      assert.equal(part[side].landed, whole[side].landed, `landed ${at}`);
      assert.equal(part[side].blocked, whole[side].blocked, `blocked ${at}`);
      assert.equal(part[side].knockdowns, whole[side].knockdowns, `knockdowns ${at}`);

      if (tick % full.stride === 0) {
        for (const field of [...FIGHTER_LERP_FIELDS, ...FIGHTER_HOLD_FIELDS]) {
          const step =
            0.5 / fullWire.channels[`${side}.${field}`].scale +
            0.5 / wire.channels[`${side}.${field}`].scale +
            1e-9;
          assert.ok(
            Math.abs(part[side][field] - whole[side][field]) <= step,
            `${field} ${at}: ${part[side][field]} vs ${whole[side][field]}`,
          );
        }
      }
    }
    if (tick % 50 === 0 || tick % TIMELINE_CHUNK_TICKS === 0) {
      assert.deepEqual(feedUpTo(piece, tick), feedUpTo(full, tick), `feed at tick ${tick}`);
      assert.deepEqual(cardsUpTo(piece, tick), cardsUpTo(full, tick), `cards at tick ${tick}`);
    }
  }

  assert.deepEqual(decoded.at(-1)!.result, full.result, "final chunk carries the result");
  const total = chunks.reduce((sum, chunk) => sum + gzipSync(chunk.encoded).length, 0);
  console.log(
    `chunks: ${chunks.length} × ${TIMELINE_CHUNK_TICKS} ticks, ` +
      `${(total / 1024).toFixed(1)} KB gzipped total`,
  );
});

// The ringside call rides the recording: written down off the same frames the
// chunks are cut from, cut with them, and never a word of the finish before the
// final chunk — the finish call names the winner, and a round-one chunk that
// carried it would be the seed leak in a new voice.
test("the ringside call is recorded with the fight and cut with its chunks", () => {
  assert.ok(capture.voice && capture.voice.length > 20, "a whole fight is called at length");
  const voice = capture.voice!;
  for (const [index, line] of voice.entries()) {
    assert.equal(line.line, index, "lines are numbered in order of saying");
    if (index > 0) assert.ok(line.tick >= voice[index - 1].tick, "and never go backwards");
    assert.ok(line.tick <= capture.ticks, `line ${index} is said inside the fight`);
  }
  const finish = voice.at(-1)!;
  assert.equal(finish.register, "alarm", "the last word is the verdict");
  assert.equal(finish.tick, capture.ticks, "said on the final frame");

  const chunks = chunkCapture(capture);
  const gathered = chunks.flatMap((chunk) => decodeTimeline(chunk.encoded).voice ?? []);
  assert.deepEqual(gathered, voice, "the chunks carry every line once, in order");
  for (const chunk of chunks) {
    const decoded = decodeTimeline(chunk.encoded);
    assert.ok(decoded.voice, "every chunk carries its slice of the call, even an empty one");
    for (const line of decoded.voice) {
      assert.ok(line.tick >= chunk.startTick && line.tick <= chunk.endTick, "a line sits in its own chunk");
    }
    if (!chunk.isFinal) {
      assert.ok(!decoded.voice.some((line) => line.line === finish.line), "the verdict waits for the final chunk");
    }
  }

  // Footage recorded before the call existed decodes to no call at all — the
  // stage's own engine takes those — rather than to an empty one.
  assert.equal(decodeTimeline(encodeTimeline({ ...capture, voice: undefined })).voice, null);
});
