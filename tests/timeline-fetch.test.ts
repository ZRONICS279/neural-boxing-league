import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createTimelinePlayer } from "../app/timeline-play.ts";

interface FetchCall {
  url: string;
  aborted: boolean;
  resolve: (response: { ok: boolean; status: number }) => void;
  reject: (error: Error) => void;
}

/** A fetch that never touches the network: every call parks until the test
 *  settles it, and honours its abort signal the way the real one would. */
function stubFetch(calls: FetchCall[]) {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const call: FetchCall = {
        url: String(input),
        aborted: false,
        resolve: resolve as FetchCall["resolve"],
        reject,
      };
      init?.signal?.addEventListener("abort", () => {
        call.aborted = true;
        reject(new Error("aborted"));
      });
      calls.push(call);
    })) as typeof fetch;
}

/** Lets the player's own then/catch/finally chains run. `setImmediate` is
 *  real even under mocked timers, which is the point. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function trackedFetch(t: TestContext) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(calls);
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("the playhead chunk and its read-ahead load side by side", async (t) => {
  const calls = trackedFetch(t);
  const player = createTimelinePlayer(9001);

  // Both aired chunks go on the wire at once: a tab rejoining from the
  // background rebuilds its whole runway in one round trip, not two.
  player.ensure(0, 750);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /chunk=0/);
  assert.match(calls[1].url, /chunk=1/);
  // Asking again while both are on the wire adds nothing.
  player.ensure(0, 750);
  assert.equal(calls.length, 2);
  // A chunk whose span has not fully aired is never asked for.
  assert.ok(calls.every((call) => !call.url.includes("chunk=2")));

  player.stop();
  assert.ok(calls[0].aborted && calls[1].aborted, "stop abandons the wire");
  await flush();
});

test("a failure retries in a beat; not-aired keeps the courtesy wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = trackedFetch(t);
  const player = createTimelinePlayer(9002);

  player.ensure(0, 250);
  assert.equal(calls.length, 1, "read-ahead waits for its span to air");
  calls[0].reject(new Error("connection reset"));
  await flush();
  player.ensure(0, 250);
  assert.equal(calls.length, 1, "a fresh failure is not hammered");
  t.mock.timers.tick(400);
  player.ensure(0, 250);
  assert.equal(calls.length, 2, "a network failure retries in a beat");

  calls[1].resolve({ ok: false, status: 404 });
  await flush();
  t.mock.timers.tick(600);
  player.ensure(0, 250);
  assert.equal(calls.length, 2, "not-aired sits out the courtesy interval");
  t.mock.timers.tick(1000);
  player.ensure(0, 250);
  assert.equal(calls.length, 3);

  player.stop();
  await flush();
});

test("a hung request is abandoned instead of freezing the picture", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = trackedFetch(t);
  const player = createTimelinePlayer(9003);

  player.ensure(0, 250);
  assert.equal(calls.length, 1);
  // Nothing ever answers. The deadline cuts the request loose…
  t.mock.timers.tick(3000);
  await flush();
  assert.ok(calls[0].aborted, "the wedged request is abandoned");
  // …and one retry beat later the player is asking again.
  t.mock.timers.tick(400);
  player.ensure(0, 250);
  assert.equal(calls.length, 2);

  player.stop();
  await flush();
});
