import { adminAuthorized } from "./admin.ts";
import type { LeagueDatabase } from "./league.ts";

const TABLES = [
  "league_state",
  "fighters",
  "training_jobs",
  "fight_archive",
  "fight_timeline",
] as const;
const MAX_PAGE_ROWS = 20;
const ACTIVE_MIGRATION = "active";
const FREEZE_ROW = "migration-freeze";

type MigrationTable = (typeof TABLES)[number];
type MigrationRow = Record<string, unknown>;

interface MigrationEnv {
  DB?: LeagueDatabase;
  FORGE_ADMIN_TOKEN?: string;
  FORGE_MIGRATION_IMPORT?: string;
}

interface CountRow {
  rows: number;
  bytes: number;
}

interface MigrationSessionRow {
  migration_id: string;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isTable(value: string | null): value is MigrationTable {
  return TABLES.includes(value as MigrationTable);
}

function pageSize(url: URL) {
  const requested = Number(url.searchParams.get("limit") ?? MAX_PAGE_ROWS);
  if (!Number.isFinite(requested)) return MAX_PAGE_ROWS;
  return Math.max(1, Math.min(MAX_PAGE_ROWS, Math.floor(requested)));
}

function rowsFrom<T>(result: { results?: T[] }) {
  return result.results ?? [];
}

async function all<T>(db: LeagueDatabase, query: string, values: unknown[] = []) {
  const statement = db.prepare(query).bind(...values);
  if (!statement.all) throw new Error("This database cannot return migration pages.");
  return rowsFrom(await statement.all<T>());
}

function bytesFrom(value: ArrayBuffer | Uint8Array | number[]) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(value);
}

export function encodeMigrationBlob(value: ArrayBuffer | Uint8Array | number[]) {
  const bytes = bytesFrom(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeMigrationBlob(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function ensureMigrationSchema(db: LeagueDatabase) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS league_state (
      id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fighters (
      id TEXT PRIMARY KEY NOT NULL,
      ordinal INTEGER NOT NULL,
      profile TEXT NOT NULL,
      policy TEXT NOT NULL,
      dossiers TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS training_jobs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS fight_archive (
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
    )`,
    "CREATE INDEX IF NOT EXISTS fight_archive_night ON fight_archive (night)",
    `CREATE TABLE IF NOT EXISTS fight_timeline (
      bout_id INTEGER NOT NULL,
      chunk INTEGER NOT NULL,
      start_tick INTEGER NOT NULL,
      end_tick INTEGER NOT NULL,
      is_final INTEGER NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY (bout_id, chunk)
    )`,
    `CREATE TABLE IF NOT EXISTS forge_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      migration_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ];
  for (const query of statements) await db.prepare(query).run();
}

export async function migrationFrozen(db: LeagueDatabase) {
  try {
    return await db.prepare(
      "SELECT id FROM league_state WHERE id = ? LIMIT 1",
    ).bind(FREEZE_ROW).first<{ id: string }>() !== null;
  } catch {
    return false;
  }
}

async function setMigrationFreeze(db: LeagueDatabase, frozen: boolean) {
  await ensureMigrationSchema(db);
  if (frozen) {
    const now = Date.now();
    await db.prepare(`
      INSERT OR REPLACE INTO league_state (id, payload, updated_at)
      VALUES (?, ?, ?)
    `).bind(FREEZE_ROW, JSON.stringify({ frozenAt: now }), now).run();
  } else {
    await db.prepare("DELETE FROM league_state WHERE id = ?")
      .bind(FREEZE_ROW).run();
  }
  return jsonResponse({ frozen, at: Date.now() });
}

async function tableManifest(db: LeagueDatabase) {
  const [league, fighters, training, archive, timeline] = await Promise.all([
    db.prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM league_state",
    ).first<CountRow>(),
    // The careers are three columns now, so the byte count has to add them up
    // or a roster would verify as a fraction of its real size.
    db.prepare(`
      SELECT COUNT(*) AS rows,
        COALESCE(SUM(LENGTH(profile) + LENGTH(policy) + LENGTH(dossiers)), 0) AS bytes
      FROM fighters
    `).first<CountRow>(),
    db.prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(league_json)), 0) AS bytes FROM training_jobs",
    ).first<CountRow>(),
    db.prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(replay)), 0) AS bytes FROM fight_archive",
    ).first<CountRow>(),
    db.prepare(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM fight_timeline",
    ).first<CountRow>(),
  ]);
  const normalized = (row: CountRow | null) => ({
    rows: Number(row?.rows ?? 0),
    bytes: Number(row?.bytes ?? 0),
  });
  return {
    league_state: normalized(league),
    fighters: normalized(fighters),
    training_jobs: normalized(training),
    fight_archive: normalized(archive),
    fight_timeline: normalized(timeline),
  };
}

async function exportPage(db: LeagueDatabase, table: MigrationTable, url: URL) {
  const limit = pageSize(url);
  const cursor = url.searchParams.get("cursor") ?? "";

  if (table === "league_state") {
    const rows = await all<MigrationRow>(db,
      "SELECT * FROM league_state WHERE id > ? ORDER BY id LIMIT ?",
      [cursor, limit],
    );
    return { rows, cursor: rows.length === limit ? String(rows.at(-1)?.id ?? "") : null };
  }
  if (table === "fighters") {
    const rows = await all<MigrationRow>(db,
      "SELECT * FROM fighters WHERE id > ? ORDER BY id LIMIT ?",
      [cursor, limit],
    );
    return { rows, cursor: rows.length === limit ? String(rows.at(-1)?.id ?? "") : null };
  }
  if (table === "training_jobs") {
    const rows = await all<MigrationRow>(db,
      "SELECT * FROM training_jobs WHERE id > ? ORDER BY id LIMIT ?",
      [cursor, limit],
    );
    return { rows, cursor: rows.length === limit ? String(rows.at(-1)?.id ?? "") : null };
  }
  if (table === "fight_archive") {
    const after = Number(cursor || -1);
    if (!Number.isSafeInteger(after)) throw new Error("Invalid archive cursor.");
    const rows = await all<MigrationRow>(db,
      "SELECT * FROM fight_archive WHERE id > ? ORDER BY id LIMIT ?",
      [after, limit],
    );
    return { rows, cursor: rows.length === limit ? String(rows.at(-1)?.id ?? "") : null };
  }

  const [boutText = "-1", chunkText = "-1"] = cursor.split(":");
  const bout = Number(boutText);
  const chunk = Number(chunkText);
  if (!Number.isSafeInteger(bout) || !Number.isSafeInteger(chunk)) {
    throw new Error("Invalid timeline cursor.");
  }
  const rows = await all<MigrationRow>(db, `
    SELECT * FROM fight_timeline
    WHERE bout_id > ? OR (bout_id = ? AND chunk > ?)
    ORDER BY bout_id, chunk
    LIMIT ?
  `, [bout, bout, chunk, limit]);
  const encoded = rows.map((row) => ({
    ...row,
    payload: encodeMigrationBlob(
      row.payload as ArrayBuffer | Uint8Array | number[],
    ),
    payload_encoding: "base64",
  }));
  const last = rows.at(-1);
  return {
    rows: encoded,
    cursor: rows.length === limit ? `${last?.bout_id}:${last?.chunk}` : null,
  };
}

function stringValue(row: MigrationRow, name: string, nullable = false) {
  const value = row[name];
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${name}.`);
  return value;
}

function numberValue(row: MigrationRow, name: string, nullable = false) {
  const value = row[name];
  if (nullable && value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${name}.`);
  return number;
}

function insertStatement(db: LeagueDatabase, table: MigrationTable, row: MigrationRow) {
  if (table === "league_state") {
    return db.prepare(`
      INSERT OR REPLACE INTO league_state (id, payload, updated_at)
      VALUES (?, ?, ?)
    `).bind(
      stringValue(row, "id"),
      stringValue(row, "payload"),
      numberValue(row, "updated_at"),
    );
  }
  if (table === "fighters") {
    return db.prepare(`
      INSERT OR REPLACE INTO fighters (
        id, ordinal, profile, policy, dossiers, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      stringValue(row, "id"),
      numberValue(row, "ordinal"),
      stringValue(row, "profile"),
      stringValue(row, "policy"),
      stringValue(row, "dossiers"),
      numberValue(row, "updated_at"),
    );
  }
  if (table === "training_jobs") {
    return db.prepare(`
      INSERT OR REPLACE INTO training_jobs (
        id, status, target_id, league_json, remaining_cycles, cycles, bouts,
        physics_steps, candidates, checkpoints, start_fitness,
        current_fitness, reward_gain, pause_requested, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      stringValue(row, "id"),
      stringValue(row, "status"),
      stringValue(row, "target_id"),
      stringValue(row, "league_json"),
      numberValue(row, "remaining_cycles", true),
      numberValue(row, "cycles"),
      numberValue(row, "bouts"),
      numberValue(row, "physics_steps"),
      numberValue(row, "candidates"),
      numberValue(row, "checkpoints"),
      numberValue(row, "start_fitness"),
      numberValue(row, "current_fitness"),
      numberValue(row, "reward_gain"),
      numberValue(row, "pause_requested"),
      stringValue(row, "last_error", true),
      numberValue(row, "created_at"),
      numberValue(row, "updated_at"),
    );
  }
  if (table === "fight_archive") {
    return db.prepare(`
      INSERT OR REPLACE INTO fight_archive (
        id, night, season, week, division, kind, blue_id, red_id, blue_name,
        red_name, winner_id, finish, round, total_rounds, ticks, blue_landed,
        red_landed, started_at, aired_at, replay
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      numberValue(row, "id"),
      numberValue(row, "night"),
      numberValue(row, "season"),
      numberValue(row, "week"),
      stringValue(row, "division"),
      stringValue(row, "kind"),
      stringValue(row, "blue_id"),
      stringValue(row, "red_id"),
      stringValue(row, "blue_name"),
      stringValue(row, "red_name"),
      stringValue(row, "winner_id", true),
      stringValue(row, "finish"),
      numberValue(row, "round"),
      numberValue(row, "total_rounds"),
      numberValue(row, "ticks"),
      numberValue(row, "blue_landed"),
      numberValue(row, "red_landed"),
      numberValue(row, "started_at"),
      numberValue(row, "aired_at"),
      stringValue(row, "replay", true),
    );
  }
  if (row.payload_encoding !== "base64") {
    throw new Error("Timeline payload is not base64 encoded.");
  }
  return db.prepare(`
    INSERT OR REPLACE INTO fight_timeline (
      bout_id, chunk, start_tick, end_tick, is_final, payload
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    numberValue(row, "bout_id"),
    numberValue(row, "chunk"),
    numberValue(row, "start_tick"),
    numberValue(row, "end_tick"),
    numberValue(row, "is_final"),
    decodeMigrationBlob(stringValue(row, "payload")),
  );
}

async function prepareImport(db: LeagueDatabase, migrationId: string) {
  await ensureMigrationSchema(db);
  const active = await db.prepare(
    "SELECT migration_id FROM forge_migrations WHERE id = ? LIMIT 1",
  ).bind(ACTIVE_MIGRATION).first<MigrationSessionRow>();
  if (active) {
    if (active.migration_id !== migrationId) {
      return jsonResponse({ error: "A different migration is already active." }, 409);
    }
    return jsonResponse({ ready: true, migrationId, tables: await tableManifest(db) });
  }

  const tables = await tableManifest(db);
  if (Object.values(tables).some((table) => table.rows > 0)) {
    return jsonResponse({
      error: "Target database is not empty; refusing to begin an import.",
      tables,
    }, 409);
  }
  await db.prepare(`
    INSERT INTO forge_migrations (id, migration_id, created_at)
    VALUES (?, ?, ?)
  `).bind(ACTIVE_MIGRATION, migrationId, Date.now()).run();
  return jsonResponse({ ready: true, migrationId, tables });
}

async function importRows(
  db: LeagueDatabase,
  migrationId: string,
  table: MigrationTable,
  rows: MigrationRow[],
) {
  await ensureMigrationSchema(db);
  const active = await db.prepare(
    "SELECT migration_id FROM forge_migrations WHERE id = ? LIMIT 1",
  ).bind(ACTIVE_MIGRATION).first<MigrationSessionRow>();
  if (!active || active.migration_id !== migrationId) {
    return jsonResponse({ error: "This migration has not been prepared." }, 409);
  }
  if (rows.length > MAX_PAGE_ROWS) {
    return jsonResponse({ error: `An import page may contain at most ${MAX_PAGE_ROWS} rows.` }, 400);
  }

  const statements = rows.map((row) => insertStatement(db, table, row));
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
  return jsonResponse({ imported: rows.length, table });
}

export async function handleMigrationRequest(request: Request, env: MigrationEnv) {
  if (!await adminAuthorized(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!env.DB) return jsonResponse({ error: "Database binding is unavailable." }, 503);

  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/migration/manifest") {
      return jsonResponse({ tables: await tableManifest(env.DB) });
    }
    if (request.method === "GET" && url.pathname === "/api/migration/export") {
      const table = url.searchParams.get("table");
      if (!isTable(table)) return jsonResponse({ error: "Unknown migration table." }, 400);
      return jsonResponse({ table, ...await exportPage(env.DB, table, url) });
    }

    if (request.method === "POST" && url.pathname === "/api/migration/freeze") {
      const body = await request.json() as { frozen?: unknown };
      if (typeof body.frozen !== "boolean") {
        return jsonResponse({ error: "A boolean frozen value is required." }, 400);
      }
      return setMigrationFreeze(env.DB, body.frozen);
    }

    if (env.FORGE_MIGRATION_IMPORT !== "1") {
      return jsonResponse({ error: "Migration import is not enabled here." }, 403);
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    const body = await request.json() as {
      migrationId?: unknown;
      table?: unknown;
      rows?: unknown;
    };
    if (typeof body.migrationId !== "string" || body.migrationId.length < 12) {
      return jsonResponse({ error: "A valid migration id is required." }, 400);
    }
    if (url.pathname === "/api/migration/prepare") {
      return prepareImport(env.DB, body.migrationId);
    }
    if (url.pathname === "/api/migration/import") {
      if (typeof body.table !== "string" || !isTable(body.table) || !Array.isArray(body.rows)) {
        return jsonResponse({ error: "A valid table and rows are required." }, 400);
      }
      return importRows(env.DB, body.migrationId, body.table, body.rows as MigrationRow[]);
    }
    return jsonResponse({ error: "Not found." }, 404);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "Migration request failed.",
    }, 500);
  }
}
