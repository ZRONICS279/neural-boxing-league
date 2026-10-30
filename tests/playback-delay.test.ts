import assert from "node:assert/strict";
import test from "node:test";
import { BOXING_MODEL } from "../app/fight-model.ts";
import { TIMELINE_CHUNK_TICKS, TIMELINE_SAMPLE_SECONDS } from "../app/fight-timeline.ts";
import { PLAYBACK_DELAY_MS } from "../app/broadcast-store.ts";

/** The playback delay is what buys the network its time. A chunk is only
 *  servable once its whole span has aired, so a playhead PLAYBACK_DELAY_MS
 *  behind the bell reaches each chunk `PLAYBACK_DELAY_MS − CHUNK_MS` after it
 *  became fetchable — less one sample for tick rounding. At one chunk of delay
 *  that margin was a single 20 ms sample, so every boundary froze for a round
 *  trip; the picture stuttered every five seconds by construction. The delay
 *  must leave at least a whole chunk of margin: the next chunk is then always
 *  servable the moment the current one starts playing, and a fetch has five
 *  real seconds to land before anyone notices. */
test("the playback delay leaves a full chunk of fetch budget", () => {
  const chunkMs = TIMELINE_CHUNK_TICKS * BOXING_MODEL.physicsStepSeconds * 1000;
  const budget = PLAYBACK_DELAY_MS - chunkMs - TIMELINE_SAMPLE_SECONDS * 1000;
  assert.ok(
    budget >= chunkMs,
    `fetch budget ${budget}ms is under one chunk (${chunkMs}ms) — boundary stalls are back`,
  );
});
