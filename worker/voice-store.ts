import { PLAYBACK_DELAY_MS, type BroadcastState } from "../app/broadcast.ts";
import type { TimelineVoiceLine } from "../app/fight-timeline.ts";
import type { LeagueDatabase } from "./league.ts";
import { type VoiceEnv, renderVoiceLine } from "./voice.ts";

/** Every line of every recorded fight's call, and the spoken clip for each.
 *
 * A row is written with the fight's chunks, in the same batches, the moment the
 * bout is recorded — the text of the line and where it falls, no audio yet. A
 * later pass of the tick renders the audio a batch at a time, earliest lines
 * of the soonest fight first, so a fight's opening is spoken well before its
 * bell and the finish has the whole fight to land in. A line whose clip has
 * not landed by the time it airs is simply captioned: the picture never waits
 * on the voice, and the caption carries the call either way.
 *
 * Serving is gated exactly like the chunks, over in `handleVoiceRequest`: a
 * clip's tick has to have aired, and a clip from the final chunk waits for the
 * book to be confirmed shut, because the finish call names the winner. */

/** Lines rendered in one pass of the tick, and how many at once. A full fight
 *  is ~150 lines and airs over ten minutes or more; forty a minute keeps the
 *  rendering comfortably ahead of the playhead without one pass spending a
 *  hundred and fifty subrequests. */
const RENDER_BATCH = 40;
const RENDER_PARALLEL = 8;
/** How long the tick leaves the speech model alone after it refuses a request
 *  for a reason asking again will not change — no balance, a bad key. */
const REFUSAL_BACKOFF_MS = 5 * 60 * 1000;
/** How many recent bouts keep their clips. A clip is ~50 KB of MP3 and a
 *  fight is ~130 of them, so this is ~6 MB a fight against the timeline's
 *  ~1.4 MB — a fight past this horizon rewatches with the call as captions,
 *  which is what a fight recorded before the voice existed does anyway. */
const VOICE_KEEP_BOUTS = 40;

type LeagueStatement = ReturnType<LeagueDatabase["prepare"]>;

/** Same reasoning as the timeline's own schema check: once per isolate, and a
 *  failure must not be the answer the next request is handed. */
let schemaReady: Promise<unknown> | null = null;
/** Per isolate, like the schema flag: a refusal is about the key, not the row. */
let refusedUntil = 0;

export function ensureVoiceSchema(db: LeagueDatabase) {
  schemaReady ??= (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS fight_voice (
        bout_id INTEGER NOT NULL,
        line INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        is_final INTEGER NOT NULL,
        register TEXT NOT NULL,
        text TEXT NOT NULL,
        audio BLOB,
        PRIMARY KEY (bout_id, line)
      )
    `).run();
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** The call as rows, ready to ride in the recording's own batches. `INSERT OR
 *  IGNORE` for the same reason the chunks use it: a recording finished on a
 *  retry costs a no-op per line already on file, and a clip already rendered
 *  is never overwritten with silence. `finalStartTick` is where the last chunk
 *  begins — a line past it is served under the final chunk's rules. */
export function voiceInserts(
  db: LeagueDatabase,
  boutId: number,
  voice: TimelineVoiceLine[],
  finalStartTick: number,
): LeagueStatement[] {
  return voice.map((line) =>
    db.prepare(`
      INSERT OR IGNORE INTO fight_voice (
        bout_id, line, tick, is_final, register, text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      boutId,
      line.line,
      line.tick,
      line.tick > finalStartTick ? 1 : 0,
      line.register,
      line.text,
    ),
  );
}

interface PendingRow {
  bout_id: number;
  line: number;
  register: TimelineVoiceLine["register"];
  text: string;
}

/** Renders clips for lines on tonight's card that do not have one yet.
 *
 * Only the card, and only the fights still to be heard: a fight rebuilt into
 * the timeline from the archive gets its rows too, and a fight that has
 * finished airing keeps its unrendered lines, but nobody is about to hear
 * either, and rendering them would be paying for a broadcast with no
 * audience. The fight on air comes first, then the next one up — `now` is the
 * league clock — so a pass never spends its batch on a bout that is still
 * an hour off while the live one is being captioned. Returns how many clips
 * landed. */
export async function renderPendingVoice(
  db: LeagueDatabase,
  env: VoiceEnv,
  state: BroadcastState,
  now: number,
  realNow = Date.now(),
  fetcher: typeof fetch = fetch,
) {
  if (!env.OPENAI_API_KEY || realNow < refusedUntil) return 0;
  const bouts = state.card
    .filter((bout) => bout.result && bout.endsAt + PLAYBACK_DELAY_MS > now)
    .sort((left, right) => left.startsAt - right.startsAt);
  if (bouts.length === 0) return 0;
  await ensureVoiceSchema(db);
  const pending: PendingRow[] = [];
  for (const bout of bouts) {
    if (pending.length >= RENDER_BATCH) break;
    const rows = await db.prepare(`
      SELECT bout_id, line, register, text FROM fight_voice
      WHERE audio IS NULL AND bout_id = ?
      ORDER BY line ASC
      LIMIT ?
    `).bind(bout.id, RENDER_BATCH - pending.length).all?.<PendingRow>();
    pending.push(...(rows?.results ?? []));
  }

  let rendered = 0;
  for (let at = 0; at < pending.length; at += RENDER_PARALLEL) {
    const wave = pending.slice(at, at + RENDER_PARALLEL);
    const outcomes = await Promise.all(wave.map((row) => renderVoiceLine(row, env, fetcher)));
    const writes: LeagueStatement[] = [];
    let refused = false;
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.ok) {
        if (!outcome.again) refused = true;
        continue;
      }
      const row = wave[index];
      // `audio IS NULL` again on the write: two passes racing on the same
      // line keep whichever clip landed first rather than the last one in.
      writes.push(db.prepare(
        "UPDATE fight_voice SET audio = ? WHERE bout_id = ? AND line = ? AND audio IS NULL",
      ).bind(outcome.audio, row.bout_id, row.line));
    }
    if (writes.length > 0) {
      if (db.batch) await db.batch(writes);
      else for (const statement of writes) await statement.run();
      rendered += writes.length;
    }
    if (refused) {
      refusedUntil = realNow + REFUSAL_BACKOFF_MS;
      break;
    }
  }
  return rendered;
}

export interface VoiceClipRow {
  tick: number;
  is_final: number;
  /** Null until rendered. See `gunzipToText` for why a BLOB reads back as
   *  more than one shape. */
  audio: ArrayBuffer | number[] | null;
}

export async function readVoiceClip(db: LeagueDatabase, boutId: number, line: number) {
  await ensureVoiceSchema(db);
  return db.prepare(
    "SELECT tick, is_final, audio FROM fight_voice WHERE bout_id = ? AND line = ? LIMIT 1",
  ).bind(boutId, line).first<VoiceClipRow>();
}

/** Drops whole fights' calls past the voice's own, shorter, horizon — see
 *  VOICE_KEEP_BOUTS. Ids climb monotonically, so "the newest forty bouts" is a
 *  comparison rather than a sort, as in the timeline's prune. */
export async function pruneVoice(db: LeagueDatabase) {
  try {
    await db.prepare(`
      DELETE FROM fight_voice
      WHERE bout_id < (
        SELECT MIN(bout_id) FROM (
          SELECT DISTINCT bout_id FROM fight_voice ORDER BY bout_id DESC LIMIT ?
        )
      )
    `).bind(VOICE_KEEP_BOUTS).run();
  } catch {
    // Housekeeping. If it fails the table is merely larger than intended.
  }
}
