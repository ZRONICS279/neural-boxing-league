/** Putting the maker through a card before it quotes one with real money.
 *
 * Everything here runs against the *actual* contracts on a throwaway anvil, not
 * against a model of them. That is the whole point: a book simulated in
 * TypeScript would be a second implementation of complementary matching, and a
 * second implementation that is subtly wrong is worse than no test at all —
 * it produces a P&L that looks convincing and isn't. So `FightCardCLOB` is
 * deployed, `openingLine` prices the fights, `simulateBoutToCompletion` decides
 * them, and the money is counted by reading token balances before and after.
 *
 * The three questions it exists to answer, in order of how much they matter:
 *
 *  1. **Is the line any good?** Everything downstream rests on it. A maker
 *     quoting a mispriced book loses money no matter how cleverly it skews. So
 *     the first pass ignores the chain entirely and just asks whether a fight
 *     quoted at 64¢ is actually won by that corner about 64% of the time.
 *
 *  2. **What does the maker lose when it is wrong?** Not "does it lose" — it
 *     does, one-sided flow guarantees it. The number that matters is the worst
 *     single bout and the worst card, because that is what the wallet has to
 *     survive.
 *
 *  3. **Could anybody actually bet?** A maker that never loses because it never
 *     fills is not a market. Fill rates and average slippage are reported beside
 *     the P&L so the two are read together.
 *
 * Run it with:  npm run market:sim
 *
 * Nothing in here touches the deployed chain, the league database, or any key
 * that controls real money. Anvil is spawned on a private port and killed on the
 * way out. */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createInitialLeague, simulateBoutToCompletion, type Fighter } from "../app/simulation.ts";
import { openingLine } from "../app/opening-line.ts";
import {
  DEFAULT_MAKER_CONFIG,
  SIDE_A,
  SIDE_B,
  type MakerConfig,
  planQuotes,
} from "../worker/market-maker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ------------------------------------------------------------------ config */

const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;
/** Anvil's published test mnemonic. Public on purpose — these keys are worth
 *  nothing and must never be reachable from anything that isn't a local node. */
const MNEMONIC = "test test test test test test test test test test test junk";

/** How many fights the market pass trades. The calibration pass separately
 *  covers every distinct pairing on the roster, which is a much bigger sample
 *  and needs no chain. */
const FIGHTS = Number(process.env.SIM_FIGHTS ?? 32);
/** Bettor actions per fight, before the bell. */
const ACTIONS_PER_FIGHT = Number(process.env.SIM_ACTIONS ?? 9);
/** Taker fee in basis points. The contract's ceiling is 100 (1%). */
const TAKER_FEE_BPS = Number(process.env.SIM_FEE_BPS ?? 50);
/** Collateral units the maker starts with. */
const MAKER_BANKROLL = Number(process.env.SIM_BANKROLL ?? 1500);

const MAKER_CONFIG: MakerConfig = {
  ...DEFAULT_MAKER_CONFIG,
  // `SIM_STOCK=0` quotes bids only — the configuration that could not be traded
  // against at all before `_matchBuyComplementary` learned to walk levels, and
  // therefore the sharpest test that it now can be.
  stock: Number(process.env.SIM_STOCK ?? DEFAULT_MAKER_CONFIG.stock),
};

/** Mirrors `FightCardCLOB.OrderType`. */
const GTC = 0;
const FAK = 2;
/** Mirrors `FightCardCLOB.Outcome`. */
const OUTCOME_A = 1;
const OUTCOME_B = 2;
const OUTCOME_VOID = 3;

/** `bestAsk == 100` means "nothing resting", not an offer at a whole unit. */
const NO_ASK = 100;

/** Every revert in here is swallowed, because a maker that throws on a crossed
 *  order stops quoting the card. That is right in production and useless in a
 *  rehearsal, where a silently empty book looks exactly like a working one. */
const DEBUG = process.env.SIM_DEBUG === "1";
function swallow(where: string, error: unknown) {
  if (!DEBUG) return;
  const raw = error instanceof Error ? error.message : String(error);
  const reason = /reverted with the following reason:\s*\n?(.+)/.exec(raw);
  const message = (reason?.[1] ?? raw.split("\n")[0]).trim();
  console.error(`    ! ${where}: ${message}`);
}

/* ------------------------------------------------------------------ random */

/** Seeded, so a run that finds something bad can be run again and still find it. */
let seed = Number(process.env.SIM_SEED ?? 20260805);
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)];
}
function between(low: number, high: number) {
  return low + Math.floor(random() * (high - low + 1));
}

/* ---------------------------------------------------------------- the node */

function artifact(name: string) {
  const path = join(ROOT, "chain", "forge-out", `${name}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

async function startAnvil(): Promise<ChildProcess> {
  const child = spawn(
    "anvil",
    ["--port", String(PORT), "--accounts", "40", "--balance", "1000", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr?.on("data", (chunk) => process.stderr.write(`anvil: ${chunk}`));

  const probe = createPublicClient({ transport: http(RPC) });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await probe.getBlockNumber();
      return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error("anvil did not come up");
}

const chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** Anvil mines every transaction the moment it arrives, but viem waits for
 *  receipts on a four-second poll by default — which would be essentially all
 *  of this script's runtime, spent asleep. */
const POLL = 10;

/* ------------------------------------------------------------- the fixture */

type Wallet = ReturnType<typeof createWalletClient>;

interface Rig {
  publicClient: ReturnType<typeof createPublicClient>;
  clob: Address;
  reader: Address;
  usd: Address;
  abi: { clob: unknown[]; reader: unknown[]; usd: unknown[] };
  unit: bigint;
}

/** Whole shares → contract units. Shares are denominated in the collateral's
 *  own decimals, so one share of a winner redeems for exactly one usdc per share. */
function shares(rig: Rig, whole: number) {
  return BigInt(Math.round(whole)) * rig.unit;
}
function toUnits(rig: Rig, raw: bigint) {
  return Number(raw) / Number(rig.unit);
}

async function deploy(deployer: Wallet, operator: Address): Promise<Rig> {
  const publicClient = createPublicClient({ chain, transport: http(RPC), pollingInterval: POLL });
  const usdArt = artifact("TestUSD");
  const clobArt = artifact("FightCardCLOB");
  const readerArt = artifact("FightCardReader");

  const send = async (art: { abi: unknown[]; bytecode: Hex }, args: unknown[]) => {
    const hash = await deployer.deployContract({
      abi: art.abi as never, bytecode: art.bytecode, args: args as never,
      account: deployer.account!, chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("deploy produced no address");
    return receipt.contractAddress;
  };

  const usd = await send(usdArt, []);
  const clob = await send(clobArt, [usd, operator, operator, BigInt(TAKER_FEE_BPS)]);
  const reader = await send(readerArt, [clob]);

  const unit = (await publicClient.readContract({
    address: clob, abi: clobArt.abi as never, functionName: "oneUnit",
  })) as bigint;

  return {
    publicClient,
    clob, reader, usd,
    abi: { clob: clobArt.abi, reader: readerArt.abi, usd: usdArt.abi },
    unit,
  };
}

/* -------------------------------------------------------------- the actors */

interface Actor {
  name: string;
  address: Address;
  wallet: Wallet;
}

function actorAt(index: number, name: string): Actor {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: index });
  return {
    name,
    address: account.address,
    wallet: createWalletClient({ account, chain, transport: http(RPC), pollingInterval: POLL }),
  };
}

/** Stock an account with play money and let the book spend it.
 *
 * `drip()` is rate-limited against the *caller*, so every account calls it for
 * itself rather than one account trying to fund forty. */
async function fund(rig: Rig, actor: Actor, topUp: number) {
  await actor.wallet.writeContract({
    address: rig.usd, abi: rig.abi.usd as never, functionName: "drip",
    account: actor.wallet.account!, chain, args: [],
  });
  if (topUp > 0) {
    // A second drip needs the cooldown to pass, so the maker's larger bankroll
    // comes out of the deployer's stack instead of the faucet.
    await deployerTransfer(rig, actor.address, topUp);
  }
  await actor.wallet.writeContract({
    address: rig.usd, abi: rig.abi.usd as never, functionName: "approve",
    account: actor.wallet.account!, chain,
    args: [rig.clob, (1n << 255n)],
  });
}

let deployerActor: Actor;
async function deployerTransfer(rig: Rig, to: Address, amount: number) {
  await deployerActor.wallet.writeContract({
    address: rig.usd, abi: rig.abi.usd as never, functionName: "transfer",
    account: deployerActor.wallet.account!, chain,
    args: [to, parseUnits(String(amount), 6)],
  });
}

/* ----------------------------------------------------------- reading a book */

async function readNumber(rig: Rig, fn: string, args: unknown[]): Promise<bigint> {
  return (await rig.publicClient.readContract({
    address: rig.clob, abi: rig.abi.clob as never, functionName: fn, args: args as never,
  })) as bigint;
}

async function balanceOf(rig: Rig, who: Address) {
  return (await rig.publicClient.readContract({
    address: rig.usd, abi: rig.abi.usd as never, functionName: "balanceOf", args: [who],
  })) as bigint;
}

async function positionOf(rig: Rig, boutId: bigint, who: Address) {
  const [a, b, ea, eb] = await Promise.all([
    readNumber(rig, "sharesOf", [boutId, SIDE_A, who]),
    readNumber(rig, "sharesOf", [boutId, SIDE_B, who]),
    readNumber(rig, "escrowedOf", [boutId, SIDE_A, who]),
    readNumber(rig, "escrowedOf", [boutId, SIDE_B, who]),
  ]);
  return {
    a: toUnits(rig, a + ea),
    b: toUnits(rig, b + eb),
    free: { a: toUnits(rig, a), b: toUnits(rig, b) },
  };
}

/** The cheapest anybody can buy this corner for, folding the other side's bids.
 *
 * A bid of 34¢ on B *is* an offer of 66¢ on A — a buyer at 66 matches it
 * complementarily and the set is minted between them. Reading one side's asks
 * alone therefore under-reports what is actually available, which is exactly the
 * mistake the panel made once already. */
async function offerFor(rig: Rig, boutId: bigint, side: number): Promise<number> {
  const other = side === SIDE_A ? SIDE_B : SIDE_A;
  const [ask, otherBid] = await Promise.all([
    readNumber(rig, "bestAsk", [boutId, side]),
    readNumber(rig, "bestBid", [boutId, other]),
  ]);
  const direct = Number(ask) === NO_ASK ? Infinity : Number(ask);
  const folded = Number(otherBid) === 0 ? Infinity : 100 - Number(otherBid);
  return Math.min(direct, folded);
}

async function bidFor(rig: Rig, boutId: bigint, side: number): Promise<number> {
  // A sell only ever matches resting bids on its own corner — there is no
  // complementary path out of a share, only into one.
  return Number(await readNumber(rig, "bestBid", [boutId, side]));
}

/** Every order this account still has resting, anywhere on the book.
 *
 * `userOrders` is append-only: the contract never removes an entry, it only
 * zeroes the order it points at. Reading `getUserOrders(account, 0, n)` therefore
 * reads the *oldest* n slots, and once an account has placed more than n orders
 * in its life that window holds nothing but dead ones — at which point the maker
 * believes its book is empty, re-posts the whole ladder every pass, and climbs
 * to the contract's five-hundred-order ceiling, after which every `_rest`
 * reverts with "UL" and it stops quoting entirely.
 *
 * Page backwards from the end instead, stopping once `activeOrderCount` live
 * orders have been accounted for. */
interface LiveOrder {
  id: bigint; boutId: bigint; shares: bigint; price: number; side: number; isBuy: boolean;
}
async function liveOrders(rig: Rig, who: Address): Promise<LiveOrder[]> {
  const [total, active] = await Promise.all([
    readNumber(rig, "userOrderCount", [who]),
    readNumber(rig, "activeOrderCount", [who]),
  ]);

  const found: LiveOrder[] = [];
  let end = total;
  while (end > 0n && BigInt(found.length) < active) {
    const start = end > 256n ? end - 256n : 0n;
    const [page] = (await rig.publicClient.readContract({
      address: rig.reader, abi: rig.abi.reader as never, functionName: "getUserOrders",
      args: [who, start, end - start],
    })) as [LiveOrder[], bigint];
    found.push(...page);
    end = start;
  }
  return found;
}

/* ------------------------------------------------------------- the trades */

interface Fill {
  who: string;
  archetype: string;
  boutId: bigint;
  side: number;
  /** Whole shares gained (buy) or given up (sell). */
  shares: number;
  /** Collateral units paid (buy, positive) or received (sell, negative). */
  cost: number;
  isBuy: boolean;
}

/** Put an order in and measure what it actually did.
 *
 * Reading the position and the balance either side of the transaction is more
 * reliable than reconstructing fills from logs, and it is what a bettor would
 * actually experience: this many shares, for this much money. A reverted order
 * simply moves nothing and is recorded as a miss. */
async function trade(
  rig: Rig,
  actor: Actor,
  archetype: string,
  boutId: bigint,
  side: number,
  isBuy: boolean,
  price: number,
  size: number,
  orderType: number,
): Promise<Fill | null> {
  const limit = Math.max(1, Math.min(99, Math.round(price)));
  const before = await Promise.all([balanceOf(rig, actor.address), positionOf(rig, boutId, actor.address)]);

  try {
    const hash = await actor.wallet.writeContract({
      address: rig.clob, abi: rig.abi.clob as never,
      functionName: isBuy ? "placeBuyOrder" : "placeSellOrder",
      account: actor.wallet.account!, chain,
      args: [boutId, side, limit, shares(rig, size), orderType],
    });
    await rig.publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    swallow("trade", error);
    return null;
  }

  const after = await Promise.all([balanceOf(rig, actor.address), positionOf(rig, boutId, actor.address)]);
  const gained = (side === SIDE_A ? after[1].a - before[1].a : after[1].b - before[1].b);
  const spent = toUnits(rig, before[0] - after[0]);
  if (Math.abs(gained) < 1e-9) return null;

  return { who: actor.name, archetype, boutId, side, shares: Math.abs(gained), cost: spent, isBuy };
}

/* --------------------------------------------------------------- the maker */

/** One pass of the maker over one book: read, plan, correct.
 *
 * Deliberately the same `planQuotes` the worker calls — the policy is the thing
 * under test, and a harness that re-implemented it would be testing itself.
 * Only the plumbing round it differs, because the worker walks a whole card off
 * a broadcast state and this walks one fight. */
async function makerPass(rig: Rig, maker: Actor, boutId: bigint, fair: number) {
  const [position, balance, orders] = await Promise.all([
    positionOf(rig, boutId, maker.address),
    balanceOf(rig, maker.address),
    liveOrders(rig, maker.address),
  ]);

  const mine = orders
    .filter((order) => order.boutId === boutId)
    .map((order) => ({
      orderId: order.id,
      side: order.side,
      isBuy: order.isBuy,
      price: order.price,
      shares: toUnits(rig, order.shares),
    }));

  const parked = mine
    .filter((order) => order.isBuy)
    .reduce((sum, order) => sum + (order.price * order.shares) / 100, 0);

  const plan = planQuotes({
    fair,
    inventory: { a: position.a, b: position.b },
    resting: mine,
    cash: toUnits(rig, balance) + parked,
    config: MAKER_CONFIG,
  });

  if (DEBUG) {
    console.error(`    · plan bout ${boutId} fair ${fair} inv ${position.a}/${position.b} ` +
      `cash ${toUnits(rig, balance).toFixed(2)} resting ${mine.length} ` +
      `→ cancel ${plan.cancel.length} place ${plan.place.length} ` +
      `[${plan.place.map((q) => `${q.side}${q.isBuy ? "b" : "a"}${q.price}x${q.shares}`).join(" ")}]`);
  }

  // Stock first: the ask ladder is sold out of it, and `placeSellOrder` reverts
  // on shares the account does not hold yet.
  if (plan.mint > 0) {
    try {
      const hash = await maker.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never, functionName: "mint",
        account: maker.wallet.account!, chain,
        args: [boutId, shares(rig, plan.mint)],
      });
      await rig.publicClient.waitForTransactionReceipt({ hash });
    } catch (error) { swallow("mint", error); }
  }

  // Cancels first, always: a stale bid left resting above a fresh ask on the
  // same corner is the maker buying its own shares back and paying a fee to do
  // it. The planner guards against it too; the ordering is what makes it safe.
  for (const orderId of plan.cancel) {
    try {
      const hash = await maker.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never, functionName: "cancelOrder",
        account: maker.wallet.account!, chain, args: [orderId],
      });
      await rig.publicClient.waitForTransactionReceipt({ hash });
    } catch (error) { swallow("cancel", error); }
  }

  for (const quote of plan.place) {
    try {
      const hash = await maker.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never,
        functionName: quote.isBuy ? "placeBuyOrder" : "placeSellOrder",
        account: maker.wallet.account!, chain,
        args: [boutId, quote.side, quote.price, shares(rig, quote.shares), GTC],
      });
      await rig.publicClient.waitForTransactionReceipt({ hash });
    } catch (error) { swallow("place", error); }
  }

  return plan;
}

/* ------------------------------------------------------------ the bettors */

/** How each kind of punter behaves.
 *
 * Between them they have to cover the cases that actually cost a maker money:
 * flow that all arrives on one corner, flow that knows the answer, and size that
 * arrives all at once. `balanced` is the case the maker is *supposed* to profit
 * from and is here as the control. */
type Scenario =
  | "balanced"
  | "chalk"
  | "underdog"
  | "sharp"
  | "whale"
  | "churn"
  | "quiet"
  | "rival-maker";

const SCENARIOS: Scenario[] = [
  "balanced", "chalk", "underdog", "sharp", "whale", "churn", "quiet", "rival-maker",
];

interface BetContext {
  rig: Rig;
  boutId: bigint;
  fair: number;
  /** The side that actually wins, or null for a draw. Only `sharp` may look. */
  truth: number | null;
  bettors: Actor[];
}

/** One bettor action. Returns the fill, or null if nothing traded. */
async function act(scenario: Scenario, ctx: BetContext, step: number): Promise<Fill | null> {
  const { rig, boutId, fair, truth, bettors } = ctx;
  const actor = pick(bettors);
  const favourite = fair >= 50 ? SIDE_A : SIDE_B;
  const outsider = favourite === SIDE_A ? SIDE_B : SIDE_A;

  /** A market buy: take whatever is offered, up to a few cents of slippage. */
  const marketBuy = async (side: number, size: number, slippage = 3) => {
    const offer = await offerFor(rig, boutId, side);
    if (!Number.isFinite(offer)) return null;
    return trade(rig, actor, scenario, boutId, side, true, offer + slippage, size, FAK);
  };

  switch (scenario) {
    case "quiet":
      return null;

    case "balanced":
      // Alternating corners: the flow a maker dreams about, and the control
      // that shows what the spread alone is worth.
      return marketBuy(step % 2 === 0 ? SIDE_A : SIDE_B, between(4, 20));

    case "chalk":
      return marketBuy(favourite, between(6, 25));

    case "underdog":
      return marketBuy(outsider, between(6, 25));

    case "sharp":
      // Informed money. A draw leaves nothing to be informed about, so it backs
      // the favourite and takes the void like everybody else.
      return marketBuy(truth ?? favourite, between(10, 30));

    case "whale":
      // One side, all at once, early. The single worst thing that can walk into
      // a thin book.
      return step === 0
        ? marketBuy(random() < 0.5 ? SIDE_A : SIDE_B, between(40, 90), 12)
        : marketBuy(random() < 0.5 ? SIDE_A : SIDE_B, between(3, 10));

    case "churn": {
      // Buy now, sell back before the bell. Tests the round trip: the maker
      // should earn the spread twice and end flat.
      const side = random() < 0.5 ? SIDE_A : SIDE_B;
      if (step % 2 === 0) return marketBuy(side, between(5, 18));
      const held = await positionOf(rig, boutId, actor.address);
      const have = side === SIDE_A ? held.free.a : held.free.b;
      if (have < 1) return null;
      const bid = await bidFor(rig, boutId, side);
      if (bid < 1) return null;
      return trade(rig, actor, scenario, boutId, side, false, bid - 2, Math.floor(have), FAK);
    }

    case "rival-maker": {
      // Somebody else quoting the same fight. On the odd steps they rest inside
      // our spread; on the even ones ordinary flow arrives and has a choice of
      // two books. Resting alone tested nothing — nobody ever took it.
      const side = random() < 0.5 ? SIDE_A : SIDE_B;
      if (step % 2 === 1) {
        const line = side === SIDE_A ? fair : 100 - fair;
        const price = Math.max(1, Math.min(99, line - between(1, 4)));
        return trade(rig, actor, scenario, boutId, side, true, price, between(5, 15), GTC);
      }
      return marketBuy(side, between(5, 20));
    }
  }
}

/* ---------------------------------------------------------------- the card */

interface Matchup {
  blue: Fighter;
  red: Fighter;
  line: number;
  /** null is a draw. */
  winner: "blue" | "red" | null;
}

/** Every distinct in-division pairing on the roster, priced and fought.
 *
 * This is the calibration sample and it needs no chain at all: the line is a
 * pure function of two fighters and the result is a pure function of the same
 * two, so the honest question — does a corner quoted at N cents win N% of the
 * time — is answerable straight out of the simulator.
 *
 * Note the sim is deterministic, so a given pair always produces the same
 * result. Calibration is therefore measured *across* pairings at a given price,
 * never by running one pairing repeatedly, which would only ever return 0% or
 * 100%. */
function buildMatchups(roster: Fighter[], limit: number): Matchup[] {
  const divisions = new Map<string, Fighter[]>();
  for (const fighter of roster) {
    const list = divisions.get(fighter.weightClass) ?? [];
    list.push(fighter);
    divisions.set(fighter.weightClass, list);
  }

  const pairs: { blue: Fighter; red: Fighter }[] = [];
  for (const division of divisions.values()) {
    for (let i = 0; i < division.length; i += 1) {
      for (let j = i + 1; j < division.length; j += 1) {
        pairs.push({ blue: division[i], red: division[j] });
      }
    }
  }

  const chosen = limit >= pairs.length ? pairs : shuffle(pairs).slice(0, limit);
  return chosen.map(({ blue, red }) => {
    const bout = simulateBoutToCompletion(roster, blue.id, red.id);
    const winner = bout.winnerId === null ? null : bout.winnerId === blue.id ? "blue" : "red";
    return { blue, red, line: openingLine(blue, red), winner };
  });
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/* --------------------------------------------------------------- reporting */

interface BoutResult {
  boutId: bigint;
  scenario: Scenario;
  label: string;
  line: number;
  outcome: number;
  /** Maker's collateral change across the whole life of this book. */
  makerPnl: number;
  makerPosition: { a: number; b: number };
  fills: Fill[];
}

function money(value: number) {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function table(rows: string[][], headers: string[]) {
  const all = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...all.map((row) => (row[col] ?? "").length)));
  const line = (row: string[]) =>
    row.map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col]))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function reportCalibration(matchups: Matchup[]) {
  console.log("\n══ line calibration ══════════════════════════════════════════");
  console.log(`${matchups.length} distinct pairings, priced by openingLine and fought by the simulator.\n`);

  // Every fight contributes both corners, so the buckets are symmetric and a
  // systematic lean toward favourites or underdogs shows up as a diagonal.
  const buckets = new Map<number, { n: number; won: number; draws: number }>();
  for (const bout of matchups) {
    for (const [corner, price] of [["blue", bout.line], ["red", 100 - bout.line]] as const) {
      const key = Math.round(price / 5) * 5;
      const cell = buckets.get(key) ?? { n: 0, won: 0, draws: 0 };
      cell.n += 1;
      if (bout.winner === corner) cell.won += 1;
      if (bout.winner === null) cell.draws += 1;
      buckets.set(key, cell);
    }
  }

  const rows = [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([price, cell]) => {
      // A draw pays half a unit on both sides, so it is half a win to each
      // corner — scoring it as a loss would libel every price on the card.
      const scored = (cell.won + cell.draws / 2) / cell.n;
      return [
        `${price}¢`,
        String(cell.n),
        `${(scored * 100).toFixed(1)}%`,
        `${(scored * 100 - price >= 0 ? "+" : "")}${(scored * 100 - price).toFixed(1)}`,
      ];
    });
  console.log(table(rows, ["quoted", "corners", "actually won", "edge"]));

  const draws = matchups.filter((bout) => bout.winner === null).length;
  const favouriteWins = matchups.filter((bout) =>
    bout.winner !== null &&
    ((bout.line > 50 && bout.winner === "blue") || (bout.line < 50 && bout.winner === "red"))).length;
  const decisive = matchups.filter((bout) => bout.winner !== null && bout.line !== 50).length;

  console.log(`\ndraws: ${draws}/${matchups.length} (${((draws / matchups.length) * 100).toFixed(1)}%)`);
  console.log(`favourite wins: ${favouriteWins}/${decisive} (${((favouriteWins / Math.max(1, decisive)) * 100).toFixed(1)}%)`);

  // Brier score: the standard test of a probabilistic forecast. 0 is perfect,
  // 0.25 is what you get by quoting every fight at 50/50, and anything above
  // that means the line is worse than having no opinion at all.
  let brier = 0;
  let flat = 0;
  for (const bout of matchups) {
    const actual = bout.winner === null ? 0.5 : bout.winner === "blue" ? 1 : 0;
    brier += Math.pow(bout.line / 100 - actual, 2);
    flat += Math.pow(0.5 - actual, 2);
  }
  console.log(`Brier: ${(brier / matchups.length).toFixed(4)} (a flat 50/50 line scores ${(flat / matchups.length).toFixed(4)})`);
  console.log(brier < flat
    ? "→ the line beats a coin flip, so quoting off it is worth doing."
    : "→ the line is NOT beating a coin flip. Fix that before quoting real money.");
}

function reportMaker(results: BoutResult[], bankroll: number, finalBalance: number) {
  console.log("\n══ the maker ═════════════════════════════════════════════════");

  const byScenario = new Map<Scenario, BoutResult[]>();
  for (const bout of results) {
    const list = byScenario.get(bout.scenario) ?? [];
    list.push(bout);
    byScenario.set(bout.scenario, list);
  }

  const rows = [...byScenario.entries()].map(([scenario, bouts]) => {
    const total = bouts.reduce((sum, bout) => sum + bout.makerPnl, 0);
    const worst = Math.min(...bouts.map((bout) => bout.makerPnl));
    const wins = bouts.filter((bout) => bout.makerPnl > 0).length;
    const volume = bouts.reduce(
      (sum, bout) => sum + bout.fills.reduce((inner, fill) => inner + Math.abs(fill.cost), 0), 0);
    return [
      scenario,
      String(bouts.length),
      money(total),
      money(total / bouts.length),
      money(worst),
      `${wins}/${bouts.length}`,
      money(volume),
    ];
  });
  console.log(table(rows, ["scenario", "fights", "total", "per fight", "worst", "profitable", "volume"]));

  const total = results.reduce((sum, bout) => sum + bout.makerPnl, 0);
  const worst = results.reduce((low, bout) => Math.min(low, bout.makerPnl), 0);
  const best = results.reduce((high, bout) => Math.max(high, bout.makerPnl), 0);
  const winners = results.filter((bout) => bout.makerPnl > 0).length;
  const traded = results.filter((bout) => bout.fills.length > 0);
  const volume = results.reduce(
    (sum, bout) => sum + bout.fills.reduce((inner, fill) => inner + Math.abs(fill.cost), 0), 0);

  // The ledger is the sum of the per-bout attributions; the wallet is the truth.
  // They should agree to rounding, and if they do not, the attribution is wrong.
  const measured = finalBalance - bankroll;

  console.log(`\nbankroll        ${money(bankroll)}`);
  console.log(`ended           ${money(finalBalance)}`);
  console.log(`net             ${money(measured)}`);
  console.log(`per-bout ledger ${money(total)}  ${Math.abs(total - measured) < 0.05 ? "✓ agrees with the wallet" : "✗ DOES NOT AGREE — attribution is wrong"}`);
  console.log(`per fight       ${money(measured / Math.max(1, traded.length))} over ${traded.length} fights that actually traded`);
  // The bankroll is not the denominator that means anything — most of it never
  // leaves the wallet. Margin on the money that crossed the book is what says
  // whether the spread is paying for the risk of quoting it.
  console.log(`margin          ${((measured / Math.max(1, volume)) * 100).toFixed(2)}% of ${money(volume)} traded`);
  console.log(`working capital ${money(MAKER_CONFIG.budget)} a fight, so ${money(MAKER_CONFIG.budget * 18)} for an 18-fight card`);
  console.log(`profitable      ${winners}/${traded.length} fights`);
  console.log(`best fight      ${money(best)}`);
  console.log(`worst fight     ${money(worst)}   ← the number the bankroll has to survive`);

  // `maxNet` bounds the *directional* shares carried into the bell, and a share
  // can be bought for at most 99¢, so that is the floor under one fight.
  const cap = MAKER_CONFIG.maxNet * 0.99;
  console.log(`\nmaxNet is ${MAKER_CONFIG.maxNet} shares, so one fight cannot lose more than ~${money(cap)}.`);
  console.log(worst >= -cap
    ? `observed worst was ${money(worst)} — inside the cap.`
    : `observed worst was ${money(worst)} — OUTSIDE the cap, which is a bug, not variance.`);
}

function reportBettors(results: BoutResult[]) {
  console.log("\n══ the bettors ═══════════════════════════════════════════════");

  const fills = results.flatMap((bout) =>
    bout.fills.map((fill) => ({ fill, outcome: bout.outcome })));
  const buys = fills.filter((entry) => entry.fill.isBuy);
  if (buys.length === 0) {
    console.log("nobody traded.");
    return;
  }

  /** What a share is worth once the bout is scored. A void pays half on both
   *  corners — it is not a refund of what anybody paid. */
  const settles = (side: number, outcome: number) =>
    outcome === OUTCOME_VOID ? 0.5 : (outcome === OUTCOME_A ? SIDE_A : SIDE_B) === side ? 1 : 0;

  const byType = new Map<string, typeof buys>();
  for (const entry of buys) {
    const list = byType.get(entry.fill.archetype) ?? [];
    list.push(entry);
    byType.set(entry.fill.archetype, list);
  }

  const rows = [...byType.entries()].map(([archetype, entries]) => {
    const staked = entries.reduce((sum, entry) => sum + entry.fill.cost, 0);
    // What the ticket would have promised: every share pays a whole unit if the
    // corner wins. This is the number a buyer is shown before the bell.
    const promised = entries.reduce((sum, entry) => sum + entry.fill.shares, 0);
    const actual = entries.reduce(
      (sum, entry) => sum + entry.fill.shares * settles(entry.fill.side, entry.outcome), 0);
    const avgPrice = (staked / promised) * 100;
    return [
      archetype,
      String(entries.length),
      money(staked),
      `${avgPrice.toFixed(1)}¢`,
      money(promised),
      money(actual),
      money(actual - staked),
      `${(((actual - staked) / staked) * 100).toFixed(1)}%`,
    ];
  });
  console.log(table(rows, [
    "archetype", "bets", "staked", "avg price", "if right", "actual", "net", "ROI",
  ]));

  const staked = buys.reduce((sum, entry) => sum + entry.fill.cost, 0);
  const actual = buys.reduce(
    (sum, entry) => sum + entry.fill.shares * settles(entry.fill.side, entry.outcome), 0);
  console.log(`\nall bettors: ${buys.length} bets, ${money(staked)} staked, ${money(actual)} returned, ` +
    `net ${money(actual - staked)} (${(((actual - staked) / staked) * 100).toFixed(2)}%)`);
  console.log("the bettors' net and the maker's net are two sides of the same money, less the fee.");

  const attempted = results.reduce(
    (sum, bout) => sum + (bout.scenario === "quiet" ? 0 : ACTIONS_PER_FIGHT), 0);
  console.log(`fill rate: ${fills.length}/${attempted} attempted actions found liquidity ` +
    `(${((fills.length / Math.max(1, attempted)) * 100).toFixed(0)}%) — a maker that never ` +
    `loses because it never fills is not a market.`);
}

/** Every single bet, as a row, for anybody who wants to check the arithmetic
 *  rather than take the summary's word for it. */
function writeLedger(results: BoutResult[], path: string) {
  const settles = (side: number, outcome: number) =>
    outcome === OUTCOME_VOID ? 0.5 : (outcome === OUTCOME_A ? SIDE_A : SIDE_B) === side ? 1 : 0;

  const rows = [[
    "bout", "fight", "scenario", "line", "bettor", "archetype", "side", "action",
    "shares", "paid", "avg_price_cents", "payout_if_right", "outcome", "actual_payout", "net",
  ].join(",")];

  for (const bout of results) {
    for (const fill of bout.fills) {
      const value = settles(fill.side, bout.outcome);
      const actual = fill.isBuy ? fill.shares * value : 0;
      rows.push([
        bout.boutId, `"${bout.label}"`, bout.scenario, bout.line,
        fill.who, fill.archetype, fill.side === SIDE_A ? "A" : "B",
        fill.isBuy ? "buy" : "sell",
        fill.shares.toFixed(2), fill.cost.toFixed(4),
        ((fill.cost / fill.shares) * 100).toFixed(2),
        fill.isBuy ? fill.shares.toFixed(2) : "0",
        bout.outcome === OUTCOME_VOID ? "draw" : bout.outcome === OUTCOME_A ? "A" : "B",
        actual.toFixed(2),
        (actual - fill.cost).toFixed(4),
      ].join(","));
    }
  }

  writeFileSync(path, rows.join("\n") + "\n");
  console.log(`\nevery bet written to ${path} (${rows.length - 1} rows)`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  console.log("Forge League — market maker rehearsal\n");

  const league = createInitialLeague();

  // 1. The line, on its own, with no market anywhere near it.
  const calibration = buildMatchups(league.roster, Number.MAX_SAFE_INTEGER);
  reportCalibration(calibration);

  // 2. The market. A subset of the same fights, traded for real on a real book.
  console.log("\n══ trading ═══════════════════════════════════════════════════");
  console.log(`booting anvil on :${PORT}…`);
  const node = await startAnvil();

  try {
    deployerActor = actorAt(0, "deployer");
    const maker = actorAt(1, "maker");
    const bettors = Array.from({ length: 12 }, (_, i) => actorAt(i + 2, `bettor-${i + 1}`));

    const rig = await deploy(deployerActor.wallet, deployerActor.address);
    console.log(`deployed: clob ${rig.clob}`);

    await fund(rig, deployerActor, 0);
    // The deployer's own drip bankrolls everyone's top-ups, so it drips first
    // and the rest come out of its balance.
    await fund(rig, maker, 0);
    await deployerTransfer(rig, maker.address, MAKER_BANKROLL - 10000 > 0 ? MAKER_BANKROLL - 10000 : 0);
    for (const bettor of bettors) await fund(rig, bettor, 0);

    const startBalance = toUnits(rig, await balanceOf(rig, maker.address));
    console.log(`maker bankroll: ${money(startBalance)}, taker fee ${TAKER_FEE_BPS} bps\n`);

    const card = shuffle(calibration).slice(0, FIGHTS);
    const results: BoutResult[] = [];

    for (const [index, matchup] of card.entries()) {
      const scenario = SCENARIOS[index % SCENARIOS.length];
      const boutId = BigInt(index + 1);

      // Book it. `latestCloseAt` and `voidAfter` are backstops the harness never
      // reaches — the bell here is an explicit `closeBout`, exactly as it is in
      // the league, because a paused broadcast clock has no wall time.
      const now = BigInt(Math.floor(Date.now() / 1000));
      await deployerActor.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never, functionName: "createBout",
        account: deployerActor.wallet.account!, chain,
        args: [
          1n,
          `0x${Buffer.from(matchup.blue.id.padEnd(32, "\0")).toString("hex")}` as Hex,
          `0x${Buffer.from(matchup.red.id.padEnd(32, "\0")).toString("hex")}` as Hex,
          now + 86400n, now + 172800n,
        ],
      });

      const before = toUnits(rig, await balanceOf(rig, maker.address));
      const fair = matchup.line;
      const truth = matchup.winner === null ? null : matchup.winner === "blue" ? SIDE_A : SIDE_B;

      // The opening quote, then a requote after every single fill — a maker that
      // only looks between fights is a maker that gets picked off within one.
      await makerPass(rig, maker, boutId, fair);

      const fills: Fill[] = [];
      const ctx: BetContext = { rig, boutId, fair, truth, bettors };
      for (let step = 0; step < ACTIONS_PER_FIGHT; step += 1) {
        const fill = await act(scenario, ctx, step);
        if (fill) fills.push(fill);
        await makerPass(rig, maker, boutId, fair);
      }

      // The bell.
      await deployerActor.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never, functionName: "closeBout",
        account: deployerActor.wallet.account!, chain, args: [boutId],
      });

      const outcome = matchup.winner === null
        ? OUTCOME_VOID
        : (matchup.winner === "blue" ? SIDE_A : SIDE_B) === SIDE_A ? OUTCOME_A : OUTCOME_B;
      await deployerActor.wallet.writeContract({
        address: rig.clob, abi: rig.abi.clob as never, functionName: "resolveBout",
        account: deployerActor.wallet.account!, chain, args: [boutId, outcome],
      });

      const position = await positionOf(rig, boutId, maker.address);

      // Settle up: pull the resting orders, redeem the winners, take the money
      // out of the pull-payment ledger. Without all three the maker looks broke
      // while being owed a fortune, which is the failure `reclaim` exists for.
      for (const actor of [maker, ...bettors]) {
        // Only the accounts that actually touched this fight have anything to
        // cancel, redeem or withdraw. Sending three no-op transactions each for
        // every bettor on every bout is most of the runtime and none of the
        // information.
        const held = await positionOf(rig, boutId, actor.address);
        const traded = fills.some((fill) => fill.who === actor.name);
        if (actor !== maker && !traded && held.a === 0 && held.b === 0) continue;
        // Cancel by id off the backwards scan. `cancelMyOrders(0, n)` walks the
        // oldest n slots of an append-only array and would miss everything.
        for (const order of await liveOrders(rig, actor.address)) {
          try {
            const hash = await actor.wallet.writeContract({
              address: rig.clob, abi: rig.abi.clob as never, functionName: "cancelOrder",
              account: actor.wallet.account!, chain, args: [order.id],
            });
            await rig.publicClient.waitForTransactionReceipt({ hash });
          } catch (error) { swallow("settle-cancel", error); }
        }
        try {
          await actor.wallet.writeContract({
            address: rig.clob, abi: rig.abi.clob as never, functionName: "redeem",
            account: actor.wallet.account!, chain, args: [boutId],
          });
        } catch { /* holds only losing shares — redeem reverts, which is fine */ }
        try {
          await actor.wallet.writeContract({
            address: rig.clob, abi: rig.abi.clob as never, functionName: "withdraw",
            account: actor.wallet.account!, chain, args: [],
          });
        } catch { /* nothing owed */ }
      }

      const after = toUnits(rig, await balanceOf(rig, maker.address));
      results.push({
        boutId, scenario, line: fair, outcome,
        label: `${matchup.blue.lastName} v ${matchup.red.lastName}`,
        makerPnl: after - before,
        makerPosition: { a: position.a, b: position.b },
        fills,
      });

      process.stdout.write(
        `  ${String(index + 1).padStart(2)}/${card.length} ${scenario.padEnd(12)} ` +
        `line ${String(fair).padStart(2)}¢  ${fills.length} fills  maker ${money(after - before).padStart(8)}\n`,
      );
    }

    const finalBalance = toUnits(rig, await balanceOf(rig, maker.address));
    reportMaker(results, startBalance, finalBalance);
    reportBettors(results);
    writeLedger(results, join(ROOT, "market-sim-bets.csv"));
    console.log("");
  } finally {
    node.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
