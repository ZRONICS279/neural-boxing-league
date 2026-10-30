import type { BroadcastState, ScheduledBout } from "../app/broadcast.ts";
import { ANNOUNCER_VOICE } from "../app/feature-flags.ts";
import { chunkCapture } from "../app/fight-timeline.ts";
import { captureBout } from "./fight-timeline.ts";
import type { LeagueDatabase } from "./league.ts";
import { ensureVoiceSchema, pruneVoice, voiceInserts } from "./voice-store.ts";

/** Every aired fight, recorded as the chunks a viewer actually plays.
 *
 * A row is five seconds of fight: pose samples, the exact-tick change log, the
 * slice of commentary a viewer at that point has seen, and the ringside call for
 * those seconds (its spoken clips live in `fight_voice`, written in the same
 * batches — see voice-store.ts). Rows are written the moment a bout is
 * simulated — minutes before its slot — and never change, so the whole table
 * is immutable history. What keeps that from leaking a result
 * is that WRITING is early but SERVING is gated: the league clock decides which
 * chunks have aired, over in `handleTimelineRequest`, and a chunk that has not
 * fully aired is indistinguishable from one that does not exist.
 *
 * Payloads are gzipped before they go in. A full decision fight is ~112 chunks
 * and ~1.4 MB compressed at the full 50 Hz pose track; uncompressed the same
 * fight is ~6.6 MB of JSON, which is the difference between an archive and a
 * quota problem. */

/** How many recent bouts keep their chunks. Ties into the archive-backfill
 *  decision: the archive lists fights forever and keeps replay blobs for 600,
 *  but at ~1.4 MB a fight (~280 MB at this horizon) the timeline keeps fewer
 *  until the retention question is settled. */
const TIMELINE_KEEP_BOUTS = 200;

/** How many inserts go in one round trip.
 *
 * A full fight is ~112 chunks, and one statement apiece spends ~112 of a
 * worker's subrequests on a single bout. A pass that commits several fights at
 * once — a worker that has been quiet, or a card catching up — ran out partway
 * through, which is how fights ended up aired but half recorded. Twenties bring
 * a fight down to six round trips, and at a measured 15 KB for the largest
 * chunk a batch is ~270 KB: far inside what D1 takes in one request, and
 * transactional, so a batch that fails leaves nothing behind. */
const WRITE_BATCH = 20;

/** How many gaps the backfill reads for every one it is allowed to step. A
 *  fight the archive cannot rebuild would otherwise sit at the front of the
 *  newest-first list forever and keep every older gap from ever being filled. */
const BACKFILL_SCAN = 8;

type LeagueStatement = ReturnType<LeagueDatabase["prepare"]>;

/** Same reasoning as the league's own schema check: once per isolate, and a
 *  failure must not be the answer the next request is handed. */
let schemaReady: Promise<unknown> | null = null;

export function ensureTimelineSchema(db: LeagueDatabase) {
  return ensureSchema(db);
}

function ensureSchema(db: LeagueDatabase) {
  schemaReady ??= (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS fight_timeline (
        bout_id INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        start_tick INTEGER NOT NULL,
        end_tick INTEGER NOT NULL,
        is_final INTEGER NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (bout_id, chunk)
      )
    `).run();
    await ensureVoiceSchema(db);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function gzipText(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** D1 hands a BLOB column back differently depending on the runtime — an
 *  ArrayBuffer in production, a plain array of byte values from the local
 *  simulator. A number array fed to Blob would be stringified, so normalize
 *  to real bytes first. */
export function blobBytes(payload: ArrayBuffer | Uint8Array | number[]) {
  return payload instanceof Uint8Array
    ? new Uint8Array(payload)
    : Array.isArray(payload)
      ? Uint8Array.from(payload)
      : new Uint8Array(payload);
}

export async function gunzipToText(payload: ArrayBuffer | Uint8Array | number[]) {
  const stream = new Blob([blobBytes(payload)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** True if this fight's recording is complete — the guard that keeps the tick
 *  from re-stepping a whole bout it has already recorded.
 *
 *  Complete, not merely started. Chunks go in from the opening bell forward and
 *  the final one is written last, so its row is also the mark that says the
 *  recording finished. Asking only whether any chunk existed meant a fight
 *  whose write ran out of room read as recorded forever, and played until it
 *  reached the chunk the pass never got to. */
async function hasTimeline(db: LeagueDatabase, boutId: number) {
  const row = await db.prepare(
    "SELECT chunk FROM fight_timeline WHERE bout_id = ? AND is_final = 1 LIMIT 1",
  ).bind(boutId).first<{ chunk: number }>();
  return row !== null;
}

/** Steps a bout and writes it down, in order, a batch at a time.
 *
 * `INSERT OR IGNORE` is what makes a retry cheap: a fight that was recorded
 * halfway is finished by rewriting it, and the chunks already on file cost a
 * no-op apiece. The call's rows go in first, so by the time the final chunk —
 * the completeness marker — is on file, every line the fight will need has a
 * row waiting for its clip. */
async function writeTimeline(db: LeagueDatabase, bout: ScheduledBout) {
  const pending: LeagueStatement[] = [];
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    if (db.batch) await db.batch(batch);
    else for (const statement of batch) await statement.run();
  };
  const capture = captureBout(bout);
  const chunks = chunkCapture(capture);
  // With the voice off the rows are not filed either: they exist to be filled
  // with clips, and a fight recorded while it is off is captioned off the
  // chunks alone. See ANNOUNCER_VOICE.
  const voice = ANNOUNCER_VOICE ? capture.voice ?? [] : [];
  for (const statement of voiceInserts(db, bout.id, voice, chunks.at(-1)!.startTick)) {
    pending.push(statement);
    if (pending.length >= WRITE_BATCH) await flush();
  }
  for (const chunk of chunks) {
    pending.push(db.prepare(`
      INSERT OR IGNORE INTO fight_timeline (
        bout_id, chunk, start_tick, end_tick, is_final, payload
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      bout.id,
      chunk.chunk,
      chunk.startTick,
      chunk.endTick,
      chunk.isFinal ? 1 : 0,
      await gzipText(chunk.encoded),
    ));
    if (pending.length >= WRITE_BATCH) await flush();
  }
  await flush();
}

/** Records every simulated-but-unrecorded bout across the given card states.
 *
 * Mirrors the archive's habits: the richest copy of each bout wins (a bout can
 * lose its athlete snapshots inside the very pass that commits it), and
 * `INSERT OR IGNORE` makes a lost race cost nothing. Unlike the archive there
 * is no aired gate here — recording is early on purpose, serving is what
 * waits for the clock. */
export async function storeTimelines(db: LeagueDatabase, states: BroadcastState[]) {
  await ensureSchema(db);

  const richest = new Map<number, ScheduledBout>();
  for (const state of states) {
    for (const bout of state.card) {
      if (!bout.result || !bout.profiles) continue;
      if (richest.has(bout.id)) continue;
      richest.set(bout.id, bout);
    }
  }
  if (richest.size === 0) return 0;

  let recorded = 0;
  for (const bout of richest.values()) {
    try {
      // Stepping a fight is ~2 s of CPU, so the completeness check is the real
      // guard; the insert's OR IGNORE only settles simultaneous writers.
      if (await hasTimeline(db, bout.id)) continue;
      await writeTimeline(db, bout);
      recorded += 1;
    } catch {
      // A fight that cannot be recorded is not a reason to stop the card. Its
      // chunks stay missing and the tick carries on — and, because the guard
      // above reads completeness rather than existence, a later pass picks the
      // fight back up instead of leaving it half written for good.
    }
  }

  if (recorded > 0) {
    await pruneTimelines(db);
    await pruneVoice(db);
  }
  return recorded;
}

/** Fills in fights that aired without a recording on file.
 *
 * Recording happens on the pass that simulates a bout, which is the one moment
 * the card is holding everything it needs. A pass that ran out of room there —
 * out of subrequests, or a D1 that blinked — left a fight aired, listed, and
 * unwatchable, which the site then reported to viewers as the fight being old
 * enough to have lost its rewatch. It was hours old.
 *
 * The archive is the second copy. Its replay blob is the bout exactly as it was
 * fought — seed, both athletes as they stepped through the ropes, the corner
 * instructions pinned to their ticks — so a gap inside the retention window can
 * be closed later from that alone. One fight a pass by default: re-stepping a
 * bout costs the same couple of seconds the original simulation paid, and a gap
 * is not urgent enough to spend a tick's whole budget on. */
export async function backfillTimelines(db: LeagueDatabase, limit = 1) {
  await ensureSchema(db);
  let filled = 0;
  try {
    // The floor is the oldest fight the store is still keeping, not a count of
    // its own: filling in a gap that retention has already walked past would
    // write a fight the next prune deletes, every pass, forever.
    const rows = await db.prepare(`
      SELECT id, replay FROM fight_archive
      WHERE replay IS NOT NULL
        AND id >= COALESCE((SELECT MIN(bout_id) FROM fight_timeline), 0)
        AND NOT EXISTS (
          SELECT 1 FROM fight_timeline
          WHERE fight_timeline.bout_id = fight_archive.id AND fight_timeline.is_final = 1
        )
      ORDER BY id DESC
      LIMIT ?
    `).bind(limit * BACKFILL_SCAN).all?.<{ id: number; replay: string }>();
    let stepped = 0;
    for (const row of rows?.results ?? []) {
      if (stepped >= limit) break;
      let bout: ScheduledBout;
      try {
        bout = JSON.parse(row.replay) as ScheduledBout;
      } catch {
        continue;
      }
      // The blob is written by the archive and read back by nobody else, but a
      // recording needs the athletes and the result the same way a live one
      // does, and a row that predates either is simply not backfillable.
      if (!bout.result || !bout.profiles) continue;
      stepped += 1;
      try {
        await writeTimeline(db, bout);
        filled += 1;
      } catch {
        // The next pass tries the next fight down. A gap that cannot be closed
        // is one unwatchable fight, and it must not stand in front of the ones
        // that can be — which is the whole reason more rows are read than are
        // ever stepped in a pass.
      }
    }
  } catch {
    // No archive table yet, or a database that is having a bad minute.
  }
  return filled;
}

/** Drops whole fights past the retention horizon. Ids climb monotonically, so
 *  "the newest two hundred bouts" is a comparison rather than a sort. */
async function pruneTimelines(db: LeagueDatabase) {
  try {
    await db.prepare(`
      DELETE FROM fight_timeline
      WHERE bout_id < (
        SELECT MIN(bout_id) FROM (
          SELECT DISTINCT bout_id FROM fight_timeline ORDER BY bout_id DESC LIMIT ?
        )
      )
    `).bind(TIMELINE_KEEP_BOUTS).run();
  } catch {
    // Housekeeping. If it fails the table is merely larger than intended.
  }
}

export interface TimelineChunkRow {
  bout_id: number;
  chunk: number;
  start_tick: number;
  end_tick: number;
  is_final: number;
  /** See `gunzipToText`: the runtime decides what a BLOB reads back as. */
  payload: ArrayBuffer | number[];
}

export async function readTimelineChunk(
  db: LeagueDatabase,
  boutId: number,
  chunk: number,
) {
  await ensureSchema(db);
  return db.prepare(
    "SELECT * FROM fight_timeline WHERE bout_id = ? AND chunk = ? LIMIT 1",
  ).bind(boutId, chunk).first<TimelineChunkRow>();
}

/** Whether this bout aired before the current card — the archive only lists
 *  fights the public has actually seen, so a listing is proof of airing. Keeps
 *  a card reset from exposing recordings of fights nobody ever watched. */
export async function airedBeforeThisCard(db: LeagueDatabase, boutId: number) {
  try {
    const row = await db.prepare(
      "SELECT id FROM fight_archive WHERE id = ? LIMIT 1",
    ).bind(boutId).first<{ id: number }>();
    return row !== null;
  } catch {
    return false;
  }
}
