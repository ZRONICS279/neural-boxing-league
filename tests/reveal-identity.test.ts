import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledBout } from "../app/broadcast-model.ts";
import { fightIdentity, revealOf } from "../app/broadcast-store.ts";

/** The live row a viewer polls mid-fight: `result` masked, `endsAt` padded to
 *  the placeholder every unfought slot uses, so nothing on the wire says which
 *  round the fight ends in. */
function maskedCut(): ScheduledBout {
  return {
    id: 18,
    seed: 0,
    division: "middleweight",
    kind: "title",
    blueId: "fl-okoro",
    redId: "fl-bright",
    startsAt: 100_000,
    endsAt: 100_000 + 15 * 60_000,
    totalRounds: 5,
    roundSeconds: 180,
    result: null,
    directives: [],
    committed: false,
  };
}

/** The same row one poll later, after the final bell went on the league
 *  clock: the mask lifts, `endsAt` snaps to the true finish and the result
 *  appears. Same slot, same bell, same fight. */
function revealedCut(): ScheduledBout {
  return {
    ...maskedCut(),
    endsAt: 100_000 + 11 * 60_000,
    result: {
      winnerId: "fl-bright",
      finish: "KO",
      round: 4,
      ticks: 33_000,
      blueLanded: 61,
      redLanded: 74,
    },
    committed: true,
  };
}

test("the reveal is the same fight, not a republish", () => {
  const held = fightIdentity(maskedCut())!;
  const next = fightIdentity(revealedCut())!;
  // The identities differ — that is what used to drop the athlete snapshots
  // and cut the stream to "between fights" across the knockout count — but
  // the reveal check recognises the mask lifting and keeps the pair.
  assert.notEqual(held, next);
  assert.equal(revealOf(held, next), true);
});

test("a genuine republish is still a restart", () => {
  const held = fightIdentity(maskedCut())!;

  // An admin ringing the bell early moves the airtime: different fight.
  const rebelled = revealedCut();
  rebelled.startsAt = 40_000;
  assert.equal(revealOf(held, fightIdentity(rebelled)!), false);

  // New corner instructions mean a re-simulated bout: different fight.
  const redirected = revealedCut();
  redirected.directives = [{
    tick: 9_000,
    corner: "red",
    directive: {
      focus: "pressure",
      pace: 0.7,
      risk: 0.5,
      target: "head",
      ringMode: "pressure",
      confidence: 0.6,
      note: "walk him down",
      source: "between-round",
      issuedRound: 3,
    },
  }];
  assert.equal(revealOf(held, fightIdentity(redirected)!), false);

  // A different slot altogether never matches, revealed or not.
  const otherSlot = revealedCut();
  otherSlot.id = 19;
  assert.equal(revealOf(held, fightIdentity(otherSlot)!), false);

  // Two revealed cuts that disagree are rival simulations, not a reveal.
  const revealed = fightIdentity(revealedCut())!;
  const refought = revealedCut();
  refought.result = { ...refought.result!, ticks: 41_000 };
  assert.equal(revealOf(revealed, fightIdentity(refought)!), false);

  // And the mask never comes back down: revealed → masked is not a reveal.
  assert.equal(revealOf(revealed, held), false);
});
