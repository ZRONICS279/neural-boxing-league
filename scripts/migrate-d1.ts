import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const TABLES = [
  "league_state",
  "fighters",
  "training_jobs",
  "fight_archive",
  "fight_timeline",
] as const;
/** The league itself: the season header, the careers, and the gym. Small
 *  enough to move on its own, and the half you cannot rebuild. */
const CORE_TABLES = ["league_state", "fighters", "training_jobs"] as const;
const SOURCE_URL = "https://forgeleague.space";
const PAGE_ROWS = 20;

type MigrationTable = (typeof TABLES)[number];

interface TableSummary {
  rows: number;
  bytes: number;
}

interface Manifest {
  tables: Record<MigrationTable, TableSummary>;
}

interface Backup {
  format: 1;
  migrationId: string;
  source: string;
  exportedAt: string;
  tables?: MigrationTable[];
  sourceManifest?: Manifest;
  manifest: Manifest;
}

function parseEnv(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function localEnv() {
  const values: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    try {
      Object.assign(values, parseEnv(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { ...values, ...process.env };
}

function cleanUrl(value: string) {
  return value.replace(/\/$/, "");
}

async function requestJson<T>(url: string, token: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-forge-admin": token,
      ...init?.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error ?? response.statusText}`);
  }
  return body;
}

function backupName() {
  return `forge-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function readBackup(directory: string) {
  const path = resolve(directory);
  const backup = JSON.parse(await readFile(resolve(path, "backup.json"), "utf8")) as Backup;
  if (backup.format !== 1 || !backup.migrationId || !backup.manifest) {
    throw new Error("This is not a Forge League migration backup.");
  }
  return { backup, path };
}

async function remoteManifest(baseUrl: string, token: string) {
  return requestJson<Manifest>(`${cleanUrl(baseUrl)}/api/migration/manifest`, token);
}

async function exportBackup(
  baseUrl: string,
  token: string,
  requestedDirectory?: string,
  selectedTables: readonly MigrationTable[] = TABLES,
) {
  const source = cleanUrl(baseUrl);
  const sourceManifest = await remoteManifest(source, token);
  const selected = new Set<MigrationTable>(selectedTables);
  const manifest: Manifest = {
    tables: Object.fromEntries(TABLES.map((table) => [
      table,
      selected.has(table) ? sourceManifest.tables[table] : { rows: 0, bytes: 0 },
    ])) as Record<MigrationTable, TableSummary>,
  };
  const path = resolve(requestedDirectory ?? "backups", requestedDirectory ? "" : backupName());
  await mkdir(resolve(path, ".."), { recursive: true });
  await mkdir(path, { recursive: false });

  const backup: Backup = {
    format: 1,
    migrationId: randomUUID(),
    source,
    exportedAt: new Date().toISOString(),
    tables: [...selectedTables],
    sourceManifest,
    manifest,
  };
  await writeFile(resolve(path, "backup.json"), `${JSON.stringify(backup, null, 2)}\n`, {
    flag: "wx",
  });

  for (const table of selectedTables) {
    const file = resolve(path, `${table}.jsonl`);
    let cursor: string | null = "";
    let exported = 0;
    await writeFile(file, "", { flag: "wx" });
    while (cursor !== null) {
      const params = new URLSearchParams({ table, limit: String(PAGE_ROWS) });
      if (cursor) params.set("cursor", cursor);
      const page = await requestJson<{
        rows: Record<string, unknown>[];
        cursor: string | null;
      }>(`${source}/api/migration/export?${params}`, token);
      if (page.rows.length > 0) {
        await appendFile(file, `${page.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
      }
      exported += page.rows.length;
      cursor = page.cursor;
      process.stdout.write(`\r${table}: ${exported}/${sourceManifest.tables[table].rows}`);
    }
    process.stdout.write("\n");
    if (exported !== sourceManifest.tables[table].rows) {
      throw new Error(`${table} changed during export (${exported} exported, ${sourceManifest.tables[table].rows} expected).`);
    }
  }
  console.log(`Backup saved to ${path}`);
  return path;
}

async function post(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
) {
  return requestJson<Record<string, unknown>>(`${cleanUrl(baseUrl)}${path}`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function freeze(baseUrl: string, token: string, frozen: boolean) {
  const result = await post(baseUrl, token, "/api/migration/freeze", { frozen });
  console.log(JSON.stringify(result, null, 2));
}

async function prepare(baseUrl: string, token: string, directory: string) {
  const { backup } = await readBackup(directory);
  const result = await post(baseUrl, token, "/api/migration/prepare", {
    migrationId: backup.migrationId,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function importTable(
  baseUrl: string,
  token: string,
  migrationId: string,
  table: MigrationTable,
  file: string,
  expected: number,
) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let page: Record<string, unknown>[] = [];
  let imported = 0;
  const flush = async () => {
    if (page.length === 0) return;
    await post(baseUrl, token, "/api/migration/import", {
      migrationId,
      table,
      rows: page,
    });
    imported += page.length;
    page = [];
    process.stdout.write(`\r${table}: ${imported}/${expected}`);
  };
  for await (const line of lines) {
    if (!line) continue;
    page.push(JSON.parse(line) as Record<string, unknown>);
    if (page.length === PAGE_ROWS) await flush();
  }
  await flush();
  process.stdout.write("\n");
  if (imported !== expected) {
    throw new Error(`${table} backup has ${imported} rows, expected ${expected}.`);
  }
}

function compareManifest(expected: Manifest, actual: Manifest) {
  const differences: string[] = [];
  for (const table of TABLES) {
    for (const field of ["rows", "bytes"] as const) {
      if (expected.tables[table][field] !== actual.tables[table][field]) {
        differences.push(
          `${table}.${field}: expected ${expected.tables[table][field]}, got ${actual.tables[table][field]}`,
        );
      }
    }
  }
  return differences;
}

async function verify(baseUrl: string, token: string, directory: string) {
  const { backup } = await readBackup(directory);
  const actual = await remoteManifest(baseUrl, token);
  const differences = compareManifest(backup.manifest, actual);
  if (differences.length > 0) {
    throw new Error(`Migration verification failed:\n${differences.join("\n")}`);
  }
  console.log("Verified: every table has the expected row count and byte total.");
}

async function importBackup(baseUrl: string, token: string, directory: string) {
  const { backup, path } = await readBackup(directory);
  await prepare(baseUrl, token, directory);
  for (const table of backup.tables ?? TABLES) {
    await importTable(
      baseUrl,
      token,
      backup.migrationId,
      table,
      resolve(path, `${table}.jsonl`),
      backup.manifest.tables[table].rows,
    );
  }
  await verify(baseUrl, token, directory);
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  const env = await localEnv();
  const token = env.FORGE_ADMIN_TOKEN;
  if (!token) throw new Error("FORGE_ADMIN_TOKEN is not set in .env.local, .env, or the shell.");

  if (command === "manifest") {
    console.log(JSON.stringify(await remoteManifest(first ?? SOURCE_URL, token), null, 2));
    return;
  }
  if (command === "export") {
    await exportBackup(first ?? SOURCE_URL, token, second);
    return;
  }
  if (command === "export-core") {
    await exportBackup(first ?? SOURCE_URL, token, second, CORE_TABLES);
    return;
  }
  if (command === "freeze" || command === "unfreeze") {
    await freeze(first ?? SOURCE_URL, token, command === "freeze");
    return;
  }
  if (["prepare", "import", "verify"].includes(command)) {
    const baseUrl = first ?? env.FORGE_TARGET_URL;
    const directory = second;
    if (!baseUrl || !directory) {
      throw new Error(`${command} requires a target URL and backup directory.`);
    }
    if (command === "prepare") await prepare(baseUrl, token, directory);
    else if (command === "import") await importBackup(baseUrl, token, directory);
    else await verify(baseUrl, token, directory);
    return;
  }
  throw new Error([
    "Usage:",
    "  npm run migration:manifest -- [source-url]",
    "  npm run migration:export -- [source-url] [backup-directory]",
    "  npm run migration:export-core -- [source-url] [backup-directory]",
    "  npm run migration:freeze -- [source-url]",
    "  npm run migration:unfreeze -- [source-url]",
    "  npm run migration:prepare -- <target-url> <backup-directory>",
    "  npm run migration:import -- <target-url> <backup-directory>",
    "  npm run migration:verify -- <target-url> <backup-directory>",
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
