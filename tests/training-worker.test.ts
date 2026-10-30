import assert from "node:assert/strict";
import test from "node:test";
import { createInitialLeague, trainAthlete } from "../app/simulation.ts";
import { readLeagueForTraining, writeTrainedFighter } from "../worker/league.ts";
import {
  advancePersistentTrainingJob,
  handleTrainingRequest,
  handleTrainingStatusRequest,
  nextTrainingTargetId,
  type PersistentTrainingJob,
} from "../worker/training.ts";

function createJob(targetId = "malik-okoro"): PersistentTrainingJob {
  const league = createInitialLeague();
  const target = league.roster.find((fighter) => fighter.id === targetId)!;
  return {
    id: "forge-league",
    status: "running",
    targetId,
    league,
    remainingCycles: 1,
    cycles: 0,
    bouts: 0,
    physicsSteps: 0,
    candidates: 0,
    checkpoints: 0,
    startFitness: target.policy.fitness,
    currentFitness: target.policy.fitness,
    rewardGain: 0,
    pauseRequested: false,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("a persistent worker cycle advances and checkpoints only its target", () => {
  const job = createJob();
  const repeatedJob = structuredClone(job);
  const first = advancePersistentTrainingJob(job);
  const repeated = advancePersistentTrainingJob(repeatedJob);
  const trained = first.league.roster.find(
    (fighter) => fighter.id === job.targetId,
  )!;
  const untouched = first.league.roster.find(
    (fighter) => fighter.id === "jonah-vale",
  )!;

  assert.equal(first.status, "complete");
  assert.equal(first.remainingCycles, 0);
  assert.equal(first.cycles, 1);
  assert.equal(first.candidates, 3);
  assert.ok(first.bouts > 0);
  assert.ok(first.physicsSteps > 0);
  assert.equal(trained.policy.generation, 1);
  assert.equal(untouched.policy.generation, 0);
  assert.deepEqual(first.league, repeated.league);
  assert.equal(first.rewardGain, repeated.rewardGain);
});

test("switching the saved target trains the newly selected athlete", () => {
  const job = createJob("jonah-vale");
  const advanced = advancePersistentTrainingJob(job);
  const target = advanced.league.roster.find(
    (fighter) => fighter.id === "jonah-vale",
  )!;
  const previous = advanced.league.roster.find(
    (fighter) => fighter.id === "malik-okoro",
  )!;

  assert.equal(target.policy.generation, 1);
  assert.equal(previous.policy.generation, 0);
});

test("the autonomous rotation skips both athletes who are fighting", () => {
  const league = createInitialLeague();
  const current = league.roster[0];
  const fighting = new Set([
    league.roster[1].id,
    league.roster[2].id,
  ]);

  assert.equal(
    nextTrainingTargetId(league, current.id, fighting),
    league.roster[3].id,
  );
});

test("the training route fails closed without persistent storage", async () => {
  const response = await handleTrainingRequest(
    new Request("http://localhost/api/training"),
    {},
    { waitUntil() {} },
  );
  const payload = await response.json() as { available: boolean };

  assert.equal(response.status, 503);
  assert.equal(payload.available, false);
});

/** Just enough D1 to exercise the league round trip — including the careers,
 *  which live one to a row and are read a page at a time. */
function fakeLeagueDatabase() {
  const rows = new Map<string, { id: string; payload: string; updated_at: number }>();
  const fighterRows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    fighterRows,
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          if (!query.includes("FROM fighters")) return { results: [] as T[] };
          return {
            results: [...fighterRows.values()]
              .sort((a, b) => Number(a.ordinal) - Number(b.ordinal)) as T[],
          };
        },
        async first<T>() {
          if (!query.includes("SELECT")) return null;
          return (rows.get(String(bound[0])) ?? null) as T | null;
        },
        async run() {
          if (query.includes("DELETE FROM fighters")) {
            fighterRows.clear();
          } else if (query.includes("INTO fighters")) {
            fighterRows.set(String(bound[0]), {
              id: String(bound[0]),
              ordinal: Number(bound[1]),
              profile: String(bound[2]),
              policy: String(bound[3]),
              dossiers: String(bound[4]),
              updated_at: Number(bound[5]),
            });
          } else if (query.includes("INSERT INTO league_state")) {
            rows.set(String(bound[0]), {
              id: String(bound[0]),
              payload: String(bound[1]),
              updated_at: Number(bound[2]),
            });
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

test("the public training route is read-only", async () => {
  const DB = fakeLeagueDatabase();
  const response = await handleTrainingRequest(
    new Request("http://localhost/api/training", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    }),
    { DB, FORGE_ADMIN_TOKEN: "admin-secret" },
    { waitUntil() {} },
  );

  assert.equal(response.status, 401);
});

test("the live monitor polls compact telemetry without the full roster", async () => {
  const DB = fakeLeagueDatabase();
  const response = await handleTrainingStatusRequest(
    new Request("http://localhost/api/training/status"),
    { DB },
    { waitUntil() {} },
  );
  const payload = await response.json() as {
    available: boolean;
    serverTime: number;
    league?: unknown;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.available, true);
  assert.ok(payload.serverTime > 0);
  assert.equal("league" in payload, false);
});

test("the public training snapshot omits learned matrices and dossiers", async () => {
  const DB = fakeLeagueDatabase();
  const response = await handleTrainingRequest(
    new Request("http://localhost/api/training"),
    { DB },
    { waitUntil() {} },
  );
  const payload = await response.json() as {
    league: {
      roster: {
        policy: { weights: unknown[] };
        opponentDossiers: Record<string, unknown>;
        publicActionPreferences: unknown[];
      }[];
    };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.league.roster[0].policy.weights, []);
  assert.deepEqual(payload.league.roster[0].opponentDossiers, {});
  assert.ok(payload.league.roster[0].publicActionPreferences.length > 0);
});

test("the training worker improves the roster the card actually fights", async () => {
  const DB = fakeLeagueDatabase();
  const env = { DB };

  // Nothing stored yet: training falls back to the league the season opens with.
  const seeded = await readLeagueForTraining(env);
  assert.ok(seeded);
  assert.ok(seeded.roster.length > 0);

  const target = seeded.roster.find((fighter) => fighter.id === "malik-okoro")!;
  const trained = trainAthlete(seeded, target.id, {
    generations: 1,
    population: 2,
    opponents: 1,
    evaluationSeconds: 12,
  }).league.roster.find((fighter) => fighter.id === target.id)!;
  await writeTrainedFighter(env, trained);

  const reloaded = (await readLeagueForTraining(env))!;
  const persisted = reloaded.roster.find((fighter) => fighter.id === target.id)!;
  const neighbour = reloaded.roster.find((fighter) => fighter.id === "jonah-vale")!;

  // The trained brain is now in the broadcast's own roster, not a private copy.
  assert.deepEqual(persisted.policy, trained.policy);
  assert.equal(persisted.policy.generation, 1);
  // And only that athlete moved.
  assert.equal(neighbour.policy.generation, 0);
  assert.deepEqual(neighbour.policy, seeded.roster.find((f) => f.id === "jonah-vale")!.policy);
  // Viewers are told the roster changed so they refetch it.
  const broadcast = JSON.parse(DB.rows.get("broadcast")!.payload) as { rosterVersion: number };
  assert.ok(broadcast.rosterVersion > 1);
});

test("an unknown athlete is never written into the roster", async () => {
  const DB = fakeLeagueDatabase();
  const env = { DB };
  const league = (await readLeagueForTraining(env))!;
  const stranger = { ...league.roster[0], id: "not-signed" };

  await writeTrainedFighter(env, stranger);
  assert.equal(DB.rows.has("league"), false);
});
