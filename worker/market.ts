import {
  type BookLevel,
  type BoutOutcome,
  type BoutRef,
  type CardFeed,
  type CardOdds,
  type MarketFeed,
  type MarketQuote,
  type PortfolioFeed,
  type PricePoint,
  type Trade,
  SELECTORS,
  SIDE_BLUE,
  SIDE_RED,
  TOPIC_ORDER_FILLED,
  athleteIdToBytes32,
  bytes32ToAthleteId,
  decodeStructArray,
  decodeWords,
  encodeCall,
  encodeCallWithIds,
  foldedAsks,
  foldedBook,
  isQuoted,
  midPrice,
  outcomeFromCode,
  settledPrice,
} from "../app/market.ts";
import type { LeagueDatabase } from "./league.ts";

/** The league's read-only window onto the fight book.
 *
 * The order book lives on Robinhood Chain and the league does not write to it —
 * booking, closing and scoring a bout are operator calls made from the
 * clawpolymarket repo, with a key this worker deliberately does not have. All
 * that happens here is reading: odds, depth, and the trades a bout has printed,
 * turned into the shape the panel draws.
 *
 * Reads go through the worker rather than straight from the browser for two
 * reasons. The public Robinhood endpoints are rate-limited, and one viewer
 * opening the market tab would otherwise fan out into six JSON-RPC calls per
 * poll per tab. And the fill history is not read off the chain at all on a
 * request: the tick copies every event the book emits into D1 as it lands (see
 * "the event index" below), so a quote's chart and tape are a database read
 * however many people are watching and however old the contract gets. */

export interface MarketEnv {
  /** JSON-RPC endpoint the worker reads through. Unset means no market — the
   *  panel says so. Safe to point at a keyed provider: it stays server-side. */
  FIGHT_RPC_URL?: string;
  /** The endpoint handed to the browser for `wallet_addEthereumChain`, which
   *  is a different question — that one ends up in somebody's wallet settings,
   *  so it has to be an endpoint with no key in it. */
  FIGHT_PUBLIC_RPC_URL?: string;
  FIGHT_CHAIN_ID?: string;
  FIGHT_CLOB_ADDRESS?: string;
  FIGHT_READER_ADDRESS?: string;
  FIGHT_COLLATERAL_ADDRESS?: string;
  FIGHT_COLLATERAL_DECIMALS?: string;
  FIGHT_COLLATERAL_SYMBOL?: string;
  FIGHT_TAKER_FEE_BPS?: string;
  FIGHT_START_BLOCK?: string;
  FIGHT_EXPLORER_URL?: string;
  /** Where the event index lives. Unset means no history: quotes still price
   *  off the live book, with an empty chart and tape. */
  DB?: LeagueDatabase;
}

/** How long a quote is served from memory.
 *
 * Short enough that a price move shows up while somebody is looking at it, long
 * enough that a full card of viewers polling every few seconds does not turn
 * into a rate-limit. The panel polls on its own slower beat on top of this. */
const QUOTE_TTL_MS = 4_000;
/** The bout-id lookup is a different kind of fact: which on-chain bout is this
 *  fight is settled the moment the card is booked and never changes after. */
const MAPPING_TTL_MS = 5 * 60_000;
/** How long "this fight has no book" is believed for.
 *
 * Nothing like as long, because it is not the same kind of answer. A hit is
 * permanent — a bout id, once booked, is that fight forever. A miss is only
 * ever "not yet": the league posts the next card the moment the last one ends
 * and the operator seeds the book onto the chain a little after that, so every
 * fight on a fresh card is unbooked for a short window and then is not.
 *
 * Held for five minutes, that window became the bug it looks like: the card
 * rail reads the whole night's board on a four-second cache and fills with
 * prices, while anybody who opened a fight in the gap kept being told nobody
 * had put a book up against it — for five minutes, on a fight that was quoted
 * on the row behind the popup. Re-asking costs one `eth_call`, which is what
 * the board beside it is already spending every four seconds. */
const MISS_TTL_MS = QUOTE_TTL_MS;
/** Bouts scanned per `getCard` call, counted back from the newest.
 *
 * A league night is eighteen fights and cards are booked in order, so the fight
 * on air is always inside the last few dozen ids. Scanning forward from id 1
 * would work for the first three cards and then quietly stop finding anything,
 * because bout ids keep climbing while the window does not. */
const CARD_SCAN = 64;
/** Block timestamps fetched per indexed window. A batch is billed by the node
 *  as that many requests, and forty a window was enough to get the public
 *  endpoint answering 429 halfway through a backfill. */
const MAX_TIMESTAMP_LOOKUPS = 24;
/** How much tape the panel gets. A busy bout prints hundreds of fills and the
 *  list is scrolled by hand; what somebody wants from it is the last few
 *  minutes, and shipping the rest is payload nobody reads. */
const MAX_TRADES = 30;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** Which on-chain bout a league fight is, or a cached "none". */
type BoutMapping = { boutId: number; flipped: boolean } | null;

const quoteCache = new Map<string, CacheEntry<MarketQuote>>();
const boardCache = new Map<string, CacheEntry<CardOdds[]>>();
const mappingCache = new Map<string, CacheEntry<BoutMapping>>();
let indexCache: CacheEntry<BoutRef[]> | null = null;

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/* --------------------------------------------------------------- json-rpc */

interface RpcCall {
  method: string;
  params: unknown[];
}

let rpcId = 1;

/** One HTTP round trip for however many calls. Batching matters more here than
 *  it usually does: a quote is a bout view, a full book, and a log scan, and
 *  three serial requests to a rate-limited public node is three chances to be
 *  throttled instead of one. */
async function rpcBatch(rpcUrl: string, calls: RpcCall[], timeoutMs?: number): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const payload = calls.map((call) => ({
    jsonrpc: "2.0",
    id: rpcId++,
    method: call.method,
    params: call.params,
  }));

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) {
    throw new Error(`RPC ${response.status}`);
  }

  const body = (await response.json()) as
    | { id: number; result?: unknown; error?: { message: string } }[]
    | { id: number; result?: unknown; error?: { message: string } };
  // A node is allowed to answer a single-element batch with a bare object.
  const rows = Array.isArray(body) ? body : [body];

  const byId = new Map(rows.map((row) => [row.id, row]));
  return payload.map((sent) => {
    const row = byId.get(sent.id);
    if (!row) throw new Error(`RPC dropped ${sent.method}`);
    if (row.error) throw new Error(`RPC ${sent.method}: ${row.error.message}`);
    return row.result;
  });
}

function ethCall(to: string, data: string): RpcCall {
  return { method: "eth_call", params: [{ to, data }, "latest"] };
}

/* ------------------------------------------------------ league bout → chain */

interface Config {
  rpcUrl: string;
  publicRpcUrl: string;
  chainId: number;
  clob: string;
  reader: string;
  collateral: string;
  collateralDecimals: number;
  collateralSymbol: string;
  takerFeeBps: number;
  startBlock: number;
  explorer: string;
  db?: LeagueDatabase;
}

function readConfig(env: MarketEnv): Config | null {
  if (!env.FIGHT_RPC_URL || !env.FIGHT_CLOB_ADDRESS || !env.FIGHT_READER_ADDRESS) return null;
  return {
    rpcUrl: env.FIGHT_RPC_URL,
    publicRpcUrl: env.FIGHT_PUBLIC_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com/rpc",
    chainId: Number(env.FIGHT_CHAIN_ID ?? 46630),
    clob: env.FIGHT_CLOB_ADDRESS,
    reader: env.FIGHT_READER_ADDRESS,
    collateral: env.FIGHT_COLLATERAL_ADDRESS ?? "",
    collateralDecimals: Number(env.FIGHT_COLLATERAL_DECIMALS ?? 6),
    collateralSymbol: env.FIGHT_COLLATERAL_SYMBOL ?? "tUSD",
    takerFeeBps: Number(env.FIGHT_TAKER_FEE_BPS ?? 0),
    startBlock: Number(env.FIGHT_START_BLOCK ?? 0),
    explorer: env.FIGHT_EXPLORER_URL ?? "",
    db: env.DB,
  };
}

/** BoutView is eighteen static fields, so `getCard` returns them inline. */
const BOUT_VIEW_WORDS = 18;

/** The stretch of bout ids anything current could be inside.
 *
 * Ids climb forever while a card is fifteen fights, so scanning back a fixed
 * window from the newest is what keeps the reads a constant size however many
 * nights the league has run. */
async function boutWindow(config: Config): Promise<{ head: number; from: number }> {
  const [headRaw] = await rpcBatch(config.rpcUrl, [
    ethCall(config.clob, encodeCall(SELECTORS.nextBoutId)),
  ]);
  const head = Number(decodeWords(headRaw as string)[0] ?? 1n);
  return { head, from: Math.max(1, head - CARD_SCAN) };
}

/** How far back the archive is allowed to walk looking for an old night's book.
 *
 * A page is one `eth_call`. Only the archive ever spends more than one — every
 * live surface reads the card that is on the board, and that is always inside
 * the first page. Sixteen pages is a thousand bouts, which is well over a month
 * of cards and far longer than a settled book takes to be claimed out. */
const CARD_PAGES = 16;

/** The bout id a `BoutView` row is. */
function rowId(row: bigint[]) {
  return Number(row[0]);
}

/** Every bout booked on one night, as raw `BoutView` rows.
 *
 * `deep` is the archive asking. Without it this is exactly what it always was:
 * one page off the head, which is where the current card lives. With it the scan
 * walks backwards a page at a time until it finds the night, which is what keeps
 * a claim button working on a fight nobody has been back to in a fortnight.
 * Paging continues past the first hit only when the night's bouts run right to
 * the bottom of the page, because fifteen fights can straddle a boundary. */
async function scanCard(config: Config, night: number, deep = false): Promise<bigint[][]> {
  const { head } = await boutWindow(config);
  const rows: bigint[][] = [];

  for (let page = 0; page < (deep ? CARD_PAGES : 1); page += 1) {
    const from = Math.max(1, head - CARD_SCAN * (page + 1));
    const [raw] = await rpcBatch(config.rpcUrl, [
      ethCall(config.reader, encodeCall(SELECTORS.getCard, [night, from, CARD_SCAN])),
    ]);
    // (BoutView[] views, uint256 nextIdx)
    const found = decodeStructArray(decodeWords(raw as string), 0, BOUT_VIEW_WORDS);
    // Ids climb, so an earlier page's bouts belong in front of what is held.
    rows.unshift(...found);
    if (from === 1) break;
    // The night begins inside this page, so nothing older can belong to it.
    if (found.length > 0 && rowId(found[0]) > from) break;
    // Nothing here and nothing yet: keep walking back. Nothing here but the
    // night already found: it was whole, and this page is past its start.
    if (found.length === 0 && rows.length > 0) break;
  }
  return rows;
}

/** One `BoutView` row as the price the panel draws.
 *
 * Both sides of the book folded together first: a bid on B at 32¢ is an offer
 * of A at 68¢, and a row read only off A's own orders misprices every fight
 * the league has seeded, which is all of them. */
function rowToOdds(row: bigint[], lastTrade: number | undefined, volume: number): CardOdds {
  const { bid: bestBid, ask: bestAsk } = foldedBook(
    Number(row[14]), Number(row[15]),
    Number(row[16]), Number(row[17]),
  );
  // `outcome` here is quoted for fighter A, which is how the row is quoted, so
  // a settled fight needs no corner-swapping before it is priced.
  const outcome = outcomeFromCode(row[6]);
  const settled = settledPrice(outcome);
  return {
    boutId: Number(row[0]),
    fighterA: bytes32ToAthleteId(row[2]),
    fighterB: bytes32ToAthleteId(row[3]),
    priceA: settled ?? midPrice(bestBid, bestAsk, lastTrade),
    quoted: settled !== null || isQuoted(bestBid, bestAsk, lastTrade),
    closed: row[7] === 1n,
    resolved: row[8] === 1n,
    outcome,
    volume,
  };
}

/** Find the on-chain bout for a league fight, without keeping a mapping table.
 *
 * The operator books a card with the league's own identifiers — night number as
 * `cardId`, athlete ids as the two `bytes32` fighters — so the mapping is
 * already on chain and can be read back. A table in D1 would be a second copy
 * of a fact the contract already holds, and the failure mode of a second copy
 * is showing somebody the odds for the wrong fight.
 *
 * Fighter order is not assumed. Whoever booked the card may have put the
 * league's blue corner in either slot, so a match either way counts and the
 * caller is told which way round it went. */
async function findBout(
  config: Config,
  night: number,
  blueId: string,
  redId: string,
  deep = false,
): Promise<{ boutId: number; flipped: boolean } | null> {
  const blue = BigInt(athleteIdToBytes32(blueId));
  const red = BigInt(athleteIdToBytes32(redId));

  for (const row of await scanCard(config, night, deep)) {
    const fighterA = row[2];
    const fighterB = row[3];
    if (fighterA === blue && fighterB === red) return { boutId: Number(row[0]), flipped: false };
    if (fighterA === red && fighterB === blue) return { boutId: Number(row[0]), flipped: true };
  }
  return null;
}

/* --------------------------------------------------------- the event index */

/** Every event the book emits, copied into D1 as it lands.
 *
 * The contract keeps the book and not its past. A trade is an `OrderFilled`
 * log and nothing else, and the only way back to a log is `eth_getLogs`. Asking
 * for that on every quote meant asking for the contract's whole life on every
 * quote, and the chain makes over half a million blocks a day: three weeks
 * after deploying, the range was past the node's 10M-block cap and every quote
 * failed with it.
 *
 * So the chain is read forward once, behind the tick, from a cursor that only
 * moves when the rows it covers have been written. A caught-up pass asks for a
 * few seconds of blocks. Everything the book emits is kept, not only fills,
 * because the row is cheap and the next thing anybody wants to draw (a wallet's
 * order history, a bout's open interest over time) is already in it.
 *
 * The table is a copy of the chain and nothing else. Dropping it and its cursor
 * is a safe reset: the next pass starts again from `FIGHT_START_BLOCK`. That is
 * also why it stays out of the migration export. */

/** Blocks left unread at the head, so a block the sequencer replaces is never
 *  filed. Under two seconds at the chain's ~7 blocks a second. */
const INDEX_LAG_BLOCKS = 12;
/** The widest window one `eth_getLogs` may ask for. The node's own cap is 10M,
 *  but measured on the public endpoint 5M times out and 2M answers in under
 *  three seconds with ~8,000 logs in it. */
const INDEX_SPAN_MAX = 2_000_000;
/** Where halving stops. A window this narrow failing is the node, not the range. */
const INDEX_SPAN_MIN = 10_000;
/** Logs a window is sized to come back with. The book's density swings by a
 *  factor of fifty between a quiet week and a busy night, so a fixed width is
 *  either far too many calls or a scan the node times out on. */
const INDEX_TARGET_LOGS = 3_000;
/** Windows read per pass while catching up, so a backfill is spread over a few
 *  ticks instead of holding the simulation lease, or the node's rate limit,
 *  for all of it. */
const INDEX_WINDOWS_PER_PASS = 2;
/** How often a caught-up index goes back to the chain, across every isolate.
 *  Under the quote cache, so a fill is on the tape by the next poll after it. */
const INDEX_INTERVAL_MS = 3_000;
/** Rows per insert. They travel as one JSON parameter and a row is ~540 bytes,
 *  so this keeps a statement under D1's 100KB cap even if the parameter is
 *  counted toward it. */
const INDEX_INSERT_ROWS = 150;
/** One window's log scan. A hung read must not hold the tick that runs the card. */
const INDEX_RPC_TIMEOUT_MS = 10_000;
/** How long the index leaves the node alone after a failed pass. Measured on
 *  the public endpoint, a timed-out scan is followed by a 429 if it is retried
 *  straight away, so a timeout earns the same rest a 429 does. */
const INDEX_BACKOFF_MS = 30_000;

/** The current window width. Halved when a scan fails and refitted to the log
 *  density after one succeeds, so a busy stretch costs narrower windows
 *  rather than a stalled index. */
let indexSpan = INDEX_SPAN_MAX / 2;
/** Set by a failed pass. */
let indexRestUntil = 0;

function rateLimited(error: unknown) {
  return /429|too many/i.test(error instanceof Error ? error.message : String(error));
}

/** What each topic is, and which topic carries the bout id when one does. */
const EVENTS: Record<string, { name: string; boutTopic?: number }> = {
  "0x28da57892c5e4c48a917d9a7e9782cd54070c158657c063ce4b8fefb7f3b467e": { name: "BoutCreated", boutTopic: 1 },
  "0x41f575a18c847edf96f553cf3f47c185201599dcafce5186aa22e8c7d8cf5cd3": { name: "BoutClosed", boutTopic: 1 },
  "0x7611a51b494098a51bdb0b7f4d0c544b9103a05232a829be50936ceb1253e4ec": { name: "BoutResolved", boutTopic: 1 },
  "0xa676bdb4305a288519511cbeea6fa856967598f4be60ae5ed741f346d3c18ffe": { name: "OrderPlaced", boutTopic: 2 },
  [TOPIC_ORDER_FILLED]: { name: "OrderFilled", boutTopic: 3 },
  "0x45440fd71570d51cec1fc372b217cc4d5e384746c7cc844e2ee3d7804bc339ca": { name: "OrderCancelled" },
  "0xb2b3cbe033aa38e93c0eb1ceee79d790e60008cbc021b10eed86e2fa214ae645": { name: "SharesMinted", boutTopic: 1 },
  "0x003195cc3cce6bd8cab724dba36b9fcdbd8b093db6771402b7b0ff3637f79070": { name: "SharesBurned", boutTopic: 1 },
  "0x374ddac058d6545dd0b061fc8e54f7834b2459d35e96ce508588dd9ab07c701d": { name: "SharesRedeemed", boutTopic: 1 },
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65": { name: "Withdrawal" },
  "0x9493e5bbe4e8e0ac67284469a2d677403d0378a85a59e341d3abc433d0d9a209": { name: "FeesClaimed" },
  "0xb3b3f5f64ab192e4b5fefde1f51ce9733bbdcf831951543b325aebd49cc27ec4": { name: "OperatorUpdated" },
  "0xe42708d93b95810922305119a3271ca42233da9ebe1e1e503f0e887817a32c7a": { name: "FeeConfigUpdated" },
};

interface RawLog {
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
}

/** Same reasoning as the archive's schema check: once per isolate, and a
 *  failure must not be the answer the next request is handed. */
let indexSchemaReady: Promise<unknown> | null = null;

function ensureIndexSchema(db: LeagueDatabase) {
  indexSchemaReady ??= (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS market_events (
        address TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        event TEXT NOT NULL,
        bout_id INTEGER,
        block_time INTEGER NOT NULL,
        topics TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (address, block_number, log_index)
      )
    `).run();
    await db.prepare(
      "CREATE INDEX IF NOT EXISTS market_events_bout ON market_events (address, event, bout_id, block_number, log_index)",
    ).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS market_index (
        address TEXT PRIMARY KEY NOT NULL,
        next_block INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run();
  })().catch((error) => {
    indexSchemaReady = null;
    throw error;
  });
  return indexSchemaReady;
}

function hexBlock(block: number) {
  return "0x" + block.toString(16);
}

/** Up to `limit` of `values`, spread evenly and keeping both ends. */
function thin(values: number[], limit: number) {
  if (values.length <= limit) return values;
  if (limit < 2) return values.slice(0, limit);
  const step = (values.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => values[Math.round(i * step)]);
}

/** Timestamps for the blocks a window's events landed in.
 *
 * Logs give block numbers and not times, and one lookup per event would make a
 * backfill thousands of calls. So a window dates a handful of its blocks and
 * places everything between two of them on the line between them. Fills are
 * dated first, because a fill's time is drawn on the chart and nothing else's
 * is yet: spread evenly over a two-million-block backfill window, the same
 * budget left fills out by over a minute. The rest of the budget goes on
 * evenly spaced blocks so the other events land close too. */
async function blockTimestamps(
  config: Config,
  blocks: number[],
  priority: number[],
): Promise<Map<number, number>> {
  const distinct = [...new Set(blocks)].sort((a, b) => a - b);
  const wanted = new Set(thin([...new Set(priority)].sort((a, b) => a - b), MAX_TIMESTAMP_LOOKUPS - 2));
  if (distinct.length > 0) {
    wanted.add(distinct[0]);
    wanted.add(distinct[distinct.length - 1]);
  }
  for (const block of thin(distinct, Math.max(2, MAX_TIMESTAMP_LOOKUPS - wanted.size))) {
    if (wanted.size >= MAX_TIMESTAMP_LOOKUPS) break;
    wanted.add(block);
  }
  const sampled = [...wanted].sort((a, b) => a - b);

  const anchors: { block: number; at: number }[] = [];
  if (sampled.length > 0) {
    const results = await rpcBatch(config.rpcUrl, sampled.map((block) => ({
      method: "eth_getBlockByNumber",
      params: [hexBlock(block), false],
    })), INDEX_RPC_TIMEOUT_MS);
    results.forEach((result, i) => {
      const stamp = (result as { timestamp?: string } | null)?.timestamp;
      if (stamp) anchors.push({ block: sampled[i], at: Number(BigInt(stamp)) * 1000 });
    });
  }
  // A row filed with a made-up time would sit on the chart forever, so a
  // window the node would not date is not filed at all. The next pass asks again.
  if (distinct.length > 0 && anchors.length === 0) {
    throw new Error("The chain returned no block timestamps.");
  }

  const out = new Map<number, number>();
  let k = 0;
  for (const block of distinct) {
    while (k < anchors.length - 1 && anchors[k + 1].block <= block) k += 1;
    const left = anchors[k];
    const right = anchors[Math.min(k + 1, anchors.length - 1)];
    if (block <= left.block || right.block === left.block) {
      out.set(block, left.at);
    } else {
      const share = (block - left.block) / (right.block - left.block);
      out.set(block, Math.round(left.at + (right.at - left.at) * share));
    }
  }
  return out;
}

/** Moves the cursor and files the rows that got it there, in one transaction.
 *
 * The rows go in as JSON and are unpacked by SQLite, which is a statement per
 * hundred and fifty events rather than one each: a backfill is tens of thousands of
 * rows, and D1 counts statements. Already-filed rows are ignored rather than
 * refused, so a pass that dies after writing and before the cursor moved just
 * reads the same window again. The cursor only ever moves forward, so two
 * passes that did overlap cannot walk it back. */
async function writeIndex(
  db: LeagueDatabase,
  address: string,
  rows: unknown[][],
  nextBlock: number,
  realNow: number,
) {
  const statements: ReturnType<LeagueDatabase["prepare"]>[] = [];
  for (let start = 0; start < rows.length; start += INDEX_INSERT_ROWS) {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO market_events
        (address, block_number, log_index, tx_hash, event, bout_id, block_time, topics, data)
      SELECT ?,
        json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
        json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'),
        json_extract(value, '$[6]'), json_extract(value, '$[7]')
      FROM json_each(?)
    `).bind(address, JSON.stringify(rows.slice(start, start + INDEX_INSERT_ROWS))));
  }
  statements.push(db.prepare(`
    INSERT INTO market_index (address, next_block, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (address) DO UPDATE SET
      next_block = max(next_block, excluded.next_block),
      updated_at = excluded.updated_at
  `).bind(address, nextBlock, realNow));
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

/** Reads the chain forward from the cursor and files what it finds.
 *
 * Called from the tick behind the simulation lease, so one worker at a time is
 * in here; the conditional cursor and the ignored duplicates are what make it
 * safe anyway if a lease ever runs out underneath a pass. Returns how many
 * events were filed. Throws when the chain does, after narrowing the window
 * for next time, and the caller swallows it: a missed pass is a tape a few
 * seconds behind, never a stopped card. */
export async function indexMarketEvents(env: MarketEnv, realNow = Date.now()): Promise<number> {
  const config = readConfig(env);
  if (!config?.db || realNow < indexRestUntil) return 0;
  const db = config.db;
  await ensureIndexSchema(db);
  try {
    return await indexPass(config, db, realNow);
  } catch (error) {
    indexRestUntil = realNow + INDEX_BACKOFF_MS;
    throw error;
  }
}

async function indexPass(config: Config, db: LeagueDatabase, realNow: number): Promise<number> {
  const address = config.clob.toLowerCase();
  const cursor = await db.prepare(
    "SELECT next_block, updated_at FROM market_index WHERE address = ? LIMIT 1",
  ).bind(address).first<{ next_block: number; updated_at: number }>();
  if (cursor && realNow - cursor.updated_at < INDEX_INTERVAL_MS) return 0;

  // A start block set after the index had already begun from an earlier one
  // still counts: nothing before the deploy can be on the contract.
  let next = Math.max(cursor?.next_block ?? 0, config.startBlock);
  const [headRaw] = await rpcBatch(config.rpcUrl, [
    { method: "eth_blockNumber", params: [] },
  ], INDEX_RPC_TIMEOUT_MS);
  const safe = Number(BigInt(headRaw as string)) - INDEX_LAG_BLOCKS;

  let filed = 0;
  let windows = 0;
  for (; windows < INDEX_WINDOWS_PER_PASS && next <= safe; windows += 1) {
    const to = Math.min(safe, next + indexSpan - 1);
    let logs: RawLog[];
    try {
      const [logsRaw] = await rpcBatch(config.rpcUrl, [{
        method: "eth_getLogs",
        params: [{ address: config.clob, fromBlock: hexBlock(next), toBlock: hexBlock(to) }],
      }], INDEX_RPC_TIMEOUT_MS);
      logs = (logsRaw ?? []) as RawLog[];
    } catch (error) {
      // Too wide and too slow are both answered by asking for less. A 429 is
      // not: the node is counting requests there, not blocks.
      if (!rateLimited(error)) indexSpan = Math.max(INDEX_SPAN_MIN, Math.floor(indexSpan / 2));
      throw error;
    }

    const stamps = await blockTimestamps(
      config,
      logs.map((log) => Number(log.blockNumber)),
      logs
        .filter((log) => log.topics[0]?.toLowerCase() === TOPIC_ORDER_FILLED)
        .map((log) => Number(log.blockNumber)),
    );
    const rows = logs.map((log) => {
      const known = EVENTS[log.topics[0]?.toLowerCase() ?? ""];
      const boutTopic = known?.boutTopic !== undefined ? log.topics[known.boutTopic] : undefined;
      const block = Number(log.blockNumber);
      return [
        block,
        Number(log.logIndex),
        log.transactionHash,
        // An event this table does not know is still kept, under its topic.
        known?.name ?? log.topics[0] ?? "",
        boutTopic ? Number(BigInt(boutTopic)) : null,
        stamps.get(block) ?? 0,
        JSON.stringify(log.topics),
        log.data,
      ];
    });
    await writeIndex(db, address, rows, to + 1, realNow);
    filed += rows.length;
    // Aim the next window at the target from the density this one found, and
    // never more than double, so one empty stretch cannot fling the next scan
    // across a busy night.
    const fit = Math.round(((to - next + 1) * INDEX_TARGET_LOGS) / Math.max(1, logs.length));
    indexSpan = Math.max(INDEX_SPAN_MIN, Math.min(INDEX_SPAN_MAX, indexSpan * 2, fit));
    next = to + 1;
  }
  // Nothing new at the head still stamps the cursor, which is what spaces the
  // next pass out by `INDEX_INTERVAL_MS` instead of asking every tick.
  if (windows === 0) await writeIndex(db, address, [], next, realNow);
  return filed;
}

interface FillRow {
  bout_id: number;
  block_time: number;
  data: string;
}

/** Every indexed fill on a run of bout ids, oldest first. */
async function readFills(config: Config, fromId: number, toId: number): Promise<FillRow[]> {
  if (!config.db) return [];
  await ensureIndexSchema(config.db);
  const statement = config.db.prepare(`
    SELECT bout_id, block_time, data FROM market_events
    WHERE address = ? AND event = 'OrderFilled' AND bout_id >= ? AND bout_id <= ?
    ORDER BY block_number, log_index
  `).bind(config.clob.toLowerCase(), fromId, toId);
  if (!statement.all) return [];
  return (await statement.all<FillRow>()).results ?? [];
}

/* ------------------------------------------------------------- the quote */

/** A 100-entry depth array from `getFullBook`, as levels worth drawing. */
function levelsFrom(words: bigint[], offset: number, unit: bigint, descending: boolean): BookLevel[] {
  const levels: BookLevel[] = [];
  for (let price = 1; price < 100; price++) {
    const depth = words[offset + price];
    if (!depth) continue;
    levels.push({ price, shares: Number((depth * 1000n) / unit) / 1000 });
  }
  // Bids are walked best-first from the top, asks from the bottom.
  return descending ? levels.reverse() : levels;
}

/** Every trade the bout has printed, as a blue-side price line.
 *
 * A fill is recorded on whichever side the taker was working, so a print on red
 * at 26¢ is the same event as a print on blue at 74¢. Folding them onto one
 * line is what makes the chart two mirrored curves rather than two unrelated
 * ones with gaps where the other side was busy. */
async function fillHistory(
  config: Config,
  boutId: number,
  flipped: boolean,
): Promise<{ history: PricePoint[]; volume: number; trades: Trade[] }> {
  const logs = await readFills(config, boutId, boutId);
  if (logs.length === 0) return { history: [], volume: 0, trades: [] };

  const unit = 10n ** BigInt(config.collateralDecimals);
  const history: PricePoint[] = [];
  const fills: Trade[] = [];
  let volume = 0n;

  for (const log of logs) {
    // data: (uint256 shares, uint8 price, uint8 side, bool takerIsBuy)
    const words = decodeWords(log.data);
    if (words.length < 3) continue;
    const shares = words[0];
    const price = Number(words[1]);
    const side = Number(words[2]);
    volume += (shares * BigInt(price)) / 100n;

    // The contract's side A is the league's blue corner unless the card was
    // booked the other way round.
    const isBlueSide = flipped ? side === SIDE_RED : side === SIDE_BLUE;
    history.push({ at: log.block_time, blue: isBlueSide ? price : 100 - price });
    // The tape keeps the fill as it happened — the corner the shares were on
    // and the price paid for that corner — rather than folding it onto blue
    // the way the line does. A row saying somebody bought red at 40¢ is what
    // they did; the same row written as blue at 60¢ is a fact about the price
    // and a lie about the trade.
    fills.push({
      at: log.block_time,
      blueSide: isBlueSide,
      price,
      shares: Number((shares * 1000n) / unit) / 1000,
      takerBought: words[3] === 1n,
    });
  }

  // Newest first, because that is the end of the tape anybody reads.
  const trades = fills.slice(-MAX_TRADES).reverse();

  return { history, volume: Number((volume * 1000n) / unit) / 1000, trades };
}

/** Every bout of a night, priced, in one call.
 *
 * `getCard` already carries the mid for both sides of every bout it returns, so
 * a whole board is one `eth_call` — which is what makes putting live odds on
 * eighteen rows of the card rail affordable at all. */
async function buildBoard(config: Config, night: number, deep = false): Promise<CardOdds[]> {
  const rows = await scanCard(config, night, deep);
  if (rows.length === 0) return [];
  const { prices, volumes } = await tradeSummary(config, rowId(rows[0]), rowId(rows[rows.length - 1]));
  return rows.map((row) => rowToOdds(row, prices.get(Number(row[0])), volumes.get(Number(row[0])) ?? 0));
}

/** Every bout still worth naming, across nights.
 *
 * The board is one card; a wallet's holdings are not. Somebody who backed a
 * fight three nights ago and never came back still owns those shares, and a
 * portfolio that only looked at tonight would tell them they hold nothing.
 * `getBouts` takes the ids outright, so the whole window is one call rather
 * than one per night nobody knows the number of. */
async function buildBoutIndex(config: Config): Promise<BoutRef[]> {
  const { head, from } = await boutWindow(config);
  const ids: number[] = [];
  for (let id = from; id < head; id++) ids.push(id);
  if (ids.length === 0) return [];

  const [raw] = await rpcBatch(config.rpcUrl, [
    ethCall(config.reader, encodeCallWithIds(SELECTORS.getBouts, [], ids)),
  ]);
  const rows = decodeStructArray(decodeWords(raw as string), 0, BOUT_VIEW_WORDS);
  const { prices, volumes } = await tradeSummary(config, from, head - 1);

  return rows
    // An id inside the window that was never booked reads back as a zeroed
    // view. Night 0 does not exist, so that is the tell.
    .filter((row) => row[1] > 0n)
    .map((row) => ({
      ...rowToOdds(row, prices.get(Number(row[0])), volumes.get(Number(row[0])) ?? 0),
      night: Number(row[1]),
    }))
    // Newest first: the fight somebody is still thinking about is the last one
    // they bet on, not the first.
    .reverse();
}

/** The last price and the money through every bout in a run of ids, in one read.
 *
 * A bout whose book has emptied out has no mid to read, and the card rail would
 * show 50¢ for a fight the market has an opinion about. One read over the
 * indexed fills covers the whole night — cheaper than eighteen filtered ones,
 * and the rows are drawn from a single answer. The same pass totals each
 * bout's volume, which is what lets the board name its busiest book without
 * the read-per-bout a full quote costs. */
async function tradeSummary(
  config: Config,
  fromId: number,
  toId: number,
): Promise<{ prices: Map<number, number>; volumes: Map<number, number> }> {
  const prices = new Map<number, number>();
  const sums = new Map<number, bigint>();
  for (const log of await readFills(config, fromId, toId)) {
    const words = decodeWords(log.data);
    if (words.length < 3) continue;
    const boutId = log.bout_id;
    const price = Number(words[1]);
    // Rows come back in block order, so the last one written wins. A fill
    // printed on side B is the same event as its complement on side A.
    prices.set(boutId, Number(words[2]) === SIDE_BLUE ? price : 100 - price);
    sums.set(boutId, (sums.get(boutId) ?? 0n) + (words[0] * BigInt(price)) / 100n);
  }

  const unit = 10n ** BigInt(config.collateralDecimals);
  const volumes = new Map<number, number>();
  for (const [boutId, sum] of sums) {
    volumes.set(boutId, Number((sum * 1000n) / unit) / 1000);
  }
  return { prices, volumes };
}

async function buildQuote(config: Config, boutId: number, flipped: boolean): Promise<MarketQuote> {
  const [boutRaw, bookRaw] = await rpcBatch(config.rpcUrl, [
    ethCall(config.reader, encodeCall(SELECTORS.getBout, [boutId])),
    ethCall(config.reader, encodeCall(SELECTORS.getFullBook, [boutId])),
  ]);

  const b = decodeWords(boutRaw as string);
  const unit = 10n ** BigInt(config.collateralDecimals);

  // BoutView, in declaration order.
  const outcomeCode = Number(b[6]);
  const closed = b[7] === 1n;
  const resolved = b[8] === 1n;
  const pool = Number((b[9] * 1000n) / unit) / 1000;
  const bestBidA = Number(b[14]);
  const bestBidB = Number(b[16]);
  // 100 is the contract's "nothing resting" sentinel, not an offer at a
  // hundred cents. Normalised here so it never reaches the panel, where the
  // ticket would otherwise default its limit price to it and quote somebody a
  // fill at 99¢ against an empty book.
  const askOf = (raw: number) => (raw > 0 && raw < 100 ? raw : 0);
  const bestAskA = askOf(Number(b[15]));
  const bestAskB = askOf(Number(b[17]));

  // getFullBook: four uint256[100] in a row — bidA, askA, bidB, askB.
  const book = decodeWords(bookRaw as string);
  const A_BID = 0, A_ASK = 100, B_BID = 200, B_ASK = 300;

  const rawOutcome = outcomeFromCode(outcomeCode);
  const flip = <T,>(a: T, b: T) => (flipped ? b : a);

  const { history, volume, trades } = await fillHistory(config, boutId, flipped);

  // History is already quoted for blue, so the fallback goes in the same way
  // round as the answer and the flip is applied once, not twice.
  const lastBlue = history[history.length - 1]?.blue;
  // Both sides folded together, because the book matches them against each
  // other: what blue is really offered at is whichever is cheaper of a resting
  // ask on blue and the mirror of a resting bid on red.
  const { bid: blueBid, ask: blueAsk } = foldedBook(
    flip(bestBidA, bestBidB), flip(bestAskA, bestAskB),
    flip(bestBidB, bestBidA), flip(bestAskB, bestAskA),
  );
  const { bid: redBid, ask: redAsk } = foldedBook(
    flip(bestBidB, bestBidA), flip(bestAskB, bestAskA),
    flip(bestBidA, bestBidB), flip(bestAskA, bestAskB),
  );
  const blueMid = midPrice(blueBid, blueAsk, lastBlue);
  const blueBids = levelsFrom(book, flip(A_BID, B_BID), unit, true);
  const redBids = levelsFrom(book, flip(B_BID, A_BID), unit, true);

  // A void is a draw either way round; a winner has to be swapped with the
  // corners if the card was booked with the fighters the other way about.
  const outcome: BoutOutcome = flipped && rawOutcome === "blue" ? "red"
    : flipped && rawOutcome === "red" ? "blue"
    : rawOutcome;

  // Once the verdict is in, the market is not a mid any more. `_freezeBook`
  // has already cleared both sides, so reading the book here would hand back
  // whatever the last trade before the bell happened to be — a fight that ended
  // in a first-round stoppage still showing 58/42.
  const settled = settledPrice(outcome);
  const blue = settled ?? blueMid;

  return {
    boutId,
    outcome,
    closed,
    resolved,
    blue,
    red: 100 - blue,
    quoted: settled !== null || isQuoted(blueBid, blueAsk, lastBlue),
    bestBidBlue: blueBid,
    bestAskBlue: blueAsk,
    bestBidRed: redBid,
    bestAskRed: redAsk,
    pool,
    volume,
    bidsBlue: blueBids,
    // What a buyer can actually reach, which is the asks on this side plus
    // every bid on the other one at its mirror price.
    asksBlue: foldedAsks(levelsFrom(book, flip(A_ASK, B_ASK), unit, false), redBids),
    bidsRed: redBids,
    asksRed: foldedAsks(levelsFrom(book, flip(B_ASK, A_ASK), unit, false), blueBids),
    history,
    trades,
  };
}

/* ------------------------------------------------------------------- route */

export async function handleMarketRequest(request: Request, env: MarketEnv): Promise<Response> {
  const config = readConfig(env);
  if (!config) {
    return jsonResponse({ ok: true, booked: false, reason: "unconfigured" } satisfies MarketFeed);
  }

  const url = new URL(request.url);
  const night = Number(url.searchParams.get("night"));
  const blueId = url.searchParams.get("blue") ?? "";
  const redId = url.searchParams.get("red") ?? "";
  const now = Date.now();

  // The bouts a wallet could be holding something in, with no wallet named.
  // The address stays in the browser and does its own reading against these
  // ids, so the league hands over the map without learning who walks it.
  if (url.searchParams.get("scope") === "portfolio") {
    try {
      if (!indexCache || now - indexCache.at > QUOTE_TTL_MS) {
        indexCache = { at: now, value: await buildBoutIndex(config) };
      }
      return jsonResponse(
        indexCache.value.length === 0
          ? { ok: true, booked: false, reason: "unbooked" } satisfies PortfolioFeed
          : {
              ok: true,
              booked: true,
              chainId: config.chainId,
              rpcUrl: config.publicRpcUrl,
              clob: config.clob,
              reader: config.reader,
              collateral: config.collateral,
              collateralDecimals: config.collateralDecimals,
              collateralSymbol: config.collateralSymbol,
              explorer: config.explorer,
              bouts: indexCache.value,
            } satisfies PortfolioFeed,
      );
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : "The market is unreachable.",
      } satisfies PortfolioFeed, 502);
    }
  }

  if (!Number.isFinite(night) || night <= 0) {
    return jsonResponse({ ok: false, error: "Need a night." } satisfies MarketFeed, 400);
  }

  // The archive asking after a night that has been and gone. It costs a deeper
  // scan and it is believed for far longer, because both halves of the short
  // answer are wrong for a card that is over: the book is not going to appear
  // late, and it is not sitting in the first page off the head either.
  const settled = url.searchParams.get("settled") === "1";
  const key = `${night}:${blueId}:${redId}${settled ? ":settled" : ""}`;

  // A night with no fight named is the whole board — what the card rail draws
  // against eighteen rows at once.
  if (!blueId || !redId) {
    try {
      let cached = boardCache.get(key);
      if (!cached || now - cached.at > QUOTE_TTL_MS) {
        cached = { at: now, value: await buildBoard(config, night, settled) };
        boardCache.set(key, cached);
      }
      return jsonResponse(
        cached.value.length === 0
          ? { ok: true, booked: false, reason: "unbooked" } satisfies CardFeed
          : { ok: true, booked: true, bouts: cached.value } satisfies CardFeed,
      );
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : "The market is unreachable.",
      } satisfies CardFeed, 502);
    }
  }

  try {
    let mapped = mappingCache.get(key);
    // A miss is cached too, so a league with no book does not rescan the card
    // on every poll — but only for a few seconds, because a miss goes stale on
    // its own the moment the operator books the card. See `MISS_TTL_MS`.
    const ttl = mapped?.value === null && !settled ? MISS_TTL_MS : MAPPING_TTL_MS;
    if (!mapped || now - mapped.at > ttl) {
      mapped = { at: now, value: await findBout(config, night, blueId, redId, settled) };
      mappingCache.set(key, mapped);
    }

    if (mapped.value === null) {
      return jsonResponse({ ok: true, booked: false, reason: "unbooked" } satisfies MarketFeed);
    }

    const { boutId, flipped } = mapped.value;

    let cached = quoteCache.get(key);
    if (!cached || now - cached.at > QUOTE_TTL_MS) {
      cached = { at: now, value: await buildQuote(config, boutId, flipped) };
      quoteCache.set(key, cached);
    }

    return jsonResponse({
      ok: true,
      booked: true,
      chainId: config.chainId,
      rpcUrl: config.publicRpcUrl,
      clob: config.clob,
      reader: config.reader,
      collateral: config.collateral,
      collateralDecimals: config.collateralDecimals,
      collateralSymbol: config.collateralSymbol,
      explorer: config.explorer,
      takerFeeBps: config.takerFeeBps,
      quote: cached.value,
    } satisfies MarketFeed);
  } catch (error) {
    // The chain being unreachable is not the league being broken. Say what
    // happened and let the panel keep the fight on screen.
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "The market is unreachable.",
    } satisfies MarketFeed, 502);
  }
}
