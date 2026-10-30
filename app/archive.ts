import type { Fighter, WeightClassId } from "./fight-model.ts";

/** What the archive is, on both sides of the wire.
 *
 * The worker writes these rows and the browser draws them, so the shape lives
 * here rather than in either — the same reason `broadcast.ts` sits in `app/` and
 * is imported by the worker. */

/** One fight the league has finished, as the listing knows it.
 *
 * Everything here is a few hundred bytes and is kept for as long as the league
 * runs. The replay that goes with it is far heavier and is not: `replayable`
 * says whether this fight can still be watched, and it goes false on the older
 * end of the archive without the result ever going with it. */
export interface ArchivedFight {
  id: number;
  night: number;
  season: number;
  week: number;
  division: WeightClassId;
  kind: "contender" | "title";
  blueId: string;
  redId: string;
  /** Last names, frozen at the bell. A fight is read out under the names the
   *  two men had when they fought it, not the ones the roster carries now. */
  blueName: string;
  redName: string;
  winnerId: string | null;
  finish: string;
  round: number;
  totalRounds: number;
  ticks: number;
  blueLanded: number;
  redLanded: number;
  /** Opening bell on the league clock — the slot it was fought in. */
  startedAt: number;
  /** Final bell in wall time, which is the one a date can be read off. */
  airedAt: number;
  replayable: boolean;
}

export type ArchiveListFeed =
  | { ok: true; fights: ArchivedFight[]; nextBefore: number | null }
  | { ok: false; error: string };

export type ArchiveFightFeed =
  | {
      ok: true;
      fight: ArchivedFight;
      /** The pair as the public knows them, frozen at the bell — careers and
       *  tendencies, no learned matrices. The fight itself plays from the
       *  recorded timeline; nothing the engine could run ships. */
      profiles: [Fighter, Fighter] | null;
    }
  | { ok: false; error: string };

/** The speeds a rewatch is offered at.
 *
 * A live bout runs at one; the archive is a fight somebody already knows the
 * ending of, so it is allowed to be hurried. Twelve gets a three-round fight
 * down to under a minute, which is about as fast as the ring still reads as a
 * fight rather than a flicker. */
export const REPLAY_SPEEDS = [1, 2, 4, 12] as const;

export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** How a verdict is said out loud, in one line. */
export function verdictLabel(fight: {
  winnerId: string | null;
  finish: string;
  round: number;
  totalRounds: number;
}) {
  if (!fight.winnerId) return `Draw · ${fight.totalRounds} rounds`;
  return fight.finish === "Decision"
    ? `Decision · R${fight.totalRounds}`
    : `${fight.finish} · R${fight.round}`;
}
