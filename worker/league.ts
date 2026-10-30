import {
  CARD_BOUTS,
  PLAYBACK_DELAY_MS,
  RESET_CARD_DELAY_MS,
  SIMULATE_LEAD_MS,
  type BroadcastState,
  type CoachRequest,
  type ScheduledBout,
  advanceBroadcast,
  airtimeEnd,
  createBroadcast,
  currentBout,
  estimatedDuration,
  leagueNow,
  nextBout,
  openDoorsNow,
  reanchorClock,
  recentResults,
  resetCardNow,
  stageBoutNow,
  tickForTime,
  upgradeBroadcast,
} from "../app/broadcast.ts";
import {
  type Fighter,
  type LeagueState,
  type WeightClassId,
  buildStrategyContext,
  createInitialLeague,
  upgradeLeagueState,
} from "../app/simulation.ts";
import { ANNOUNCER_VOICE } from "../app/feature-flags.ts";
import { adminAuthorized } from "./admin.ts";
import { archiveAiredBouts, clearArchivedFights } from "./archive.ts";
import {
  type StoredRoster,
  dirtyFighterStatements,
  ensureFighterSchema,
  fighterUpsert,
  readStoredRoster,
  reconcileStatements,
  writeRows,
} from "./fighter-store.ts";
import { indexMarketEvents } from "./market.ts";
import { migrationFrozen } from "./migration.ts";
import { publicFighter } from "./public-fighter.ts";
import { generateStrategyDirective } from "./strategy.ts";
import {
  airedBeforeThisCard,
  backfillTimelines,
  blobBytes,
  gunzipToText,
  readTimelineChunk,
  storeTimelines,
} from "./timeline-store.ts";
import { readVoiceClip, renderPendingVoice } from "./voice-store.ts";
import {
  type LiveFair,
  type MarketOperatorEnv,
  ensureBoutClosed,
  settleAbandonedMarkets,
  syncMarkets,
} from "./market-operator.ts";
import {
  TIMELINE_CHUNK_TICKS,
  type FightTimeline,
  cardsUpTo,
  decodeTimeline,
  frameAt,
} from "../app/fight-timeline.ts";
import { inPlayLine } from "./inplay-line.ts";
import { openingLineFor } from "../app/opening-line.ts";

/** The server side of the broadcast.
 *
 * One card, one clock, one source of truth. Viewers only ever read from here —
 * the write path is the admin commands at the bottom, behind a token. The card
 * is run forward both by the cron trigger and opportunistically by any read, so
 * the league keeps fighting whether or not anybody has the page open. */

const BROADCAST_ROW = "broadcast";
const LEAGUE_ROW = "league";
const LEGACY_TRAINING_ROW = "forge-league";
/** The league row exactly as it stood the moment before the careers moved out
 *  of it and into their own table. Written once, never read by the running
 *  league, and never overwritten — it is the thing to restore from if the
 *  split ever turns out to have been wrong about something. */
const PRE_SPLIT_ROW = "league-pre-split";
/** Held by whichever worker is currently allowed to fight the next bout. */
const SIMULATION_LEASE_ROW = "simulation-lease";
/** Long enough for a bout and the four coaching calls it makes, short enough
 *  that a worker which dies mid-fight does not wedge the card behind it. */
const SIMULATION_LEASE_MS = 60_000;
/** How long an isolate may serve the card it last read. Only the card ages
 *  here — the payload is rebuilt from the live clock on every request, so the
 *  fight clock every viewer replays against stays exact. */
const STATE_CACHE_MS = 1_000;
/** Enough room to recover several missed nights in one protected write. A
 *  normal minute uses one or two passes; the ceiling is only for a worker that
 *  wakes after its host stopped delivering timers. */
const MAX_TICK_PASSES = 32;

interface LeagueStatement {
  bind(...values: unknown[]): LeagueStatement;
  first<T>(): Promise<T | null>;
  /** Only the archive reads more than one row at a time, and only D1 proper
   *  implements it — the test doubles in here answer single rows. */
  all?<T>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface LeagueDatabase {
  prepare(query: string): LeagueStatement;
  batch?(statements: LeagueStatement[]): Promise<unknown[]>;
}

export interface LeagueEnv extends MarketOperatorEnv {
  DB?: LeagueDatabase;
  FORGE_ADMIN_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_STRATEGY_MODEL?: string;
  OPENAI_VOICE_MODEL?: string;
  OPENAI_VOICE?: string;
}

interface LeagueExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface StateRow {
  id: string;
  payload: string;
  updated_at: number;
}

interface LegacyLeagueRow {
  league_json: string;
}

interface TrainingRestore {
  status: "running" | "working" | "paused" | "complete" | "error";
  targetId: string;
  remainingCycles: number | null;
  cycles: number;
  bouts: number;
  physicsSteps: number;
  candidates: number;
  checkpoints: number;
  startFitness: number;
  currentFitness: number;
  rewardGain: number;
  pauseRequested: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Creates the table once per isolate rather than once per request.
 *
 * Training now reads this league too, so the schema check was running on the
 * broadcast poll and the training poll at the same time — and concurrent DDL is
 * exactly what the local D1 emulator intermittently fails on. The table only
 * has to exist once; a cold isolate re-checks, which is all the guarantee this
 * ever gave. */
let schemaReady: Promise<unknown> | null = null;

function ensureSchema(db: LeagueDatabase) {
  schemaReady ??= db.prepare(`
    CREATE TABLE IF NOT EXISTS league_state (
      id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run().then(() => ensureFighterSchema(db)).catch((error) => {
    // A failed check must not be cached, or the isolate never recovers.
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function readRow(db: LeagueDatabase, id: string) {
  return db.prepare("SELECT * FROM league_state WHERE id = ? LIMIT 1")
    .bind(id).first<StateRow>();
}

async function readLegacyLeagueRow(db: LeagueDatabase) {
  return db.prepare(
    "SELECT league_json FROM training_jobs WHERE id = ? LIMIT 1",
  ).bind(LEGACY_TRAINING_ROW).first<LegacyLeagueRow>();
}

/** Writes a row only if nobody has touched it since it was read at `expected`.
 *
 * The row's `updated_at` doubles as its version, and this is the whole reason
 * two viewers can no longer produce two different fight nights. A worker that
 * reads the card, runs it forward, and finds somebody else published first has
 * its work rejected rather than laid over a bout that is already on air. The
 * version is forced strictly upward so the token always moves, even when two
 * writes land inside the same millisecond. */
async function writeRow(
  db: LeagueDatabase,
  id: string,
  payload: unknown,
  expected: number | null,
) {
  const version = Math.max(Date.now(), (expected ?? 0) + 1);
  const body = JSON.stringify(payload);
  const result = expected === null
    ? await db.prepare(`
        INSERT INTO league_state (id, payload, updated_at)
        SELECT ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM league_state WHERE id = ?)
      `).bind(id, body, version, id).run()
    : await db.prepare(`
        UPDATE league_state SET payload = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).bind(body, version, id, expected).run();
  return { landed: await conditionalWriteLanded(db, result, id, version), version };
}

/** Did the conditional write actually take?
 *
 * D1 reports the affected row count. When it is missing the row is read back
 * instead, which answers the same question a beat later rather than guessing —
 * and guessing here would put the two fight nights straight back. */
async function conditionalWriteLanded(
  db: LeagueDatabase,
  result: { meta?: { changes?: number } },
  id: string,
  version: number,
) {
  const changes = result?.meta?.changes;
  if (typeof changes === "number") return changes > 0;
  const row = await readRow(db, id);
  return row?.updated_at === version;
}

/** An unconditional upsert, for a row already covered by another row's gate or
 *  for an operator deliberately overwriting whatever is there. */
async function forceRow(db: LeagueDatabase, id: string, payload: unknown) {
  const current = await readRow(db, id);
  const version = Math.max(Date.now(), (current?.updated_at ?? 0) + 1);
  await db.prepare(`
    INSERT INTO league_state (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(id, JSON.stringify(payload), version).run();
  return version;
}

/** The corner between rounds, as the broadcast records it.
 *
 * Only wired up when an API key is present; otherwise the bout falls back to
 * the simulation's own corner logic and stays every bit as deterministic. */
function buildCoach(env: LeagueEnv) {
  if (!env.OPENAI_API_KEY) return undefined;
  return async (request: CoachRequest) => {
    const runtime = request.corner === "blue" ? request.bout.left : request.bout.right;
    const opponentRuntime =
      request.corner === "blue" ? request.bout.right : request.bout.left;
    const context = buildStrategyContext(
      request.self,
      request.opponent,
      runtime,
      opponentRuntime,
      request.bout.round,
    );
    try {
      return await generateStrategyDirective(context, env);
    } catch {
      return null;
    }
  };
}

interface LoadedLeague {
  state: BroadcastState;
  league: LeagueState;
  /** The version the gate row was read at, so a write can prove nothing moved
   *  underneath it. Null means the row did not exist yet. */
  broadcastVersion: number | null;
  /** Where each athlete sat in the stored roster when it was read, so a write
   *  can tell a career that moved from one that merely stayed put. */
  ordinals: Map<string, number>;
}

function parseLeagueRow(row: StateRow): { roster?: unknown } {
  try {
    return JSON.parse(row.payload) as { roster?: unknown };
  } catch {
    throw new Error(
      `league row is not JSON (${row.payload.length} bytes) — refusing to replace the roster with a fresh one`,
    );
  }
}

/** The careers, or nothing at all.
 *
 * A fresh league is only ever the right answer when the league has never been
 * saved. Every other route to one — a payload that is not JSON, a version this
 * build does not recognise, a single malformed athlete in a roster of
 * thirty-six — used to fall quietly through to `createInitialLeague()`, and
 * then the next tick wrote it back over the top. Every record, every ladder
 * position, every decision the brains had learned: gone, with nothing in the
 * logs, because one field was the wrong shape.
 *
 * So a row that exists and cannot be read is a throw. The tick fails, the
 * league freezes exactly where it is, and the row is still sitting in D1 to be
 * looked at. Frozen is a bad afternoon; overwritten is unrecoverable.
 *
 * The card gets the opposite treatment on purpose — an unreadable *card* is
 * forgiven and rebuilt, because a card is one evening and is derived from these
 * careers anyway. */
function readLeague(
  parsed: { roster?: unknown } | null,
  stored: StoredRoster | null,
): LeagueState {
  if (!parsed && !stored) return createInitialLeague();
  if (!parsed) {
    // Careers without the season they were fought in. Recoverable by hand from
    // the pre-split copy, so it stops the tick rather than inventing a week 1.
    throw new Error(
      `the roster holds ${stored?.roster.length ?? 0} careers but the league row is gone — refusing to restart the season around them`,
    );
  }

  // Before the split the row carried its own roster; after it, the careers
  // live in their own table and the row is just the season header. A row that
  // still has a roster is read from as it always was — the split has simply
  // not run yet, and it runs on the way out of the load.
  const roster = Array.isArray(parsed.roster) ? parsed.roster : stored?.roster;
  if (!roster) {
    throw new Error(
      "league row holds no roster and the fighters table is empty — refusing to seed a fresh league over a season already under way",
    );
  }

  // One upgrade authority, whichever shape the careers arrived in: the version
  // gate, the per-fighter repairs and the merge that signs newly seeded
  // athletes onto an older save all still happen in exactly one place.
  const league = upgradeLeagueState({ ...parsed, roster });
  if (!league) {
    throw new Error(
      "league row could not be read by this build — refusing to overwrite it with a fresh league",
    );
  }
  return league;
}

/** The season, without the careers — what the league row holds once they have
 *  moved out of it. Around 80 bytes, against the 673 KB it used to be. */
function headerOf(league: LeagueState) {
  return {
    version: league.version,
    season: league.season,
    week: league.week,
    boutsCompleted: league.boutsCompleted,
  };
}

function headerUpsert(db: LeagueDatabase, league: LeagueState, now: number) {
  return db.prepare(`
    INSERT INTO league_state (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(LEAGUE_ROW, JSON.stringify(headerOf(league)), now);
}

/** Moves the careers out of the league row and into their own, once.
 *
 * Ordered so the pre-image is safe before anything is changed: the untouched
 * league payload is copied aside first, then every athlete is written to his
 * own row, and only then does the fat row become a header. All three land in
 * one batch, so a league is never half-moved.
 *
 * Two cold workers can reach this at the same time and both do the work. That
 * is harmless — they split the same league into the same rows — and the
 * recovery copy is a conditional insert, so the second one cannot lay a
 * half-migrated payload over the genuine pre-image. */
async function splitLeagueRow(db: LeagueDatabase, row: StateRow, league: LeagueState) {
  const now = Date.now();
  await writeRows(db, [
    db.prepare(`
      INSERT INTO league_state (id, payload, updated_at)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM league_state WHERE id = ?)
    `).bind(PRE_SPLIT_ROW, row.payload, now, PRE_SPLIT_ROW),
    ...league.roster.map((fighter, ordinal) => fighterUpsert(db, fighter, ordinal, now)),
    headerUpsert(db, league, now),
  ]);
}

/** The careers as they stand, and the ordinals they were read at.
 *
 * The one place that knows how a league is stored. It is also where the split
 * happens, because this is the only read that can see both halves at once —
 * and once it has run, the branch never fires again. */
async function loadStoredLeague(db: LeagueDatabase) {
  const [row, stored] = await Promise.all([
    readStoredLeagueRow(db),
    readStoredRoster(db),
  ]);
  const parsed = row ? parseLeagueRow(row) : null;
  const league = readLeague(parsed, stored);

  // A league nobody has stored yet is left alone: it has no header row either,
  // and materialising careers without the season they belong to would leave
  // the next load holding a roster it cannot date. The first write lands both.
  if (!row) return { league, ordinals: new Map<string, number>() };

  if (Array.isArray(parsed?.roster)) {
    await splitLeagueRow(db, row, league);
    // Every athlete has just been written at his index, so that is what the
    // stored ordinals are — no re-read needed to find out.
    return { league, ordinals: ordinalsOf(league) };
  }

  // Anyone the roster gained on the way through — a newly seeded signing, or
  // a row that went missing — is written now rather than waiting for somebody
  // else's result to carry him. Settled leagues produce nothing here.
  const missing = reconcileStatements(
    db,
    league.roster,
    stored?.ordinals ?? new Map(),
    Date.now(),
  );
  await writeRows(db, missing);
  return { league, ordinals: ordinalsOf(league) };
}

function ordinalsOf(league: LeagueState) {
  return new Map(league.roster.map((fighter, ordinal) => [fighter.id, ordinal]));
}

/** Moves the original training-owned league into its permanent row once.
 *
 * Older deployments kept every career, learned policy and opponent dossier in
 * `training_jobs.league_json`. The new broadcast cannot start fresh merely
 * because its own table did not exist at the instant it was deployed. The
 * conditional insert makes concurrent cold workers safe, and the legacy row is
 * deliberately left untouched as a recovery copy. */
async function readStoredLeagueRow(db: LeagueDatabase) {
  const current = await readRow(db, LEAGUE_ROW);
  if (current) return current;

  const legacy = await readLegacyLeagueRow(db);
  if (!legacy) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(legacy.league_json);
  } catch {
    throw new Error(
      `legacy league is not JSON (${legacy.league_json.length} bytes) — refusing to start a fresh roster`,
    );
  }
  const league = upgradeLeagueState(parsed);
  if (!league) {
    throw new Error(
      "legacy league could not be read by this build — refusing to start a fresh roster",
    );
  }

  await writeRow(db, LEAGUE_ROW, league, null);
  const imported = await readRow(db, LEAGUE_ROW);
  if (!imported) throw new Error("legacy league import did not land");
  return imported;
}

function readTrainingRestore(value: unknown, league: LeagueState): TrainingRestore | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const statuses = new Set(["running", "working", "paused", "complete", "error"]);
  if (!statuses.has(String(candidate.status))) return null;
  if (
    typeof candidate.targetId !== "string" ||
    !league.roster.some((fighter) => fighter.id === candidate.targetId)
  ) return null;

  const numeric = [
    "cycles",
    "bouts",
    "physicsSteps",
    "candidates",
    "checkpoints",
    "startFitness",
    "currentFitness",
    "rewardGain",
    "createdAt",
    "updatedAt",
  ] as const;
  if (numeric.some((key) => !Number.isFinite(candidate[key]))) return null;
  if (
    candidate.remainingCycles !== null &&
    !Number.isFinite(candidate.remainingCycles)
  ) return null;
  if (candidate.lastError !== null && typeof candidate.lastError !== "string") return null;

  return {
    status: candidate.status as TrainingRestore["status"],
    targetId: candidate.targetId,
    remainingCycles: candidate.remainingCycles as number | null,
    cycles: Number(candidate.cycles),
    bouts: Number(candidate.bouts),
    physicsSteps: Number(candidate.physicsSteps),
    candidates: Number(candidate.candidates),
    checkpoints: Number(candidate.checkpoints),
    startFitness: Number(candidate.startFitness),
    currentFitness: Number(candidate.currentFitness),
    rewardGain: Number(candidate.rewardGain),
    pauseRequested: Boolean(candidate.pauseRequested),
    lastError: candidate.lastError as string | null,
    createdAt: Number(candidate.createdAt),
    updatedAt: Number(candidate.updatedAt),
  };
}

/** Atomically replaces an empty/new hosted state with an explicitly supplied
 * recovery snapshot. This is an admin operation rather than startup behavior:
 * local Miniflare data and hosted D1 are different databases, so moving a
 * developed league between them has to be deliberate. */
async function restoreStoredState(
  db: LeagueDatabase,
  state: BroadcastState,
  league: LeagueState,
  training: TrainingRestore | null,
) {
  const version = Date.now();
  const statements = [
    // A restore replaces the roster outright, so the stored careers go with
    // it. Leaving them would let an athlete who is not on the restored roster
    // survive as a row nobody wrote and the next load would hand him back.
    // The snapshot is written with its careers still inside it and the split
    // rebuilds the table from them on the next read, which is the same path a
    // league arriving from the old blob takes.
    db.prepare("DELETE FROM fighters"),
    db.prepare(`
      INSERT INTO league_state (id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload, updated_at = excluded.updated_at
    `).bind(LEAGUE_ROW, JSON.stringify(league), version),
    db.prepare(`
      INSERT INTO league_state (id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload, updated_at = excluded.updated_at
    `).bind(BROADCAST_ROW, JSON.stringify(state), version),
  ];

  if (training) {
    statements.push(db.prepare(`
      INSERT INTO training_jobs (
        id, status, target_id, league_json, remaining_cycles,
        cycles, bouts, physics_steps, candidates, checkpoints,
        start_fitness, current_fitness, reward_gain, pause_requested,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, target_id = excluded.target_id,
        remaining_cycles = excluded.remaining_cycles, cycles = excluded.cycles,
        bouts = excluded.bouts, physics_steps = excluded.physics_steps,
        candidates = excluded.candidates, checkpoints = excluded.checkpoints,
        start_fitness = excluded.start_fitness,
        current_fitness = excluded.current_fitness,
        reward_gain = excluded.reward_gain,
        pause_requested = excluded.pause_requested,
        last_error = excluded.last_error, created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).bind(
      LEGACY_TRAINING_ROW,
      training.status,
      training.targetId,
      training.remainingCycles,
      training.cycles,
      training.bouts,
      training.physicsSteps,
      training.candidates,
      training.checkpoints,
      training.startFitness,
      training.currentFitness,
      training.rewardGain,
      training.pauseRequested ? 1 : 0,
      training.lastError,
      training.createdAt,
      training.updatedAt,
    ));
  }

  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

async function loadState(db: LeagueDatabase, realNow: number): Promise<LoadedLeague> {
  const [broadcastRow, stored] = await Promise.all([
    readRow(db, BROADCAST_ROW),
    loadStoredLeague(db),
  ]);
  const league = stored.league;
  let state: BroadcastState | null = null;
  if (broadcastRow) {
    // Only unreadable JSON is forgiven here. Starting a brand-new card is the
    // most destructive thing this function can do — it throws away the night
    // every viewer is watching — so it must happen because the stored card is
    // genuinely not a card, never because the code that adopts one threw.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(broadcastRow.payload);
    } catch {
      parsed = null;
    }
    state = upgradeBroadcast(parsed);
  }
  if (!state) state = createBroadcast(league, realNow);
  return {
    state,
    league,
    broadcastVersion: broadcastRow?.updated_at ?? null,
    ordinals: stored.ordinals,
  };
}

/** Publishes a transition, but only if the card it was built on is still the
 *  one on air.
 *
 * The broadcast row is the single gate every state change goes through. A pass
 * that loses the race writes nothing at all, which is what stops a bout being
 * replaced by a second, differently-fought version of itself after viewers have
 * started replaying the first. The league row is written once the gate has
 * opened, because it is the derived half: careers only move by committing
 * results the card already records, so the worker that won the race is also the
 * only one whose careers are the right successor to what it just published. */
async function persist(
  db: LeagueDatabase,
  state: BroadcastState,
  league: LeagueState,
  from: LoadedLeague,
) {
  const gate = await writeRow(db, BROADCAST_ROW, state, from.broadcastVersion);
  if (!gate.landed) return false;
  if (league !== from.league) {
    // Only the careers that actually moved. A committed bout dirties the two
    // men who fought it and a training cycle dirties one, so this writes tens
    // of kilobytes where the single roster blob charged hundreds for the same
    // two results. The header goes with them either way — it is eighty bytes,
    // and working out whether the week turned costs more than writing it.
    const now = Date.now();
    const statements = dirtyFighterStatements(
      db,
      league.roster,
      { roster: from.league.roster, ordinals: from.ordinals },
      now,
    );
    statements.push(headerUpsert(db, league, now));
    await writeRows(db, statements);
  }
  return true;
}

/** Claims the right to fight the next bout, or null if another worker holds it.
 *
 * Simulating is the one part of a tick that cannot be re-derived: it calls out
 * to the language coach, whose answers differ every time it is asked. Two
 * workers running it at once is how the same scheduled bout ended up with two
 * different winners, so exactly one at a time is allowed to. */
export async function takeSimulationLease(db: LeagueDatabase, realNow: number) {
  const row = await readRow(db, SIMULATION_LEASE_ROW);
  if (row) {
    let until = 0;
    try {
      until = Number((JSON.parse(row.payload) as { until?: number }).until ?? 0);
    } catch {
      until = 0;
    }
    if (until > realNow) return null;
  }
  const taken = await writeRow(
    db,
    SIMULATION_LEASE_ROW,
    { until: realNow + SIMULATION_LEASE_MS },
    row?.updated_at ?? null,
  );
  return taken.landed ? { version: taken.version } : null;
}

/** Conditional on purpose: a lease that has already expired and been taken by
 *  somebody else must not be cleared out from under them. */
export async function releaseSimulationLease(
  db: LeagueDatabase,
  lease: { version: number },
) {
  await writeRow(db, SIMULATION_LEASE_ROW, { until: 0 }, lease.version);
}

/** What this isolate last knew, so a stampede of viewers is not a stampede of
 *  database reads. Tagged with the binding it came from: a deployment only ever
 *  has one, but a cache that cannot say which league it holds is the kind of
 *  thing that quietly serves the wrong card. */
let cached: {
  db: LeagueDatabase;
  state: BroadcastState;
  league: LeagueState;
  at: number;
} | null = null;

function remember(
  db: LeagueDatabase,
  state: BroadcastState,
  league: LeagueState,
  at: number,
) {
  cached = { db, state, league, at };
}

/** The card as this worker best knows it: the isolate's own copy while it is
 *  fresh enough, and the database otherwise. */
async function currentState(db: LeagueDatabase, realNow: number) {
  if (cached && cached.db === db && realNow - cached.at < STATE_CACHE_MS) return cached;
  const loaded = await loadState(db, realNow);
  remember(db, loaded.state, loaded.league, realNow);
  return loaded;
}

/** The decoded chunk the in-play line last priced off, kept while the live
 *  fight stays inside it — one D1 read per five seconds of fight, not per
 *  pass. */
let liveFairChunk: { boutId: number; index: number; timeline: FightTimeline } | null = null;

/** What the maker should think of the fight on air, priced strictly off the
 *  frame the viewer is watching — the playhead runs `PLAYBACK_DELAY_MS`
 *  behind the league clock, and the quotes have to run behind with it.
 *  Pricing the newest fetchable frame instead put the finish in the odds
 *  before it was in the picture: the line slamming toward the winner while
 *  the knockdown has not aired is as loud an announcement as printing the
 *  verdict. The cost is worn knowingly — someone decoding chunks at the
 *  fetchable edge is a few seconds better informed than the standing quotes —
 *  and it is bounded by the resting depth, which the spoiler was not.
 *  Null between fights, in the aftermath, before the first chunk is stored,
 *  or when either man has left the roster. Never the result: the in-play book
 *  must not know how the fight ends any earlier than the crowd does. */
async function liveMarketFair(
  db: LeagueDatabase,
  state: BroadcastState,
  league: LeagueState,
  realNow: number,
): Promise<LiveFair | null> {
  const now = leagueNow(state.clock, realNow);
  const bout = currentBout(state, now);
  if (!bout || !bout.result || now >= bout.endsAt) return null;
  const prior = openingLineFor(league.roster, bout.blueId, bout.redId);
  if (prior === null) return null;

  const aired = tickForTime(bout, now - PLAYBACK_DELAY_MS);
  const index = Math.floor(aired / TIMELINE_CHUNK_TICKS);
  if (!liveFairChunk || liveFairChunk.boutId !== bout.id || liveFairChunk.index !== index) {
    const row = await readTimelineChunk(db, bout.id, index);
    if (!row) return null;
    liveFairChunk = {
      boutId: bout.id,
      index,
      timeline: decodeTimeline(await gunzipToText(row.payload)),
    };
  }
  return {
    boutId: bout.id,
    blueLine: inPlayLine(
      prior,
      frameAt(liveFairChunk.timeline, aired),
      cardsUpTo(liveFairChunk.timeline, aired),
    ),
  };
}

/** Runs the card forward and saves it. Safe to call from anywhere, and safe to
 *  call from everywhere at once — which is the point. */
export async function processLeagueTick(env: LeagueEnv, realNow = Date.now()) {
  if (!env.DB) return null;
  const db = env.DB;
  await ensureSchema(db);
  if (await migrationFrozen(db)) return null;
  // The cheap half of a tick — committing finished results and filling out the
  // card — is deterministic, so every worker runs it and the compare-and-swap
  // decides who publishes. The expensive half is gated behind the lease.
  const lease = await takeSimulationLease(db, realNow);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await loadState(db, realNow);
      let state = loaded.state;
      let league = loaded.league;
      let changed = false;
      const versions = [state];
      // One delayed pass used to make only two overdue fights, publish them,
      // and leave the visitor looking at yesterday's card. Keep stepping the
      // same compare-and-swap candidate until the league reaches wall time, so
      // an idle host catches up atomically instead of exposing every missed
      // minute on successive polls.
      for (let pass = 0; pass < MAX_TICK_PASSES; pass += 1) {
        const advanced = await advanceBroadcast(state, league, {
          realNow,
          coach: lease ? buildCoach(env) : undefined,
          maxSimulate: lease ? undefined : 0,
        });
        if (!advanced.changed) break;
        state = advanced.state;
        league = advanced.league;
        versions.push(state);
        changed = true;
      }
      const advanced = { state, league, changed };
      if (!advanced.changed || await persist(db, advanced.state, advanced.league, loaded)) {
        remember(db, advanced.state, advanced.league, realNow);
        // File whatever has aired before anything else. Both versions of the
        // card go in: a bout can be committed and stripped of its athlete
        // snapshots inside one pass, and the copy that still has them is the
        // one on the card this pass started from.
        await archiveAiredBouts(
          db,
          versions,
          leagueNow(advanced.state.clock, realNow),
          realNow,
        ).catch(() => 0);
        // Record simulated bouts as servable chunks. Behind the lease because
        // recording steps the whole fight again — the same bill the simulation
        // itself pays, and one worker's bill is enough. Serving stays gated on
        // the clock, so writing minutes early leaks nothing.
        if (lease) {
          const recorded = await storeTimelines(db, versions)
            .catch(() => 0);
          // A pass with nothing new to record spends the same budget closing a
          // gap instead: a fight that aired without its recording landing is
          // still watchable off the archive's own copy, and this is the only
          // thing that ever goes looking for one.
          if (recorded === 0) await backfillTimelines(db).catch(() => 0);
        }
        // Books for tonight's fights, behind the same lease that gates the
        // expensive half. It reads the chain and sends only what is missing, so
        // a pass that loses the race or dies halfway costs nothing but a tick —
        // and a chain that is down cannot stop the card, because `syncMarkets`
        // swallows its own failures. The in-play read rides along so the
        // maker's quotes follow the fight that is airing.
        if (lease) {
          const liveFair = await liveMarketFair(db, advanced.state, advanced.league, realNow)
            .catch(() => null);
          await syncMarkets(env, advanced.state, advanced.league, realNow, liveFair);
          // Then file whatever the book emitted since the last pass, which is
          // where every chart and tape reads its trades from. After the quotes
          // so a backfill never holds up the maker, and it swallows its own
          // failures for the same reason the sync does.
          await indexMarketEvents(env, realNow).catch(() => 0);
        }
        // The ringside voice for tonight's recorded fights, a batch of lines a
        // pass, after the book so a slow speech model never holds up a quote.
        // Behind the lease for the same reason recording is: one worker's bill
        // — and behind the flag so that, switched off, it is no bill at all.
        if (lease && ANNOUNCER_VOICE) {
          await renderPendingVoice(
            db,
            env,
            advanced.state,
            leagueNow(advanced.state.clock, realNow),
            realNow,
          ).catch(() => 0);
        }
        return advanced;
      }
      // Somebody published first. Theirs is the night that is on air, so this
      // pass is dropped and rebuilt on top of what they wrote instead.
    }
    return null;
  } finally {
    if (lease) await releaseSimulationLease(db, lease).catch(() => {});
  }
}

/** One tick per isolate at a time, so a busy worker does not stampede itself. */
let tickInFlight: Promise<unknown> | null = null;
let lastTickAt = 0;

/** How long this isolate waits on a pass before it stops holding the door.
 *
 * A tick that never settles used to stop the league dead: every later poll was
 * handed the same in-flight promise, so no worker on this isolate ever ran the
 * card forward again and the card sat on "between fights" until the deployment
 * was replaced. Giving up on the pass is safe — its writes still have to clear
 * the compare-and-swap, so a straggler cannot land on a card that has moved on.
 * Deliberately longer than the simulation lease, so the pass has already lost
 * its claim on the next bout by the time anything else picks the card up. */
const TICK_WATCHDOG_MS = 90_000;

/** Runs the card forward behind a request, at most once a second per worker.
 *
 * A poll is a read; the tick is only there so the league keeps fighting for as
 * long as anybody is watching. Kicking one off for every viewer would turn a
 * large audience into its own load problem, and the scheduled heartbeat moves
 * the card when nobody is. */
function sharedTick(env: LeagueEnv, realNow: number) {
  if (tickInFlight) return tickInFlight;
  if (realNow - lastTickAt < STATE_CACHE_MS) return Promise.resolve(null);
  lastTickAt = realNow;
  const pass = processLeagueTick(env, realNow).catch(() => null);
  // The watchdog is cleared once the race settles: a finished pass must not
  // leave a live timer pinning the event loop for the full watchdog span.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  tickInFlight = Promise.race([
    pass,
    new Promise((resolve) => {
      watchdog = setTimeout(resolve, TICK_WATCHDOG_MS, null);
    }),
  ]).finally(() => {
    clearTimeout(watchdog);
    tickInFlight = null;
  });
  return tickInFlight;
}

/** Whether serving the cached card would visibly put the league behind its own
 *  clock. Ordinary polls stay cheap; only a missing card, an imminent unsimmed
 *  bout, an uncommitted final bell, or a completed night holds the response for
 *  the protected catch-up pass. */
function needsCurrentTick(state: BroadcastState, realNow: number) {
  const now = leagueNow(state.clock, realNow);
  if (state.card.length < CARD_BOUTS) return true;
  if (state.card.some((bout) => !bout.result && bout.startsAt <= now + SIMULATE_LEAD_MS)) {
    return true;
  }
  if (state.card.some((bout) => bout.result && !bout.committed && bout.endsAt <= now)) {
    return true;
  }
  return state.card.every((bout) => bout.committed && airtimeEnd(bout) <= now);
}

/** The roster as it actually stands, for the training worker to improve.
 *
 * Training reads the broadcast's own league rather than a copy of it. A private
 * copy was the whole reason a trained brain never made it into the ring: the
 * lab improved one league while the card kept fighting another. */
export async function readLeagueForTraining(env: LeagueEnv) {
  if (!env.DB) return null;
  await ensureSchema(env.DB);
  // Same rule as the card's own read: training against a league that turned out
  // to be a fresh one would hand `writeTrainedFighter` a blank roster to lay
  // over the real careers.
  return (await loadStoredLeague(env.DB)).league;
}

/** The two men currently on air are at work, not in the gym. Read from the
 * same broadcast clock every viewer uses so a paused or fast-forwarded card
 * produces the same answer here as it does on the ring page. */
export async function readTrainingExclusions(
  env: LeagueEnv,
  realNow = Date.now(),
) {
  if (!env.DB) return new Set<string>();
  await ensureSchema(env.DB);
  const row = await readRow(env.DB, BROADCAST_ROW);
  if (!row) return new Set<string>();
  let state: BroadcastState | null = null;
  try {
    state = upgradeBroadcast(JSON.parse(row.payload));
  } catch {
    state = null;
  }
  if (!state) return new Set<string>();
  const live = currentBout(state, leagueNow(state.clock, realNow));
  return new Set(live ? [live.blueId, live.redId] : []);
}

const TRAINING_POLICY_MATRICES = [
  "weights",
  "hiddenWeights",
  "recurrentHiddenWeights",
  "memoryInputWeights",
  "memoryWeights",
  "intentWeights",
  "intentMemoryWeights",
  "outputWeights",
  "outputMemoryWeights",
  "intentActionWeights",
] as const;

const TRAINING_POLICY_VECTORS = [
  "bias",
  "hiddenBias",
  "memoryBias",
  "intentBias",
] as const;

/** Applies only what sparring changed onto the fighter D1 holds now.
 *
 * An official bout can finish during a training calculation. Replacing the
 * whole athlete with the calculation's older snapshot would put his record,
 * dossier, XP, and fight-earned policy step back in time. Parameter deltas let
 * both pieces of learning land, while every career field starts from the newest
 * fighter rather than the stale training input. */
export function mergeTrainedFighter(
  latest: Fighter,
  baseline: Fighter,
  trained: Fighter,
): Fighter {
  const policy = { ...latest.policy };
  for (const key of TRAINING_POLICY_MATRICES) {
    policy[key] = latest.policy[key].map((row, rowIndex) =>
      row.map((value, columnIndex) =>
        value +
        ((trained.policy[key][rowIndex]?.[columnIndex] ?? value) -
          (baseline.policy[key][rowIndex]?.[columnIndex] ?? value)),
      ),
    );
  }
  for (const key of TRAINING_POLICY_VECTORS) {
    policy[key] = latest.policy[key].map((value, index) =>
      value +
      ((trained.policy[key][index] ?? value) -
        (baseline.policy[key][index] ?? value)),
    );
  }
  policy.generation += trained.policy.generation - baseline.policy.generation;
  policy.evaluatedBouts +=
    trained.policy.evaluatedBouts - baseline.policy.evaluatedBouts;
  policy.learnedDecisions +=
    trained.policy.learnedDecisions - baseline.policy.learnedDecisions;
  policy.fitness = trained.policy.fitness;

  const carried = (latestValue: number, before: number, after: number) =>
    Math.round((latestValue + after - before) * 100) / 100;

  return {
    ...latest,
    rating: carried(latest.rating, baseline.rating, trained.rating),
    confidence: carried(
      latest.confidence,
      baseline.confidence,
      trained.confidence,
    ),
    trainingBouts:
      latest.trainingBouts + trained.trainingBouts - baseline.trainingBouts,
    lastTrainingGain: trained.lastTrainingGain,
    policy,
    conditioning: {
      lowerBodyPower: carried(
        latest.conditioning.lowerBodyPower,
        baseline.conditioning.lowerBodyPower,
        trained.conditioning.lowerBodyPower,
      ),
      lowerBodyEndurance: carried(
        latest.conditioning.lowerBodyEndurance,
        baseline.conditioning.lowerBodyEndurance,
        trained.conditioning.lowerBodyEndurance,
      ),
      kineticChain: carried(
        latest.conditioning.kineticChain,
        baseline.conditioning.kineticChain,
        trained.conditioning.kineticChain,
      ),
      shoulderEndurance: carried(
        latest.conditioning.shoulderEndurance,
        baseline.conditioning.shoulderEndurance,
        trained.conditioning.shoulderEndurance,
      ),
      workloadSteps:
        latest.conditioning.workloadSteps +
        trained.conditioning.workloadSteps -
        baseline.conditioning.workloadSteps,
      adaptationCycles:
        latest.conditioning.adaptationCycles +
        trained.conditioning.adaptationCycles -
        baseline.conditioning.adaptationCycles,
    },
  };
}

/** Writes one trained athlete back into the broadcast roster.
 *
 * Only the athlete that was trained is replaced. A cycle takes long enough that
 * fights are committed underneath it, and writing a whole stale league back
 * would roll their results — and the learning those bouts produced — away
 * again. Airing bouts carry their own athlete snapshots, so a brain that
 * changes mid-card cannot alter a fight already on screen. */
export async function writeTrainedFighter(
  env: LeagueEnv,
  trained: Fighter,
  baseline?: Fighter,
) {
  if (!env.DB) return;
  const db = env.DB;
  await ensureSchema(db);
  // Through the same gate as the card. A cycle takes long enough that fights
  // commit underneath it, and landing this write blind would roll those results
  // — and the learning they produced — straight back off the roster.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const realNow = Date.now();
    const loaded = await loadState(db, realNow);
    if (!loaded.league.roster.some((fighter) => fighter.id === trained.id)) return;
    const latest = loaded.league.roster.find(
      (fighter) => fighter.id === trained.id,
    )!;
    const successor = baseline
      ? mergeTrainedFighter(latest, baseline, trained)
      : trained;
    const landed = await persist(
      db,
      {
        ...loaded.state,
        rosterVersion: loaded.state.rosterVersion + 1,
        updatedAt: realNow,
      },
      {
        ...loaded.league,
        roster: loaded.league.roster.map((fighter) =>
          fighter.id === trained.id ? successor : fighter,
        ),
      },
      loaded,
    );
    if (landed) {
      cached = null;
      return;
    }
  }
}

/** Drops the athlete snapshots the caller already holds.
 *
 * They are ~15 KB each and never change once a bout is scheduled, so a browser
 * that is already watching should not re-download them every poll. */
function trimProfiles(bout: ScheduledBout | null, held: Set<string>) {
  if (!bout) return null;
  if (!held.has(String(bout.id))) return bout;
  return { ...bout, profiles: undefined };
}

/** The fight on deck, with its ending taken back out.
 *
 * A bout is simulated up to `SIMULATE_LEAD_MS` before its slot — the whole
 * thing at once, not a tick at a time — so by the time it is the one on deck it
 * already exists in full: who wins, in which round, and every step of it. The
 * browser needs none of that yet. It wants a countdown and the two athlete
 * snapshots to preload, and it can have exactly those.
 *
 * Sending the rest put the winner of a fight nobody had watched into a response
 * anyone could read, minutes before the bell, while that fight's book was still
 * open. Nothing here is scripted — the policies decide it and no one else does
 * — but the simulation runs ahead of the broadcast, and a market cannot price a
 * fight whose answer is already downloadable. */
function previewBout(bout: ScheduledBout | null): ScheduledBout | null {
  if (!bout) return null;
  return {
    ...bout,
    // The seed on its own reproduces the fight: the policies are deterministic.
    // Withholding the result and keeping this would be a lock with the key
    // left in it.
    seed: 0,
    result: null,
    directives: [],
    // The walk-in preload gets the athletes as the public knows them — the
    // learned matrices never leave the server.
    profiles: publicPair(bout.profiles),
    // A real `endsAt` is the exact final bell, so the duration would say which
    // round it goes out in. Back to the placeholder every unfought slot uses.
    endsAt: bout.startsAt + estimatedDuration(bout.kind),
  };
}

/** Display-safe athlete snapshots: careers and tendencies, no learned matrices. */
function publicPair(profiles?: [Fighter, Fighter]): [Fighter, Fighter] | undefined {
  return profiles ? [publicFighter(profiles[0]), publicFighter(profiles[1])] : undefined;
}

/** The fight on air, stripped to what a viewer needs: billing, timing and the
 *  two athletes as the public knows them. The fight itself arrives as aired
 *  chunks from `/api/timeline`, so nothing here may reproduce it — no seed, no
 *  corner directives, no learned matrices — and the verdict and the exact
 *  final bell wait until they have actually happened on air. `result` early is
 *  an announcement; exact `endsAt` early is the duration, which says which
 *  round it ends in. `holdReveal` keeps the mask up past the bell for a bout
 *  whose book is not yet confirmed shut — see the guard in the GET handler. */
function liveBout(
  bout: ScheduledBout | null,
  now: number,
  holdReveal: number | null = null,
): ScheduledBout | null {
  if (!bout) return null;
  const shared = {
    ...bout,
    seed: 0,
    directives: [],
    profiles: publicPair(bout.profiles),
  };
  if (bout.endsAt <= now && bout.id !== holdReveal) return shared;
  return {
    ...shared,
    result: null,
    endsAt: bout.startsAt + estimatedDuration(bout.kind),
  };
}

/** A bout as the card shows it: billing, timing and verdict, no athlete
 *  snapshots and no per-tick directives. */
function publicBout(bout: ScheduledBout, now: number, holdReveal: number | null = null) {
  // Same reasoning as `liveBout`: a fought-ahead slot's exact final bell is a
  // spoiler until that bell has actually gone on air — and a bell that has
  // gone stays masked while the bout's book is not yet confirmed shut.
  const revealed = bout.endsAt <= now && bout.id !== holdReveal;
  return {
    id: bout.id,
    division: bout.division,
    kind: bout.kind,
    blueId: bout.blueId,
    redId: bout.redId,
    startsAt: bout.startsAt,
    endsAt: revealed ? bout.endsAt : bout.startsAt + estimatedDuration(bout.kind),
    totalRounds: bout.totalRounds,
    // A booked slot has no result yet, and a fought one only counts as final
    // for the card once the bell has actually gone.
    result: bout.result && revealed ? bout.result : null,
    status:
      revealed
        ? "final"
        : bout.startsAt <= now
          ? "live"
          : "scheduled",
  };
}

function broadcastPayload(
  state: BroadcastState,
  league: LeagueState,
  realNow: number,
  held: Set<string>,
  holdReveal: number | null = null,
) {
  const now = leagueNow(state.clock, realNow);
  return {
    ok: true,
    // The browser's own clock may be off; every replay is timed against this.
    serverTime: realNow,
    leagueTime: now,
    clock: state.clock,
    season: state.season,
    week: state.week,
    night: state.night,
    weekStartedAt: state.weekStartedAt,
    rosterVersion: state.rosterVersion,
    boutsCompleted: league.boutsCompleted,
    divisions: state.divisions,
    live: liveBout(trimProfiles(currentBout(state, now), held), now, holdReveal),
    upcoming: previewBout(trimProfiles(nextBout(state, now), held)),
    // The whole night in one list — what has been fought, what is on now, and
    // what is still to come with the slot it is booked into.
    card: state.card.map((bout) => publicBout(bout, now, holdReveal)),
  };
}

type AdminCommand =
  | { action: "verify" }
  | {
      action: "restore";
      confirm: "replace-hosted-state";
      league: unknown;
      broadcast: unknown;
      training?: unknown;
    }
  | { action: "start"; blueId: string; redId: string; kind?: "contender" | "title" }
  | { action: "skip" }
  | { action: "doors" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "rate"; rate: number }
  | { action: "title"; division: WeightClassId }
  | { action: "week" }
  | { action: "archive-reset"; confirm: "wipe-past-fights" }
  | { action: "reset" };

export async function handleLeagueRequest(
  request: Request,
  env: LeagueEnv,
  ctx: LeagueExecutionContext,
) {
  if (!env.DB) {
    return jsonResponse(
      { ok: false, error: "The league database is not bound." },
      503,
    );
  }
  const db = env.DB;
  await ensureSchema(db);
  const url = new URL(request.url);
  const realNow = Date.now();

  if (request.method === "GET") {
    // The full roster is ~450 KB, so it lives behind its own URL and the client
    // only refetches it when `rosterVersion` moves.
    if (url.pathname.endsWith("/roster")) {
      const { state, league } = await currentState(db, realNow);
      return jsonResponse({
        ok: true,
        rosterVersion: state.rosterVersion,
        roster: league.roster.map(publicFighter),
      });
    }

    // Most reads serve the cached card and move the league behind the response.
    // If the host missed its timer, though, serving first would expose the old
    // night and only repair it for the second poll. The first viewer instead
    // waits on the same shared, leased pass every other viewer reuses, then gets
    // the card that belongs to the current six-hour slot.
    let current = await currentState(db, realNow);
    if (needsCurrentTick(current.state, realNow)) {
      await sharedTick(env, realNow);
      current = await currentState(db, Date.now());
    } else {
      ctx.waitUntil(sharedTick(env, realNow));
    }
    const { state, league } = current;
    // The aftermath is when this payload starts naming the winner, and the
    // book has to be shut before any response does — the tick that closes it
    // runs *behind* reads, so a read landing in a lull the ticks missed would
    // otherwise announce a result the chain is still taking bets on. One
    // confirmation per isolate per fight; every later pass through here is a
    // set lookup. A book that cannot be CONFIRMED shut holds the reveal
    // instead: the row keeps its mask and the card keeps airing, because a
    // result served over an open book is an invitation to dump shares into
    // it. The bout asked about is the one airing through its aftermath — or,
    // if the stage has already moved on, the last fight with a result, whose
    // book could still be catching up after an outage.
    let holdReveal: number | null = null;
    {
      const now = leagueNow(state.clock, realNow);
      const airing = currentBout(state, now);
      const naming = airing?.result && airing.endsAt <= now
        ? airing
        : recentResults(state, now).find((bout) => bout.result) ?? null;
      if (naming && !await ensureBoutClosed(env, state, naming.id)) {
        holdReveal = naming.id;
      }
    }
    const held = new Set(
      (url.searchParams.get("have") ?? "").split(",").filter(Boolean),
    );
    return jsonResponse({
      ...broadcastPayload(state, league, realNow, held, holdReveal),
      adminConfigured: Boolean(env.FORGE_ADMIN_TOKEN),
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  if (!await adminAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Not authorised." }, 401);
  }

  let command: AdminCommand;
  try {
    command = await request.json() as AdminCommand;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid command." }, 400);
  }

  if (command.action === "verify") {
    return jsonResponse({ ok: true, admin: true });
  }

  if (command.action === "archive-reset") {
    if (command.confirm !== "wipe-past-fights") {
      return jsonResponse({ ok: false, error: "Archive reset confirmation is missing." }, 400);
    }
    const reset = await clearArchivedFights(db);
    return jsonResponse({
      ok: true,
      admin: true,
      archiveReset: true,
      ...reset,
    });
  }

  if (command.action === "restore") {
    if (command.confirm !== "replace-hosted-state") {
      return jsonResponse({ ok: false, error: "Restore confirmation is missing." }, 400);
    }
    const league = upgradeLeagueState(command.league);
    const state = upgradeBroadcast(command.broadcast);
    if (!league || !state) {
      return jsonResponse({ ok: false, error: "The recovery snapshot is invalid." }, 400);
    }
    const training = command.training === undefined
      ? null
      : readTrainingRestore(command.training, league);
    if (command.training !== undefined && !training) {
      return jsonResponse({ ok: false, error: "The training snapshot is invalid." }, 400);
    }

    await restoreStoredState(db, state, league, training);
    cached = null;
    return jsonResponse({
      ok: true,
      admin: true,
      restored: true,
      roster: league.roster.length,
      boutsCompleted: league.boutsCompleted,
      training: Boolean(training),
    });
  }

  if (command.action === "reset") {
    // Hold the simulation door shut while the replacement card is published
    // and booked on chain. Other ticks may still do the deterministic half,
    // but none can fight the first bout before its market exists.
    const resetLease = await forceRow(
      db,
      SIMULATION_LEASE_ROW,
      { until: realNow + TICK_WATCHDOG_MS },
    );
    try {
      let replaced: LoadedLeague | null = null;
      let prepared: { state: BroadcastState; league: LeagueState } | null = null;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const loaded = await loadState(db, realNow);
        const empty = resetCardNow(loaded.state, realNow);
        const planned = await advanceBroadcast(empty, loaded.league, {
          realNow,
          maxSimulate: 0,
          firstBell: leagueNow(empty.clock, realNow) + RESET_CARD_DELAY_MS,
        });
        if (await persist(db, planned.state, planned.league, loaded)) {
          replaced = loaded;
          prepared = { state: planned.state, league: planned.league };
          break;
        }
      }

      if (!replaced || !prepared) {
        return jsonResponse(
          { ok: false, error: "The card kept moving while it was being reset. Try again." },
          409,
        );
      }

      cached = null;
      // Close out the discarded night first, then create the replacement
      // markets. Both operations are best-effort by design: an unavailable
      // chain must not leave the broadcast stopped.
      const abandoned = await settleAbandonedMarkets(env, replaced.state, realNow);
      const market = await syncMarkets(env, prepared.state, prepared.league, realNow);

      await releaseSimulationLease(db, { version: resetLease });
      const started = await processLeagueTick(env, realNow);
      const final = started ?? prepared;
      return jsonResponse({
        ...broadcastPayload(final.state, final.league, realNow, new Set()),
        admin: true,
        reset: true,
        market: { abandoned, created: market },
      });
    } finally {
      await releaseSimulationLease(db, { version: resetLease }).catch(() => {});
    }
  }

  const loaded = await loadState(db, realNow);
  const { state, league } = loaded;
  let next: BroadcastState = state;

  switch (command.action) {
    case "pause":
      next = { ...state, clock: reanchorClock(state.clock, realNow, 0) };
      break;
    case "resume":
      next = { ...state, clock: reanchorClock(state.clock, realNow, 1) };
      break;
    case "rate": {
      const rate = Math.max(0, Math.min(8, Number(command.rate) || 1));
      next = { ...state, clock: reanchorClock(state.clock, realNow, rate) };
      break;
    }
    case "skip": {
      // Ring the final bell early. The result the bout already produced still
      // stands, so the ladder and the careers stay honest.
      const now = leagueNow(state.clock, realNow);
      next = {
        ...state,
        card: state.card.map((bout) =>
          bout.startsAt <= now && bout.endsAt > now
            ? { ...bout, endsAt: now }
            : bout,
        ),
      };
      break;
    }
    case "doors": {
      // Don't wait out the gap between cards — ring the opening bell now and
      // let the rest of the night keep its running order behind it.
      next = openDoorsNow(state, realNow);
      if (next === state) {
        return jsonResponse(
          { ok: false, error: "The card is already under way." },
          400,
        );
      }
      break;
    }
    case "start": {
      next = await stageBoutNow(
        state,
        league,
        {
          blueId: command.blueId,
          redId: command.redId,
          kind: command.kind ?? "contender",
          realNow,
        },
        buildCoach(env),
      );
      if (next === state) {
        return jsonResponse(
          { ok: false, error: "Pick two different athletes on the roster." },
          400,
        );
      }
      break;
    }
    case "title": {
      // Make the belt due immediately in one division by clearing its flag and
      // winding the week back far enough that the title match is what the
      // matchmaker reaches for next.
      next = {
        ...state,
        weekStartedAt: leagueNow(state.clock, realNow) - (24 * 60 * 60 * 1000) - 1,
        divisions: state.divisions.map((division) =>
          division.id === command.division
            ? { ...division, titleFightThisWeek: false }
            : division,
        ),
      };
      break;
    }
    case "week": {
      next = {
        ...state,
        weekStartedAt: leagueNow(state.clock, realNow) - (24 * 60 * 60 * 1000) - 1,
        divisions: state.divisions.map((division) => ({
          ...division,
          titleFightThisWeek: false,
        })),
      };
      break;
    }
    default:
      return jsonResponse({ ok: false, error: "Unknown command." }, 400);
  }

  if (!await persist(db, next, league, loaded)) {
    return jsonResponse(
      {
        ok: false,
        error: "The card moved while the command was being applied. Try again.",
      },
      409,
    );
  }
  cached = null;
  const advanced = await processLeagueTick(env, realNow);
  const final = advanced ?? { state: next, league };
  return jsonResponse({
    ...broadcastPayload(final.state, final.league, realNow, new Set()),
    admin: true,
  });
}

/** One chunk of one fight, and only if it has aired.
 *
 * Chunks are written to the store minutes before their fight's slot, so this
 * gate is the whole anti-spoiler story: a chunk is served once its final tick
 * is behind the league clock, and until then the response is the same 404 a
 * nonexistent chunk gets — a poller cannot tell "not yet" from "never", which
 * is also how a client learns a fight is over (the chunk after the final one
 * never arrives, and the final one says so itself). Off the card, a fight is
 * served only if the archive lists it, because the archive only lists fights
 * the public actually watched — a torn-down card must not expose recordings
 * of bouts nobody saw.
 *
 * Nothing here reads `caches.default`, and nothing here may. An aired chunk is
 * immutable and its response says so, which is the caching this route gets:
 * reaching for the worker's own cache instead took the whole route down, since
 * the hosting plane refuses a worker that touches it and every chunk — every
 * rewatch, and every live bout past its opening — came back a 500. */
export async function handleTimelineRequest(request: Request, env: LeagueEnv) {
  if (!env.DB) {
    return jsonResponse(
      { ok: false, error: "The league database is not bound." },
      503,
    );
  }
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }
  const db = env.DB;
  await ensureSchema(db);
  const url = new URL(request.url);
  // Number(null) is 0, which would read as a perfectly valid chunk index — a
  // missing parameter has to be caught before the numbers are.
  const boutParam = url.searchParams.get("bout");
  const chunkParam = url.searchParams.get("chunk");
  const boutId = Number(boutParam);
  const chunk = Number(chunkParam);
  if (
    !boutParam || !chunkParam ||
    !Number.isFinite(boutId) || boutId <= 0 ||
    !Number.isInteger(chunk) || chunk < 0
  ) {
    return jsonResponse({ ok: false, error: "A bout and a chunk index are required." }, 400);
  }

  const realNow = Date.now();
  const { state } = await currentState(db, realNow);
  const onCard = state.card.find((bout) => bout.id === boutId);
  if (!onCard && !(await airedBeforeThisCard(db, boutId))) {
    return jsonResponse({ ok: false, error: "That chunk has not aired." }, 404);
  }

  const row = await readTimelineChunk(db, boutId, chunk);
  const aired = onCard
    ? tickForTime(onCard, leagueNow(state.clock, realNow))
    : Number.MAX_SAFE_INTEGER;
  if (!row || row.end_tick > aired) {
    return jsonResponse({ ok: false, error: "That chunk has not aired." }, 404);
  }
  // The final chunk carries the verdict, and serving it is the announcement.
  // The book must be confirmed shut before that response leaves — see
  // `ensureBoutClosed` for why the tick-driven close alone is not enough. A
  // book that cannot be confirmed shut keeps this chunk unaired: the player
  // already retries a 404 on its own cadence, so the finish draws the moment
  // the close lands instead of over a book still taking orders.
  if (row.is_final && onCard && !await ensureBoutClosed(env, state, boutId)) {
    return jsonResponse({ ok: false, error: "That chunk has not aired." }, 404);
  }
  return new Response(await gunzipToText(row.payload), {
    headers: {
      "Content-Type": "application/json",
      // An aired chunk never changes: a URL either 404s or serves this forever.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/** One spoken line of the ringside call, under the chunk route's own gate.
 *
 * The line's tick has to have aired on the league clock, and a line from the
 * final chunk waits on the book exactly as that chunk does — the finish call
 * names the winner, and hearing it is the same announcement as reading it. A
 * clip that has not been rendered yet answers 404 too, uncached: the player
 * asks once more a moment later and otherwise lets the caption carry the line. */
export async function handleVoiceRequest(request: Request, env: LeagueEnv) {
  if (!env.DB) {
    return jsonResponse(
      { ok: false, error: "The league database is not bound." },
      503,
    );
  }
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }
  const db = env.DB;
  await ensureSchema(db);
  const url = new URL(request.url);
  const boutParam = url.searchParams.get("bout");
  const lineParam = url.searchParams.get("line");
  const boutId = Number(boutParam);
  const line = Number(lineParam);
  if (
    !boutParam || !lineParam ||
    !Number.isFinite(boutId) || boutId <= 0 ||
    !Number.isInteger(line) || line < 0
  ) {
    return jsonResponse({ ok: false, error: "A bout and a line index are required." }, 400);
  }

  const realNow = Date.now();
  const { state } = await currentState(db, realNow);
  const onCard = state.card.find((bout) => bout.id === boutId);
  if (!onCard && !(await airedBeforeThisCard(db, boutId))) {
    return jsonResponse({ ok: false, error: "That line has not aired." }, 404);
  }

  const row = await readVoiceClip(db, boutId, line);
  const aired = onCard
    ? tickForTime(onCard, leagueNow(state.clock, realNow))
    : Number.MAX_SAFE_INTEGER;
  if (!row || row.tick > aired) {
    return jsonResponse({ ok: false, error: "That line has not aired." }, 404);
  }
  if (row.is_final && onCard && !await ensureBoutClosed(env, state, boutId)) {
    return jsonResponse({ ok: false, error: "That line has not aired." }, 404);
  }
  if (!row.audio) {
    return jsonResponse({ ok: false, error: "That line has no voice yet." }, 404);
  }
  return new Response(blobBytes(row.audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export { publicFighter, publicLeague } from "./public-fighter.ts";
