import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTORS,
  SETTLED_WINNER,
  SIDE_BLUE,
  SIDE_RED,
  SIZE_STEP,
  addressWord,
  athleteIdToBytes32,
  bytes32ToAthleteId,
  buyCalldata,
  decodeWords,
  encodeCall,
  explainError,
  foldedAsks,
  foldedBook,
  isQuoted,
  midPrice,
  oddsForFight,
  outcomeFromCode,
  settledPrice,
  walkBook,
  word,
} from "../app/market.ts";
import { DatabaseSync } from "node:sqlite";
import { handleMarketRequest, indexMarketEvents } from "../worker/market.ts";
import type { LeagueDatabase } from "../worker/league.ts";

/** The market client has no web3 library behind it, so the encoding is the part
 *  worth testing: a selector that is one nibble out, or a word padded on the
 *  wrong end, produces calldata a node accepts and a contract misreads. */

/* -------------------------------------------------------------- the codec */

test("selectors match the deployed signatures", () => {
  // Cross-checked against `cast sig` on clawpolymarket's contracts. Pinned
  // here so a hand-edit to the table fails a test rather than a transaction.
  assert.equal(SELECTORS.placeBuyOrder, "0x3ba153d1");
  assert.equal(SELECTORS.placeSellOrder, "0x206e210f");
  assert.equal(SELECTORS.getBout, "0x604e053b");
  assert.equal(SELECTORS.getFullBook, "0xcbf17da0");
  assert.equal(SELECTORS.getPosition, "0xd29f541d");
  assert.equal(SELECTORS.getCard, "0xf1b166e0");
  assert.equal(SELECTORS.approve, "0x095ea7b3");
  assert.equal(SELECTORS.balanceOf, "0x70a08231");
  for (const selector of Object.values(SELECTORS)) {
    assert.match(selector, /^0x[0-9a-f]{8}$/);
  }
});

test("words are 32 bytes, right-aligned", () => {
  assert.equal(word(0), "0".repeat(64));
  assert.equal(word(1), "0".repeat(63) + "1");
  assert.equal(word(255), "0".repeat(62) + "ff");
  assert.equal(
    word(10n ** 24n),
    "00000000000000000000000000000000000000000000d3c21bcecceda1000000",
  );
  assert.throws(() => word(-1));
});

test("addresses are left-padded and case-folded", () => {
  const padded = addressWord("0x3D46a3Bf7974eA5c84f0C9D6F089417D455170Dc");
  assert.equal(padded.length, 64);
  assert.equal(padded, "0".repeat(24) + "3d46a3bf7974ea5c84f0c9d6f089417d455170dc");
  assert.throws(() => addressWord("0xnope"));
});

test("a buy is a selector and five words", () => {
  const data = buyCalldata(7, 1, 42, 500_000n);
  assert.equal(data.slice(0, 10), SELECTORS.placeBuyOrder);
  const args = decodeWords("0x" + data.slice(10));
  assert.deepEqual(args, [7n, 1n, 42n, 500_000n, 0n]);
});

test("calldata round-trips through the decoder", () => {
  const data = encodeCall(SELECTORS.getPosition, [12, "0x3D46a3Bf7974eA5c84f0C9D6F089417D455170Dc"]);
  const args = decodeWords("0x" + data.slice(10));
  assert.equal(args[0], 12n);
  assert.equal(args[1], BigInt("0x3d46a3bf7974ea5c84f0c9d6f089417d455170dc"));
});

/* ------------------------------------------------------------ fighter ids */

test("athlete ids survive the trip to bytes32 and back", () => {
  for (const id of ["a1", "flyweight-04", "x".repeat(31)]) {
    assert.equal(bytes32ToAthleteId(athleteIdToBytes32(id)), id);
  }
});

test("ids are left-aligned, the way the operator books them", () => {
  // `ethers.encodeBytes32String("ab")` — UTF-8 first, zero padding after.
  assert.equal(athleteIdToBytes32("ab"), "0x6162" + "0".repeat(60));
});

test("an id with no bytes32 form is refused, not truncated", () => {
  // Silently cutting this to 31 bytes would book a market on a different
  // fighter, which is the one failure mode worth a hard error.
  assert.throws(() => athleteIdToBytes32("y".repeat(32)));
});

test("a bigint from returndata decodes as an id", () => {
  const asWord = BigInt(athleteIdToBytes32("flyweight-04"));
  assert.equal(bytes32ToAthleteId(asWord), "flyweight-04");
});

/* ------------------------------------------------------------------ prices */

test("the mid crosses the book, and admits to 50 when there isn't one", () => {
  assert.equal(midPrice(40, 44), 42);
  assert.equal(midPrice(40, 0), 40);
  assert.equal(midPrice(0, 44), 44);
  assert.equal(midPrice(0, 0), 50);
});

test("an empty ask is 100, and must not price the market at certainty", () => {
  // The contract seeds bestAsk at 100 to mean "nothing resting" — ticks only
  // run 1–99. Reading it as a real offer put a fight at 100% the instant a
  // complementary match cleared both sides of its book.
  assert.equal(midPrice(0, 100), 50);
  assert.equal(midPrice(70, 100), 70);
  // With nothing resting at all, the last print is the honest answer.
  assert.equal(midPrice(0, 100, 74), 74);
  assert.equal(midPrice(0, 0, 74), 74);
  // A live book still wins over a stale print.
  assert.equal(midPrice(70, 72, 20), 71);
});

test("a bid on one side is an offer on the other", () => {
  // How the league seeds a book: bids on both corners, no asks anywhere. Read
  // one side at a time that is a market with no offer in it; folded together it
  // is 64 bid at 68, which is what it actually trades at.
  const blue = foldedBook(64, 100, 32, 100);
  assert.deepEqual(blue, { bid: 64, ask: 68 });
  const red = foldedBook(32, 100, 64, 100);
  assert.deepEqual(red, { bid: 32, ask: 36 });
  // Mid of the folded book is the line the league quoted, not the bid.
  assert.equal(midPrice(blue.bid, blue.ask), 66);

  // A real ask still wins when it is the better price, and loses when it isn't.
  assert.equal(foldedBook(64, 67, 32, 100).ask, 67);
  assert.equal(foldedBook(64, 70, 32, 100).ask, 68);
  // Nothing on either side stays nothing.
  assert.deepEqual(foldedBook(0, 100, 0, 100), { bid: 0, ask: 0 });
});

test("depth a buyer can reach includes the other side's bids", () => {
  const asks = [{ price: 70, shares: 5 }];
  const otherBids = [{ price: 32, shares: 12 }, { price: 30, shares: 8 }];
  // 32¢ on red is 68¢ on blue, and 30¢ is 70¢ — which lands on the resting ask
  // and has to add to it rather than replace it.
  assert.deepEqual(foldedAsks(asks, otherBids), [
    { price: 68, shares: 12 },
    { price: 70, shares: 13 },
  ]);
  // Walking that ladder now fills where it used to say "this will rest".
  assert.equal(walkBook(foldedAsks(asks, otherBids), 12).filled, 12);
  assert.equal(walkBook(asks, 12).filled, 5);
});

test("an unquoted book is told apart from a genuine 50¢ market", () => {
  // Both read 50. One is a market that thinks the fight is even and the other
  // is a book with nothing on it, and the panel draws the league's own line
  // over the second — so it has to be able to tell which it is holding.
  assert.equal(isQuoted(0, 100), false);
  assert.equal(isQuoted(0, 0), false);
  assert.equal(isQuoted(50, 50), true);
  assert.equal(isQuoted(0, 100, 50), true);
  // The sentinel is not a quote however it is spelled.
  assert.equal(isQuoted(0, 100, 100), false);
});

test("a scored fight prints at certainty, not at its last mid", () => {
  assert.equal(settledPrice("blue"), SETTLED_WINNER);
  assert.equal(settledPrice("red"), 100 - SETTLED_WINNER);
  // A draw is a void, and a void pays both sides the same.
  assert.equal(settledPrice("void"), 50);
  assert.equal(settledPrice("unresolved"), null);
  // Inside the 1–99 ticks the book itself quotes, so the chart's axis holds.
  assert.ok(SETTLED_WINNER > 0 && SETTLED_WINNER < 100);
});

test("walking the book stops at the depth that is actually there", () => {
  const asks = [
    { price: 40, shares: 10 },
    { price: 42, shares: 5 },
  ];
  // Inside the first level: the top of book is the whole price.
  assert.deepEqual(walkBook(asks, 8), { filled: 8, avgPrice: 40, cost: 3.2 });
  // Through it: the average has to move, or a large order is quoted a price
  // only the first few shares were ever getting.
  const deep = walkBook(asks, 15);
  assert.equal(deep.filled, 15);
  assert.ok(deep.avgPrice > 40 && deep.avgPrice < 42);
  // Past it: partial, and honest about how partial.
  assert.equal(walkBook(asks, 100).filled, 15);
  assert.equal(walkBook([], 10).filled, 0);
});

test("outcomes decode in contract order", () => {
  assert.equal(outcomeFromCode(0), "unresolved");
  assert.equal(outcomeFromCode(1), "blue");
  assert.equal(outcomeFromCode(2), "red");
  assert.equal(outcomeFromCode(3), "void");
});

test("order sizes step in hundredths of a share", () => {
  assert.equal(SIZE_STEP, 100n);
});

test("a row read from the wrong corner is turned round, quoted flag and all", () => {
  const board = [{
    boutId: 4,
    fighterA: "kaito-mori",
    fighterB: "emilio-vargas",
    priceA: 63,
    quoted: false,
    closed: false,
    resolved: false,
    outcome: "unresolved" as const,
    volume: 0,
  }];
  assert.deepEqual(oddsForFight(board, "kaito-mori", "emilio-vargas"), {
    boutId: 4, blue: 63, red: 37, quoted: false, closed: false, resolved: false,
  });
  // Booked with the corners the other way about: the same fight, mirrored.
  assert.deepEqual(oddsForFight(board, "emilio-vargas", "kaito-mori"), {
    boutId: 4, blue: 37, red: 63, quoted: false, closed: false, resolved: false,
  });
  assert.equal(oddsForFight(board, "kaito-mori", "nobody"), null);
});

/* ------------------------------------------------------------------ errors */

test("two-letter reverts become something a person can act on", () => {
  // "CL" is the book's own closed code. This asserted "BC" for a while, which
  // is the parlay contract's — nothing this client talks to can raise it. The
  // wording is deliberately quiet about WHY the book is not matching: the
  // close now lands while the finish is still airing, and "closed" on screen
  // during a live round announces that the fight is decided.
  assert.match(explainError(new Error("execution reverted: CL")), /not matching orders/i);
  assert.match(explainError(new Error("execution reverted: IS")), /shares/i);
  // "ISV" must not be read as "IS" — one says you are short of shares, the
  // other says the book refused the trade outright.
  assert.match(explainError(new Error("execution reverted: ISV")), /solvency/i);
  assert.equal(explainError({ code: 4001 }), "Cancelled in the wallet.");
});

/* ------------------------------------------------------------- the route */

test("an unconfigured league answers, rather than failing", async () => {
  const response = await handleMarketRequest(
    new Request("https://forge.test/api/market?night=1&blue=a&red=b"),
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, booked: false, reason: "unconfigured" });
});

test("the route needs a night", async () => {
  const env = {
    FIGHT_RPC_URL: "https://rpc.invalid",
    FIGHT_CLOB_ADDRESS: "0x0000000000000000000000000000000000000001",
    FIGHT_READER_ADDRESS: "0x0000000000000000000000000000000000000002",
  };
  for (const query of ["", "?night=0", "?night=nope&blue=a&red=b"]) {
    const response = await handleMarketRequest(
      new Request(`https://forge.test/api/market${query}`),
      env,
    );
    assert.equal(response.status, 400, query || "(no query)");
  }
});

test("a night with no fight named is the whole board", async () => {
  // Naming no fighters is the card rail's request, not a malformed one — it
  // asks for every bout of the night in a single call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const response = await handleMarketRequest(
      new Request("https://forge.test/api/market?night=907"),
      {
        FIGHT_RPC_URL: "https://rpc.invalid",
        FIGHT_CLOB_ADDRESS: "0x0000000000000000000000000000000000000001",
        FIGHT_READER_ADDRESS: "0x0000000000000000000000000000000000000002",
      },
    );
    assert.equal(response.status, 502, "reached for the board rather than rejecting");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain that cannot be reached is a 502, not a crash", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    const response = await handleMarketRequest(
      // A night nothing else in this file uses, so the miss cannot be served
      // out of the module-level cache another test filled.
      new Request("https://forge.test/api/market?night=904&blue=a&red=b"),
      {
        FIGHT_RPC_URL: "https://rpc.invalid",
        FIGHT_CLOB_ADDRESS: "0x0000000000000000000000000000000000000001",
        FIGHT_READER_ADDRESS: "0x0000000000000000000000000000000000000002",
      },
    );
    assert.equal(response.status, 502);
    const body = await response.json() as { ok: boolean };
    assert.equal(body.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a fight with no book yet is asked about again, not written off", async () => {
  // The bug this pins down: a card is posted the moment the last one ends and
  // the operator seeds its book onto the chain a little after that, so every
  // fight is briefly unbooked and then is not. Cached as long as a hit, that
  // gap became five minutes of "nobody has put a book up against this fight"
  // on a fight the card rail beside it was already quoting a price for.
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  // An empty card: (BoutView[] views, uint256 nextIdx) with no views in it.
  const emptyCard = "0x" + word(64) + word(0) + word(0);
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls++;
    const batch = JSON.parse(init.body) as { id: number }[];
    return {
      ok: true,
      json: async () => batch.map((sent) => ({ id: sent.id, result: emptyCard })),
    };
  }) as unknown as typeof fetch;

  const ask = () => handleMarketRequest(
    // A night of its own, so no other test's cache entry answers for it.
    new Request("https://forge.test/api/market?night=911&blue=a&red=b"),
    {
      FIGHT_RPC_URL: "https://rpc.invalid",
      FIGHT_CLOB_ADDRESS: "0x0000000000000000000000000000000000000001",
      FIGHT_READER_ADDRESS: "0x0000000000000000000000000000000000000002",
    },
  );

  try {
    assert.deepEqual(await (await ask()).json(), { ok: true, booked: false, reason: "unbooked" });
    const afterFirst = calls;
    assert.ok(afterFirst > 0, "the first miss reached the chain");

    // Straight away, the miss still comes out of the cache — which is the half
    // of this worth keeping, or an unbooked league rescans on every poll.
    await ask();
    assert.equal(calls, afterFirst, "a fresh miss is served from memory");

    // A few seconds on, it is a question again rather than a settled answer.
    Date.now = () => realNow() + 30_000;
    await ask();
    assert.ok(calls > afterFirst, "a stale miss is re-asked, not believed forever");
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});

/* -------------------------------------------------------- the event index */

/** D1 over a real SQLite, because the index leans on `json_each` and an upsert
 *  that a hand-rolled double would only pretend to run. One database for the
 *  whole file: the schema is created once per isolate, like it is in a worker,
 *  so each test keeps to a contract address of its own instead. */
const indexDb = new DatabaseSync(":memory:");
const sqliteDb: LeagueDatabase = {
  prepare(query: string) {
    const make = (values: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      first: async <T,>() => (indexDb.prepare(query).get(...(values as never[])) ?? null) as T | null,
      all: async <T,>() => ({ results: indexDb.prepare(query).all(...(values as never[])) as T[] }),
      run: async () => ({ meta: { changes: Number(indexDb.prepare(query).run(...(values as never[])).changes) } }),
    });
    return make([]);
  },
  async batch(statements) {
    indexDb.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      indexDb.exec("COMMIT");
    } catch (error) {
      indexDb.exec("ROLLBACK");
      throw error;
    }
    return [];
  },
};

const TOPICS = {
  boutCreated: "0x28da57892c5e4c48a917d9a7e9782cd54070c158657c063ce4b8fefb7f3b467e",
  orderPlaced: "0xa676bdb4305a288519511cbeea6fa856967598f4be60ae5ed741f346d3c18ffe",
  orderFilled: "0x9c5ddddcffc3d086a3f0937c20216a27ea913e83eaec6b00092655bb3ae4ff8f",
  orderCancelled: "0x45440fd71570d51cec1fc372b217cc4d5e384746c7cc844e2ee3d7804bc339ca",
};

interface FakeLog { block: number; index: number; topics: string[]; data: string }

/** A chain that answers the four calls the index and the board make, and keeps
 *  every log range it was asked for. */
function fakeChain(options: {
  head: () => number;
  logs: FakeLog[];
  refuse?: () => boolean;
  nextBoutId?: number;
  card?: string;
}) {
  const ranges: { from: number; to: number }[] = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[];
    const rows = sent.map((call) => {
      if (call.method === "eth_blockNumber") return { id: call.id, result: "0x" + options.head().toString(16) };
      if (call.method === "eth_getBlockByNumber") {
        // One block a second from a round epoch, so a time reads back as a block.
        return { id: call.id, result: { timestamp: "0x" + (1_000_000 + Number(call.params[0])).toString(16) } };
      }
      if (call.method === "eth_getLogs") {
        const filter = call.params[0] as { fromBlock: string; toBlock: string };
        const from = Number(filter.fromBlock);
        const to = Number(filter.toBlock);
        ranges.push({ from, to });
        if (options.refuse?.()) return { id: call.id, error: { message: "log query timed out" } };
        return {
          id: call.id,
          result: options.logs
            .filter((log) => log.block >= from && log.block <= to)
            .map((log) => ({
              blockNumber: "0x" + log.block.toString(16),
              logIndex: "0x" + log.index.toString(16),
              transactionHash: "0x" + word(log.block * 100 + log.index),
              topics: log.topics,
              data: log.data,
            })),
        };
      }
      const data = (call.params[0] as { data: string }).data;
      if (data.startsWith(SELECTORS.nextBoutId)) return { id: call.id, result: "0x" + word(options.nextBoutId ?? 1) };
      return { id: call.id, result: options.card ?? "0x" + word(64) + word(0) + word(0) };
    });
    return { ok: true, json: async () => rows };
  }) as unknown as typeof fetch;
  return { fetcher, ranges };
}

const topicOf = (value: number) => "0x" + word(value);
/** OrderFilled's data: (uint256 shares, uint8 price, uint8 side, bool takerIsBuy). */
const fillData = (shares: number, price: number, side: number) =>
  "0x" + word(shares) + word(price) + word(side) + word(1);

function indexEnv(clob: string, startBlock: number) {
  return {
    FIGHT_RPC_URL: "https://rpc.invalid",
    FIGHT_CLOB_ADDRESS: clob,
    FIGHT_READER_ADDRESS: "0x0000000000000000000000000000000000000002",
    FIGHT_START_BLOCK: String(startBlock),
    DB: sqliteDb,
  };
}

test("the index files every event once and its cursor only moves forward", async () => {
  const clob = "0x00000000000000000000000000000000000000A1";
  let head = 2_000;
  const logs: FakeLog[] = [
    { block: 1_005, index: 0, topics: [TOPICS.boutCreated, topicOf(7), topicOf(3)], data: "0x" },
    { block: 1_010, index: 2, topics: [TOPICS.orderPlaced, topicOf(41), topicOf(7), topicOf(9)], data: "0x" },
    { block: 1_020, index: 0, topics: [TOPICS.orderFilled, topicOf(42), topicOf(41), topicOf(7)], data: fillData(2_000_000, 60, SIDE_BLUE) },
    { block: 1_020, index: 1, topics: [TOPICS.orderFilled, topicOf(43), topicOf(41), topicOf(7)], data: fillData(1_000_000, 35, SIDE_RED) },
    { block: 1_030, index: 0, topics: [TOPICS.orderCancelled, topicOf(41), topicOf(9)], data: "0x" },
    // An event this worker has never heard of still goes in, under its topic.
    { block: 1_040, index: 0, topics: [topicOf(0xabc)], data: "0x" },
  ];
  const chain = fakeChain({ head: () => head, logs });
  const realFetch = globalThis.fetch;
  globalThis.fetch = chain.fetcher;
  const env = indexEnv(clob, 1_000);
  const now = 50_000_000;

  try {
    assert.equal(await indexMarketEvents(env, now), 6);
    const rows = indexDb.prepare(
      "SELECT block_number, event, bout_id, block_time FROM market_events WHERE address = ? ORDER BY block_number, log_index",
    ).all(clob.toLowerCase()) as { block_number: number; event: string; bout_id: number | null; block_time: number }[];
    assert.deepEqual(rows.map((row) => row.event), [
      "BoutCreated", "OrderPlaced", "OrderFilled", "OrderFilled", "OrderCancelled", topicOf(0xabc),
    ]);
    // The bout id comes off whichever topic that event keeps it in.
    assert.deepEqual(rows.map((row) => row.bout_id), [7, 7, 7, 7, null, null]);
    // Each block dated off the chain, in ms.
    assert.equal(rows[2].block_time, (1_000_000 + 1_020) * 1000);
    // Read up to a few blocks short of the head, never from zero.
    assert.deepEqual(chain.ranges, [{ from: 1_000, to: head - 12 }]);

    // A second pass inside the interval is not a second trip to the chain.
    assert.equal(await indexMarketEvents(env, now + 1_000), 0);
    assert.equal(chain.ranges.length, 1);

    // Later, with nothing new at the head, it still does not re-read old blocks.
    assert.equal(await indexMarketEvents(env, now + 5_000), 0);
    assert.equal(chain.ranges.length, 1);

    // New blocks: only those are asked for, and nothing already filed doubles up.
    head = 3_000;
    logs.push({ block: 2_500, index: 0, topics: [TOPICS.orderFilled, topicOf(44), topicOf(41), topicOf(7)], data: fillData(1_000_000, 64, SIDE_BLUE) });
    assert.equal(await indexMarketEvents(env, now + 10_000), 1);
    assert.deepEqual(chain.ranges[1], { from: 2_000 - 12 + 1, to: 3_000 - 12 });
    const count = indexDb.prepare("SELECT COUNT(*) AS n FROM market_events WHERE address = ?")
      .get(clob.toLowerCase()) as { n: number };
    assert.equal(count.n, 7);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a window the node refuses is narrowed, and the cursor stays put", async () => {
  const clob = "0x00000000000000000000000000000000000000A2";
  let refuse = true;
  const chain = fakeChain({ head: () => 50_000_000, logs: [], refuse: () => refuse });
  const realFetch = globalThis.fetch;
  globalThis.fetch = chain.fetcher;
  const env = indexEnv(clob, 0);

  try {
    await assert.rejects(indexMarketEvents(env, 60_000_000), /timed out/);
    const cursor = indexDb.prepare("SELECT next_block FROM market_index WHERE address = ?")
      .get(clob.toLowerCase());
    assert.equal(cursor, undefined, "nothing was filed, so nothing was skipped");

    // Straight after a failure the node is left alone: retried at once, a
    // timed-out scan on the public endpoint comes back as a 429.
    assert.equal(await indexMarketEvents(env, 60_001_000), 0);
    assert.equal(chain.ranges.length, 1);

    // The retry starts from the same block with half the window.
    await assert.rejects(indexMarketEvents(env, 60_031_000), /timed out/);
    const [first, second] = chain.ranges;
    assert.equal(second.from, first.from);
    assert.equal(second.to - second.from + 1, (first.to - first.from + 1) / 2);

    // Once the node answers again, the cursor moves past what it read.
    refuse = false;
    await indexMarketEvents(env, 60_062_000);
    const moved = indexDb.prepare("SELECT next_block FROM market_index WHERE address = ?")
      .get(clob.toLowerCase()) as { next_block: number };
    assert.ok(moved.next_block > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the board prices an empty book off the indexed fills", async () => {
  // One bout on the card with nothing resting on either side, so the only
  // opinion the market has is the trades it printed.
  const clob = "0x00000000000000000000000000000000000000A3";
  const logs: FakeLog[] = [
    { block: 5_010, index: 0, topics: [TOPICS.orderFilled, topicOf(1), topicOf(2), topicOf(21)], data: fillData(2_000_000, 60, SIDE_BLUE) },
    // A print on red at 30¢ is blue at 70¢, and the latest print wins.
    { block: 5_020, index: 0, topics: [TOPICS.orderFilled, topicOf(3), topicOf(4), topicOf(21)], data: fillData(1_000_000, 30, SIDE_RED) },
  ];
  const row = [21, 913, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 100];
  const card = "0x" + word(64) + word(0) + word(1) + row.map((value) => word(value)).join("");
  const chain = fakeChain({ head: () => 6_000, logs, nextBoutId: 22, card });
  const realFetch = globalThis.fetch;
  globalThis.fetch = chain.fetcher;
  const env = indexEnv(clob, 5_000);

  try {
    assert.equal(await indexMarketEvents(env, 70_000_000), 2);
    const before = chain.ranges.length;
    const response = await handleMarketRequest(new Request("https://forge.test/api/market?night=913"), env);
    const body = await response.json() as { booked: boolean; bouts: { boutId: number; priceA: number; volume: number }[] };
    assert.equal(body.booked, true);
    assert.equal(body.bouts[0].boutId, 21);
    assert.equal(body.bouts[0].priceA, 70);
    // 2 shares at 60¢ and 1 at 30¢.
    assert.equal(body.bouts[0].volume, 1.5);
    assert.equal(chain.ranges.length, before, "a request never scans the chain's logs");
  } finally {
    globalThis.fetch = realFetch;
  }
});
