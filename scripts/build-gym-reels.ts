/** Regenerates public/gym-reels/ — the canned sparring footage the gym cam
 *  loops.
 *
 *  The gym's sparring scene used to run the actual engine in the browser for a
 *  disposable practice round, which kept the whole simulation in the bundle
 *  for the sake of background footage. So the practice rounds are fought HERE,
 *  once, and recorded with the same codec the broadcast uses. The canvas draws
 *  whoever is actually on the floor over the recorded motion — identity comes
 *  from the `left`/`right` athlete props, not the reel — so a handful of reels
 *  covers every trainee.
 *
 *  Run it again to reroll the footage, or after engine changes worth showing:
 *
 *    node --experimental-strip-types scripts/build-gym-reels.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { ScheduledBout } from "../app/broadcast.ts";
import { BOXING_MODEL, createInitialLeague } from "../app/simulation.ts";
import { encodeTimeline } from "../app/fight-timeline.ts";
import { captureBout } from "../worker/fight-timeline.ts";

/** Enough that the loop does not read as a loop from across the room. */
const REEL_COUNT = 6;
const REEL_ROUND_SECONDS = 20;

const roster = createInitialLeague().roster;
const divisions = [...new Set(roster.map((fighter) => fighter.weightClass))];

mkdirSync(new URL("../public/gym-reels/", import.meta.url), { recursive: true });

for (let reel = 0; reel < REEL_COUNT; reel++) {
  // Rotate through the divisions so the reels carry visibly different builds
  // and tempos — a featherweight spar does not move like a heavyweight one.
  const division = divisions[reel % divisions.length];
  const pool = roster.filter((fighter) => fighter.weightClass === division);
  const blue = pool[reel % pool.length];
  const red = pool[(reel + 1 + Math.floor(reel / pool.length)) % pool.length];

  const bout: ScheduledBout = {
    id: 9000 + reel,
    seed: 730_000 + reel * 1013,
    division,
    kind: "contender",
    blueId: blue.id,
    redId: red.id,
    startsAt: 0,
    endsAt: 0,
    totalRounds: 1,
    roundSeconds: REEL_ROUND_SECONDS,
    result: null,
    directives: [],
    committed: false,
    profiles: [blue, red],
  };

  const encoded = encodeTimeline(captureBout(bout));
  const path = new URL(`../public/gym-reels/reel-${reel}.json`, import.meta.url);
  writeFileSync(path, encoded);
  console.log(
    `reel-${reel}: ${blue.lastName} v ${red.lastName} (${division}), ` +
      `${JSON.parse(encoded).ticks} ticks at ${1 / BOXING_MODEL.physicsStepSeconds} Hz, ` +
      `${(encoded.length / 1024).toFixed(0)} KB`,
  );
}
