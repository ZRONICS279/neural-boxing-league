import assert from "node:assert/strict";
import test from "node:test";
import type { LeagueDatabase } from "../worker/league.ts";
import {
  decodeMigrationBlob,
  encodeMigrationBlob,
  handleMigrationRequest,
  migrationFrozen,
} from "../worker/migration.ts";

test("migration blobs survive the JSON transport byte for byte", () => {
  const original = Uint8Array.from({ length: 131_089 }, (_, index) => index % 251);
  const encoded = encodeMigrationBlob(original);
  assert.deepEqual(decodeMigrationBlob(encoded), original);
});

test("migration routes require the server-side admin token", async () => {
  const response = await handleMigrationRequest(
    new Request("https://example.com/api/migration/manifest"),
    { FORGE_ADMIN_TOKEN: "admin-secret" },
  );
  assert.equal(response.status, 401);
});

test("the source deployment cannot accept an import", async () => {
  const DB = {
    prepare() {
      throw new Error("the disabled route must not touch D1");
    },
  } as LeagueDatabase;
  const response = await handleMigrationRequest(
    new Request("https://example.com/api/migration/prepare", {
      method: "POST",
      headers: { "x-forge-admin": "admin-secret" },
      body: JSON.stringify({ migrationId: "migration-test-123" }),
    }),
    { DB, FORGE_ADMIN_TOKEN: "admin-secret" },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Migration import is not enabled here." });
});

test("timeline exports encode the D1 blob and advance a composite cursor", async () => {
  const payload = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  const DB = {
    prepare(query: string) {
      return {
        bind() { return this; },
        first: async () => null,
        run: async () => ({}),
        all: async () => {
          assert.match(query, /FROM fight_timeline/);
          return {
            results: Array.from({ length: 20 }, (_, index) => ({
              bout_id: 44,
              chunk: index,
              start_tick: index * 250,
              end_tick: index * 250 + 249,
              is_final: 0,
              payload,
            })),
          };
        },
      };
    },
  } as LeagueDatabase;
  const response = await handleMigrationRequest(
    new Request("https://example.com/api/migration/export?table=fight_timeline", {
      headers: { "x-forge-admin": "admin-secret" },
    }),
    { DB, FORGE_ADMIN_TOKEN: "admin-secret" },
  );
  const body = await response.json() as {
    rows: { payload: string; payload_encoding: string }[];
    cursor: string;
  };
  assert.equal(response.status, 200);
  assert.equal(body.rows[0].payload_encoding, "base64");
  assert.deepEqual(decodeMigrationBlob(body.rows[0].payload), payload);
  assert.equal(body.cursor, "44:19");
});

test("the source can be frozen and unfrozen without enabling imports", async () => {
  let frozen = false;
  const DB = {
    prepare(query: string) {
      return {
        bind() { return this; },
        first: async () => query.includes("SELECT id FROM league_state") && frozen
          ? { id: "migration-freeze" }
          : null,
        all: async () => ({ results: [] }),
        run: async () => {
          if (query.includes("INSERT OR REPLACE INTO league_state")) frozen = true;
          if (query.includes("DELETE FROM league_state")) frozen = false;
          return {};
        },
      };
    },
  } as LeagueDatabase;
  const call = (value: boolean) => handleMigrationRequest(
    new Request("https://example.com/api/migration/freeze", {
      method: "POST",
      headers: { "x-forge-admin": "admin-secret" },
      body: JSON.stringify({ frozen: value }),
    }),
    { DB, FORGE_ADMIN_TOKEN: "admin-secret" },
  );

  assert.equal((await call(true)).status, 200);
  assert.equal(await migrationFrozen(DB), true);
  assert.equal((await call(false)).status, 200);
  assert.equal(await migrationFrozen(DB), false);
});

test("a roster exports and imports without a career changing shape", async () => {
  // The careers used to ride inside league_state, so a backup that only knew
  // the old table list would now carry a league with no fighters in it and
  // restore a season nobody had fought. This is the table being covered.
  const source = new Map<string, Record<string, unknown>>([
    ["malik-okoro", {
      id: "malik-okoro",
      ordinal: 0,
      profile: JSON.stringify({ id: "malik-okoro", seed: 17, record: { wins: 21 } }),
      policy: JSON.stringify({ generation: 61, learnedDecisions: 48210 }),
      dossiers: JSON.stringify({ "darius-cole": { boutsObserved: 6 } }),
      updated_at: 1_700_000_000_000,
    }],
    ["darius-cole", {
      id: "darius-cole",
      ordinal: 1,
      profile: JSON.stringify({ id: "darius-cole", seed: 61, record: { wins: 14 } }),
      policy: JSON.stringify({ generation: 40, learnedDecisions: 31002 }),
      dossiers: JSON.stringify({}),
      updated_at: 1_700_000_000_001,
    }],
  ]);
  const landed = new Map<string, unknown[]>();

  const database = (rows: Map<string, Record<string, unknown>>, capture = false) => ({
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bound = values; return statement; },
        first: async () => (query.includes("forge_migrations")
          ? { migration_id: "migration-test-123" }
          : null),
        run: async () => {
          if (capture && query.includes("INTO fighters")) {
            landed.set(String(bound[0]), bound);
          }
          return {};
        },
        all: async () => ({
          results: query.includes("FROM fighters") ? [...rows.values()] : [],
        }),
      };
      return statement;
    },
  }) as unknown as LeagueDatabase;

  const exported = await handleMigrationRequest(
    new Request("https://example.com/api/migration/export?table=fighters", {
      headers: { "x-forge-admin": "admin-secret" },
    }),
    { DB: database(source), FORGE_ADMIN_TOKEN: "admin-secret" },
  );
  assert.equal(exported.status, 200);
  const body = await exported.json() as { rows: Record<string, unknown>[] };
  assert.equal(body.rows.length, 2);

  const imported = await handleMigrationRequest(
    new Request("https://example.com/api/migration/import", {
      method: "POST",
      headers: { "x-forge-admin": "admin-secret" },
      body: JSON.stringify({
        migrationId: "migration-test-123",
        table: "fighters",
        rows: body.rows,
      }),
    }),
    {
      DB: database(new Map(), true),
      FORGE_ADMIN_TOKEN: "admin-secret",
      FORGE_MIGRATION_IMPORT: "1",
    },
  );
  assert.equal(imported.status, 200, await imported.clone().text());

  // Every column of every career arrived exactly as it left.
  for (const [id, original] of source) {
    assert.deepEqual(
      landed.get(id),
      [id, original.ordinal, original.profile, original.policy, original.dossiers, original.updated_at],
      `${id} did not survive the round trip`,
    );
  }
});
