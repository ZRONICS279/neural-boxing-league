import { type LeagueState, trainAthlete } from "../app/simulation.ts";
import { TRAINING_CYCLE_INTERVAL_MS } from "../app/training-config.ts";
import {
  type LeagueDatabase,
  type LeagueEnv,
  publicLeague,
  readLeagueForTraining,
  readTrainingExclusions,
  releaseSimulationLease,
  takeSimulationLease,
  writeTrainedFighter,
} from "./league.ts";
import { adminAuthorized } from "./admin.ts";
import { migrationFrozen } from "./migration.ts";

/** The persistent sparring worker.
 *
 * It trains the athletes who are actually on the card. This table holds only
 * the telemetry of the run — which athlete, how many cycles, how it is going —
 * and never a league of its own: every cycle reads the live roster, improves
 * one man in it, and writes that one man back. */

const TRAINING_JOB_ID = "forge-league";
/** Thirty-six athletes at one cycle every four minutes gives each man ten
 * training gates a day. The cron still wakes every minute so a failed or stale
 * claim is noticed quickly, but most wakes are deliberately no-ops. */
const STALE_TRAINING_CLAIM_MS = 5 * 60 * 1000;

export type PersistentTrainingStatus =
  | "running"
  | "working"
  | "paused"
  | "complete"
  | "error";

export interface PersistentTrainingJob {
  id: string;
  status: PersistentTrainingStatus;
  targetId: string;
  league: LeagueState;
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

interface TrainingRow {
  id: string;
  status: PersistentTrainingStatus;
  target_id: string;
  remaining_cycles: number | null;
  cycles: number;
  bouts: number;
  physics_steps: number;
  candidates: number;
  checkpoints: number;
  start_fitness: number;
  current_fitness: number;
  reward_gain: number;
  pause_requested: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface TrainingExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface StartTrainingPayload {
  action: "start";
  targetId: string;
  budget: number | "continuous";
}

interface PauseTrainingPayload {
  action: "pause";
}

interface TargetTrainingPayload {
  action: "target";
  targetId: string;
}

interface ResetTrainingPayload {
  action: "reset";
}

type TrainingPayload =
  | StartTrainingPayload
  | PauseTrainingPayload
  | TargetTrainingPayload
  | ResetTrainingPayload;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Created once per isolate, for the same reason as the league's own schema. */
let schemaReady: Promise<unknown> | null = null;

function ensureTrainingSchema(db: LeagueDatabase) {
  // `league_json` is dead weight kept only so an already deployed table, where
  // the column is NOT NULL, still accepts inserts. Nothing reads it and every
  // write puts an empty object in it — the league now lives in one place.
  schemaReady ??= db.prepare(`
    CREATE TABLE IF NOT EXISTS training_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      target_id TEXT NOT NULL,
      league_json TEXT NOT NULL,
      remaining_cycles INTEGER,
      cycles INTEGER DEFAULT 0 NOT NULL,
      bouts INTEGER DEFAULT 0 NOT NULL,
      physics_steps INTEGER DEFAULT 0 NOT NULL,
      candidates INTEGER DEFAULT 0 NOT NULL,
      checkpoints INTEGER DEFAULT 0 NOT NULL,
      start_fitness REAL DEFAULT 0 NOT NULL,
      current_fitness REAL DEFAULT 0 NOT NULL,
      reward_gain REAL DEFAULT 0 NOT NULL,
      pause_requested INTEGER DEFAULT 0 NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function readTrainingRow(db: LeagueDatabase) {
  return db.prepare(
    "SELECT * FROM training_jobs WHERE id = ? LIMIT 1",
  ).bind(TRAINING_JOB_ID).first<TrainingRow>();
}

function parseTrainingRow(
  row: TrainingRow,
  league: LeagueState,
): PersistentTrainingJob {
  return {
    id: row.id,
    status: row.status,
    targetId: row.target_id,
    league,
    remainingCycles: row.remaining_cycles ?? null,
    cycles: row.cycles,
    bouts: row.bouts,
    physicsSteps: row.physics_steps,
    candidates: row.candidates,
    checkpoints: row.checkpoints,
    startFitness: row.start_fitness,
    currentFitness: row.current_fitness,
    rewardGain: row.reward_gain,
    pauseRequested: Boolean(row.pause_requested),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicJob(job: PersistentTrainingJob | null) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    targetId: job.targetId,
    remainingCycles: job.remainingCycles,
    cycles: job.cycles,
    bouts: job.bouts,
    physicsSteps: job.physicsSteps,
    candidates: job.candidates,
    checkpoints: job.checkpoints,
    startFitness: job.startFitness,
    currentFitness: job.currentFitness,
    rewardGain: job.rewardGain,
    pauseRequested: job.pauseRequested,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function publicTrainingRow(row: TrainingRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    targetId: row.target_id,
    remainingCycles: row.remaining_cycles ?? null,
    cycles: row.cycles,
    bouts: row.bouts,
    physicsSteps: row.physics_steps,
    candidates: row.candidates,
    checkpoints: row.checkpoints,
    startFitness: row.start_fitness,
    currentFitness: row.current_fitness,
    rewardGain: row.reward_gain,
    pauseRequested: Boolean(row.pause_requested),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The roster order is the rotation order. It is durable, division-balanced,
 * and unlike the rankings it does not reshuffle merely because somebody won a
 * fight while another athlete was waiting for his turn. */
function eligibleTrainingTargetId(
  league: LeagueState,
  targetId: string,
  excluded: ReadonlySet<string>,
  advance: boolean,
) {
  const found = league.roster.findIndex((fighter) => fighter.id === targetId);
  const current = found < 0 ? 0 : found;
  for (let offset = advance ? 1 : 0; offset <= league.roster.length; offset += 1) {
    const candidate = league.roster[(current + offset) % league.roster.length];
    if (candidate && !excluded.has(candidate.id)) return candidate.id;
  }
  return null;
}

export function nextTrainingTargetId(
  league: LeagueState,
  targetId: string,
  excluded: ReadonlySet<string> = new Set(),
) {
  return eligibleTrainingTargetId(league, targetId, excluded, true) ?? targetId;
}

/** Creates or re-arms the one league-wide rotation without throwing away its
 * counters. A crashed isolate can leave a `working` claim behind, so that state
 * becomes claimable again after a conservative lease window. */
async function prepareAutonomousTrainingJob(
  env: LeagueEnv,
  db: LeagueDatabase,
  excluded: ReadonlySet<string>,
) {
  const league = await readLeagueForTraining(env);
  if (!league?.roster.length) return false;
  const now = Date.now();
  const row = await readTrainingRow(db);

  if (!row) {
    const targetId = eligibleTrainingTargetId(
      league,
      league.roster[0].id,
      excluded,
      false,
    );
    const target = league.roster.find((fighter) => fighter.id === targetId);
    if (!target) return false;
    await db.prepare(`
      INSERT INTO training_jobs (
        id, status, target_id, league_json, remaining_cycles,
        cycles, bouts, physics_steps, candidates, checkpoints,
        start_fitness, current_fitness, reward_gain, pause_requested,
        last_error, created_at, updated_at
      ) VALUES (?, 'running', ?, '{}', NULL, 0, 0, 0, 0, 0, ?, ?, 0, 0, NULL, ?, ?)
    `).bind(
      TRAINING_JOB_ID,
      target.id,
      target.policy.fitness,
      target.policy.fitness,
      now,
      now - TRAINING_CYCLE_INTERVAL_MS,
    ).run();
    return true;
  }

  if (
    row.status === "working" &&
    now - row.updated_at < STALE_TRAINING_CLAIM_MS
  ) return false;

  const targetId = eligibleTrainingTargetId(
    league,
    row.target_id,
    excluded,
    false,
  );
  if (!targetId) return false;
  const target = league.roster.find((fighter) => fighter.id === targetId)!;
  const due = now - row.updated_at >= TRAINING_CYCLE_INTERVAL_MS;
  const rearming = row.status !== "running";
  if (!due && !rearming) {
    if (targetId !== row.target_id) {
      await db.prepare(`
        UPDATE training_jobs
        SET target_id = ?, start_fitness = ?, current_fitness = ?
        WHERE id = ?
      `).bind(
        targetId,
        target.policy.fitness,
        target.policy.fitness,
        TRAINING_JOB_ID,
      ).run();
    }
    return false;
  }

  await db.prepare(`
    UPDATE training_jobs
    SET status = 'running', target_id = ?, remaining_cycles = NULL,
        start_fitness = ?, current_fitness = ?, pause_requested = 0
    WHERE id = ?
  `).bind(
    targetId,
    target.policy.fitness,
    target.policy.fitness,
    TRAINING_JOB_ID,
  ).run();
  return due || rearming;
}

export function advancePersistentTrainingJob(job: PersistentTrainingJob) {
  const result = trainAthlete(job.league, job.targetId, {
    generations: 1,
    population: 3,
    opponents: 2,
    evaluationSeconds: 20,
  });
  const remainingCycles =
    job.remainingCycles === null
      ? null
      : Math.max(0, job.remainingCycles - 1);
  const completed = remainingCycles === 0;
  return {
    ...job,
    league: result.league,
    status: completed ? "complete" : "running",
    remainingCycles,
    cycles: job.cycles + 1,
    bouts: job.bouts + result.bouts,
    physicsSteps: job.physicsSteps + result.physicsSteps,
    candidates: job.candidates + result.candidates,
    checkpoints: job.checkpoints + (result.gain > 0 ? 1 : 0),
    currentFitness: result.fitnessAfter,
    rewardGain: result.fitnessAfter - job.startFitness,
    lastError: null,
    updatedAt: Date.now(),
  } satisfies PersistentTrainingJob;
}

export async function processTrainingQueue(env: LeagueEnv) {
  if (!env.DB) return false;
  const db = env.DB;
  await ensureTrainingSchema(db);
  if (await migrationFrozen(db)) return false;
  const queued = await readTrainingRow(db);
  const queuedAge = queued ? Date.now() - queued.updated_at : Infinity;
  if (queued?.status === "running" && queuedAge < TRAINING_CYCLE_INTERVAL_MS) {
    return false;
  }
  if (queued?.status === "working" && queuedAge < STALE_TRAINING_CLAIM_MS) {
    return false;
  }
  const lease = await takeSimulationLease(db, Date.now());
  if (!lease) return false;
  try {
    const excluded = await readTrainingExclusions(env);
    if (!await prepareAutonomousTrainingJob(env, db, excluded)) return false;
    const now = Date.now();
    const claim = await db.prepare(`
      UPDATE training_jobs
      SET status = 'working', updated_at = ?
      WHERE id = ? AND status = 'running' AND pause_requested = 0
    `).bind(now, TRAINING_JOB_ID).run();
    if ((claim.meta?.changes ?? 0) !== 1) return false;

    const claimedRow = await readTrainingRow(db);
    if (!claimedRow) return false;

    // Start from the roster as it stands right now. Fights are committed while
    // a cycle runs, and each of those already taught both men something, so the
    // sparring builds on that rather than on a snapshot taken cycles ago.
    const league = await readLeagueForTraining(env);
    if (!league) throw new Error("The league roster is unavailable.");
    const claimed = parseTrainingRow(claimedRow, league);
    if (!claimed.league.roster.some((fighter) => fighter.id === claimed.targetId)) {
      throw new Error("The selected training athlete no longer exists.");
    }
    const advanced = advancePersistentTrainingJob(claimed);
    const trained = advanced.league.roster.find(
      (fighter) => fighter.id === advanced.targetId,
    );
    const baseline = claimed.league.roster.find(
      (fighter) => fighter.id === advanced.targetId,
    );
    if (trained && baseline) await writeTrainedFighter(env, trained, baseline);
    const targetId = nextTrainingTargetId(
      advanced.league,
      advanced.targetId,
      excluded,
    );
    const nextTarget = advanced.league.roster.find(
      (fighter) => fighter.id === targetId,
    );
    await db.prepare(`
      UPDATE training_jobs SET
        status = ?, target_id = ?, remaining_cycles = ?,
        cycles = ?, bouts = ?, physics_steps = ?, candidates = ?,
        checkpoints = ?, start_fitness = ?, current_fitness = ?, reward_gain = ?,
        pause_requested = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).bind(
      "running",
      targetId,
      null,
      advanced.cycles,
      advanced.bouts,
      advanced.physicsSteps,
      advanced.candidates,
      advanced.checkpoints,
      nextTarget?.policy.fitness ?? advanced.currentFitness,
      nextTarget?.policy.fitness ?? advanced.currentFitness,
      advanced.rewardGain,
      0,
      advanced.updatedAt,
      TRAINING_JOB_ID,
    ).run();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Training failed.";
    await db.prepare(`
      UPDATE training_jobs
      SET status = 'error', last_error = ?, updated_at = ?
      WHERE id = ?
    `).bind(message, Date.now(), TRAINING_JOB_ID).run();
    return false;
  } finally {
    await releaseSimulationLease(db, lease).catch(() => {});
  }
}

/** The lab's view of the run, alongside the roster it is actually training. */
async function trainingState(env: LeagueEnv, db: LeagueDatabase) {
  const league = await readLeagueForTraining(env);
  const row = await readTrainingRow(db);
  const displayLeague = league ? publicLeague(league) : null;
  if (!row || !league) {
    return { available: true, serverTime: Date.now(), job: null, league: displayLeague };
  }
  return {
    available: true,
    serverTime: Date.now(),
    job: publicJob(parseTrainingRow(row, league)),
    league: displayLeague,
  };
}

/** Small enough to poll while somebody watches the training board. The full
 * public roster is fetched only when this counter says a cycle has landed. */
export async function handleTrainingStatusRequest(
  request: Request,
  env: LeagueEnv,
  ctx: TrainingExecutionContext,
) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (!env.DB) {
    return jsonResponse(
      { available: false, error: "Persistent training storage is unavailable." },
      503,
    );
  }
  await ensureTrainingSchema(env.DB);
  // The cron owns the cadence. A monitor read is a second door into the same
  // guarded queue so a busy fight worker cannot starve a due training turn by
  // winning the shared simulation lease at every minute boundary.
  ctx.waitUntil(processTrainingQueue(env));
  return jsonResponse({
    available: true,
    serverTime: Date.now(),
    job: publicTrainingRow(await readTrainingRow(env.DB)),
  });
}

export async function handleTrainingRequest(
  request: Request,
  env: LeagueEnv,
  ctx: TrainingExecutionContext,
) {
  if (!env.DB) {
    return jsonResponse(
      { available: false, error: "Persistent training storage is unavailable." },
      503,
    );
  }
  const db = env.DB;
  await ensureTrainingSchema(db);

  if (request.method === "GET") {
    ctx.waitUntil(processTrainingQueue(env));
    return jsonResponse(await trainingState(env, db));
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (!await adminAuthorized(request, env)) {
    return jsonResponse({ error: "Not authorised." }, 401);
  }

  let payload: TrainingPayload;
  try {
    payload = await request.json() as TrainingPayload;
  } catch {
    return jsonResponse({ error: "Invalid training command." }, 400);
  }

  if (payload.action === "reset") {
    // Only the training run is torn down. The league is the broadcast's, and a
    // lab reset has no business throwing away everybody's careers.
    await db.prepare("DELETE FROM training_jobs WHERE id = ?")
      .bind(TRAINING_JOB_ID).run();
    return jsonResponse(await trainingState(env, db));
  }

  if (payload.action === "pause") {
    return jsonResponse(
      { error: "League-wide training is autonomous and cannot be paused here." },
      409,
    );
  }

  if (payload.action === "target") {
    return jsonResponse(
      { error: "The autonomous worker rotates through the complete roster." },
      409,
    );
  }

  if (payload.action !== "start") {
    return jsonResponse({ error: "Unknown training command." }, 400);
  }

  // Kept as a compatible nudge for an already-open copy of the old control
  // room. It can wake the autonomous queue, but it cannot choose a man, change
  // the cadence, or reset the league-wide counters.
  ctx.waitUntil(processTrainingQueue(env));
  return jsonResponse(await trainingState(env, db), 202);
}
