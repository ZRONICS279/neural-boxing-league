import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type BroadcastClock,
  type BroadcastState,
  type ScheduledBout,
  airtimeEnd,
  leagueNow,
  realTimeFor,
} from "../app/broadcast.ts";
import { athleteIdToBytes32 } from "../app/market.ts";
import { openingLineFor } from "../app/opening-line.ts";
import type { LeagueState } from "../app/simulation.ts";
import {
  DEFAULT_MAKER_CONFIG,
  type MakerConfig,
  type RestingOrder,
  planQuotes,
} from "./market-maker.ts";

/** The league booking its own fights.
 *
 * A card is drawn up in full six hours before its first bell, and that gap is
 * the whole reason the markets can exist: eighteen matchups are settled and
 * public with an evening to look at them in. This is what puts them on chain —
 * one `createCard` when the night is announced, an opening quote at the
 * league's own line so the book is worth looking at, in-play quotes that ride
 * the aired fight, a `closeBouts` just ahead of each finish airing, and a
 * `resolveBouts` the moment the verdict is public.
 *
 * It is the only part of the league that holds a key. The read path
 * (`worker/market.ts`) cannot write, the browser cannot write, and everything
 * lifecycle-shaped here is `onlyOperator` on the contract's side. It holds no
 * *user* money at any point: the operator can book, close and score a bout, and
 * cannot touch a single unit of anyone else's collateral. Its own quoting money
 * is a position like anybody else's, taking the same fills at the same prices.
 *
 * Nothing in here is allowed to break the card. Every failure is swallowed and
 * retried on the next tick — a chain that is down, a key that is out of gas, or
 * an RPC that times out must not stop the league from fighting. */

/* ------------------------------------------------------------------ config */

export interface MarketOperatorEnv {
  FIGHT_RPC_URL?: string;
  FIGHT_CHAIN_ID?: string;
  FIGHT_CLOB_ADDRESS?: string;
  FIGHT_READER_ADDRESS?: string;
  /** The operator key, as a Wrangler secret. Its absence is what makes the
   *  whole of this module a no-op, which is the default. */
  FIGHT_OPERATOR_KEY?: string;
  /** Whole shares on the best rung of each ladder. "0" turns the maker off
   *  entirely and leaves every book to whoever gets there first. */
  FIGHT_SEED_SHARES?: string;
  /** Cents between the league's line and the price it will actually pay. */
  FIGHT_SEED_SPREAD?: string;
  /** Cents between ladder rungs. */
  FIGHT_MM_STEP?: string;
  /** Rungs per corner. */
  FIGHT_MM_LEVELS?: string;
  /** Size multiplier per rung out from the top. */
  FIGHT_MM_SIZE_GROWTH?: string;
  /** Net shares of exposure that buy one cent of lean. */
  FIGHT_MM_SKEW_SHARES?: string;
  /** Cap on that lean, in cents. */
  FIGHT_MM_MAX_SKEW?: string;
  /** Net shares of one-way exposure the maker will carry on one fight. The
   *  hard stop that bounds the loss on any single bout. */
  FIGHT_MM_MAX_NET?: string;
  /** Matched pairs held per fight to rest asks over. This is what makes an
   *  ordinary market order fillable; 0 leaves a bids-only book. */
  FIGHT_MM_STOCK?: string;
  /** Collateral units one fight may tie up in resting bids. */
  FIGHT_MM_BUDGET?: string;
}

/** How long before a fight's real finish its book shuts, in real milliseconds.
 *
 * Betting runs through the whole fight — that is the point of the streaming
 * cutover: nothing a client is served can name the winner until the finish
 * itself airs, so the fight is priceable for as long as it is watchable. Zero
 * because any positive lead is a close the card has to explain: this used to
 * be twenty seconds, and twenty real seconds of "book closed" over a fight
 * still airing told everyone watching that the finish was already booked —
 * roughly when, and from the shape of the round, roughly for whom. The rule
 * now is the house rule a viewer would state themselves: open until the clock
 * hits zero of the last round or the stoppage is called, never before. What
 * makes zero safe is that the tick-driven close was never the real gate —
 * `ensureBoutClosed` confirms the book is shut before either read path that
 * can name the winner serves a byte, so a close that lands a beat after
 * `endsAt` still lands before anyone can have learned the result. */
export const CLOSE_LEAD_MS = 0;

/** How far past the last fight of the night the wall-clock backstop sits.
 *
 * `latestCloseAt` is the "somebody has to be able to close this" valve, not the
 * bell — the bell is `closeBouts` below. It has to clear the whole card's real
 * airtime with room to spare, because the league clock can be paused and a
 * paused clock stretches an evening into however long the admin leaves it. If
 * it fires early the market simply freezes early and nobody loses money. */
const CLOSE_BACKSTOP_MS = 36 * 60 * 60 * 1000;
/** After this, anyone can `forceVoid` and every share redeems pro-rata. The
 *  valve for the operator key going dark, so it is deliberately far out. */
const VOID_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** Bouts read back per lookup, counted down from the newest id. */
const CARD_SCAN = 64n;
/** Resting orders read back when reclaiming collateral off a settled bout. */
const ORDER_SCAN = 128n;

/** Bouts requoted per pass, and orders cleaned up per pass.
 *
 * All of these are here because a tick is a shared resource: the league waits on
 * this before it publishes. Four bouts a pass walks the whole card in five
 * ticks, and the write cap keeps a pass bounded even when every one of them
 * needs its ladder rebuilt — which only happens on a card that has just been
 * booked, or one that has just been hammered. */
const QUOTE_BOUTS_PER_TICK = 4;
const QUOTE_WRITES_PER_TICK = 14;

/** An allowance large enough never to be the thing that stops a quote. */
const MAX_UINT256 = (1n << 256n) - 1n;
const RECYCLE_ORDERS_PER_TICK = 8;
const RECYCLE_BOUTS_PER_TICK = 6;

/** Settled bouts this isolate has already emptied out.
 *
 * Not authoritative and does not need to be — a fresh isolate simply reads the
 * positions again. It exists so the steady state, which is a card of eighteen
 * finished fights with nothing left in them, costs one call a tick instead of
 * thirty-six. */
const emptied = new Set<string>();

/* --------------------------------------------------------------------- abi */

const CLOB_ABI = [
  {
    type: "function", name: "createCard", stateMutability: "nonpayable",
    inputs: [
      { name: "cardId", type: "uint64" },
      { name: "fightersA", type: "bytes32[]" },
      { name: "fightersB", type: "bytes32[]" },
      { name: "latestCloseAt", type: "uint64" },
      { name: "voidAfter", type: "uint64" },
    ],
    outputs: [{ name: "boutIds", type: "uint256[]" }],
  },
  {
    type: "function", name: "closeBouts", stateMutability: "nonpayable",
    inputs: [{ name: "boutIds", type: "uint256[]" }], outputs: [],
  },
  {
    type: "function", name: "resolveBouts", stateMutability: "nonpayable",
    inputs: [
      { name: "boutIds", type: "uint256[]" },
      { name: "outcomes", type: "uint8[]" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "placeBuyOrder", stateMutability: "nonpayable",
    inputs: [
      { name: "boutId", type: "uint256" }, { name: "side", type: "uint8" },
      { name: "price", type: "uint8" }, { name: "shares", type: "uint256" },
      { name: "orderType", type: "uint8" },
    ],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "boutId", type: "uint256" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function", name: "placeSellOrder", stateMutability: "nonpayable",
    inputs: [
      { name: "boutId", type: "uint256" }, { name: "side", type: "uint8" },
      { name: "price", type: "uint8" }, { name: "shares", type: "uint256" },
      { name: "orderType", type: "uint8" },
    ],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function", name: "cancelOrder", stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint64" }], outputs: [],
  },
  {
    type: "function", name: "redeemMany", stateMutability: "nonpayable",
    inputs: [{ name: "boutIds", type: "uint256[]" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "nextBoutId", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "collateral", stateMutability: "view",
    inputs: [], outputs: [{ type: "address" }],
  },
  {
    type: "function", name: "oneUnit", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "pendingWithdrawal", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "sharesOf", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint8" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "escrowedOf", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint8" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "activeOrderCount", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "userOrderCount", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "cancelMyOrders", stateMutability: "nonpayable",
    inputs: [{ name: "startIdx", type: "uint256" }, { name: "maxBatch", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }],
  },
] as const;

const BOUT_VIEW = {
  type: "tuple",
  components: [
    { name: "boutId", type: "uint256" }, { name: "cardId", type: "uint64" },
    { name: "fighterA", type: "bytes32" }, { name: "fighterB", type: "bytes32" },
    { name: "latestCloseAt", type: "uint64" }, { name: "voidAfter", type: "uint64" },
    { name: "outcome", type: "uint8" }, { name: "closed", type: "bool" },
    { name: "resolved", type: "bool" }, { name: "pool", type: "uint256" },
    { name: "totalA", type: "uint256" }, { name: "totalB", type: "uint256" },
    { name: "priceA", type: "uint256" }, { name: "priceB", type: "uint256" },
    { name: "bestBidA", type: "uint8" }, { name: "bestAskA", type: "uint8" },
    { name: "bestBidB", type: "uint8" }, { name: "bestAskB", type: "uint8" },
  ],
} as const;

const ORDER_VIEW = {
  components: [
    { name: "orderId", type: "uint64" }, { name: "boutId", type: "uint256" },
    { name: "shares", type: "uint256" }, { name: "price", type: "uint8" },
    { name: "side", type: "uint8" }, { name: "isBuy", type: "bool" },
  ],
} as const;

const READER_ABI = [
  {
    type: "function", name: "getCard", stateMutability: "view",
    inputs: [
      { name: "cardId", type: "uint64" },
      { name: "fromBoutId", type: "uint256" },
      { name: "maxScan", type: "uint256" },
    ],
    outputs: [
      { name: "views", type: "tuple[]", components: BOUT_VIEW.components },
      { name: "nextIdx", type: "uint256" },
    ],
  },
  {
    type: "function", name: "getUserOrders", stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "startIdx", type: "uint256" },
      { name: "maxBatch", type: "uint256" },
    ],
    outputs: [
      { name: "open", type: "tuple[]", components: ORDER_VIEW.components },
      { name: "nextIdx", type: "uint256" },
    ],
  },
] as const;

/** Mirrors `FightCardCLOB.Outcome`. */
const OUTCOME_A = 1;
const OUTCOME_B = 2;
const OUTCOME_VOID = 3;

/** Mirrors `FightCardCLOB.OrderType`. */
const ORDER_GTC = 0;

const SIDE_A = 0;
const SIDE_B = 1;

/* ------------------------------------------------------------------ client */

interface Wired {
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  clob: Address;
  reader: Address;
  /** How the maker quotes, or null to leave every book to the crowd. */
  maker: MakerConfig | null;
}

function wire(env: MarketOperatorEnv): Wired | null {
  const { FIGHT_RPC_URL, FIGHT_CLOB_ADDRESS, FIGHT_READER_ADDRESS, FIGHT_OPERATOR_KEY } = env;
  if (!FIGHT_RPC_URL || !FIGHT_CLOB_ADDRESS || !FIGHT_READER_ADDRESS || !FIGHT_OPERATOR_KEY) {
    return null;
  }

  const chain = defineChain({
    id: Number(env.FIGHT_CHAIN_ID ?? 46630),
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [FIGHT_RPC_URL] } },
  });

  const account = privateKeyToAccount(
    (FIGHT_OPERATOR_KEY.startsWith("0x") ? FIGHT_OPERATOR_KEY : `0x${FIGHT_OPERATOR_KEY}`) as Hex,
  );

  return {
    publicClient: createPublicClient({ chain, transport: http(FIGHT_RPC_URL) }),
    walletClient: createWalletClient({ account, chain, transport: http(FIGHT_RPC_URL) }),
    account,
    clob: FIGHT_CLOB_ADDRESS as Address,
    reader: FIGHT_READER_ADDRESS as Address,
    maker: makerConfig(env),
  };
}

/** The maker's settings, as a card of environment overrides.
 *
 * `FIGHT_SEED_SHARES=0` still turns the whole thing off and leaves every book
 * empty, which is the setting a deploy with no quoting money wants. Everything
 * else falls back to `DEFAULT_MAKER_CONFIG` — the numbers there are chosen to
 * quote an eighteen-fight card on a few hundred units of collateral. */
function makerConfig(env: MarketOperatorEnv): MakerConfig | null {
  const size = Math.max(0, Number(env.FIGHT_SEED_SHARES ?? DEFAULT_MAKER_CONFIG.size) || 0);
  if (size === 0) return null;

  const read = (value: string | undefined, fallback: number, low = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= low ? parsed : fallback;
  };

  return {
    size,
    spread: Math.max(1, read(env.FIGHT_SEED_SPREAD, DEFAULT_MAKER_CONFIG.spread, 1)),
    step: Math.max(1, read(env.FIGHT_MM_STEP, DEFAULT_MAKER_CONFIG.step, 1)),
    levels: Math.max(1, read(env.FIGHT_MM_LEVELS, DEFAULT_MAKER_CONFIG.levels, 1)),
    sizeGrowth: Math.max(1, read(env.FIGHT_MM_SIZE_GROWTH, DEFAULT_MAKER_CONFIG.sizeGrowth, 1)),
    skewShares: Math.max(1, read(env.FIGHT_MM_SKEW_SHARES, DEFAULT_MAKER_CONFIG.skewShares, 1)),
    maxSkew: read(env.FIGHT_MM_MAX_SKEW, DEFAULT_MAKER_CONFIG.maxSkew),
    maxNet: read(env.FIGHT_MM_MAX_NET, DEFAULT_MAKER_CONFIG.maxNet),
    stock: read(env.FIGHT_MM_STOCK, DEFAULT_MAKER_CONFIG.stock),
    budget: read(env.FIGHT_MM_BUDGET, DEFAULT_MAKER_CONFIG.budget),
  };
}

/** Nonces, handed out in order for the whole pass.
 *
 * A pass can send half a dozen transactions and they all come from one account.
 * Left to itself each `writeContract` asks the node for a pending nonce, and a
 * node that has not yet seen the previous transaction hands out the same number
 * twice — so the second send replaces the first instead of following it. Read
 * once, count up locally.
 *
 * `resync` is for carrying on after a write that THREW: a send rejected at gas
 * estimation never reached the chain, so its number was handed out but never
 * used, and every later send this pass would sit in the pool behind a nonce
 * that is never coming. Re-reading the pending count closes the gap. */
type NonceDispenser = (() => number) & { resync: () => Promise<void> };

async function nonces(wired: Wired): Promise<NonceDispenser> {
  const pending = () =>
    wired.publicClient.getTransactionCount({
      address: wired.account.address,
      blockTag: "pending",
    });
  let next = await pending();
  const dispense = (() => next++) as NonceDispenser;
  dispense.resync = async () => {
    next = await pending();
  };
  return dispense;
}

/* ------------------------------------------------------------- the mapping */

interface OnChainBout {
  boutId: bigint;
  fighterA: Hex;
  fighterB: Hex;
  closed: boolean;
  resolved: boolean;
  /** `FightCardCLOB.Outcome`, and only meaningful once `resolved`. */
  outcome: number;
}

/** Tonight's bouts as the chain has them.
 *
 * Read back rather than remembered. The league already stores its card in D1
 * and a second copy of "which bout is which" in the same place is a second
 * thing that can be wrong — and when it is wrong, it closes betting on the
 * wrong fight. The contract holds the league's own ids, so it can just be
 * asked. */
async function onChainCard(wired: Wired, night: number): Promise<OnChainBout[]> {
  const head = await wired.publicClient.readContract({
    address: wired.clob, abi: CLOB_ABI, functionName: "nextBoutId",
  });
  const from = head > CARD_SCAN ? head - CARD_SCAN : 1n;

  const [views] = await wired.publicClient.readContract({
    address: wired.reader, abi: READER_ABI, functionName: "getCard",
    args: [BigInt(night), from, CARD_SCAN],
  });

  return views.map((view) => ({
    boutId: view.boutId,
    fighterA: view.fighterA,
    fighterB: view.fighterB,
    closed: view.closed,
    resolved: view.resolved,
    outcome: view.outcome,
  }));
}

/** The chain-side bout for a league fight, in whichever order it was booked. */
function matchBout(onChain: OnChainBout[], bout: ScheduledBout) {
  const blue = athleteIdToBytes32(bout.blueId).toLowerCase();
  const red = athleteIdToBytes32(bout.redId).toLowerCase();
  return onChain.find((entry) => {
    const a = entry.fighterA.toLowerCase();
    const b = entry.fighterB.toLowerCase();
    return (a === blue && b === red) || (a === red && b === blue);
  }) ?? null;
}

/** True when the league's blue corner was booked as the contract's fighter A.
 *
 * The card can be booked with the corners either way round, so every price and
 * every outcome has to be turned the right way before it leaves this module. */
function blueIsA(entry: OnChainBout, bout: ScheduledBout) {
  return entry.fighterA.toLowerCase() === athleteIdToBytes32(bout.blueId).toLowerCase();
}

/** True when this fight's book has to be shut, measured against what airs.
 *
 * The bout's own `endsAt` is server knowledge — the fight is simulated ahead
 * of its slot — and the finishing moment becomes public the instant the
 * league clock reaches it, so the close is due at that instant and
 * `CLOSE_LEAD_MS` (zero, see above) is how far it may anticipate it. A paused
 * broadcast maps `endsAt` to no real moment at all (`realTimeFor` is null)
 * and airs nothing while it is paused, so nothing needs closing until the
 * clock runs again. A slot that somehow reaches its bell unsimulated has no
 * finish to wait for — for that one the old rule, shut at the opening bell,
 * is the only safe one. */
export function bookCloseDue(
  bout: ScheduledBout,
  clock: BroadcastClock,
  realNow: number,
): boolean {
  const now = leagueNow(clock, realNow);
  if (!bout.result) return bout.startsAt <= now;
  if (bout.endsAt <= now) return true;
  const realEnd = realTimeFor(clock, bout.endsAt);
  return realEnd !== null && realEnd - realNow <= CLOSE_LEAD_MS;
}

/** How a league result reads to the contract.
 *
 * A draw is VOID, which pays every share 0.50 out of a pool that is funded for
 * it by construction. A bout with no result yet is not resolvable at all. */
function outcomeFor(bout: ScheduledBout, onChain: OnChainBout): number | null {
  const result = bout.result;
  if (!result || !bout.committed) return null;
  if (result.finish === "Draw" || result.winnerId === null) return OUTCOME_VOID;

  const winnerIsBlue = result.winnerId === bout.blueId;
  return winnerIsBlue === blueIsA(onChain, bout) ? OUTCOME_A : OUTCOME_B;
}

/* ---------------------------------------------------------------- the sync */

/** The in-play read on the fight currently airing, priced off the aired frame
 *  by `worker/inplay-line.ts` and handed in by the league tick. Blue's cents,
 *  unrounded — the operator decides when a move is big enough to requote. */
export interface LiveFair {
  boutId: number;
  blueLine: number;
}

export interface MarketSyncReport {
  booked: number;
  closed: number;
  resolved: number;
  quoted: number;
  reclaimed: number;
  error?: string;
}

/** Settles every market left behind when an operator replaces a card.
 *
 * A fight the audience has already seen keeps its real result. Anything still
 * running or only advertised is voided, returning both sides of every matched
 * set pro-rata rather than leaving money locked in a night that will never
 * finish. Like the regular sync, this can never stop the league: an unavailable
 * chain is reported and the replacement card still goes ahead. */
export async function settleAbandonedMarkets(
  env: MarketOperatorEnv,
  state: BroadcastState,
  realNow: number,
): Promise<{ resolved: number; error?: string }> {
  const report: { resolved: number; error?: string } = { resolved: 0 };
  const wired = wire(env);
  if (!wired || state.card.length === 0) return report;

  try {
    const onChain = await onChainCard(wired, state.night);
    const now = leagueNow(state.clock, realNow);
    const toResolve: { boutId: bigint; outcome: number }[] = [];
    for (const bout of state.card) {
      const entry = matchBout(onChain, bout);
      if (!entry || entry.resolved) continue;
      let outcome = OUTCOME_VOID;
      if (bout.result && bout.endsAt <= now) {
        if (bout.result.finish !== "Draw" && bout.result.winnerId !== null) {
          const winnerIsBlue = bout.result.winnerId === bout.blueId;
          outcome = winnerIsBlue === blueIsA(entry, bout) ? OUTCOME_A : OUTCOME_B;
        }
      }
      toResolve.push({ boutId: entry.boutId, outcome });
    }
    if (toResolve.length === 0) return report;

    const next = await nonces(wired);
    await wired.walletClient.writeContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "resolveBouts",
      account: wired.account, chain: wired.walletClient.chain, nonce: next(),
      args: [
        toResolve.map((entry) => entry.boutId),
        toResolve.map((entry) => entry.outcome),
      ],
    });
    report.resolved = toResolve.length;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}

/** Bring the chain into line with the card, in one pass.
 *
 * Idempotent by design: it reads what is on chain, diffs it against the card,
 * and only sends what is missing. Two workers racing here would produce the
 * same lists and the second one's transactions would revert or no-op rather
 * than double-booking a night — but it is still called from behind the league's
 * simulation lease, so ordinarily only one is ever in here.
 *
 * The order matters. Scoring a finished fight is the only thing anybody is
 * owed money by, so it goes before quoting the next one. */
export async function syncMarkets(
  env: MarketOperatorEnv,
  state: BroadcastState,
  league: LeagueState,
  realNow: number,
  liveFair: LiveFair | null = null,
): Promise<MarketSyncReport> {
  const report: MarketSyncReport = { booked: 0, closed: 0, resolved: 0, quoted: 0, reclaimed: 0 };
  const wired = wire(env);
  if (!wired || state.card.length === 0) return report;

  try {
    const onChain = await onChainCard(wired, state.night);
    const now = leagueNow(state.clock, realNow);
    const next = await nonces(wired);

    // 1. Book anything on the card the chain has never heard of. One call for
    //    the whole night: calldata is posted to L1 on an Orbit chain, so
    //    eighteen separate creates is eighteen times the expensive part.
    const unbooked = state.card.filter((bout) => !matchBout(onChain, bout));
    if (unbooked.length > 0) {
      const lastBell = Math.max(...state.card.map((bout) => airtimeEnd(bout)));
      // A paused clock has no real time at all, so the backstop is measured
      // from now rather than from a moment that does not exist yet.
      const lastBellReal = realTimeFor(state.clock, lastBell) ?? realNow + CLOSE_BACKSTOP_MS;
      const latestCloseAt = BigInt(Math.floor((lastBellReal + CLOSE_BACKSTOP_MS) / 1000));
      const voidAfter = BigInt(Math.floor((lastBellReal + VOID_AFTER_MS) / 1000));

      await wired.walletClient.writeContract({
        address: wired.clob, abi: CLOB_ABI, functionName: "createCard",
        account: wired.account, chain: wired.walletClient.chain, nonce: next(),
        args: [
          BigInt(state.night),
          unbooked.map((bout) => athleteIdToBytes32(bout.blueId) as Hex),
          unbooked.map((bout) => athleteIdToBytes32(bout.redId) as Hex),
          latestCloseAt,
          voidAfter,
        ],
      });
      report.booked = unbooked.length;
      // The ids only exist after that lands, so everything else waits for the
      // next pass. Nothing on the card needs any of it in the same second it
      // was announced — the first bell is six hours out.
      return report;
    }

    // 2. Shut the book on any fight whose finish has been reached. In-play
    //    trading means the opening bell no longer closes anything — the book
    //    rides the whole fight and shuts at the final bell or the stoppage
    //    call itself, with `ensureBoutClosed` holding the reveal until this
    //    write has landed. League-clock maths, not wall-clock: an admin can
    //    pause or fast-forward the broadcast, and the market has to follow
    //    the fight people are watching.
    const toClose = state.card
      .filter((bout) => bookCloseDue(bout, state.clock, realNow))
      .map((bout) => matchBout(onChain, bout))
      .filter((entry): entry is OnChainBout => entry !== null && !entry.closed && !entry.resolved);

    if (toClose.length > 0) {
      await wired.walletClient.writeContract({
        address: wired.clob, abi: CLOB_ABI, functionName: "closeBouts",
        account: wired.account, chain: wired.walletClient.chain, nonce: next(),
        args: [toClose.map((entry) => entry.boutId)],
      });
      report.closed = toClose.length;
      for (const entry of toClose) entry.closed = true;
    }

    // 3. Score the ones that are over, the moment they are over. `resolveBout`
    //    closes the bout itself, so this does not wait on the close above
    //    landing — a fight whose verdict is on screen is payable in the same
    //    pass that put it there.
    //
    //    Committed results only: a bout is simulated ahead of its slot, and
    //    paying out on a fight the audience has not been shown yet is how you
    //    leak the card.
    const toResolve: { boutId: bigint; outcome: number }[] = [];
    for (const bout of state.card) {
      const entry = matchBout(onChain, bout);
      if (!entry || entry.resolved) continue;
      const outcome = outcomeFor(bout, entry);
      if (outcome !== null && airtimeEnd(bout) <= now) {
        toResolve.push({ boutId: entry.boutId, outcome });
      }
    }

    if (toResolve.length > 0) {
      await wired.walletClient.writeContract({
        address: wired.clob, abi: CLOB_ABI, functionName: "resolveBouts",
        account: wired.account, chain: wired.walletClient.chain, nonce: next(),
        args: [
          toResolve.map((entry) => entry.boutId),
          toResolve.map((entry) => entry.outcome),
        ],
      });
      report.resolved = toResolve.length;
    }

    // 4. Keep the open books quoted, and take back what the settled ones hold.
    //    Each behind its own guard: a revert while quoting must not starve the
    //    reclaim, because the reclaim is what frees the order slots and the
    //    collateral that quoting needs. Letting one bad rung kill the whole
    //    pass is how the operator once wedged itself permanently — stuck at
    //    the contract's active-order ceiling, every ask reverting, and the
    //    cancels that would have freed it dying with the pass.
    report.quoted = await quoteBooks(wired, state, league, onChain, next, liveFair)
      .catch((error) => {
        report.error = error instanceof Error ? error.message : String(error);
        return 0;
      });
    report.reclaimed = await reclaim(wired, onChain, next);
  } catch (error) {
    // Never the league's problem. The next tick reads the chain again and
    // sends whatever is still missing.
    report.error = error instanceof Error ? error.message : String(error);
  }

  return report;
}

/* ------------------------------------------------------------- the reveal */

/** Bouts whose books this isolate has confirmed shut (or shut itself). */
const confirmedClosed = new Set<string>();

/** How long a reveal read waits for the close to be mined before giving up
 *  and holding the verdict for another poll. Generous against one slow block,
 *  short enough that a poller is never hung on a dead chain. */
const CLOSE_RECEIPT_MS = 8_000;

/** The last line of defence between an open book and a served result.
 *
 * The tick-driven close in `syncMarkets` fires the moment the finish is
 * reached and is how books usually shut. But with zero lead the ticks are
 * guaranteed to be racing the reveal — the final timeline chunk, the
 * aftermath verdict in the league payload — and those are served by read
 * handlers that run on any isolate at any moment. So the handlers call this
 * before serving anything that names a winner: it confirms the book is shut,
 * shuts it if it is not, and remembers the answer so every later reveal
 * costs nothing. This guard is what makes the zero-lead close safe at all.
 *
 * It deliberately runs outside the simulation lease — it must, since it backs
 * reads — which opens a small nonce race against a concurrent sync pass from
 * the operator account. Accepted: the write branch here only runs when the
 * tick close already failed to land, which is exactly when no sync pass is in
 * flight, and both paths retry idempotently anyway.
 *
 * Failure HOLDS the reveal (2026-08-10, reversing the original bargain): the
 * answer is a boolean, and a caller that gets `false` must keep the verdict
 * masked and the final chunk unaired. It used to serve anyway on the theory
 * that a dead chain must not freeze the broadcast — but the worker's RPC
 * being down does not mean the chain is down for everybody, and a result
 * published over a book the operator cannot reach is an invitation to dump
 * shares into it. So the mask stays up for as long as the book might still
 * be taking orders, and the finish airs the moment the close is confirmed.
 * Confirmed means MINED: the write waits for its receipt, because a reveal
 * served while the close is still in the mempool is a front-runnable race. */
export async function ensureBoutClosed(
  env: MarketOperatorEnv,
  state: BroadcastState,
  boutId: number,
): Promise<boolean> {
  const wired = wire(env);
  // No market wired up means no book anybody could dump into.
  if (!wired) return true;
  const bout = state.card.find((entry) => entry.id === boutId);
  if (!bout) return true;
  const key = `${wired.clob}:${state.night}:${boutId}`;
  if (confirmedClosed.has(key)) return true;

  /** The bout's book if it is still standing open on chain — null once it is
   *  closed or resolved, or if it was never booked and there is nothing to
   *  dump into. */
  const stillOpen = async () => {
    const entry = matchBout(await onChainCard(wired, state.night), bout);
    return entry && !entry.closed && !entry.resolved ? entry : null;
  };

  try {
    const entry = await stillOpen();
    if (entry) {
      const next = await nonces(wired);
      const hash = await wired.walletClient.writeContract({
        address: wired.clob, abi: CLOB_ABI, functionName: "closeBouts",
        account: wired.account, chain: wired.walletClient.chain, nonce: next(),
        args: [[entry.boutId]],
      });
      const receipt = await wired.publicClient.waitForTransactionReceipt({
        hash, timeout: CLOSE_RECEIPT_MS, pollingInterval: 500,
      });
      // Mined-but-reverted is almost always "CL" — the tick close won the
      // race — which is the answer being asked for. The re-read settles it.
      if (receipt.status !== "success" && (await stillOpen()) !== null) return false;
    }
    confirmedClosed.add(key);
    return true;
  } catch {
    // Left un-memoised on purpose: the next reveal asks again. A write that
    // reverted at estimation because the book is already shut still counts —
    // one re-read decides — while a chain that is truly unreachable stays
    // unconfirmed and the reveal stays held.
    const shut = await stillOpen().then((entry) => entry === null).catch(() => false);
    if (shut) confirmedClosed.add(key);
    return shut;
  }
}

/* ---------------------------------------------------------------- the quote */

/** Where the rotation left off last pass.
 *
 * A card is eighteen fights and a tick only has room for a handful of them, so
 * the maker works its way round rather than starting at the top every time.
 * Without this the last fights on the card would be quoted once when they were
 * booked and then never looked at again — which is the exact failure the
 * standing quote exists to fix. Not authoritative: a fresh isolate starts at
 * zero and simply arrives at the same books a pass or two later. */
let quoteCursor = 0;

/** The fair last actually quoted on the live fight, per bout.
 *
 * The in-play line drifts a fraction of a cent on almost every pass, and every
 * one-cent move rebuilds the whole ladder — a dozen transactions to say almost
 * nothing. So the quoted fair holds still until the model has moved three
 * cents away from it, and then jumps to the model. Measured over 33 captured
 * fights: ~14 requotes a fight instead of ~28, with the quote never more than
 * a couple of cents from the model's own read. Not authoritative — a fresh
 * isolate re-anchors on its first pass. */
const liveQuoted = new Map<number, number>();
const LIVE_REQUOTE_CENTS = 3;

function liveFairFor(boutId: number, blueLine: number): number {
  const held = liveQuoted.get(boutId);
  if (held !== undefined && Math.abs(blueLine - held) < LIVE_REQUOTE_CENTS) return held;
  const next = Math.round(blueLine);
  liveQuoted.set(boutId, next);
  return next;
}

/** Keep the league's line on every open book on the card.
 *
 * The old seeder quoted a fight once, when it was booked, and never again. That
 * is enough to make a book look populated and not enough to make it a market:
 * the first taker eats the quote, and the second finds an empty ladder on a
 * fight the league has an opinion about. Everything expensive about liquidity is
 * in the *second* quote and the two hundredth.
 *
 * So this reads what the maker is actually holding and actually has resting on
 * each fight, asks `planQuotes` what should be there instead, and sends the
 * difference. In the steady state — nothing filled, line unchanged — the diff is
 * empty and the pass costs no transactions at all. It only writes when the book
 * has moved away from where the league wants it.
 *
 * Cancels go before places, always. A stale bid resting above a fresh ask on the
 * same corner is a self-trade: the contract matches a sell against resting bids
 * without caring that both sides belong to us, and the maker would pay the taker
 * fee to buy its own shares back. */
async function quoteBooks(
  wired: Wired,
  state: BroadcastState,
  league: LeagueState,
  onChain: OnChainBout[],
  next: NonceDispenser,
  liveFair: LiveFair | null,
): Promise<number> {
  const config = wired.maker;
  if (!config) return 0;

  const open = state.card
    .map((bout) => ({ bout, entry: matchBout(onChain, bout) }))
    .filter(
      (pair): pair is { bout: ScheduledBout; entry: OnChainBout } =>
        pair.entry !== null && !pair.entry.closed && !pair.entry.resolved,
    );
  if (open.length === 0) return 0;

  for (const id of liveQuoted.keys()) {
    if (!open.some((pair) => pair.bout.id === id)) liveQuoted.delete(id);
  }

  // The fight on air jumps the queue every pass — its fair moves with the
  // action, and a maker one knockdown behind the screen is the free money the
  // in-play book must not be. The rest of the card takes the rotation.
  const live = liveFair ? open.find((pair) => pair.bout.id === liveFair.boutId) ?? null : null;
  const rest = live ? open.filter((pair) => pair !== live) : open;
  const candidates = live ? [live] : [];
  if (rest.length > 0) {
    quoteCursor %= rest.length;
    const spots = Math.min(QUOTE_BOUTS_PER_TICK - candidates.length, rest.length);
    for (let i = 0; i < spots; i += 1) candidates.push(rest[(quoteCursor + i) % rest.length]);
    quoteCursor += spots;
  }

  const [collateral, oneUnit] = await Promise.all([
    wired.publicClient.readContract({ address: wired.clob, abi: CLOB_ABI, functionName: "collateral" }),
    wired.publicClient.readContract({ address: wired.clob, abi: CLOB_ABI, functionName: "oneUnit" }),
  ]);
  const [balance, allowance, resting] = await Promise.all([
    wired.publicClient.readContract({
      address: collateral, abi: ERC20_ABI, functionName: "balanceOf",
      args: [wired.account.address],
    }),
    wired.publicClient.readContract({
      address: collateral, abi: ERC20_ABI, functionName: "allowance",
      args: [wired.account.address, wired.clob],
    }),
    liveOrders(wired),
  ]);

  if (allowance < balance / 2n) {
    // Approve the wallet, not the ticket. This account exists to quote the
    // league's own card and nothing else, and a fresh approval before every
    // order is a transaction per rung for no security anybody has.
    await wired.walletClient.writeContract({
      address: collateral, abi: ERC20_ABI, functionName: "approve",
      account: wired.account, chain: wired.walletClient.chain, nonce: next(),
      args: [wired.clob, MAX_UINT256],
    });
  }

  const restingByBout = new Map<bigint, RestingOrder[]>();
  for (const order of resting) {
    const list = restingByBout.get(order.boutId) ?? [];
    list.push({ ...order, shares: order.shares / Number(oneUnit) });
    restingByBout.set(order.boutId, list);
  }

  /** Collateral in the wallet, in whole units, as this pass spends it down. */
  let wallet = Number(balance) / Number(oneUnit);
  let writes = 0;
  let quoted = 0;

  for (const { bout, entry } of candidates) {
    if (writes >= QUOTE_WRITES_PER_TICK) break;

    // The live fight is priced off what has aired; everything else still
    // trades on the opening line until its own bell.
    const blueLine = bout.id === liveFair?.boutId
      ? liveFairFor(bout.id, liveFair.blueLine)
      : openingLineFor(league.roster, bout.blueId, bout.redId);
    // A fighter who has left the roster has no line, and a made-up one would
    // be a real price on a real book. Leave that fight to the market.
    if (blueLine === null) continue;
    const fair = blueIsA(entry, bout) ? blueLine : 100 - blueLine;

    // Shares parked in an unfilled sell order still belong to us and are still
    // exposure — `placeSellOrder` moves them out of `sharesOf` and into escrow,
    // so reading only the first would have the maker believe it had flattened
    // itself the moment it offered.
    const [heldA, heldB, escrowA, escrowB] = await Promise.all([
      readShares(wired, "sharesOf", entry.boutId, SIDE_A),
      readShares(wired, "sharesOf", entry.boutId, SIDE_B),
      readShares(wired, "escrowedOf", entry.boutId, SIDE_A),
      readShares(wired, "escrowedOf", entry.boutId, SIDE_B),
    ]);
    const unit = Number(oneUnit);
    const inventory = {
      a: (Number(heldA) + Number(escrowA)) / unit,
      b: (Number(heldB) + Number(escrowB)) / unit,
    };

    const mine = restingByBout.get(entry.boutId) ?? [];
    // Cancelling a bid hands its collateral straight back, so money already
    // resting on *this* fight is money this fight can re-spend. Without that
    // the maker would read a drained wallet and cancel its own ladder down to
    // nothing on the first pass after it had quoted the card.
    const parked = mine
      .filter((order) => order.isBuy)
      .reduce((sum, order) => sum + (order.price * order.shares) / 100, 0);

    const plan = planQuotes({
      fair,
      inventory,
      resting: mine,
      cash: wallet + parked,
      config,
    });
    if (plan.cancel.length === 0 && plan.place.length === 0 && plan.mint === 0) continue;

    // One bout's book failing must not silence the rest of the card — least
    // of all the live fight, which is always first in the queue. A revert
    // here skips to the next bout and the next pass retries this one.
    try {
      // Stock first: the asks below are sold out of it, and `placeSellOrder`
      // reverts on shares the account does not hold yet.
      if (plan.mint > 0 && writes < QUOTE_WRITES_PER_TICK) {
        await wired.walletClient.writeContract({
          address: wired.clob, abi: CLOB_ABI, functionName: "mint",
          account: wired.account, chain: wired.walletClient.chain, nonce: next(),
          args: [entry.boutId, BigInt(plan.mint) * oneUnit],
        });
        writes += 1;
        wallet -= plan.mint;
        inventory.a += plan.mint;
        inventory.b += plan.mint;
      }

      for (const orderId of plan.cancel) {
        if (writes >= QUOTE_WRITES_PER_TICK) break;
        await wired.walletClient.writeContract({
          address: wired.clob, abi: CLOB_ABI, functionName: "cancelOrder",
          account: wired.account, chain: wired.walletClient.chain, nonce: next(),
          args: [orderId],
        });
        writes += 1;
        const order = mine.find((entry) => entry.orderId === orderId);
        if (order?.isBuy) wallet += (order.price * order.shares) / 100;
      }

      for (const quote of plan.place) {
        if (writes >= QUOTE_WRITES_PER_TICK) break;
        const cost = (quote.price * quote.shares) / 100;
        if (quote.isBuy && cost > wallet) continue;
        await wired.walletClient.writeContract({
          address: wired.clob, abi: CLOB_ABI,
          functionName: quote.isBuy ? "placeBuyOrder" : "placeSellOrder",
          account: wired.account, chain: wired.walletClient.chain, nonce: next(),
          args: [entry.boutId, quote.side, quote.price, BigInt(quote.shares) * oneUnit, ORDER_GTC],
        });
        writes += 1;
        if (quote.isBuy) wallet -= cost;
      }
      quoted += 1;
    } catch {
      // The failed send never reached the chain, so its nonce was handed out
      // and never used — everything after it would queue behind a number
      // that is never coming. Close the gap before the next bout.
      await next.resync().catch(() => {});
    }
  }

  return quoted;
}

function readShares(wired: Wired, fn: "sharesOf" | "escrowedOf", boutId: bigint, side: number) {
  return wired.publicClient.readContract({
    address: wired.clob, abi: CLOB_ABI, functionName: fn,
    args: [boutId, side, wired.account.address],
  });
}

/** Every order the maker still has resting, anywhere.
 *
 * `userOrders` is append-only — the contract never removes an entry, it only
 * zeroes the order it points at. So `getUserOrders(account, 0, n)` reads the
 * *oldest* n slots, and once the account has placed more than n orders in its
 * life that window is nothing but dead ones. The maker then believes it has an
 * empty book, re-posts its whole ladder every pass, and climbs to the
 * contract's five-hundred-order ceiling, after which every single `_rest`
 * reverts with "UL" and it silently stops quoting the card for good.
 *
 * So: page backwards from the end, and stop as soon as we have accounted for
 * `activeOrderCount` live orders. Backwards because a maker that reconciles
 * every pass has its live orders bunched at the tail; the counter is what makes
 * it exact rather than merely likely. */
async function liveOrders(wired: Wired): Promise<(RestingOrder & { boutId: bigint })[]> {
  const [total, active] = await Promise.all([
    wired.publicClient.readContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "userOrderCount",
      args: [wired.account.address],
    }),
    wired.publicClient.readContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "activeOrderCount",
      args: [wired.account.address],
    }),
  ]);

  const found: (RestingOrder & { boutId: bigint })[] = [];
  let end = total;
  while (end > 0n && BigInt(found.length) < active) {
    const start = end > ORDER_SCAN ? end - ORDER_SCAN : 0n;
    const [page] = await wired.publicClient.readContract({
      address: wired.reader, abi: READER_ABI, functionName: "getUserOrders",
      args: [wired.account.address, start, end - start],
    });
    for (const order of page) {
      found.push({
        orderId: order.orderId,
        boutId: order.boutId,
        side: order.side,
        isBuy: order.isBuy,
        price: order.price,
        shares: Number(order.shares),
      });
    }
    end = start;
  }
  return found;
}

/* ------------------------------------------------------------ the capital */

/** Take back what a settled fight is still holding.
 *
 * Quoting money is not spent, it is parked: a resting bid holds its collateral
 * until it is filled or cancelled, and a filled one turns into shares that are
 * worth something only once somebody redeems them. Neither comes back on its
 * own. Left alone the operator would quote one card, and then be broke with
 * every unit of it sitting in books on fights that finished days ago.
 *
 * So each pass reclaims a little: cancel resting orders on bouts that have been
 * scored, redeem the winning shares, and pull the proceeds out of the
 * contract's pull-payment ledger into the wallet, where the next card's quotes
 * can use them.
 *
 * "Scored" includes bouts this pass cannot see. Orders left resting when a
 * night rolls over belong to bouts that are not on the current chain card at
 * all, and nothing ever books a night ahead of time — so an order on an
 * off-card bout is on a *finished* night, full stop. The first version only
 * cancelled orders on the current night's settled bouts, and the rollover
 * strays it skipped accumulated for weeks until the operator sat at the
 * contract's 500-active-order ceiling with every quote reverting "UL". */
/** Which of the operator's resting orders a reclaim pass may cancel: on a bout
 *  scored tonight, or on no bout of tonight's card at all — the second clause
 *  is the rollover strays. Safe against the maker's own quotes: those only
 *  ever rest on tonight's open bouts, which match neither clause. Exported
 *  for the tests. */
export function staleRestingOrders<T extends { boutId: bigint }>(
  open: T[],
  onChain: Pick<OnChainBout, "boutId" | "resolved">[],
): T[] {
  const settled = new Set(
    onChain.filter((entry) => entry.resolved).map((entry) => entry.boutId),
  );
  const card = new Set(onChain.map((entry) => entry.boutId));
  return open.filter(
    (order) => settled.has(order.boutId) || !card.has(order.boutId),
  );
}

async function reclaim(
  wired: Wired,
  onChain: OnChainBout[],
  next: NonceDispenser,
): Promise<number> {
  const settled = onChain.filter(
    (entry) => entry.resolved && !emptied.has(`${wired.clob}:${entry.boutId}`),
  );
  if (settled.length === 0) return 0;

  // Scanned from the tail rather than from index 0 — see `liveOrders`. Reading
  // the oldest window here meant a maker that had been quoting for a few cards
  // never found its own stale orders, and left their collateral locked on
  // fights that finished days ago.
  const open = await liveOrders(wired);

  const stale = staleRestingOrders(open, onChain).slice(0, RECYCLE_ORDERS_PER_TICK);
  for (const order of stale) {
    await wired.walletClient.writeContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "cancelOrder",
      account: wired.account, chain: wired.walletClient.chain, nonce: next(),
      args: [order.orderId],
    });
  }

  // `redeem` reverts on a bout this account holds nothing *winning* in, and one
  // revert takes the whole batch down with it — so the positions are read
  // first. A void bout pays on either side; a scored one pays only on the side
  // that won, and holding the other side is exactly the case that reverts.
  const holdings = await Promise.all(
    settled.slice(0, RECYCLE_BOUTS_PER_TICK).map(async (entry) => {
      const [a, b] = await Promise.all([
        wired.publicClient.readContract({
          address: wired.clob, abi: CLOB_ABI, functionName: "sharesOf",
          args: [entry.boutId, SIDE_A, wired.account.address],
        }),
        wired.publicClient.readContract({
          address: wired.clob, abi: CLOB_ABI, functionName: "sharesOf",
          args: [entry.boutId, SIDE_B, wired.account.address],
        }),
      ]);
      const winning =
        entry.outcome === OUTCOME_VOID ? a + b : entry.outcome === OUTCOME_A ? a : b;
      // Nothing resting and nothing to redeem is a bout that is finished with.
      if (winning === 0n && !stale.some((order) => order.boutId === entry.boutId)) {
        emptied.add(`${wired.clob}:${entry.boutId}`);
      }
      return { boutId: entry.boutId, winning };
    }),
  );

  const payable = holdings.filter((held) => held.winning > 0n).map((held) => held.boutId);
  if (payable.length > 0) {
    await wired.walletClient.writeContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "redeemMany",
      account: wired.account, chain: wired.walletClient.chain, nonce: next(),
      args: [payable],
    });
  }

  const pending = await wired.publicClient.readContract({
    address: wired.clob, abi: CLOB_ABI, functionName: "pendingWithdrawal",
    args: [wired.account.address],
  });
  if (pending > 0n) {
    await wired.walletClient.writeContract({
      address: wired.clob, abi: CLOB_ABI, functionName: "withdraw",
      account: wired.account, chain: wired.walletClient.chain, nonce: next(),
      args: [],
    });
  }

  return stale.length + payable.length;
}
