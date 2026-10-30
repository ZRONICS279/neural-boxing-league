import assert from "node:assert/strict";
import test from "node:test";
import type { BroadcastState, ScheduledBout } from "../app/broadcast.ts";
import { decodeTimeline } from "../app/fight-timeline.ts";
import { handleTimelineRequest, handleVoiceRequest } from "../worker/league.ts";
import {
  backfillTimelines,
  gunzipToText,
  readTimelineChunk,
  storeTimelines,
  type TimelineChunkRow,
} from "../worker/timeline-store.ts";
import { renderPendingVoice, voiceInserts } from "../worker/voice-store.ts";
import { captureBout } from "../worker/fight-timeline.ts";
import { ANNOUNCER_VOICE } from "../app/feature-flags.ts";
import { TIMELINE_CHUNK_TICKS } from "../app/fight-timeline.ts";
import { BOXING_MODEL, createInitialLeague } from "../app/simulation.ts";

interface VoiceRow {
  bout_id: number;
  line: number;
  tick: number;
  is_final: number;
  register: string;
  text: string;
  audio: ArrayBuffer | null;
}

/** Just enough D1 for the timeline path: the chunk table, the call's rows and
 *  clips beside it, the archive rows the off-card gate and the backfill read,
 *  and the league rows `currentState` reads on the way to the clock. Reads on an empty league are genesis, which
 *  is fine here — these tests never persist a card. */
function fakeTimelineDatabase() {
  const rows = new Map<string, { id: string; payload: string; updated_at: number }>();
  const chunks = new Map<string, TimelineChunkRow>();
  const voice = new Map<string, VoiceRow>();
  const archived = new Map<number, string | null>();
  const complete = (boutId: number) =>
    [...chunks.values()].some((row) => row.bout_id === boutId && row.is_final === 1);
  const db = {
    chunks,
    voice,
    archived,
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          if (query.includes("SELECT id, replay FROM fight_archive")) {
            const results = [...archived.entries()]
              .filter(([id, replay]) => replay !== null && !complete(id))
              .sort(([left], [right]) => right - left)
              .slice(0, Number(bound[0]))
              .map(([id, replay]) => ({ id, replay }));
            return { results: results as T[] };
          }
          if (query.includes("FROM fight_voice") && query.includes("audio IS NULL AND bout_id = ?")) {
            const results = [...voice.values()]
              .filter((row) => row.audio === null && row.bout_id === Number(bound[0]))
              .sort((left, right) => left.line - right.line)
              .slice(0, Number(bound[1]));
            return { results: results as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (query.includes("WHERE bout_id = ? AND chunk = ?")) {
            return (chunks.get(`${bound[0]}:${bound[1]}`) ?? null) as T | null;
          }
          if (query.includes("FROM fight_voice WHERE bout_id = ? AND line = ?")) {
            return (voice.get(`${bound[0]}:${bound[1]}`) ?? null) as T | null;
          }
          if (query.includes("SELECT chunk FROM fight_timeline")) {
            return (complete(Number(bound[0])) ? { chunk: 0 } : null) as T | null;
          }
          if (query.includes("FROM fight_archive")) {
            return (archived.has(Number(bound[0])) ? { id: bound[0] } : null) as T | null;
          }
          if (query.includes("FROM league_state")) {
            return (rows.get(String(bound[0])) ?? null) as T | null;
          }
          return null;
        },
        async run() {
          if (query.includes("INSERT OR IGNORE INTO fight_timeline")) {
            const key = `${bound[0]}:${bound[1]}`;
            if (chunks.has(key)) return { meta: { changes: 0 } };
            chunks.set(key, {
              bout_id: Number(bound[0]),
              chunk: Number(bound[1]),
              start_tick: Number(bound[2]),
              end_tick: Number(bound[3]),
              is_final: Number(bound[4]),
              payload: bound[5] as ArrayBuffer,
            });
            return { meta: { changes: 1 } };
          }
          if (query.includes("INSERT OR IGNORE INTO fight_voice")) {
            const key = `${bound[0]}:${bound[1]}`;
            if (voice.has(key)) return { meta: { changes: 0 } };
            voice.set(key, {
              bout_id: Number(bound[0]),
              line: Number(bound[1]),
              tick: Number(bound[2]),
              is_final: Number(bound[3]),
              register: String(bound[4]),
              text: String(bound[5]),
              audio: null,
            });
            return { meta: { changes: 1 } };
          }
          if (query.includes("UPDATE fight_voice SET audio")) {
            const row = voice.get(`${bound[1]}:${bound[2]}`);
            if (!row || row.audio !== null) return { meta: { changes: 0 } };
            row.audio = bound[0] as ArrayBuffer;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return db;
}

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
    // Truthiness is what the store checks; recording re-steps the fight itself.
    result: {
      winnerId: null,
      finish: "Decision",
      round: 3,
      ticks: 0,
      blueLanded: 0,
      redLanded: 0,
    },
    directives: [],
    committed: false,
    profiles: [blue, red],
  };
}

const db = fakeTimelineDatabase();
const bout = scheduledBout();
const states = [{ card: [bout] } as unknown as BroadcastState];

test("a simulated bout is recorded once, as chunks that round-trip", async () => {
  const recorded = await storeTimelines(db, states);
  assert.equal(recorded, 1, "one fight recorded");
  assert.ok(db.chunks.size > 100, `a full fight is many chunks, got ${db.chunks.size}`);

  const finals = [...db.chunks.values()].filter((row) => row.is_final === 1);
  assert.equal(finals.length, 1, "exactly one final chunk");

  const first = await readTimelineChunk(db, bout.id, 0);
  assert.ok(first, "chunk zero is on file");
  const opening = decodeTimeline(await gunzipToText(first!.payload));
  assert.equal(opening.startTick, 0);
  assert.equal(opening.result.winnerId, null, "an early chunk names no winner");
  assert.equal(opening.result.finish, null, "an early chunk names no finish");

  const last = decodeTimeline(await gunzipToText(finals[0].payload));
  assert.ok(last.result.finish, "the final chunk carries the result");

  // The completeness check is what spares the tick a two-second re-simulation.
  const again = await storeTimelines(db, states);
  assert.equal(again, 0, "already-recorded fights are skipped");
});

test("a recording that stopped partway is finished rather than kept", async () => {
  // What a pass that runs out of room leaves behind: an opening, no bell.
  const half = [...db.chunks.keys()].slice(Math.floor(db.chunks.size / 2));
  for (const key of half) db.chunks.delete(key);
  assert.equal(
    [...db.chunks.values()].filter((row) => row.is_final === 1).length,
    0,
    "the fight is on file without its final chunk",
  );

  const repaired = await storeTimelines(db, states);
  assert.equal(repaired, 1, "a half-written fight is picked back up");
  assert.equal(
    [...db.chunks.values()].filter((row) => row.is_final === 1).length,
    1,
    "and is written through to the bell",
  );
});

test("a fight that aired without a recording is rebuilt from the archive", async () => {
  const filed = { ...bout, id: 7002 };
  db.archived.set(filed.id, JSON.stringify(filed));

  assert.equal(await backfillTimelines(db), 1, "the gap is filled");
  const final = [...db.chunks.values()].filter(
    (row) => row.bout_id === filed.id && row.is_final === 1,
  );
  assert.equal(final.length, 1, "the rebuilt recording runs to the bell");
  const opening = await readTimelineChunk(db, filed.id, 0);
  assert.ok(opening, "and starts at the opening bell");

  assert.equal(await backfillTimelines(db), 0, "a filled gap is not filled twice");
});

test("the route serves aired fights and nothing it cannot vouch for", async () => {
  const env = { DB: db };
  const get = (query: string) =>
    handleTimelineRequest(new Request(`https://forge.test/api/timeline${query}`), env);

  assert.equal((await get("")).status, 400, "bout and chunk are required");
  assert.equal((await get("?bout=7001")).status, 400, "chunk is required");

  // On file, but not on the current card and not in the archive: a fight the
  // public never saw, so the route must not admit it exists.
  assert.equal((await get("?bout=7001&chunk=0")).status, 404);

  db.archived.set(7001, null);
  const served = await get("?bout=7001&chunk=0");
  assert.equal(served.status, 200);
  assert.match(served.headers.get("cache-control") ?? "", /immutable/);
  const timeline = decodeTimeline(await served.text());
  assert.equal(timeline.startTick, 0);

  assert.equal((await get("?bout=7001&chunk=99999")).status, 404, "past the end reads as absent");
  assert.equal((await get("?bout=4242&chunk=0")).status, 404, "unknown fights read as absent");
});

test("the call is filed with the recording, silent, and its clips rendered a batch at a time", async () => {
  // The switch: off, recording files no rows at all — the rows exist to be
  // filled with clips, and clips are the whole cost. The store is exercised
  // below regardless, by filing the same call by hand.
  const filed = [...db.voice.values()].filter((row) => row.bout_id === bout.id).length;
  assert.equal(filed > 0, ANNOUNCER_VOICE, "rows are filed exactly when the voice is on");
  if (!ANNOUNCER_VOICE) {
    const capture = captureBout(bout);
    const finalStart = Math.floor((capture.ticks - 1) / TIMELINE_CHUNK_TICKS) * TIMELINE_CHUNK_TICKS;
    for (const statement of voiceInserts(db, bout.id, capture.voice ?? [], finalStart)) await statement.run();
  }
  const lines = [...db.voice.values()].filter((row) => row.bout_id === bout.id);
  assert.ok(lines.length > 20, `a recorded fight files its whole call, got ${lines.length}`);
  assert.ok(lines.every((row) => row.audio === null), "nothing is spoken at recording time");
  const finals = lines.filter((row) => row.is_final === 1);
  assert.ok(finals.length >= 1, "the finish call is marked as the final chunk's");
  assert.equal(
    Math.max(...finals.map((row) => row.tick)),
    Math.max(...lines.map((row) => row.tick)),
    "and it is the last thing said",
  );

  // No key: nothing is asked for, nothing is rendered.
  const state = { card: [bout] } as unknown as BroadcastState;
  assert.equal(await renderPendingVoice(db, {}, state, 0, 0, () => { throw new Error("no key, no call"); }), 0);

  // A working model: forty lines a pass, earliest first, each one's text spoken.
  const spoken: string[] = [];
  const speak: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; voice: string; instructions: string };
    spoken.push(body.input);
    assert.ok(body.instructions.length > 0, "the register travels as direction");
    return new Response(new Uint8Array([0xff, 0xfb, 0x90]), { status: 200 });
  };
  const env = { OPENAI_API_KEY: "test" };
  const first = await renderPendingVoice(db, env, state, 0, 0, speak);
  assert.equal(first, Math.min(40, lines.length), "one batch a pass");
  assert.deepEqual(spoken, lines.slice(0, first).map((row) => row.text), "earliest lines first");
  assert.ok(lines.slice(0, first).every((row) => row.audio !== null), "rendered clips are on file");
  assert.ok(lines.slice(first).every((row) => row.audio === null), "the rest wait their turn");

  // A refused key stops the pass rather than spending the batch on it, and the
  // tick leaves the model alone for a while afterwards.
  const refuse: typeof fetch = async () => new Response("no credits", { status: 429 });
  assert.equal(await renderPendingVoice(db, env, state, 0, 1000, refuse), 0);
  assert.equal(await renderPendingVoice(db, env, state, 0, 2000, speak), 0, "backing off after a refusal");
  const later = await renderPendingVoice(db, env, state, 0, 2000 + 6 * 60 * 1000, speak);
  assert.ok(later > 0, "and asks again once the backoff has passed");

  // A fight that has finished airing is not worth a clip; the one on air is.
  const aired = { ...bout, id: 7003, startsAt: 0, endsAt: 100_000 };
  const onAir = { ...bout, id: 7004, startsAt: 200_000, endsAt: 500_000 };
  for (const id of [aired.id, onAir.id]) {
    for (const line of [0, 1]) {
      db.voice.set(`${id}:${line}`, { bout_id: id, line, tick: line, is_final: 0, register: "call", text: `line ${line} of ${id}`, audio: null });
    }
  }
  spoken.length = 0;
  const card = { card: [aired, onAir] } as unknown as BroadcastState;
  await renderPendingVoice(db, env, card, 300_000, 10 ** 9, speak);
  assert.deepEqual(spoken, ["line 0 of 7004", "line 1 of 7004"], "only the fight still on air is rendered");
});

test("the voice route serves rendered clips under the chunk route's gate", async () => {
  const env = { DB: db };
  const get = (query: string) =>
    handleVoiceRequest(new Request(`https://forge.test/api/voice${query}`), env);

  assert.equal((await get("")).status, 400, "bout and line are required");
  assert.equal((await get("?bout=7001")).status, 400, "line is required");
  // 7001 was admitted to the archive by the chunk route's test above.
  const rendered = [...db.voice.values()].find((row) => row.bout_id === 7001 && row.audio !== null)!;
  const pending = [...db.voice.values()].find((row) => row.bout_id === 7001 && row.audio === null)!;
  const served = await get(`?bout=7001&line=${rendered.line}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "audio/mpeg");
  assert.match(served.headers.get("cache-control") ?? "", /immutable/);
  assert.equal((await served.arrayBuffer()).byteLength, 3);
  const quiet = await get(`?bout=7001&line=${pending.line}`);
  assert.equal(quiet.status, 404, "a line without a clip yet reads as absent");
  assert.equal(quiet.headers.get("cache-control"), "no-store", "and is asked for again");
  assert.equal((await get("?bout=7001&line=99999")).status, 404, "past the end reads as absent");
  assert.equal((await get("?bout=4242&line=0")).status, 404, "unknown fights read as absent");
});
