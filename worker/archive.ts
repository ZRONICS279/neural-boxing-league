import type { ArchivedFight } from "../app/archive.ts";
import type { BroadcastState, ScheduledBout } from "../app/broadcast.ts";
import type { Fighter } from "../app/fight-model.ts";
import type { LeagueDatabase } from "./league.ts";
import { publicFighter } from "./public-fighter.ts";
import { ensureTimelineSchema } from "./timeline-store.ts";

/** Every fight the league has ever aired, kept after the card it was on is gone.
 *
 * A card is one evening: when the last bout of a night has been fought the whole
 * listing is torn down and the next one drawn up, and the athlete snapshots a
 * replay needs are stripped off a bout within a couple of ticks of its final
 * bell. Both of those are right for the broadcast — the card is a live object
 * and it must not grow without bound — and both mean a fight is unwatchable
 * about a minute after it ends.
 *
 * This is the other half. Each aired bout is copied out to its own row on the
 * way past, with everything a replay actually needs: the seed, the two athlete
 * snapshots exactly as they stepped through the ropes, and the corner
 * instructions pinned to their ticks. `replayBout` in the browser then rebuilds
 * the fight from that alone, frame for frame, the same way a live viewer does —
 * no video, no per-tick recording, nothing streamed.
 *
 * The row is deliberately split in two. The summary columns are the listing and
 * they are kept forever: a few hundred bytes a fight, so a year of cards is a
 * couple of megabytes. The `replay` blob is ~30 KB, almost all of it policy
 * matrices, and it is dropped once the fight is old enough that the summary is
 * what anybody wants — which is what keeps the archive cheap rather than
 * something that has to be capped. */

/** How many of the most recent bouts keep their replay payload.
 *
 * Forty cards, which at the league's own cadence is a couple of weeks of
 * fighting. Past that the fight is still listed, still says who won and how, and
 * its book is still claimable — it just cannot be watched again. */
const REPLAY_KEEP_BOUTS = 600;
const ARCHIVE_RESET_ROW = "archive-reset";

/** Same reasoning as the league's own schema check: once per isolate, and a
 *  failure must not be the answer the next request is handed. */
let schemaReady: Promise<unknown> | null = null;

function ensureSchema(db: LeagueDatabase) {
  schemaReady ??= (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS fight_archive (
        id INTEGER PRIMARY KEY NOT NULL,
        night INTEGER NOT NULL,
        season INTEGER NOT NULL,
        week INTEGER NOT NULL,
        division TEXT NOT NULL,
        kind TEXT NOT NULL,
        blue_id TEXT NOT NULL,
        red_id TEXT NOT NULL,
        blue_name TEXT NOT NULL,
        red_name TEXT NOT NULL,
        winner_id TEXT,
        finish TEXT NOT NULL,
        round INTEGER NOT NULL,
        total_rounds INTEGER NOT NULL,
        ticks INTEGER NOT NULL,
        blue_landed INTEGER NOT NULL,
        red_landed INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        aired_at INTEGER NOT NULL,
        replay TEXT
      )
    `).run();
    await db.prepare(
      "CREATE INDEX IF NOT EXISTS fight_archive_night ON fight_archive (night)",
    ).run();
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function readArchiveFloor(db: LeagueDatabase) {
  try {
    const row = await db.prepare(
      "SELECT payload FROM league_state WHERE id = ? LIMIT 1",
    ).bind(ARCHIVE_RESET_ROW).first<{ payload: string }>();
    if (!row) return 0;
    return Number((JSON.parse(row.payload) as { afterId?: number }).afterId ?? 0) || 0;
  } catch {
    return 0;
  }
}

interface ArchiveRow {
  id: number;
  night: number;
  season: number;
  week: number;
  division: string;
  kind: string;
  blue_id: string;
  red_id: string;
  blue_name: string;
  red_name: string;
  winner_id: string | null;
  finish: string;
  round: number;
  total_rounds: number;
  ticks: number;
  blue_landed: number;
  red_landed: number;
  started_at: number;
  aired_at: number;
  replay: string | null;
  has_replay?: number;
}

function toFight(row: ArchiveRow): ArchivedFight {
  return {
    id: row.id,
    night: row.night,
    season: row.season,
    week: row.week,
    division: row.division as ArchivedFight["division"],
    kind: row.kind === "title" ? "title" : "contender",
    blueId: row.blue_id,
    redId: row.red_id,
    blueName: row.blue_name,
    redName: row.red_name,
    winnerId: row.winner_id,
    // Stoppages were filed as "RSC" before the league settled on "TKO". The
    // rows stay as they were written; the word is fixed on the way out so the
    // archive does not read two ways down one page.
    finish: row.finish === "RSC" ? "TKO" : row.finish,
    round: row.round,
    totalRounds: row.total_rounds,
    ticks: row.ticks,
    blueLanded: row.blue_landed,
    redLanded: row.red_landed,
    startedAt: row.started_at,
    airedAt: row.aired_at,
    replayable: Boolean(row.has_replay),
  };
}

/** The name a result is read out under. */
function lastNameOf(bout: ScheduledBout, fighterId: string) {
  const profile = bout.profiles?.find((fighter) => fighter.id === fighterId);
  return profile?.lastName ?? fighterId;
}

/** Copies whatever has aired and is not archived yet.
 *
 * Called with every version of the card this pass has touched, because a bout
 * can lose its athlete snapshots inside the very pass that commits it — the card
 * strips everything older than the fight on air, and a worker that has been
 * quiet long enough commits several fights at once. Taking the richest copy of
 * each bout across the states means the pass that retires a fight is also the
 * pass that keeps it.
 *
 * `INSERT OR IGNORE` is what makes this safe to run from every tick and from
 * every worker at once: the first one to see a fight writes it, and the rest
 * write nothing rather than racing over the top of a row viewers may already be
 * replaying. */
export async function archiveAiredBouts(
  db: LeagueDatabase,
  states: BroadcastState[],
  now: number,
  realNow: number,
) {
  await ensureSchema(db);
  const floor = await readArchiveFloor(db);

  const richest = new Map<number, { bout: ScheduledBout; state: BroadcastState }>();
  for (const state of states) {
    for (const bout of state.card) {
      // Only fights that have actually been fought in public. A bout is
      // simulated minutes before its slot, and writing that down would put the
      // winner of a fight nobody has watched into a table a reader can ask for
      // while its book is still open.
      if (!bout.result || !bout.profiles || bout.endsAt > now) continue;
      if (bout.id <= floor) continue;
      const held = richest.get(bout.id);
      if (held && held.bout.profiles) continue;
      richest.set(bout.id, { bout, state });
    }
  }
  if (richest.size === 0) return 0;

  let written = 0;
  for (const { bout, state } of richest.values()) {
    const result = bout.result!;
    try {
      const done = await db.prepare(`
        INSERT OR IGNORE INTO fight_archive (
          id, night, season, week, division, kind,
          blue_id, red_id, blue_name, red_name,
          winner_id, finish, round, total_rounds, ticks,
          blue_landed, red_landed, started_at, aired_at, replay
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        bout.id,
        state.night,
        state.season,
        state.week,
        bout.division,
        bout.kind,
        bout.blueId,
        bout.redId,
        lastNameOf(bout, bout.blueId),
        lastNameOf(bout, bout.redId),
        result.winnerId,
        result.finish,
        result.round,
        bout.totalRounds,
        result.ticks,
        result.blueLanded,
        result.redLanded,
        bout.startsAt,
        realNow,
        JSON.stringify(bout),
      ).run();
      if ((done?.meta?.changes ?? 1) > 0) written += 1;
    } catch {
      // A fight that cannot be filed is not a reason to stop the card. It stays
      // out of the archive and the tick carries on.
    }
  }

  if (written > 0) await pruneReplays(db);
  return written;
}

/** Drops the heavy half of rows old enough that nobody is rewatching them.
 *
 * The listing keeps every fight forever; only the ~30 KB of athlete snapshots
 * goes. Ids climb monotonically, so "the newest six hundred" is a comparison
 * rather than a sort. */
async function pruneReplays(db: LeagueDatabase) {
  try {
    await db.prepare(`
      UPDATE fight_archive SET replay = NULL
      WHERE replay IS NOT NULL
        AND id <= (SELECT MAX(id) FROM fight_archive) - ?
    `).bind(REPLAY_KEEP_BOUTS).run();
  } catch {
    // Housekeeping. If it fails the archive is merely larger than intended.
  }
}

export async function clearArchivedFights(db: LeagueDatabase) {
  await ensureSchema(db);
  const latest = await db.prepare(
    "SELECT MAX(id) AS max_id FROM fight_archive",
  ).first<{ max_id: number | null }>();
  const afterId = Number(latest?.max_id ?? 0) || 0;
  const result = await db.prepare("DELETE FROM fight_archive").run();
  await db.prepare(`
    INSERT INTO league_state (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(
    ARCHIVE_RESET_ROW,
    JSON.stringify({ afterId }),
    Date.now(),
  ).run();
  return { deleted: result?.meta?.changes ?? 0, afterId };
}

/** "Watchable" means the whole recorded timeline is on file, not that the raw
 *  replay blob is — the blob stopped being served the day the engine left the
 *  browser, so its presence stopped meaning anything to a viewer. The final
 *  chunk is the one that says the recording ran to the bell: a fight whose
 *  write stopped partway is worse to offer than one that was never recorded,
 *  because it plays and then stops in the middle of the fight. */
const REPLAYABLE = `EXISTS (
  SELECT 1 FROM fight_timeline
  WHERE fight_timeline.bout_id = fight_archive.id AND fight_timeline.is_final = 1
)`;

const LIST_COLUMNS = `
  id, night, season, week, division, kind,
  blue_id, red_id, blue_name, red_name,
  winner_id, finish, round, total_rounds, ticks,
  blue_landed, red_landed, started_at, aired_at,
  NULL AS replay, ${REPLAYABLE} AS has_replay
`;

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

interface ArchiveEnv {
  DB?: LeagueDatabase;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    // A finished fight never changes, so the one thing this can be generous
    // about is the row itself. The listing still moves as cards are fought.
    headers: { "Cache-Control": status === 200 ? "public, max-age=30" : "no-store" },
  });
}

/** The archive, read-only.
 *
 * Two shapes on one route: `?bout=` is one fight with its replay attached, and
 * anything else is a page of the listing, newest first, walked with `before`. */
export async function handleArchiveRequest(request: Request, env: ArchiveEnv) {
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "The league database is not bound." }, 503);
  }
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  const db = env.DB;
  await ensureSchema(db);
  // Watchability is read off the timeline table, which may not have been
  // touched yet in a fresh isolate.
  await ensureTimelineSchema(db);
  const url = new URL(request.url);

  const boutId = Number(url.searchParams.get("bout"));
  if (Number.isFinite(boutId) && boutId > 0) {
    const row = await db.prepare(
      `SELECT *, ${REPLAYABLE} AS has_replay FROM fight_archive WHERE id = ? LIMIT 1`,
    ).bind(boutId).first<ArchiveRow>();
    if (!row) {
      return jsonResponse({ ok: false, error: "That fight is not in the archive." }, 404);
    }
    // The stored blob holds the seed, the corner instructions and the two
    // athletes' full policy snapshots — everything a copy of the league would
    // want. None of it leaves. The rewatch plays the recorded timeline, and
    // what a viewer needs from here is only the pair as the public knows them,
    // frozen at the bell.
    let profiles: [Fighter, Fighter] | null = null;
    if (row.replay) {
      try {
        const held = (JSON.parse(row.replay) as ScheduledBout).profiles;
        if (held) profiles = [publicFighter(held[0]), publicFighter(held[1])];
      } catch {
        profiles = null;
      }
    }
    return jsonResponse({ ok: true, fight: toFight(row), profiles });
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT),
  );
  const before = Number(url.searchParams.get("before"));
  const night = Number(url.searchParams.get("night"));

  const filters: string[] = [];
  const values: unknown[] = [];
  if (Number.isFinite(before) && before > 0) {
    filters.push("id < ?");
    values.push(before);
  }
  if (Number.isFinite(night) && night > 0) {
    filters.push("night = ?");
    values.push(night);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const statement = db.prepare(
    `SELECT ${LIST_COLUMNS} FROM fight_archive ${where} ORDER BY id DESC LIMIT ?`,
  ).bind(...values, limit + 1);
  const rows = (await statement.all?.<ArchiveRow>())?.results ?? [];

  const page = rows.slice(0, limit);
  return jsonResponse({
    ok: true,
    fights: page.map(toFight),
    // The id to ask for next, or null when this is the last page. Keyset rather
    // than an offset: the archive grows at the front while somebody is paging
    // through it, and an offset would show them the same fight twice.
    nextBefore: rows.length > limit ? page[page.length - 1].id : null,
  });
}
