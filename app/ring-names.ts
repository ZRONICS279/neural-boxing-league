import type { Fighter } from "./fight-model";

/* Ring names are presentation, the same claim the LOOKS table makes about
 * hair: the league row keeps the fighter's founding name, his record, his
 * policy and his dossiers, and the display swaps the name at the door. Keyed
 * by seed to match LOOKS, applied wherever roster data enters the client —
 * never on anything that gets written back, so the save under the new name
 * is byte-for-byte the save under the old one.
 *
 * Every name here was picked to be nobody's property: real animals (Harambe,
 * Koko, Bokito, Snowflake, Wojtek, Hank the Tank), myth and folklore (Talos,
 * Yorick), plain words (Clanker, Zeta, Jack), or coinages of our own (Yogan,
 * Eskobear). The famous franchise names were all considered and all failed
 * the same test — a coined trademark, or a generic word welded to its
 * matching species. */
interface RingName {
  first?: string;
  last?: string;
  nickname?: string;
}

const RING_NAMES: Record<number, RingName> = {
  // Skeletons — Mori keeps his name; "Whisper" was already the brand.
  131: { first: "", last: "Jack" }, // Óscar Nuñez, Bogotá
  139: { first: "", last: "Doot" }, // Rico Salvatore, Naples — the horn player
  233: { first: "", last: "Yorick" }, // Otto Lindqvist, Malmö — Elsinore is across the bridge
  // Aliens — Vargas keeps his; Relámpago fell out of the sky already.
  137: { first: "", last: "Zeta" }, // Ibrahim Diallo, Dakar — Zeta Reticuli
  149: { first: "", last: "Yogan" }, // Jae-won Sohn, Incheon — the green one
  // Robots — Ito and Haddad keep theirs.
  151: { first: "", last: "Clanker" }, // Viktor Zeman, Ostrava — steel-town iron
  239: { first: "", last: "Talos" }, // Dario Fontana, Trieste — the bronze original
  // The cyborg keeps his whole name and takes the nickname; he is still the
  // same man from Newark, which is the entire point of him.
  89: { nickname: "Cyborg" }, // Andre Bishop
  // Grizzlies — Hale keeps his name; one bear answers to the register.
  173: { first: "Hank", last: "The Tank" }, // Ivan Brackett, Pittsburgh
  181: { first: "", last: "Wojtek" }, // Grigor Pavlenko, Kharkiv — the corporal
  199: { first: "Pablo", last: "Eskobear" }, // Bo Whitaker, Omaha — the dusted muzzle
  // Gorillas — all four go over.
  191: { first: "", last: "Harambe" }, // Wesley Duke, Houston
  193: { first: "", last: "Bokito" }, // Tomáš Kovač, Bratislava — the escape artist
  223: { first: "", last: "Koko" }, // Frank Delgado, Fresno — she lived in California
  251: { first: "", last: "Snowflake" }, // Matías Ferreira, Rosario — the albino
};

/* The archive files bouts under name strings, not fighter objects, so past
 * cards need the id looked back up to a seed before the table above applies. */
const SEED_BY_ID: Record<string, number> = {
  "oscar-nunez": 131,
  "rico-salvatore": 139,
  "otto-lindqvist": 233,
  "ibrahim-diallo": 137,
  "jae-won-sohn": 149,
  "viktor-zeman": 151,
  "dario-fontana": 239,
  "andre-bishop": 89,
  "ivan-brackett": 173,
  "grigor-pavlenko": 181,
  "bo-whitaker": 199,
  "wesley-duke": 191,
  "tomas-kovac": 193,
  "frank-delgado": 223,
  "matias-ferreira": 251,
};

export function withRingName(fighter: Fighter): Fighter {
  const ring = RING_NAMES[Math.abs(fighter.seed)];
  if (!ring) return fighter;
  return {
    ...fighter,
    firstName: ring.first ?? fighter.firstName,
    lastName: ring.last ?? fighter.lastName,
    nickname: ring.nickname ?? fighter.nickname,
  };
}

export function applyRingNames(roster: Fighter[]): Fighter[] {
  return roster.map(withRingName);
}

/** For archive rows, which carry the name the bout was filed under. */
export function ringLastName(id: string, filed: string): string {
  const seed = SEED_BY_ID[id];
  const ring = seed === undefined ? undefined : RING_NAMES[seed];
  return ring?.last ?? filed;
}
