import assert from "node:assert/strict";
import test from "node:test";
import type { BroadcastState, ScheduledBout } from "../app/broadcast.ts";
import { createBroadcast, estimatedDuration } from "../app/broadcast.ts";
import { handleLeagueRequest, handleTimelineRequest } from "../worker/league.ts";
import { storeTimelines, type TimelineChunkRow } from "../worker/timeline-store.ts";
import { BOXING_MODEL, createInitialLeague } from "../app/simulation.ts";

/** A market wired to a port nothing answers on. The operator cannot reach the
 *  chain, so no close can ever be confirmed — the exact outage during which a
 *  served result would be an invitation to dump shares into an open book. */
const DEAD_MARKET = {
  FIGHT_RPC_URL: "http://127.0.0.1:9",
  FIGHT_CLOB_ADDRESS: "0x00000000000000000000000000000000000000aa",
  FIGHT_READER_ADDRESS: "0x00000000000000000000000000000000000000bb",
  FIGHT_OPERATOR_KEY: `0x${"11".repeat(32)}`,
};

/** Just enough D1 for these routes: chunks, the archive gate, and the state
 *  rows — with the state row seeded by hand and, deliberately, no way for a
 *  conditional write to land, so a background tick can never republish the
 *  card out from under an assertion. */
function fakeDatabase() {
  const rows = new Map<string, { id: string; payload: string; updated_at: number }>();
  const chunks = new Map<string, TimelineChunkRow>();
  const db = {
    rows,
    chunks,
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          // The careers live one to a row now. This fake seeds the league row
          // with its roster still inside it, which is the shape the store
          // reads from directly, so there is nothing in the table to hand back.
          return { results: [] as T[] };
        },
        async first<T>() {
          if (query.includes("WHERE bout_id = ? AND chunk = ?")) {
            return (chunks.get(`${bound[0]}:${bound[1]}`) ?? null) as T | null;
          }
          if (query.includes("SELECT chunk FROM fight_timeline")) {
            for (const key of chunks.keys()) {
              if (key.startsWith(`${bound[0]}:`)) return { chunk: 0 } as T;
            }
            return null;
          }
          if (query.includes("FROM fight_archive")) return null;
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
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return db;
}

function finishedBout(league: ReturnType<typeof createInitialLeague>): ScheduledBout {
  const blue = league.roster[0];
  const red = league.roster.find(
    (fighter) => fighter.id !== blue.id && fighter.weightClass === blue.weightClass,
  )!;
  return {
    id: 7002,
    seed: 246813579,
    division: blue.weightClass,
    kind: "contender",
    blueId: blue.id,
    redId: red.id,
    startsAt: 0,
    endsAt: 0,
    totalRounds: BOXING_MODEL.totalRounds,
    roundSeconds: BOXING_MODEL.roundSeconds,
    result: {
      winnerId: null,
      finish: "Decision",
      round: 3,
      ticks: 0,
      blueLanded: 0,
      redLanded: 0,
    },
    // Already committed, so the tick behind a read has nothing to replay.
    directives: [],
    committed: true,
    profiles: [blue, red],
  };
}

const db = fakeDatabase();
const league = createInitialLeague();
const bout = finishedBout(league);
const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}) };

interface CardRow {
  id: number;
  status: string;
  endsAt: number;
  result: { finish: string } | null;
}
interface LeaguePayload {
  ok: boolean;
  live: (CardRow & { startsAt: number }) | null;
  card: CardRow[];
}

test("fixture: a recorded fight, ten league-seconds into its aftermath", async () => {
  const recorded = await storeTimelines(db, [{ card: [bout] } as unknown as BroadcastState]);
  assert.equal(recorded, 1);
  const final = [...db.chunks.values()].find((row) => row.is_final === 1)!;
  assert.ok(final, "the recording ends in a final chunk");
  // The bout row learns its true length from the recording, the way the
  // simulation would have written it.
  bout.result!.ticks = final.end_tick;
  bout.endsAt = final.end_tick * BOXING_MODEL.physicsStepSeconds * 1000;

  const state = createBroadcast(league, 0);
  state.card = [bout];
  state.clock = { anchorRealMs: Date.now(), anchorLeagueMs: bout.endsAt + 10_000, rate: 1 };
  db.rows.set("broadcast", { id: "broadcast", payload: JSON.stringify(state), updated_at: 1 });
  // Seeded so the ticks the handlers kick off behind their responses parse
  // this league instead of regenerating a genesis roster on every pass.
  db.rows.set("league", { id: "league", payload: JSON.stringify(league), updated_at: 1 });
});

test("the verdict is never served while the book cannot be confirmed shut", async () => {
  const request = () => new Request("https://forge.test/api/league");
  const held = await (
    await handleLeagueRequest(request(), { DB: db, ...DEAD_MARKET }, ctx)
  ).json() as LeaguePayload;
  assert.equal(held.ok, true);
  assert.equal(held.live?.id, bout.id, "the bout is still on the stage");
  assert.equal(held.live?.result, null, "the verdict stays masked");
  assert.equal(
    held.live?.endsAt,
    bout.startsAt + estimatedDuration(bout.kind),
    "the true final bell stays masked with it",
  );
  const heldRow = held.card.find((row) => row.id === bout.id);
  assert.equal(heldRow?.status, "live");
  assert.equal(heldRow?.result, null);

  // No market wired up means no book anybody could dump into: reveal freely.
  const served = await (
    await handleLeagueRequest(request(), { DB: db }, ctx)
  ).json() as LeaguePayload;
  assert.ok(served.live?.result, "an unwired league reveals on time");
  assert.equal(served.card.find((row) => row.id === bout.id)?.status, "final");
});

test("the final chunk stays unaired while the book cannot be confirmed shut", async () => {
  const final = [...db.chunks.values()].find((row) => row.is_final === 1)!;
  const url = (chunk: number) =>
    new Request(`https://forge.test/api/timeline?bout=${bout.id}&chunk=${chunk}`);

  const heldFinal = await handleTimelineRequest(url(final.chunk), { DB: db, ...DEAD_MARKET });
  assert.equal(heldFinal.status, 404, "reads exactly like a chunk still airing");
  // Only the announcement is held — the rest of the fight keeps airing.
  const stillAiring = await handleTimelineRequest(url(0), { DB: db, ...DEAD_MARKET });
  assert.equal(stillAiring.status, 200);

  const served = await handleTimelineRequest(url(final.chunk), { DB: db });
  assert.equal(served.status, 200, "an unwired league airs the finish on time");
});
