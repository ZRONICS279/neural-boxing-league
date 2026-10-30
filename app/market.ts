/** The betting book, from the league's side of the wire.
 *
 * `FightCardCLOB` on Robinhood Chain runs an order book per bout: two sides,
 * blue and red, priced in cents, and one winning share pays one collateral
 * unit. This module is the whole of what the league knows about it — the
 * worker imports the reads, the browser imports the writes, and both share the
 * types so a price never means one thing on the server and another on screen.
 *
 * There is no web3 library here on purpose. The repo runs on four dependencies
 * and this needs exactly three things a library would give it: function
 * selectors, ABI words, and a wallet handshake. All three are a few lines each
 * when every argument is a static type, which every argument here is.
 *
 * The selectors below were taken from `cast sig` against the deployed sources
 * in the clawpolymarket repo and are checked by `tests/market.test.ts`. They are
 * constants rather than something derived at runtime because deriving them
 * would mean shipping keccak-256 to the browser to recompute nineteen values
 * that cannot change without the contract changing. */

/* --------------------------------------------------------------- the market */

/** Which fighter a share pays out on. Blue is the league's left corner. */
export const SIDE_BLUE = 0;
export const SIDE_RED = 1;

/** Mirrors `FightCardCLOB.OrderType`. */
export const ORDER_GTC = 0;
export const ORDER_FOK = 1;
export const ORDER_FAK = 2;

/** Mirrors `FightCardCLOB.Outcome`. */
export type BoutOutcome = "unresolved" | "blue" | "red" | "void";
const OUTCOMES: BoutOutcome[] = ["unresolved", "blue", "red", "void"];

/** Order sizes must be a multiple of this many base units, so `shares × price
 *  / 100` is exact and a complementary match funds a whole set to the wei. */
export const SIZE_STEP = 100n;

/* ------------------------------------------------------------------ the ABI */

export const SELECTORS = {
  // FightCardReader
  getBout: "0x604e053b",          // getBout(uint256)
  getFullBook: "0xcbf17da0",      // getFullBook(uint256)
  getPosition: "0xd29f541d",      // getPosition(uint256,address)
  getCard: "0xf1b166e0",          // getCard(uint64,uint256,uint256)
  getUserOrders: "0xc7efbe36",    // getUserOrders(address,uint256,uint256)
  userOrderCount: "0xec4eb4f9",   // userOrderCount(address)
  getBouts: "0xd7eab921",         // getBouts(uint256[])
  getPortfolio: "0x8865bba3",     // getPortfolio(address,uint256[])
  // FightCardCLOB
  nextBoutId: "0x99e168f1",       // nextBoutId()
  pendingWithdrawal: "0x0964c95b",// pendingWithdrawal(address)
  oneUnit: "0xcc3342a2",          // oneUnit()
  placeBuyOrder: "0x3ba153d1",    // placeBuyOrder(uint256,uint8,uint8,uint256,uint8)
  placeSellOrder: "0x206e210f",   // placeSellOrder(uint256,uint8,uint8,uint256,uint8)
  cancelOrder: "0x523eb537",      // cancelOrder(uint64)
  cancelMyOrders: "0x8b693124",   // cancelMyOrders(uint256,uint256)
  redeem: "0xdb006a75",           // redeem(uint256)
  withdraw: "0x3ccfd60b",         // withdraw()
  // ERC-20 / TestUSD
  approve: "0x095ea7b3",          // approve(address,uint256)
  allowance: "0xdd62ed3e",        // allowance(address,address)
  balanceOf: "0x70a08231",        // balanceOf(address)
  decimals: "0x313ce567",         // decimals()
  drip: "0x9f678cca",             // drip()
  nextDripAt: "0x7e18627d",       // nextDripAt(address)
  mint: "0x40c10f19",             // mint(address,uint256)
} as const;

/** `OrderFilled(uint64,uint64,uint256,uint256,uint8,uint8,bool)`.
 *
 * Every trade the book has ever printed, and therefore the price chart. The
 * bout id is the third indexed argument, so one filter pulls the history of a
 * single fight without touching the rest of the card. */
export const TOPIC_ORDER_FILLED =
  "0x9c5ddddcffc3d086a3f0937c20216a27ea913e83eaec6b00092655bb3ae4ff8f";

/* ---------------------------------------------------------- abi encode/decode */

/** One 32-byte ABI word, unprefixed. */
export function word(value: bigint | number): string {
  const n = BigInt(value);
  if (n < 0n) throw new Error("market: negative ABI word");
  return n.toString(16).padStart(64, "0");
}

export function addressWord(address: string): string {
  const bare = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(bare)) throw new Error(`market: bad address ${address}`);
  return bare.padStart(64, "0");
}

/** Calldata for a call whose arguments are all static — which is most of them. */
export function encodeCall(selector: string, args: (bigint | number | string)[] = []) {
  const words = args.map((arg) =>
    typeof arg === "string" ? addressWord(arg) : word(arg),
  );
  return selector + words.join("");
}

/** Calldata for a call that ends in a `uint256[]`.
 *
 * The only dynamic argument anything here passes, and it is worth the twelve
 * lines: asking the reader about forty bouts in one call rather than forty is
 * the difference between a portfolio that loads and one that walks a public
 * node into a rate limit. Heads first — every static argument, then the offset
 * the array begins at — and the array's own length and contents after them. */
export function encodeCallWithIds(
  selector: string,
  head: (bigint | number | string)[],
  ids: number[],
) {
  const heads = head.map((arg) => (typeof arg === "string" ? addressWord(arg) : word(arg)));
  const offset = (heads.length + 1) * 32;
  return selector + [
    ...heads,
    word(offset),
    word(ids.length),
    ...ids.map((id) => word(id)),
  ].join("");
}

/** Split a returndata blob into 32-byte words as bigints. */
export function decodeWords(data: string): bigint[] {
  const bare = data.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= bare.length; i += 64) {
    out.push(BigInt("0x" + bare.slice(i, i + 64)));
  }
  return out;
}

/** Rows of a returned `T[]` where every field of `T` is one static word.
 *
 * Which is every struct the reader hands back — `BoutView`, `PositionView`,
 * `OrderView` are all flat — so the whole of ABI decoding this file needs is
 * "follow the offset, read the length, then walk in strides". `headWord` is
 * where the array's offset sits in the return, since a call that returns an
 * array alongside other values puts it after them. */
export function decodeStructArray(words: bigint[], headWord: number, stride: number): bigint[][] {
  const at = Number(words[headWord] ?? 0n) / 32;
  const count = Number(words[at] ?? 0n);
  const rows: bigint[][] = [];
  for (let i = 0; i < count; i++) {
    const base = at + 1 + i * stride;
    if (base + stride > words.length) break;
    rows.push(words.slice(base, base + stride));
  }
  return rows;
}

/** The league's athlete id as the contract stores it: UTF-8, left-aligned,
 *  zero-padded right. Matches `ethers.encodeBytes32String`, which is what the
 *  operator scripts book a card with. Ids longer than 31 bytes have no bytes32
 *  form at all, so this refuses rather than silently truncating a fighter into
 *  somebody else. */
export function athleteIdToBytes32(id: string): string {
  const bytes = new TextEncoder().encode(id);
  if (bytes.length > 31) throw new Error(`market: athlete id too long: ${id}`);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return "0x" + hex.padEnd(64, "0");
}

export function bytes32ToAthleteId(value: bigint | string): string {
  const bare = (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, ""))
    .padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    const byte = parseInt(bare.slice(i, i + 2), 16);
    if (byte === 0) break;
    bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function outcomeFromCode(code: bigint | number): BoutOutcome {
  return OUTCOMES[Number(code)] ?? "unresolved";
}

/* ------------------------------------------------------------------- shapes */

/** A price the book actually printed, or the mid it is showing right now.
 *
 * Always quoted for blue, in cents. Red is 100 − blue by construction: the two
 * shares of a bout are funded out of one collateral unit, so a market that
 * disagreed with itself would be free money. */
export interface PricePoint {
  /** Unix ms. */
  at: number;
  /** 1–99. */
  blue: number;
}

export interface BookLevel {
  /** 1–99 cents. */
  price: number;
  /** Shares resting, in whole shares. */
  shares: number;
}

/** One fill the book printed, the way a tape reads it.
 *
 * A `PricePoint` is this same event with everything but the price thrown away,
 * because that is all a line needs. The tape wants the rest: which corner the
 * shares were on, how many, and whether the person who crossed the spread was
 * buying or selling — which is the difference between a market somebody is
 * lifting and one somebody is hitting. */
export interface Trade {
  /** Unix ms. */
  at: number;
  /** True when the shares are on the league's blue corner. */
  blueSide: boolean;
  /** 1–99 cents, on the corner named above — not folded onto blue. */
  price: number;
  /** Whole shares. */
  shares: number;
  /** True when the taker was buying that corner. */
  takerBought: boolean;
}

export interface MarketPosition {
  blueShares: number;
  redShares: number;
  /** What `redeem()` would pay right now — zero until the bout is scored. */
  claimable: number;
  /** Collateral sitting in the contract waiting on `withdraw()`. */
  pending: number;
  balance: number;
  allowance: number;
}

/** A bet that has not been taken yet: still on the book, still the wallet's. */
export interface OpenOrder {
  id: number;
  boutId: number;
  side: 0 | 1;
  isBuy: boolean;
  /** 1–99 cents. */
  price: number;
  /** Base units, like everything else the contract counts shares in. */
  shares: bigint;
  /** The first slot of the `userOrders` page it was read from. The reader
   *  returns only the live orders in a page, not where each one sat, so this
   *  is a floor rather than its exact index. Enough to aim a bulk cancel. */
  from: number;
}

/** Everything the panel draws for one fight. */
export interface MarketQuote {
  boutId: number;
  outcome: BoutOutcome;
  closed: boolean;
  resolved: boolean;
  /** Mid price in cents, or 99/1 once the fight has been scored. */
  blue: number;
  red: number;
  /** False when nothing is resting and nothing has traded, so `blue` is a
   *  stand-in rather than a price and the caller should show its own line. */
  quoted: boolean;
  /** Best resting prices, in cents. 0 means nothing is resting. */
  bestBidBlue: number;
  bestAskBlue: number;
  bestBidRed: number;
  bestAskRed: number;
  /** Total collateral behind the bout, in whole units. */
  pool: number;
  /** Cumulative traded volume in whole units. */
  volume: number;
  bidsBlue: BookLevel[];
  asksBlue: BookLevel[];
  bidsRed: BookLevel[];
  asksRed: BookLevel[];
  history: PricePoint[];
  /** Newest first, capped — the tape, not the whole ledger. */
  trades: Trade[];
}

/** The payout a share at this price returns, the way a book quotes it.
 *
 * A share costs its own probability and pays exactly one usdc, so 61¢ is 1.64×.
 * Shown beside the percentage because they are the same fact read two ways and
 * different people read one or the other. */
export function payoutMultiple(cents: number) {
  if (cents <= 0) return 0;
  return 100 / cents;
}

/** One row of the whole-night board.
 *
 * Deliberately thinner than a `MarketQuote`: the card rail draws eighteen of
 * these at once and needs a price and nothing else. The reader hands back every
 * bout of a night in a single `getCard`, so the entire board costs one call —
 * whereas eighteen full quotes would be thirty-six, plus a log scan each. */
export interface CardOdds {
  boutId: number;
  /** Athlete ids, in whichever order the card was booked on chain. */
  fighterA: string;
  fighterB: string;
  /** Mid price of `fighterA`, in cents. `fighterB` is 100 − this. */
  priceA: number;
  /** False when the book has never held a price. See `MarketQuote.quoted`. */
  quoted: boolean;
  closed: boolean;
  resolved: boolean;
  outcome: BoutOutcome;
  /** Collateral traded through the book, both sides folded — the one field
   *  here that is not a price. It rides the same log scan as the last-trade
   *  fallback, and it is what lets a rail name the busiest fight without
   *  asking for eighteen full quotes. */
  volume: number;
}

/** A bout the league can still name, whichever night it was on.
 *
 * The board is one night; this is the window a wallet's holdings could be
 * spread across, which is however many nights ago somebody last traded and
 * never came back to claim. Same row plus the night it was fought, so the
 * portfolio can say "night 12" rather than "bout #37". */
export interface BoutRef extends CardOdds {
  night: number;
}

/** What `/api/market?scope=portfolio` answers with.
 *
 * Deliberately does not take an address and deliberately holds no positions:
 * this is the public half of a portfolio — which bouts exist, who fought, how
 * they ended — and the private half is read straight out of the wallet against
 * these ids. The league hands over the map and never learns who walked it. */
export type PortfolioFeed =
  | { ok: true; booked: false; reason: "unconfigured" | "unbooked" }
  | {
      ok: true;
      booked: true;
      chainId: number;
      rpcUrl: string;
      clob: string;
      reader: string;
      collateral: string;
      collateralDecimals: number;
      collateralSymbol: string;
      explorer: string;
      bouts: BoutRef[];
    }
  | { ok: false; error: string };

/** What `/api/market?night=N` answers with when no fight is named. */
export type CardFeed =
  | { ok: true; booked: false; reason: "unconfigured" | "unbooked" }
  | { ok: true; booked: true; bouts: CardOdds[] }
  | { ok: false; error: string };

/** The odds for one league fight, whichever way round it was booked. */
export function oddsForFight(board: CardOdds[], blueId: string, redId: string) {
  const row = board.find(
    (entry) =>
      (entry.fighterA === blueId && entry.fighterB === redId) ||
      (entry.fighterA === redId && entry.fighterB === blueId),
  );
  if (!row) return null;
  const blue = row.fighterA === blueId ? row.priceA : 100 - row.priceA;
  return {
    boutId: row.boutId,
    blue,
    red: 100 - blue,
    quoted: row.quoted,
    closed: row.closed,
    resolved: row.resolved,
  };
}

/** What `/api/market` answers with.
 *
 * `booked: false` is the ordinary case, not an error: the league runs whether
 * or not anyone has put a book up against tonight's card, and a fight with no
 * market is a fight with no market. The panel says so and stays out of the way. */
export type MarketFeed =
  | { ok: true; booked: false; reason: "unconfigured" | "unbooked" }
  | {
      ok: true;
      booked: true;
      chainId: number;
      /** Public endpoint, for adding the chain to a wallet that has never seen it. */
      rpcUrl: string;
      clob: string;
      reader: string;
      collateral: string;
      collateralDecimals: number;
      collateralSymbol: string;
      explorer: string;
      takerFeeBps: number;
      quote: MarketQuote;
    }
  | { ok: false; error: string };

/* ------------------------------------------------------------------- pricing */

/** No resting bid is 0; no resting ask is 100.
 *
 * Both are sentinels rather than prices — ticks only run 1–99 — and reading the
 * ask sentinel as a real 100¢ offer prices a market at certainty the moment its
 * book empties out, which is exactly what happens after a complementary match
 * clears both sides. */
const NO_BID = 0;
const NO_ASK = 100;

/** The mid, the way a book with one empty side has to be read.
 *
 * Cross the best bid and ask when both are there, take whichever exists when
 * only one is, and fall back to the last price the bout actually traded at when
 * neither is. That last case is not an edge: a complementary match consumes
 * both orders and leaves the book empty at a price everyone agreed on seconds
 * ago, and answering "50" there would throw the real number away. */
export function midPrice(bestBid: number, bestAsk: number, lastTrade?: number): number {
  const bid = bestBid > NO_BID ? bestBid : 0;
  const ask = bestAsk > 0 && bestAsk < NO_ASK ? bestAsk : 0;
  if (bid && ask) return Math.round((bid + ask) / 2);
  if (bid) return bid;
  if (ask) return ask;
  if (lastTrade && lastTrade > 0 && lastTrade < 100) return lastTrade;
  return 50;
}

/** One side's top of book, with the other side's folded into it.
 *
 * A bid on red at 32¢ is an offer of blue at 68¢. The book matches them against
 * each other and mints the set between them, so those are not two one-sided
 * markets — they are one two-way market written down the other way round.
 * Reading only the orders filed under blue therefore misprices every fight that
 * is quoted with bids on both sides, which is how the league seeds them and how
 * most complete sets get made.
 *
 * The direct book still wins where it exists: this only ever improves a price,
 * never invents one. */
export function foldedBook(
  bid: number,
  ask: number,
  otherBid: number,
  otherAsk: number,
): { bid: number; ask: number } {
  const directBid = bid > NO_BID ? bid : 0;
  const directAsk = ask > NO_BID && ask < NO_ASK ? ask : 0;
  const impliedBid = otherAsk > NO_BID && otherAsk < NO_ASK ? 100 - otherAsk : 0;
  const impliedAsk = otherBid > NO_BID ? 100 - otherBid : 0;
  return {
    bid: Math.max(directBid, impliedBid),
    // The best offer is the lowest one there is, and zero means there is none —
    // so it can never win a plain `Math.min`.
    ask: directAsk && impliedAsk ? Math.min(directAsk, impliedAsk) : directAsk || impliedAsk,
  };
}

/** One side's ladder, with the other side's bids mirrored into it.
 *
 * Same fact as `foldedBook`, one level deeper: the depth somebody buying blue
 * can actually reach includes every resting bid on red, at its mirror price.
 * Without this the ticket tells a buyer their order will rest on the book when
 * it would in fact fill immediately. */
export function foldedAsks(direct: BookLevel[], otherBids: BookLevel[]): BookLevel[] {
  const merged = new Map<number, number>();
  for (const level of direct) {
    merged.set(level.price, (merged.get(level.price) ?? 0) + level.shares);
  }
  for (const level of otherBids) {
    const mirrored = 100 - level.price;
    merged.set(mirrored, (merged.get(mirrored) ?? 0) + level.shares);
  }
  return [...merged.entries()]
    .map(([price, shares]) => ({ price, shares }))
    .sort((a, b) => a.price - b.price);
}

/** True when a mid is a real number and not the 50 that stands in for one.
 *
 * The panel draws the league's own opening line rather than a flat coin flip on
 * a book nothing has happened to yet, and this is how it tells the two apart —
 * a genuine 50¢ market and an unquoted one are the same number and very
 * different facts. */
export function isQuoted(bestBid: number, bestAsk: number, lastTrade?: number): boolean {
  return (
    bestBid > NO_BID ||
    (bestAsk > 0 && bestAsk < NO_ASK) ||
    (lastTrade !== undefined && lastTrade > 0 && lastTrade < 100)
  );
}

/** Where a settled market prints.
 *
 * A scored fight is not a 50/50 with the book taken away — it is a fact, and
 * the chart has to end on it. Not 100 and 0: the book only ever quoted 1–99, so
 * pinning the winner at 99 keeps the settled price on the same scale as every
 * price that came before it, and reads as certainty rather than as an axis
 * blowing out. A void is a fight that did not happen, and pays both sides the
 * same 50. */
export const SETTLED_WINNER = 99;
export const SETTLED_LOSER = 100 - SETTLED_WINNER;

/** Blue's settled price, or null while the fight is still a question. */
export function settledPrice(outcome: BoutOutcome): number | null {
  if (outcome === "blue") return SETTLED_WINNER;
  if (outcome === "red") return SETTLED_LOSER;
  if (outcome === "void") return 50;
  return null;
}

/** What a market order for `shares` would cost, walking the ladder.
 *
 * Returns the average price in cents and how much of the order the resting
 * depth can actually fill. A quote that assumed the top of book went all the
 * way down would tell someone buying 500 shares into a 12-share offer a price
 * they are never going to get. */
export function walkBook(levels: BookLevel[], shares: number) {
  let filled = 0;
  let cost = 0;
  for (const level of levels) {
    if (filled >= shares) break;
    const take = Math.min(level.shares, shares - filled);
    filled += take;
    cost += take * level.price;
  }
  return { filled, avgPrice: filled > 0 ? cost / filled : 0, cost: cost / 100 };
}

/** Cents to the percentage the panel prints. They are the same number — a
 *  share of a two-outcome market costs its own probability — but the rounding
 *  belongs in one place so the header and the chart never disagree by a point. */
export function oddsLabel(cents: number) {
  return `${Math.round(cents)}%`;
}

export function formatUnits(amount: number, places = 2) {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/* -------------------------------------------------------------- the wallet */

/** The slice of EIP-1193 this needs. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** One wallet extension, as it announced itself.
 *
 * `window.ethereum` is a single slot and every installed wallet races to write
 * it, so a browser with three of them talks to whichever loaded last rather
 * than the one the reader meant. EIP-6963 is how each extension announces
 * itself separately, and it is the only way to offer a choice. */
export interface WalletChoice {
  rdns: string;
  name: string;
  /** A data URI from the wallet itself, or nothing. */
  icon: string | null;
  provider: Eip1193;
}

/** Where the choice is remembered, so a reload does not ask again. */
const WALLET_KEY = "forge.wallet";
/** The stand-in for a wallet that never announced itself. Older extensions
 *  only write the legacy slot and there is nothing to name them by. */
const INJECTED_RDNS = "injected";

const walletListeners = new Set<(wallets: WalletChoice[]) => void>();
const accountListeners = new Set<(address: string | null) => void>();
const announced = new Map<string, WalletChoice>();
let wallets: WalletChoice[] = [];
let chosen: string | null = null;
let connected: string | null = null;
let listening = false;
let accountWallet: Eip1193 | null = null;
let releaseAccountWallet: (() => void) | null = null;
let restoringAccount: Promise<void> | null = null;
let walletVersion = 0;
let accountVersion = 0;

function pickedWallet(): Eip1193 | null {
  if (!chosen || typeof window === "undefined") return null;
  return chosen === INJECTED_RDNS
    ? (window as { ethereum?: Eip1193 }).ethereum ?? null
    : announced.get(chosen)?.provider ?? null;
}

/** Restore only the wallet the reader already chose. Never ask all installed
 *  extensions for accounts, and never open a connect prompt on page load. */
function restoreAccount(wallet: Eip1193) {
  const version = ++accountVersion;
  const pending = Promise.resolve()
    .then(() => wallet.request({ method: "eth_accounts" }))
    .then((accounts) => {
      if (accountWallet !== wallet || version !== accountVersion) return;
      publishAccount((accounts as string[])?.[0] ?? null);
    })
    .catch(() => {
      if (accountWallet === wallet && version === accountVersion) publishAccount(null);
    })
    .finally(() => {
      if (restoringAccount === pending) restoringAccount = null;
    });
  restoringAccount = pending;
}

// The account belongs to the selected provider, not to whichever page happens
// to be mounted. A late extension announcement can finish a reload's restore.
function watchAccountWallet() {
  const wallet = pickedWallet();
  if (accountWallet === wallet) return;
  releaseAccountWallet?.();
  releaseAccountWallet = null;
  accountWallet = wallet;
  const version = ++walletVersion;
  accountVersion += 1;
  restoringAccount = null;
  publishAccount(null);
  if (!wallet) return;

  const isCurrent = () => accountWallet === wallet && walletVersion === version;
  const onAccounts = (...args: unknown[]) => {
    if (isCurrent()) rememberConnectedAccount((args[0] as string[])?.[0] ?? null);
  };
  const onDisconnect = () => { if (isCurrent()) rememberConnectedAccount(null); };
  const onConnect = () => { if (isCurrent() && !restoringAccount) restoreAccount(wallet); };
  wallet.on?.("accountsChanged", onAccounts);
  wallet.on?.("disconnect", onDisconnect);
  wallet.on?.("connect", onConnect);
  releaseAccountWallet = () => {
    wallet.removeListener?.("accountsChanged", onAccounts);
    wallet.removeListener?.("disconnect", onDisconnect);
    wallet.removeListener?.("connect", onConnect);
  };
  restoreAccount(wallet);
}

function publishWallets() {
  const found = [...announced.values()].sort((a, b) => a.name.localeCompare(b.name));
  const injected = typeof window === "undefined"
    ? undefined
    : (window as { ethereum?: Eip1193 }).ethereum;
  // The legacy slot only earns a row when nothing announced itself: a wallet
  // that does both would otherwise be offered twice under two names.
  wallets = found.length || !injected
    ? found
    : [{ rdns: INJECTED_RDNS, name: "Browser wallet", icon: null, provider: injected }];
  watchAccountWallet();
  for (const listener of walletListeners) listener(wallets);
}

function beginDiscovery() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  try {
    chosen = window.localStorage.getItem(WALLET_KEY);
  } catch {
    // Private browsing refuses storage. The choice just does not survive.
  }
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<{
      info?: { rdns?: string; name?: string; icon?: string };
      provider?: Eip1193;
    }>).detail;
    const info = detail?.info;
    if (!info?.rdns || !detail?.provider) return;
    announced.set(info.rdns, {
      rdns: info.rdns,
      name: info.name ?? info.rdns,
      // Data URIs only. An icon is decoration, and a wallet does not get to
      // point the page at a URL it can then watch for hits.
      icon: info.icon?.startsWith("data:") ? info.icon : null,
      provider: detail.provider,
    });
    publishWallets();
  });
  window.addEventListener("ethereum#initialized", publishWallets);
  // Extensions answer this synchronously, and one that loads late announces
  // itself unprompted, so a sweep is a floor rather than the whole list.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  publishWallets();
}

/** Watch the list of installed wallets. Fires straight away with what is
 *  already known, then again as late-loading extensions turn up. */
export function subscribeWallets(listener: (wallets: WalletChoice[]) => void): () => void {
  walletListeners.add(listener);
  beginDiscovery();
  listener(wallets);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  return () => { walletListeners.delete(listener); };
}

/** Point every call below at one wallet, or at none of them. */
export function selectWallet(rdns: string | null) {
  beginDiscovery();
  if (chosen !== rdns) {
    accountVersion += 1;
    publishAccount(null);
  }
  chosen = rdns;
  try {
    if (rdns) window.localStorage.setItem(WALLET_KEY, rdns);
    else window.localStorage.removeItem(WALLET_KEY);
  } catch {
    // See above: the selection still holds for this tab.
  }
  publishWallets();
}

/** Which wallet is pointed at, by rdns. Reads module state and nothing else,
 *  so it is safe to call while rendering; `subscribeWallets` is what tells a
 *  component the answer has changed. */
export function selectedWalletRdns(): string | null {
  return chosen;
}

export function getWallet(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  beginDiscovery();
  // A remembered extension may arrive late. Never silently replace it with
  // another wallet that happened to win the legacy injection slot.
  if (chosen) return pickedWallet();
  return (window as { ethereum?: Eip1193 }).ethereum ?? null;
}

export async function connectedAccount(): Promise<string | null> {
  beginDiscovery();
  await restoringAccount;
  return connected;
}

/** Watch which address this tab is connected as. Fires straight away with what
 *  is already known, then on every connect, disconnect and account switch —
 *  the header's button is not the only thing that cares who is holding the
 *  keys now that the league's controls do too. */
export function subscribeAccount(listener: (address: string | null) => void): () => void {
  accountListeners.add(listener);
  beginDiscovery();
  listener(connected);
  return () => { accountListeners.delete(listener); };
}

function publishAccount(address: string | null) {
  if (connected === address) return;
  connected = address;
  for (const listener of accountListeners) listener(connected);
}

/** Keep the tab's remembered account aligned when an already connected wallet
 *  announces an account change. This never asks the provider for anything. */
export function rememberConnectedAccount(address: string | null) {
  accountVersion += 1;
  publishAccount(address);
}

export async function requestAccount(): Promise<string> {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found. Install MetaMask or another EIP-1193 wallet.");
  // The ticket can connect without opening the header's chooser. Remember
  // that provider too, so its connection survives the next page load.
  if (!chosen) selectWallet(wallets.find((entry) => entry.provider === wallet)?.rdns ?? INJECTED_RDNS);
  const selectedVersion = walletVersion;
  const version = ++accountVersion;
  const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  if (accountWallet !== wallet || selectedVersion !== walletVersion) {
    throw new Error("Wallet selection changed. Connect again.");
  }
  if (!accounts?.length) throw new Error("Wallet returned no accounts.");
  if (version === accountVersion) publishAccount(accounts[0]);
  if (!connected) throw new Error("Wallet account changed. Connect again.");
  return connected;
}

/** Sign a plain-text message with the connected key.
 *
 * `personal_sign` takes the message as hex, and the wallet is the thing that
 * shows the reader the text behind it before they approve — which is why what
 * gets signed anywhere in this app is readable English rather than a digest. */
export async function signMessage(address: string, message: string): Promise<string> {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  const bytes = new TextEncoder().encode(message);
  const hex = "0x" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return await wallet.request({
    method: "personal_sign",
    params: [hex, address],
  }) as string;
}

/** Put the wallet on the chain the book lives on, adding it if it has never
 *  seen it. Robinhood Chain is new enough that most wallets have not. */
export async function ensureChain(chainId: number, rpcUrl: string, explorer: string) {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  const hexChainId = "0x" + chainId.toString(16);
  const current = (await wallet.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === hexChainId) return;

  try {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
  } catch (error) {
    // 4902 is "unrecognised chain", the one case where adding it is the fix.
    if ((error as { code?: number })?.code !== 4902) throw error;
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hexChainId,
        chainName: chainId === 46630 ? "Robinhood Chain Testnet" : "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: explorer ? [explorer] : [],
      }],
    });
  }
}

/** A view call through the wallet's own node.
 *
 * The panel's public numbers come from `/api/market`, which is cached and
 * shared. A connected account's own numbers — balance, approval, shares, what
 * it can claim — are nobody else's business and go straight out through the
 * wallet, which means the league never sees an address at all. */
export async function walletCall(to: string, data: string): Promise<bigint[]> {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  const result = (await wallet.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  })) as string;
  return decodeWords(result);
}

/** What the chain says this transaction costs, asked before a wallet is.
 *
 * Two things come out of this and both matter. The revert reason is one: a
 * failing estimate is the chain saying why, in time to put it on screen
 * instead of in front of a signature. The gas limit is the other — a wallet
 * that cannot estimate does not stop, it falls back to the block gas limit,
 * and this chain's is 2^50. At the going 0.01 gwei that prints a network fee
 * of eleven thousand ETH over a transaction whose real cost is a fraction of a
 * cent, under a red warning, which is exactly what it looks like. */
export async function estimateGas(from: string, to: string, data: string): Promise<bigint> {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  const result = (await wallet.request({
    method: "eth_estimateGas",
    params: [{ from, to, data }],
  })) as string;
  return BigInt(result);
}

/** Send it, with a gas limit if one is known.
 *
 * The limit is passed rather than left to the wallet so the fallback above can
 * never be reached: a wallet handed a `gas` field prices the transaction off
 * that number and nothing else. */
export async function sendTransaction(
  from: string,
  to: string,
  data: string,
  gas?: bigint,
): Promise<string> {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  return (await wallet.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data, ...(gas ? { gas: "0x" + gas.toString(16) } : {}) }],
  })) as string;
}

/** Block until a hash lands, or give up.
 *
 * Orbit chains confirm in well under a second, so this is nearly always one or
 * two polls; the timeout exists for the case where a wallet reports a hash the
 * chain never saw, which should surface as a failure rather than a spinner
 * that runs until the tab is closed. */
export async function waitForReceipt(hash: string, timeoutMs = 60_000) {
  const wallet = getWallet();
  if (!wallet) throw new Error("No wallet found.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = (await wallet.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (BigInt(receipt.status ?? "0x0") === 0n) throw new Error("Transaction reverted.");
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("Timed out waiting for the transaction to confirm.");
}

/** Turn a contract revert code into something a person can act on.
 *
 * The book uses two-letter revert strings so it fits under the 24KB code cap,
 * which is the right trade on chain and useless on screen. */
const REVERT_REASONS: Record<string, string> = {
  CL: "This book is not matching orders right now.",
  NB: "This fight has no book on chain.",
  MC: "This fight is past its close time.",
  AR: "This fight has already been settled.",
  BF: "That price level is full. Try a different price.",
  FK: "Not enough resting depth to fill that all at once.",
  IS: "You don't hold that many shares.",
  IA: "You don't hold that many shares on that corner.",
  IB: "You don't hold that many shares on the other corner.",
  ISV: "The book refused the trade for solvency. Try again shortly.",
  TF: "The collateral transfer failed. Check your approval and balance.",
  FOT: "This collateral token isn't supported.",
  UL: "You have too many resting orders. Cancel one first.",
  P1: "Price has to be between 1 and 99 cents.",
  SD: "That order is too small.",
  MS: "That order is worth too little to place.",
  GRAN: `Size has to be a multiple of ${Number(SIZE_STEP) / 100} of a share.`,
  WAIT: "The faucet is on cooldown. Try again later.",
};

export function explainError(error: unknown): string {
  const raw =
    (error as { data?: { message?: string } })?.data?.message ??
    (error as { message?: string })?.message ??
    String(error);
  if ((error as { code?: number })?.code === 4001) return "Cancelled in the wallet.";
  for (const [code, message] of Object.entries(REVERT_REASONS)) {
    // Matched on a word boundary: "IS" must not fire on "ISV" or on the word
    // "this" in an RPC's own prose.
    if (new RegExp(`\\b${code}\\b`).test(raw)) return message;
  }
  return raw.length > 160 ? raw.slice(0, 157) + "…" : raw;
}

/* ------------------------------------------------------- calldata for writes */

/** Buy `shares` of one corner at `price` cents or better.
 *
 * There is no separate "mint a set" path in the UI and there does not need to
 * be: a bid that finds no matching ask pairs against a bid on the other corner
 * at the complementary price and the contract mints the set itself. Buying is
 * the only thing anyone has to understand. */
export function buyCalldata(boutId: number, side: 0 | 1, price: number, shares: bigint, type = ORDER_GTC) {
  return encodeCall(SELECTORS.placeBuyOrder, [boutId, side, price, shares, type]);
}

export function sellCalldata(boutId: number, side: 0 | 1, price: number, shares: bigint, type = ORDER_GTC) {
  return encodeCall(SELECTORS.placeSellOrder, [boutId, side, price, shares, type]);
}

export function approveCalldata(spender: string, amount: bigint) {
  return encodeCall(SELECTORS.approve, [spender, amount]);
}

export function cancelCalldata(orderId: number) {
  return encodeCall(SELECTORS.cancelOrder, [orderId]);
}

/** One transaction for every order in `orders`, instead of a wallet prompt each.
 *
 * `cancelMyOrders` walks a range of the caller's own `userOrders` and cancels
 * whatever is still live in it, skipping the dead slots. The range starts at
 * the lowest page any of these were read from and runs the length of the scan
 * window, which the contract clamps to the end of the list. */
export function cancelAllCalldata(orders: OpenOrder[]) {
  const from = Math.min(...orders.map((order) => order.from));
  return encodeCall(SELECTORS.cancelMyOrders, [from, ORDER_SCAN * ORDER_SCAN_DEPTH]);
}

export function redeemCalldata(boutId: number) {
  return encodeCall(SELECTORS.redeem, [boutId]);
}

/* --------------------------------------------------------------- portfolio */

/** What one address holds against one bout. Base units throughout — the caller
 *  knows the collateral's decimals and this does not need to. */
export interface Holding {
  boutId: number;
  sharesA: bigint;
  sharesB: bigint;
  /** Shares locked behind a resting sell order, which are still held. */
  escrowA: bigint;
  escrowB: bigint;
  /** What `redeem()` would pay right now — zero until the bout is scored. */
  claimable: bigint;
}

/** The whole of a wallet's book, in two calls it makes itself.
 *
 * Both reads go out through the wallet's own node rather than the league's, for
 * the same reason the ticket's position does: an address and what it is holding
 * are nobody's business but the holder's. */
export async function readHoldings(reader: string, address: string, boutIds: number[]) {
  if (boutIds.length === 0) return { holdings: [] as Holding[], claimable: 0n, pending: 0n };
  const words = await walletCall(
    reader,
    encodeCallWithIds(SELECTORS.getPortfolio, [address], boutIds),
  );
  // (PositionView[] positions, uint256 totalClaimable, uint256 pending)
  const holdings = decodeStructArray(words, 0, 6).map((row) => ({
    boutId: Number(row[0]),
    sharesA: row[1],
    sharesB: row[2],
    escrowA: row[3],
    escrowB: row[4],
    claimable: row[5],
  }));
  return { holdings, claimable: words[1] ?? 0n, pending: words[2] ?? 0n };
}

/** How many slots one read asks for. */
const ORDER_SCAN = 100;
/** How far back to look before giving up. A wallet's live orders are capped at
 *  500 by the contract, so this covers a page of dead history behind them
 *  without letting a very old account turn one panel into twenty calls. */
const ORDER_SCAN_DEPTH = 6;

/** Every order the wallet still has resting, across every bout.
 *
 * Read from the *end* of the list, not the start. `userOrders` is append-only:
 * cancelling or filling an order zeroes the order it points at but never
 * removes the entry. So `getUserOrders(address, 0, n)` returns the live ones
 * among the *oldest* n slots — which, for anybody who has traded more than n
 * times, is none of them, and the panel would quietly show an empty book to
 * somebody with money resting on it. */
export async function readOpenOrders(
  reader: string,
  clob: string,
  address: string,
): Promise<OpenOrder[]> {
  // The count lives on the book, not on the reader — the reader only forwards
  // pages of the list, it does not publish its length.
  const total = Number(
    (await walletCall(clob, encodeCall(SELECTORS.userOrderCount, [address])))[0] ?? 0n,
  );

  const found: OpenOrder[] = [];
  let end = total;
  for (let page = 0; page < ORDER_SCAN_DEPTH && end > 0; page += 1) {
    const start = Math.max(0, end - ORDER_SCAN);
    const words = await walletCall(
      reader,
      encodeCall(SELECTORS.getUserOrders, [address, start, end - start]),
    );
    // (OrderView[] open, uint256 nextIdx) — id, boutId, shares, price, side, isBuy
    for (const row of decodeStructArray(words, 0, 6)) {
      found.push({
        id: Number(row[0]),
        boutId: Number(row[1]),
        shares: row[2],
        price: Number(row[3]),
        side: (Number(row[4]) === SIDE_RED ? SIDE_RED : SIDE_BLUE) as 0 | 1,
        isBuy: row[5] === 1n,
        from: start,
      });
    }
    end = start;
  }
  return found;
}

export const withdrawCalldata = () => encodeCall(SELECTORS.withdraw);
export const dripCalldata = () => encodeCall(SELECTORS.drip);
export const mintCalldata = (to: string, amount: bigint) =>
  encodeCall(SELECTORS.mint, [to, amount]);

/** How a wallet gets collateral to trade with, or null if it cannot.
 *
 * Testnet money hands itself out, but not the same way everywhere: `TestUSD`
 * has `drip()`, and the USDC already sitting on Robinhood's testnet has an
 * open `mint(address,uint256)` that anyone may call. Rather than hardcode
 * which chain gets which, simulate both against the connected account and
 * keep whichever the token actually answers.
 *
 * A real stablecoin answers neither, so this returns null there — which is the
 * only gate the faucet button needs, and one that cannot be got wrong by
 * pointing the league at a mainnet address. */
export async function faucetCalldata(
  token: string,
  address: string,
  amount: bigint,
): Promise<string | null> {
  const wallet = getWallet();
  if (!wallet) return null;
  for (const data of [mintCalldata(address, amount), dripCalldata()]) {
    try {
      await wallet.request({
        method: "eth_call",
        params: [{ from: address, to: token, data }, "latest"],
      });
      return data;
    } catch {
      // This token does not have that one. Try the next shape.
    }
  }
  return null;
}
