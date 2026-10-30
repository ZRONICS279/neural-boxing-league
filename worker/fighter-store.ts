import type { Fighter } from "../app/simulation.ts";
import type { LeagueDatabase } from "./league.ts";

/** The roster, one row per fighter.
 *
 * Careers used to ride in the league row beside the season and the week: one
 * JSON blob holding all thirty-six men, rewritten in full every time anything
 * about any of them moved. Measured on the live league that blob was 673 KB,
 * and 96% of it was the part almost nothing reads — 15 KB of policy matrices
 * and 2.5 KB of opponent dossiers per fighter, against 750 bytes of the
 * identity, stats and record that the roster page, the ladders and the
 * matchmaker actually run on. Committing a bout paid to serialise the whole
 * megabyte to move two careers.
 *
 * So the three parts are stored apart, because they are read apart:
 *
 *   profile   identity, stats, record, conditioning, level — read constantly
 *   policy    the learned matrices — read only by the two men in tonight's
 *             bout and by whoever is in the gym
 *   dossiers  what he knows about specific opponents — private, and the one
 *             that grows with every new name on the roster
 *
 * Nothing above the store sees this. `LeagueState.roster` is still a plain
 * `Fighter[]` in memory and every caller is unchanged; the rows are assembled
 * into that shape on the way in and taken apart again on the way out.
 *
 * Row order is carried explicitly rather than left to the primary key. The
 * engine is deterministic and the roster array is an input to it, so the order
 * fighters come back in has to be the order they went in — not alphabetical by
 * id, which is what `ORDER BY id` would quietly have made it. */

/** A fighter as he sits in D1: three blobs and the place he holds in the
 *  roster array. */
export interface FighterRow {
  id: string;
  ordinal: number;
  profile: string;
  policy: string;
  dossiers: string;
}

/** What a load hands back — the athletes, plus the ordinals they arrived with
 *  so a later write can tell whether anybody moved. */
export interface StoredRoster {
  roster: unknown[];
  ordinals: Map<string, number>;
}

let schemaReady: Promise<unknown> | null = null;

/** Same once-per-isolate check the league row uses, and for the same reason:
 *  the broadcast poll and the training poll both land here, and concurrent DDL
 *  is what the local D1 emulator intermittently fails on. */
export function ensureFighterSchema(db: LeagueDatabase) {
  schemaReady ??= db.prepare(`
    CREATE TABLE IF NOT EXISTS fighters (
      id TEXT PRIMARY KEY NOT NULL,
      ordinal INTEGER NOT NULL,
      profile TEXT NOT NULL,
      policy TEXT NOT NULL,
      dossiers TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `).run().catch((error) => {
    // A failed check must not be cached, or the isolate never recovers.
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** Only for the tests, which build a fresh database per case and would
 *  otherwise inherit the first one's memoised promise. */
export function resetFighterSchemaCache() {
  schemaReady = null;
}

export async function readFighterRows(db: LeagueDatabase) {
  const statement = db.prepare(
    "SELECT id, ordinal, profile, policy, dossiers FROM fighters ORDER BY ordinal",
  );
  if (!statement.all) {
    throw new Error("This database cannot read the roster a row at a time.");
  }
  return (await statement.all<FighterRow>()).results ?? [];
}

/** Puts the three blobs back together into one athlete.
 *
 * A row that will not parse throws, and says whose row it was. The old blob
 * could only fail all-or-nothing, so this is the finer-grained version of the
 * same promise the league row makes: a career that cannot be read stops the
 * tick dead rather than being quietly replaced by a debutant wearing the same
 * name. Frozen is a bad afternoon; overwritten is unrecoverable. */
function fighterFrom(row: FighterRow): unknown {
  const part = (name: string, value: string) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(
        `fighter ${row.id}: ${name} is not JSON (${value.length} bytes) — refusing to replace the career with a fresh one`,
      );
    }
  };
  const profile = part("profile", row.profile);
  if (!profile || typeof profile !== "object") {
    throw new Error(`fighter ${row.id}: profile is not an athlete`);
  }
  return {
    ...(profile as Record<string, unknown>),
    policy: part("policy", row.policy),
    opponentDossiers: part("dossiers", row.dossiers),
  };
}

/** The stored roster, or null if the table has never held one.
 *
 * Null means "no roster here" and nothing more — deciding what to do about
 * that (import the old blob, or seed a brand-new league) belongs to the
 * caller, which is the only place that can see the league row too. */
export async function readStoredRoster(db: LeagueDatabase): Promise<StoredRoster | null> {
  const rows = await readFighterRows(db);
  if (rows.length === 0) return null;
  return {
    roster: rows.map(fighterFrom),
    ordinals: new Map(rows.map((row) => [row.id, Number(row.ordinal)])),
  };
}

/** Splits an athlete back into the three blobs he is stored as. */
function partsOf(fighter: Fighter) {
  const { policy, opponentDossiers, ...profile } = fighter;
  return {
    profile: JSON.stringify(profile),
    policy: JSON.stringify(policy),
    dossiers: JSON.stringify(opponentDossiers ?? {}),
  };
}

export function fighterUpsert(db: LeagueDatabase, fighter: Fighter, ordinal: number, now: number) {
  const parts = partsOf(fighter);
  return db.prepare(`
    INSERT INTO fighters (id, ordinal, profile, policy, dossiers, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ordinal = excluded.ordinal,
      profile = excluded.profile,
      policy = excluded.policy,
      dossiers = excluded.dossiers,
      updated_at = excluded.updated_at
  `).bind(fighter.id, ordinal, parts.profile, parts.policy, parts.dossiers, now);
}

/** Writes only the athletes who actually moved.
 *
 * The engine returns a fresh object for a fighter it changed and the same one
 * for everybody else, so identity is the honest test for "did this career
 * move" — the same test `persist` already applies to the league as a whole. A
 * committed bout dirties two men and training dirties one, which is why this
 * is worth doing: 36 KB and 18 KB respectively, against the 673 KB the single
 * blob charged for either.
 *
 * A fighter who has shifted position in the roster is written too, even if
 * nothing about him changed, so the stored ordinals stay a faithful picture of
 * the array. */
export function dirtyFighterStatements(
  db: LeagueDatabase,
  roster: Fighter[],
  previous: { roster: Fighter[]; ordinals: Map<string, number> } | null,
  now: number,
) {
  const before = new Map((previous?.roster ?? []).map((fighter) => [fighter.id, fighter]));
  const statements = [];
  for (let ordinal = 0; ordinal < roster.length; ordinal += 1) {
    const fighter = roster[ordinal];
    const moved = previous?.ordinals.get(fighter.id) !== ordinal;
    if (!moved && before.get(fighter.id) === fighter) continue;
    statements.push(fighterUpsert(db, fighter, ordinal, now));
  }
  return statements;
}

/** Brings the table into line with the roster that was just loaded.
 *
 * Two things put a fighter in the roster without a row behind him: the seeded
 * intake grows, so an older save gains an athlete the moment this build reads
 * it, and a row can go missing. Either way he is written where he stands,
 * which is what makes a signing land by itself rather than waiting for
 * somebody else's bout to drag the whole league through a write.
 *
 * Ordinals are reconciled at the same time, because the array index is the
 * truth about where a man sits and a stored ordinal is only a record of where
 * he sat. */
export function reconcileStatements(
  db: LeagueDatabase,
  roster: Fighter[],
  ordinals: Map<string, number>,
  now: number,
) {
  const statements = [];
  for (let ordinal = 0; ordinal < roster.length; ordinal += 1) {
    if (ordinals.get(roster[ordinal].id) === ordinal) continue;
    statements.push(fighterUpsert(db, roster[ordinal], ordinal, now));
  }
  return statements;
}

/** One transaction, so careers cannot land half-committed.
 *
 * The blob was atomic for free — one row, one write. Splitting it means the
 * batch has to buy that back, which is exactly what `db.batch` is for. Both
 * the ordinary dirty write and the one-time split go through here, so neither
 * can leave a roster half-moved. The fallback path is for the test doubles,
 * which answer one statement at a time. */
export async function writeRows(
  db: LeagueDatabase,
  statements: ReturnType<LeagueDatabase["prepare"]>[],
) {
  if (statements.length === 0) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}
