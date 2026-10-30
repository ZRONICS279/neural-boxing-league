import assert from "node:assert/strict";
import test from "node:test";
import { type BroadcastState, CARD_BOUTS } from "../app/broadcast.ts";
import {
  handleLeagueRequest,
  mergeTrainedFighter,
  processLeagueTick,
  readLeagueForTraining,
  writeTrainedFighter,
} from "../worker/league.ts";
import { BOXING_MODEL, createInitialLeague, trainAthlete } from "../app/simulation.ts";
import type { FighterRow } from "../worker/fighter-store.ts";

/** Just enough D1 to exercise the write gate — and, unlike a fake that stores
 *  whatever it is handed, honest about conditional writes. The whole point of
 *  these tests is that a losing write does not land, so a fake that lets every
 *  write through would pass them for the wrong reason. */
function fakeLeagueDatabase() {
  const rows = new Map<string, { id: string; payload: string; updated_at: number }>();
  const trainingRows = new Map<string, Record<string, unknown> & { league_json: string }>();
  const fighterRows = new Map<string, FighterRow & { updated_at: number }>();
  /** Every fighter row the store has written, so a test can assert that a
   *  committed bout moved two careers and not the whole roster. */
  const fighterWrites: string[] = [];
  /** Every version of the card that was ever published, in order. */
  const published: BroadcastState[] = [];
  let reads = 0;
  const record = (id: string, payload: string) => {
    if (id !== "broadcast") return;
    try {
      published.push(JSON.parse(payload) as BroadcastState);
    } catch {
      /* a test writing deliberate rubbish */
    }
  };
  const db = {
    rows,
    trainingRows,
    fighterRows,
    fighterWrites,
    published,
    get reads() {
      return reads;
    },
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async all<T>() {
          reads += 1;
          if (!query.includes("FROM fighters")) return { results: [] as T[] };
          const results = [...fighterRows.values()]
            .sort((a, b) => a.ordinal - b.ordinal);
          return { results: results as T[] };
        },
        async first<T>() {
          if (!query.includes("SELECT")) return null;
          reads += 1;
          if (query.includes("FROM training_jobs")) {
            return (trainingRows.get(String(bound[0])) ?? null) as T | null;
          }
          return (rows.get(String(bound[0])) ?? null) as T | null;
        },
        async run() {
          if (query.includes("DELETE FROM fighters")) {
            fighterRows.clear();
            return { meta: { changes: 1 } };
          }
          if (query.includes("INTO fighters")) {
            const id = String(bound[0]);
            fighterRows.set(id, {
              id,
              ordinal: Number(bound[1]),
              profile: String(bound[2]),
              policy: String(bound[3]),
              dossiers: String(bound[4]),
              updated_at: Number(bound[5]),
            });
            fighterWrites.push(id);
            return { meta: { changes: 1 } };
          }
          // INSERT ... WHERE NOT EXISTS — only if the row is absent.
          if (query.includes("WHERE NOT EXISTS")) {
            const id = String(bound[0]);
            if (rows.has(id)) return { meta: { changes: 0 } };
            rows.set(id, {
              id,
              payload: String(bound[1]),
              updated_at: Number(bound[2]),
            });
            record(id, String(bound[1]));
            return { meta: { changes: 1 } };
          }
          // UPDATE ... WHERE id = ? AND updated_at = ? — only if untouched.
          if (query.includes("UPDATE league_state")) {
            const id = String(bound[2]);
            const existing = rows.get(id);
            if (!existing || existing.updated_at !== Number(bound[3])) {
              return { meta: { changes: 0 } };
            }
            rows.set(id, {
              id,
              payload: String(bound[0]),
              updated_at: Number(bound[1]),
            });
            record(id, String(bound[0]));
            return { meta: { changes: 1 } };
          }
          // Unconditional upsert.
          if (query.includes("INSERT INTO league_state")) {
            rows.set(String(bound[0]), {
              id: String(bound[0]),
              payload: String(bound[1]),
              updated_at: Number(bound[2]),
            });
            record(String(bound[0]), String(bound[1]));
          }
          if (query.includes("INSERT INTO training_jobs")) {
            trainingRows.set(String(bound[0]), {
              id: String(bound[0]),
              status: String(bound[1]),
              target_id: String(bound[2]),
              league_json: "{}",
              remaining_cycles: bound[3] as number | null,
              cycles: Number(bound[4]),
              bouts: Number(bound[5]),
              physics_steps: Number(bound[6]),
              candidates: Number(bound[7]),
              checkpoints: Number(bound[8]),
              start_fitness: Number(bound[9]),
              current_fitness: Number(bound[10]),
              reward_gain: Number(bound[11]),
              pause_requested: Number(bound[12]),
              last_error: bound[13] as string | null,
              created_at: Number(bound[14]),
              updated_at: Number(bound[15]),
            });
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return db;
}

/** A strategist that answers differently every single time it is asked, which
 *  is what a language model does and what used to give two viewers two fight
 *  nights. Every call is distinct rather than alternating, so racing workers
 *  cannot accidentally be handed matching instructions and agree by luck. */
function flakyCoachFetch() {
  const foci = ["pressure", "counter", "bodyWork", "evasive"] as const;
  let call = 0;
  return async () => {
    call += 1;
    return Response.json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                focus: foci[(call * 3) % foci.length],
                pace: (((call * 37) % 200) - 100) / 100,
                risk: (((call * 61) % 200) - 100) / 100,
                target: call % 2 === 0 ? "head" : "body",
                ringMode: ["pressure", "outside", "center"][(call * 5) % 3],
                confidence: 0.9,
                note: `call ${call}`,
              }),
            },
          ],
        },
      ],
    });
  };
}

function card(db: ReturnType<typeof fakeLeagueDatabase>) {
  const row = db.rows.get("broadcast");
  return row ? (JSON.parse(row.payload) as BroadcastState).card : [];
}

/** A worker execution context that lets the test wait for the background work
 *  the request handed off, instead of leaving it dangling. */
function captureContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise.catch(() => {}));
      },
    },
    settle: () => Promise.all(pending),
  };
}

test("concurrent ticks publish one fight night, not one each", async () => {
  const DB = fakeLeagueDatabase();
  const realFetch = globalThis.fetch;
  globalThis.fetch = flakyCoachFetch() as typeof globalThis.fetch;
  const env = { DB, OPENAI_API_KEY: "test-key" };
  try {
    // Eight viewers poll at the same instant, exactly as they do in production.
    // Every one of them runs the card forward; only one may publish.
    await Promise.all(Array.from({ length: 8 }, () => processLeagueTick(env)));
  } finally {
    globalThis.fetch = realFetch;
  }

  const fought = card(DB).filter((bout) => bout.result);
  assert.ok(fought.length > 0, "the card should have been fought forward");
  assert.ok(DB.published.length > 1, "the race should have produced several writes");

  // The invariant a broadcast lives or dies by: once a bout has been published
  // it is that fight forever. Viewers replay it from the seed and the recorded
  // corner instructions, so a second, differently-fought version of the same
  // slot puts two browsers on two different fights — and drops the result panel
  // over a round still in progress on whichever one is holding the longer cut.
  const asAired = new Map<number, string>();
  for (const version of DB.published) {
    for (const bout of version.card) {
      if (!bout.result) continue;
      const fight = JSON.stringify({
        winnerId: bout.result.winnerId,
        finish: bout.result.finish,
        ticks: bout.result.ticks,
        startsAt: bout.startsAt,
        endsAt: bout.endsAt,
        directives: bout.directives.length,
      });
      const already = asAired.get(bout.id);
      if (already === undefined) asAired.set(bout.id, fight);
      else assert.equal(fight, already, `bout ${bout.id} was re-fought after it aired`);
    }
  }

  // The airtime a bout is billed for is the airtime its result fills, so the
  // final bell lands exactly where every viewer's replay runs out of ticks —
  // at however many milliseconds the physics step gives each tick.
  for (const bout of fought) {
    assert.equal(
      Math.round(bout.endsAt - bout.startsAt),
      Math.round(bout.result!.ticks * BOXING_MODEL.physicsStepSeconds * 1000),
      `bout ${bout.id} was billed for airtime it does not fill`,
    );
  }
});

test("a trained brain landing mid-card never rolls the card back", async () => {
  const DB = fakeLeagueDatabase();
  const env = { DB };
  await processLeagueTick(env);

  const league = (await readLeagueForTraining(env))!;
  const target = league.roster.find((fighter) => fighter.id === "malik-okoro")!;
  const trained = {
    ...target,
    policy: { ...target.policy, generation: target.policy.generation + 9 },
  };

  // The training worker and the card write to the same league. Both go through
  // the gate, so neither can publish over the top of the other's work.
  await Promise.all([
    writeTrainedFighter(env, trained),
    processLeagueTick(env),
    processLeagueTick(env),
  ]);

  const reloaded = (await readLeagueForTraining(env))!;
  assert.equal(
    reloaded.roster.find((fighter) => fighter.id === trained.id)!.policy.generation,
    trained.policy.generation,
    "the trained brain was rolled back by a concurrent tick",
  );
  for (const version of DB.published) {
    for (const bout of version.card) {
      if (!bout.result) continue;
      assert.ok(bout.profiles || bout.committed, "a result lost the athletes it was fought by");
    }
  }
});

test("training merges onto newer fight records and fight-earned policy steps", () => {
  const league = createInitialLeague();
  const baseline = league.roster.find((fighter) => fighter.id === "malik-okoro")!;
  const trained = trainAthlete(league, baseline.id, {
    generations: 1,
    population: 2,
    opponents: 1,
    evaluationSeconds: 12,
  }).league.roster.find((fighter) => fighter.id === baseline.id)!;
  const latest = structuredClone(baseline);
  latest.record.wins += 1;
  latest.xp += 77;
  latest.policy.weights[0][0] += 0.125;
  latest.policy.learnedDecisions += 9;

  const merged = mergeTrainedFighter(latest, baseline, trained);
  const trainingWeightDelta =
    trained.policy.weights[0][0] - baseline.policy.weights[0][0];

  assert.equal(merged.record.wins, latest.record.wins);
  assert.equal(merged.xp, latest.xp);
  assert.equal(
    merged.policy.learnedDecisions,
    latest.policy.learnedDecisions +
      trained.policy.learnedDecisions -
      baseline.policy.learnedDecisions,
  );
  assert.ok(
    Math.abs(
      merged.policy.weights[0][0] -
      (latest.policy.weights[0][0] + trainingWeightDelta),
    ) < 1e-9,
  );
  assert.equal(
    merged.trainingBouts,
    latest.trainingBouts + trained.trainingBouts - baseline.trainingBouts,
  );
});

test("the simulation lease admits one worker at a time", async () => {
  const DB = fakeLeagueDatabase();
  await processLeagueTick({ DB });
  const lease = DB.rows.get("simulation-lease");
  assert.ok(lease, "a tick should have taken and then released the lease");
  // Released, so the next tick can fight the next bout.
  assert.equal(JSON.parse(lease.payload).until, 0);

  // While somebody holds it, nobody else fights a bout — but the card still
  // moves, because committing results and booking slots is deterministic.
  DB.rows.set("simulation-lease", {
    id: "simulation-lease",
    payload: JSON.stringify({ until: Date.now() + 60_000 }),
    updated_at: Date.now(),
  });
  const before = card(DB).filter((bout) => bout.result).length;
  await processLeagueTick({ DB });
  assert.equal(card(DB).filter((bout) => bout.result).length, before);
  assert.ok(card(DB).length > 0, "slots are still announced without the lease");
});

test("the first viewer waits for a missing card instead of seeing stale state", async () => {
  const DB = fakeLeagueDatabase();
  const { ctx, settle } = captureContext();

  const response = await handleLeagueRequest(
    new Request("http://localhost/api/league"),
    { DB },
    ctx,
  );
  const payload = await response.json() as { ok: boolean; card: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.card.length, CARD_BOUTS, "the first response has the full card");
  assert.ok(
    card(DB).some((bout) => bout.result),
    "the first imminent fight is ready before the response leaves",
  );
  assert.ok(DB.published.length > 0, "catch-up lands before stale state can be served");
  await settle();

  // A full card takes the final stale-state branch. Exercise it explicitly: a
  // cold league returns earlier for its missing card and would not catch a
  // missing airtime helper in the production path.
  const stored = DB.rows.get("broadcast")!;
  DB.rows.set("broadcast", {
    ...stored,
    payload: JSON.stringify({
      ...JSON.parse(stored.payload) as BroadcastState,
      card: card(DB).map((bout) => ({ ...bout, committed: true })),
    }),
  });
  await handleLeagueRequest(
    new Request("http://localhost/api/league/roster"),
    { DB: fakeLeagueDatabase() },
    captureContext().ctx,
  );
  const full = await handleLeagueRequest(
    new Request("http://localhost/api/league"),
    { DB },
    captureContext().ctx,
  );
  assert.equal(full.status, 200, "a full card can be checked against the live clock");
});

test("the public roster omits learned matrices and opponent dossiers", async () => {
  const DB = fakeLeagueDatabase();
  const { ctx } = captureContext();
  const response = await handleLeagueRequest(
    new Request("http://localhost/api/league/roster"),
    { DB },
    ctx,
  );
  const payload = await response.json() as {
    roster: {
      policy: { weights: unknown[] };
      opponentDossiers: Record<string, unknown>;
      publicActionPreferences: unknown[];
    }[];
  };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.roster[0].policy.weights, []);
  assert.deepEqual(payload.roster[0].opponentDossiers, {});
  assert.ok(payload.roster[0].publicActionPreferences.length > 0);
});

test("the admin reset replaces only the card, books it, and starts it after five minutes", async () => {
  const DB = fakeLeagueDatabase();
  const env = { DB, FORGE_ADMIN_TOKEN: "reset-test" };
  await processLeagueTick(env);
  const before = JSON.parse(DB.rows.get("broadcast")!.payload) as BroadcastState;
  const league = (await readLeagueForTraining(env))!;
  const target = league.roster.find((fighter) => fighter.id === "malik-okoro")!;
  const trained = {
    ...target,
    policy: { ...target.policy, generation: target.policy.generation + 5 },
  };
  await writeTrainedFighter(env, trained);

  const { ctx } = captureContext();
  const response = await handleLeagueRequest(
    new Request("http://localhost/api/league", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-admin": "reset-test",
      },
      body: JSON.stringify({ action: "reset" }),
    }),
    env,
    ctx,
  );
  const payload = await response.json() as { ok: boolean; reset: boolean };
  const after = JSON.parse(DB.rows.get("broadcast")!.payload) as BroadcastState;
  const carried = (await readLeagueForTraining(env))!;

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.reset, true);
  assert.equal(after.night, before.night + 1, "the replacement gets fresh market identity");
  assert.equal(after.card.length, CARD_BOUTS, "the whole card is set up again");
  assert.equal(after.card[0].result, null, "the first fight waits through the countdown");
  assert.equal(
    after.card[0].startsAt - after.clock.anchorLeagueMs,
    5 * 60 * 1000,
    "the opening bell is five minutes after the reset",
  );
  assert.ok(
    after.card.every((bout) => !before.card.some((entry) => entry.id === bout.id)),
    "the running and scheduled card was completely replaced",
  );
  assert.equal(
    carried.roster.find((fighter) => fighter.id === trained.id)!.policy.generation,
    trained.policy.generation,
    "resetting a card does not erase trained fighters or league history",
  );
  assert.equal(JSON.parse(DB.rows.get("simulation-lease")!.payload).until, 0);

  const firstBellReal = after.clock.anchorRealMs +
    (after.card[0].startsAt - after.clock.anchorLeagueMs) / after.clock.rate;
  await processLeagueTick(env, firstBellReal);
  assert.ok(card(DB)[0].result, "the first fight starts when the countdown reaches zero");
});

test("the next fight's ending is not in the response while its book is open", async () => {
  // A bout is simulated up to SIMULATE_LEAD_MS before its slot — the whole
  // thing at once, not a step at a time — so "on deck" and "already decided"
  // are the same state on the server. For those three minutes the winner of a
  // fight nobody had watched was served to anyone who asked for it, while that
  // fight was still tradable.
  //
  // Nothing about the card is scripted; the leak is that the simulation runs
  // ahead of the broadcast, and a market cannot price a fight whose answer is
  // already downloadable.
  const DB = fakeLeagueDatabase();
  const env = { DB };

  // One pass fights the opener and re-times everything behind it, so the
  // second slot's bell stops moving.
  await processLeagueTick(env);
  const opened = JSON.parse(DB.rows.get("broadcast")!.payload) as BroadcastState;
  const onDeckAt = opened.card[1].startsAt;

  // Stand the league clock a minute short of that bell: inside the window
  // where the fight exists on the server and has not started on screen.
  const realNow = Date.now();
  DB.rows.set("broadcast", {
    ...DB.rows.get("broadcast")!,
    payload: JSON.stringify({
      ...opened,
      clock: { ...opened.clock, anchorRealMs: realNow, anchorLeagueMs: onDeckAt - 60_000 },
    }),
  });
  await processLeagueTick(env);

  const { ctx } = captureContext();
  const response = await handleLeagueRequest(
    new Request("http://localhost/api/league"),
    env,
    ctx,
  );
  const payload = await response.json() as {
    leagueTime: number;
    upcoming: {
      id: number; seed: number; startsAt: number; endsAt: number;
      result: unknown; directives: unknown[];
    } | null;
  };

  const onDeck = payload.upcoming;
  assert.ok(onDeck, "there should be a fight on deck to check");
  assert.ok(onDeck.startsAt > payload.leagueTime, "on deck means it has not started");

  const stored = JSON.parse(DB.rows.get("broadcast")!.payload) as BroadcastState;
  const known = stored.card.find((bout) => bout.id === onDeck.id)!;
  assert.ok(known.result, "this proves nothing unless the server has already fought it");

  // The server knows. The response must not.
  assert.equal(onDeck.result, null, "the winner is served before the bell");
  assert.deepEqual(onDeck.directives, [], "the corner instructions replay the fight");
  // The seed alone reproduces it: the policies are deterministic and the
  // simulation ships in the browser bundle.
  assert.equal(onDeck.seed, 0, "the seed is the result in another form");
  // An exact final bell is a duration, and a duration is the round it ends in
  // — not the winner, but not nothing either.
  assert.notEqual(onDeck.endsAt, known.endsAt, "the real final bell leaks the finish");
});

test("a league row that cannot be read freezes the league instead of wiping it", async () => {
  // The one irreplaceable thing in here is the careers: every record, ladder
  // position and learned decision the brains have accumulated. A fresh league
  // used to be the fallback for *any* unreadable league row — bad JSON, an
  // unknown version, one malformed athlete out of thirty-six — and the next
  // tick wrote that fresh league straight over the top, silently.
  //
  // Frozen is a bad afternoon. Overwritten is unrecoverable. So it throws.
  const DB = fakeLeagueDatabase();
  const env = { DB };
  const careers = createInitialLeague();
  const real = { id: "league", payload: JSON.stringify(careers), updated_at: 1 };

  for (const corrupt of [
    "{not json at all",
    JSON.stringify({ version: 999, roster: [] }),
    JSON.stringify({ version: 9, roster: [{ id: "who", seed: "not a number" }] }),
  ]) {
    DB.rows.set("league", { ...real, payload: corrupt });
    await assert.rejects(
      () => readLeagueForTraining(env),
      /refusing/,
      `a league row of ${corrupt.slice(0, 24)}… must not be replaced`,
    );
    await assert.rejects(() => processLeagueTick(env), /refusing/);
    // Whatever failed, it wrote nothing over the row it could not read.
    assert.equal(DB.rows.get("league")!.payload, corrupt, "the bad row is still there to look at");
  }

  // Put the real careers back and the league reads them again, untouched.
  DB.rows.set("league", real);
  const recovered = await readLeagueForTraining(env);
  assert.deepEqual(
    recovered!.roster.map((fighter) => fighter.id).sort(),
    careers.roster.map((fighter) => fighter.id).sort(),
  );
});

test("a league with no row at all is the only thing that starts fresh", async () => {
  // The empty database is the one case a clean slate is actually correct.
  const DB = fakeLeagueDatabase();
  const fresh = await readLeagueForTraining({ DB });
  assert.equal(fresh!.roster.length, createInitialLeague().roster.length);
  assert.ok(fresh!.roster.every((fighter) => fighter.record.wins >= 0));
});

test("the first new worker preserves the league stored by the old training worker", async () => {
  const DB = fakeLeagueDatabase();
  const legacy = createInitialLeague();
  const fighter = legacy.roster.find((entry) => entry.id === "malik-okoro")!;
  fighter.policy.generation = 37;
  fighter.record.wins = 12;
  fighter.opponentDossiers["darius-cole"] = {
    opponentId: "darius-cole",
    boutsObserved: 4,
    roundsObserved: 11,
    headAttackRate: 0.48,
    bodyAttackRate: 0.39,
    pressureRate: 0.67,
    evasionRate: 0.14,
    guardRate: 0.22,
    averageRangeMeters: 1.08,
    dangerScore: 0.73,
    lastOutcome: "win",
    updatedWeek: 9,
  };
  DB.trainingRows.set("forge-league", { league_json: JSON.stringify(legacy) });

  const imported = (await readLeagueForTraining({ DB }))!;
  const carried = imported.roster.find((entry) => entry.id === fighter.id)!;
  assert.equal(carried.policy.generation, 37, "learned policy history was reset");
  assert.equal(carried.record.wins, 12, "fight record was reset");
  assert.deepEqual(
    carried.opponentDossiers["darius-cole"],
    fighter.opponentDossiers["darius-cole"],
    "opponent knowledge was reset",
  );
  assert.ok(DB.rows.has("league"), "the legacy league was not copied to its permanent row");

  // The old row stays as a recovery copy, but it can never overwrite the new
  // source of truth after the one-time import.
  DB.trainingRows.set("forge-league", {
    league_json: JSON.stringify(createInitialLeague()),
  });
  const reloaded = (await readLeagueForTraining({ DB }))!;
  assert.equal(
    reloaded.roster.find((entry) => entry.id === fighter.id)!.policy.generation,
    37,
  );
});

test("an unreadable legacy league freezes instead of starting over", async () => {
  const DB = fakeLeagueDatabase();
  DB.trainingRows.set("forge-league", { league_json: "{not json" });

  await assert.rejects(() => readLeagueForTraining({ DB }), /refusing/);
  assert.equal(DB.rows.has("league"), false, "bad legacy data was replaced");
});

test("an authenticated restore carries local D1 careers, fights, and training telemetry", async () => {
  const source = fakeLeagueDatabase();
  await processLeagueTick({ DB: source });
  const league = (await readLeagueForTraining({ DB: source }))!;
  const fighter = league.roster.find((entry) => entry.id === "malik-okoro")!;
  fighter.policy.generation = 41;
  fighter.record.wins = 17;

  const target = fakeLeagueDatabase();
  await processLeagueTick({ DB: target });
  const broadcast = JSON.parse(source.rows.get("broadcast")!.payload) as BroadcastState;
  const { ctx } = captureContext();
  const response = await handleLeagueRequest(
    new Request("http://localhost/api/league", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-admin": "restore-test",
      },
      body: JSON.stringify({
        action: "restore",
        confirm: "replace-hosted-state",
        league,
        broadcast,
        training: {
          status: "paused",
          targetId: fighter.id,
          remainingCycles: null,
          cycles: 8,
          bouts: 96,
          physicsSteps: 12_000,
          candidates: 24,
          checkpoints: 3,
          startFitness: 1.2,
          currentFitness: 1.9,
          rewardGain: 0.7,
          pauseRequested: true,
          lastError: null,
          createdAt: 10,
          updatedAt: 20,
        },
      }),
    }),
    { DB: target, FORGE_ADMIN_TOKEN: "restore-test" },
    ctx,
  );

  assert.equal(response.status, 200);
  const restored = (await readLeagueForTraining({ DB: target }))!;
  const carried = restored.roster.find((entry) => entry.id === fighter.id)!;
  assert.equal(carried.policy.generation, 41, "learned policy was not restored");
  assert.equal(carried.record.wins, 17, "fight record was not restored");
  assert.equal(target.trainingRows.get("forge-league")!.bouts, 96);
  assert.deepEqual(
    JSON.parse(target.rows.get("broadcast")!.payload).card,
    broadcast.card,
    "the current fight card was not restored",
  );
});

/** A league as it stood before the careers moved out of the row, with enough
 *  history on it that a split which quietly dropped something would show. */
function fatLeagueRow() {
  const careers = createInitialLeague();
  const marked = careers.roster.find((entry) => entry.id === "malik-okoro")!;
  marked.record = { wins: 21, losses: 2, draws: 1, knockouts: 14 };
  marked.policy.generation = 61;
  marked.policy.learnedDecisions = 48210;
  marked.policy.hiddenBias[0] = -0.4711;
  marked.opponentDossiers["darius-cole"] = {
    opponentId: "darius-cole",
    boutsObserved: 6,
    roundsObserved: 17,
    headAttackRate: 0.51,
    bodyAttackRate: 0.32,
    pressureRate: 0.7,
    evasionRate: 0.19,
    guardRate: 0.24,
    averageRangeMeters: 1.02,
    dangerScore: 0.81,
    lastOutcome: "win",
    updatedWeek: 11,
  };
  careers.season = 3;
  careers.week = 12;
  careers.boutsCompleted = 728;
  return { careers, payload: JSON.stringify(careers) };
}

test("the roster splits out of the league row without losing a career", async () => {
  const DB = fakeLeagueDatabase();
  const { careers, payload } = fatLeagueRow();
  DB.rows.set("league", { id: "league", payload, updated_at: 1 });

  const loaded = (await readLeagueForTraining({ DB }))!;

  // Every athlete is his own row now, in the order he sat in the array.
  assert.equal(DB.fighterRows.size, careers.roster.length);
  assert.deepEqual(
    [...DB.fighterRows.values()].sort((a, b) => a.ordinal - b.ordinal).map((row) => row.id),
    careers.roster.map((fighter) => fighter.id),
  );

  // The row that used to carry them is now just the season.
  const header = JSON.parse(DB.rows.get("league")!.payload) as Record<string, unknown>;
  assert.equal(header.roster, undefined, "the careers are still in the league row");
  assert.equal(header.season, 3);
  assert.equal(header.week, 12);
  assert.equal(header.boutsCompleted, 728);
  assert.ok(
    DB.rows.get("league")!.payload.length < 200,
    "the header should be bytes, not kilobytes",
  );

  // And the payload it was split from is kept, exactly as it stood.
  assert.equal(DB.rows.get("league-pre-split")!.payload, payload);

  // What comes back is the league that went in — records, learned weights,
  // dossiers and all.
  assert.deepEqual(loaded.roster, careers.roster);
  assert.equal(loaded.season, 3);
  assert.equal(loaded.boutsCompleted, 728);

  // Reading it again goes to the rows and splits nothing a second time.
  DB.fighterWrites.length = 0;
  const reread = (await readLeagueForTraining({ DB }))!;
  assert.deepEqual(reread.roster, careers.roster);
  assert.deepEqual(DB.fighterWrites, [], "a settled league rewrote its roster");
});

test("committing a bout writes the two men in it, not the whole roster", async () => {
  const DB = fakeLeagueDatabase();
  const { payload } = fatLeagueRow();
  DB.rows.set("league", { id: "league", payload, updated_at: 1 });
  const env = { DB };

  // Split first, so the write under test is an ordinary one.
  await readLeagueForTraining(env);
  await processLeagueTick(env);
  DB.fighterWrites.length = 0;

  // Run the card far enough forward to put a result on the board.
  let fought: string[] = [];
  for (let pass = 0; pass < 40 && fought.length === 0; pass += 1) {
    await processLeagueTick(env, Date.now() + pass * 60_000);
    fought = [...new Set(DB.fighterWrites)];
  }

  assert.ok(fought.length > 0, "no bout ever committed");
  assert.ok(
    fought.length <= 2,
    `a committed bout wrote ${fought.length} careers: ${fought.join(", ")}`,
  );
});

test("a career that cannot be read freezes the league instead of reseeding it", async () => {
  // The same promise the single league row made, now made per athlete: one
  // unreadable career stops the tick rather than being quietly replaced by a
  // debutant wearing the same name.
  const DB = fakeLeagueDatabase();
  const { payload } = fatLeagueRow();
  DB.rows.set("league", { id: "league", payload, updated_at: 1 });
  await readLeagueForTraining({ DB });

  const victim = DB.fighterRows.get("malik-okoro")!;
  const intact = { ...victim };
  DB.fighterRows.set("malik-okoro", { ...victim, policy: "{truncated" });

  await assert.rejects(() => readLeagueForTraining({ DB }), /refusing/);
  await assert.rejects(() => readLeagueForTraining({ DB }), /malik-okoro/);
  await assert.rejects(() => processLeagueTick({ DB }), /refusing/);
  assert.equal(
    DB.fighterRows.get("malik-okoro")!.policy,
    "{truncated",
    "the bad row is still there to look at",
  );

  DB.fighterRows.set("malik-okoro", intact);
  const recovered = (await readLeagueForTraining({ DB }))!;
  assert.equal(recovered.roster.find((entry) => entry.id === "malik-okoro")!.policy.generation, 61);
});

test("an athlete the league signs later lands as his own row", async () => {
  // The seeded roster grows, and a league stored before a signing gains him on
  // the next read. He has to arrive as his own row, at the back of the roster,
  // without the careers that were already there being rewritten to make room.
  const DB = fakeLeagueDatabase();
  const { careers } = fatLeagueRow();
  const newcomer = careers.roster.at(-1)!;
  const short = { ...careers, roster: careers.roster.filter((entry) => entry !== newcomer) };
  DB.rows.set("league", { id: "league", payload: JSON.stringify(short), updated_at: 1 });

  // A pre-split league gains him as the row table is built.
  const signed = (await readLeagueForTraining({ DB }))!;
  assert.ok(
    signed.roster.some((entry) => entry.id === newcomer.id),
    "the signing never reached the roster",
  );
  assert.equal(
    DB.fighterRows.get(newcomer.id)!.ordinal,
    careers.roster.length - 1,
    "he joined at the wrong place in the roster",
  );

  // And a league already split gains him the same way, touching nobody else.
  DB.fighterRows.delete(newcomer.id);
  DB.fighterWrites.length = 0;
  await processLeagueTick({ DB });

  assert.ok(DB.fighterRows.has(newcomer.id), "the signing never reached the roster table");
  assert.deepEqual(
    [...new Set(DB.fighterWrites)],
    [newcomer.id],
    "signing one athlete rewrote careers that had not moved",
  );
});
