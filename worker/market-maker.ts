/** The league making a market on its own card.
 *
 * A book that is quoted once and then abandoned is not a market. The opening
 * quote gets eaten by whoever arrives first, and everybody after them finds an
 * empty ladder and either cannot trade or trades at whatever the last person
 * left behind. So this replaces the one-shot seed with a standing obligation:
 * every pass, work out what the ladder on a fight *should* look like, compare it
 * to what is actually resting, and correct the difference.
 *
 * Deliberately pure — a fight's fair value, what we are holding, and what we
 * have resting go in; a list of cancels and a list of orders come out. Nothing
 * in here talks to a chain, reads a clock or throws. That is what makes it
 * possible to run ten thousand fills through it in a test and know what the
 * thing actually does before it is quoting real money.
 *
 * The three ideas it is built on:
 *
 *  1. **Fair value is the league's line, and the market does not move it.**
 *     `openingLine` comes out of the same roster the simulation fights over, so
 *     it is the best prior on the card. A maker that chases the book away from
 *     its own line has thrown away the only edge it had and is now a mirror with
 *     a spread. Flow moves the *quote* here, never the *fair*.
 *
 *  2. **Inventory is the risk, so inventory moves the quote.** One-sided flow is
 *     the thing that actually costs money: it leaves the maker holding the
 *     corner the informed money rejected. Every share of net exposure leans the
 *     whole ladder away from the side we are heavy on, so the next taker is paid
 *     a little to flatten us. Getting flat by attracting flow earns the spread;
 *     getting flat by crossing it pays the spread. This does the first.
 *
 *  3. **The maker holds stock and quotes real asks, not just bids.** This one is
 *     forced by the contract and is not an optimisation. `_matchBuyAgainstAsks`
 *     walks up through ask levels the way any book does, but
 *     `_matchBuyComplementary` only ever looks at the *single* level exactly
 *     mirroring the taker's limit: a buy of A at 59¢ matches a resting B bid at
 *     41¢ and nothing else, so it will not touch a B bid at 44¢ even though that
 *     is a better price for the buyer. A bids-only book therefore only fills
 *     takers who name the exact mirror price to the cent. Anybody clicking "buy"
 *     with normal slippage tolerance — which is what every market order on every
 *     exchange is — gets no fill at all rather than a worse one.
 *
 *     So the maker mints complete sets and rests genuine asks over them. Minting
 *     is free of directional risk by construction: it adds a share to *both*
 *     corners, so `net` does not move and the pair is worth a unit at settlement
 *     whatever happens. It costs capital, not exposure.
 *
 * What it cannot do is stop us losing money on a fight. Nothing can — see the
 * caps below for what bounds the damage instead. */

/* ------------------------------------------------------------------ shapes */

export const SIDE_A = 0;
export const SIDE_B = 1;

/** An order the maker already has resting, as the reader hands it back. */
export interface RestingOrder {
  orderId: bigint;
  side: number;
  isBuy: boolean;
  /** Cents, 1–99. */
  price: number;
  /** Whole shares. Fractional remainders of a partly-filled order are fine. */
  shares: number;
}

/** One rung the maker wants on the book. */
export interface QuoteIntent {
  side: number;
  isBuy: boolean;
  price: number;
  shares: number;
}

export interface MakerConfig {
  /** Cents between fair and the best quote on each side. Half the round-trip
   *  edge: at 2, a matched pair of fills earns 4¢ on a 100¢ set. */
  spread: number;
  /** Cents between ladder rungs. Wider means a big taker walks further up the
   *  book before it runs out, and pays more for the privilege. */
  step: number;
  /** Rungs per side. One rung is a price, not a market — a taker who wants more
   *  than the top of the book finds nothing behind it and stops. */
  levels: number;
  /** Whole shares on the best rung. */
  size: number;
  /** Size multiplier per rung out from the top. Cheap depth where it is least
   *  likely to be hit, thin depth where it is most likely to be picked off. */
  sizeGrowth: number;
  /** Net shares of exposure that buy one cent of lean. Smaller is a maker that
   *  reacts harder to being filled. */
  skewShares: number;
  /** The hardest the ladder will ever lean, in cents. A cap because past some
   *  point we are no longer quoting a price we believe, and a maker quoting a
   *  price it does not believe is just a slower way of being wrong. */
  maxSkew: number;
  /** Net shares of one-way exposure we will carry on a fight. Past this the
   *  maker stops bidding the heavy side outright — it will still sell it, and
   *  still buy the other corner, but it will not add. This is the hard stop
   *  that bounds the loss on any single bout. */
  maxNet: number;
  /** Matched pairs to keep on hand per fight, to rest asks over.
   *
   * This is what makes an ordinary market order fillable — see the note at the
   * top about complementary matching only hitting the exact mirror level. A
   * pair costs a whole unit and is worth a whole unit at settlement, so the
   * stock is capital at work, not money at risk. Set to 0 and the maker falls
   * back to bids only, which quotes a book almost nobody can trade against. */
  stock: number;
  /** Collateral units this fight may tie up at once, stock and bids together. */
  budget: number;
}

export const DEFAULT_MAKER_CONFIG: MakerConfig = {
  spread: 2,
  step: 2,
  levels: 3,
  size: 12,
  sizeGrowth: 1.6,
  skewShares: 9,
  maxSkew: 8,
  maxNet: 60,
  stock: 30,
  budget: 60,
};

export interface MakerInput {
  /** The league's line for side A, in cents. */
  fair: number;
  /** Whole shares held, by side. */
  inventory: { a: number; b: number };
  /** Everything the maker has resting on this bout. */
  resting: RestingOrder[];
  /** Collateral units the maker can actually spend right now. Bids are trimmed
   *  to fit it, because an order the wallet cannot fund reverts the whole tick. */
  cash: number;
  config: MakerConfig;
}

export interface MakerPlan {
  cancel: bigint[];
  place: QuoteIntent[];
  /** Complete sets to mint before the asks go out, in whole shares. Risk-free:
   *  it moves collateral into a position worth exactly what it cost. */
  mint: number;
  /** What the maker thought, for the log and for the tests. */
  fair: number;
  /** Cents of lean applied, signed against the heavy side. */
  lean: number;
  /** Where the ladder is actually centred once the lean is in. */
  center: number;
  /** `inventory.a - inventory.b`. Positive is long A. */
  net: number;
  /** Collateral the resting bids will tie up once this plan lands. */
  committed: number;
}

/* ------------------------------------------------------------------ prices */

/** Ticks the contract will accept. Anything outside is not a cheap price, it is
 *  a reverted transaction. */
const MIN_TICK = 1;
const MAX_TICK = 99;

/** How much of a rung has to still be resting for it to be left alone.
 *
 * Cancel-and-replace costs a transaction and loses queue priority, so a rung
 * that is half full is worth keeping. Below that it is barely a quote and the
 * replacement is worth paying for. */
const KEEP_FRACTION = 0.5;

/** The most of a fight's budget that may sit in stock rather than in bids.
 *
 * Both halves of the book have to exist. Stock is what a buyer walks and bids
 * are what a seller hits, and a maker holding only one of them is running half a
 * market. Two thirds because stock is the dearer half per unit of quote. */
const STOCK_SHARE = 0.65;

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function keyOf(side: number, isBuy: boolean, price: number) {
  return `${side}:${isBuy ? "b" : "a"}:${price}`;
}

/* -------------------------------------------------------------------- lean */

/** How far to tilt the ladder, given what we are stuck holding.
 *
 * Signed so that being long A pushes the centre *down*: side A's bid gets worse
 * and side B's bid — which is `100 − centre − spread` — gets better, so the
 * cheapest thing on the book becomes the trade that flattens us. */
export function leanFor(net: number, config: MakerConfig): number {
  if (config.skewShares <= 0) return 0;
  return clamp(Math.round(net / config.skewShares), -config.maxSkew, config.maxSkew);
}

/* ------------------------------------------------------------------ ladder */

/** The bid ladder on one corner, before budget and before caps. */
function bidLadder(side: number, top: number, config: MakerConfig): QuoteIntent[] {
  const rungs: QuoteIntent[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < config.levels; i += 1) {
    const price = top - i * config.step;
    // A rung that clamps onto the floor is the same rung twice: one order with
    // the combined size, not two orders fighting for the same tick.
    if (price < MIN_TICK || seen.has(price)) continue;
    seen.add(price);
    rungs.push({
      side,
      isBuy: true,
      price,
      shares: Math.max(1, Math.round(config.size * Math.pow(config.sizeGrowth, i))),
    });
  }
  return rungs;
}

/** The ask ladder on one corner, capped at the shares actually held.
 *
 * This is the side of the book a market order can reach, so it gets quoted
 * whenever there is anything to quote it with — not only when the maker is
 * caught long. Selling a share out of a matched pair is the same trade as
 * bidding the other corner at the mirror price, and it costs no new collateral. */
function askLadder(side: number, top: number, sellable: number, config: MakerConfig): QuoteIntent[] {
  const rungs: QuoteIntent[] = [];
  const seen = new Set<number>();
  let left = Math.floor(sellable);
  for (let i = 0; i < config.levels && left > 0; i += 1) {
    const price = top + i * config.step;
    if (price > MAX_TICK || seen.has(price)) continue;
    seen.add(price);
    const want = Math.max(1, Math.round(config.size * Math.pow(config.sizeGrowth, i)));
    const shares = Math.min(want, left);
    left -= shares;
    rungs.push({ side, isBuy: false, price, shares });
  }
  return rungs;
}

/* ------------------------------------------------------------------ budget */

/** Fill one corner's ladder from the top down, out of its own purse.
 *
 * Outermost rungs go first when the money runs short. They are the ones least
 * likely to trade, so cutting them costs the least liquidity per unit freed, and
 * it leaves the top of the book — which is what a taker actually sees — intact. */
function fillCorner(rungs: QuoteIntent[], purse: number) {
  const kept: QuoteIntent[] = [];
  let spent = 0;
  for (const quote of rungs) {
    const cost = (quote.price * quote.shares) / 100;
    if (spent + cost <= purse) {
      kept.push(quote);
      spent += cost;
      continue;
    }
    // Part of a rung is still a quote. Below a whole share it is not — and
    // nothing further out is affordable either, so stop here.
    const affordable = Math.floor(((purse - spent) * 100) / quote.price);
    if (affordable >= 1) {
      kept.push({ ...quote, shares: affordable });
      spent += (quote.price * affordable) / 100;
    }
    break;
  }
  return { kept, spent };
}

/** Trim the bid ladder until it fits the money.
 *
 * Each corner gets half the purse before either is allowed a second helping.
 * Spending straight down a merged list looks tidier and is wrong: the favourite
 * is the dearer rung, so it eats the whole allowance first and the maker ends up
 * with a fat one-way book on the exact corner it least wants to be long. A thin
 * budget should buy a thin two-way market, not half a good one. */
function fitBudget(bids: QuoteIntent[], allowance: number): QuoteIntent[] {
  const corners = [SIDE_A, SIDE_B].map((side) =>
    bids.filter((quote) => quote.side === side).sort((left, right) => right.price - left.price),
  );

  const filled = corners.map((rungs) => fillCorner(rungs, allowance / 2));

  // A corner that ran out of ladder before it ran out of money hands the change
  // to the one that ran out of money first.
  let spare = allowance - filled.reduce((sum, corner) => sum + corner.spent, 0);
  for (let i = 0; i < corners.length && spare > 0; i += 1) {
    const retry = fillCorner(corners[i], filled[i].spent + spare);
    spare -= retry.spent - filled[i].spent;
    filled[i] = retry;
  }

  return filled.flatMap((corner) => corner.kept);
}

/* -------------------------------------------------------------------- plan */

/** What the book on this fight should look like, and what it takes to get there.
 *
 * Cancels are listed before places and must be *executed* in that order. A stale
 * bid left resting above a fresh ask on the same corner is a self-trade: the
 * contract matches a sell against resting bids without caring that both belong
 * to us, and we would pay the taker fee to buy our own shares. The guard below
 * catches the case where a kept bid still sits above the ask, but ordering is
 * what makes it safe in general. */
export function planQuotes(input: MakerInput): MakerPlan {
  const { fair, inventory, resting, cash, config } = input;

  const net = inventory.a - inventory.b;
  const lean = leanFor(net, config);
  const center = clamp(fair - lean, MIN_TICK + config.spread, MAX_TICK - config.spread);

  const desired: QuoteIntent[] = [];

  /* --- stock: enough matched pairs to have something to offer -------------- */

  // Minting moves collateral into a position worth exactly what it cost, so it
  // is bounded by the budget rather than by any risk limit. What it buys is a
  // fillable book: without shares in hand there are no asks, and without asks a
  // market order has nothing to walk.
  //
  // It does not get the whole budget, though. A share of stock ties up a whole
  // unit and a bid ties up its price, so stock left unchecked would eat a thin
  // budget entirely and leave a book that can be bought from and not sold to.
  const cap = Math.min(config.budget, Math.max(0, cash));
  const matched = Math.min(inventory.a, inventory.b);
  const mint = Math.floor(
    clamp(config.stock - matched, 0, Math.max(0, cap * STOCK_SHARE - matched)),
  );

  const stocked = {
    a: inventory.a + Math.max(0, mint),
    b: inventory.b + Math.max(0, mint),
  };

  /* --- asks: the side of the book an ordinary market order can reach ------ */

  // Capped by `maxNet` in the same breath as the bids, and for the same reason.
  // Selling A takes the position *down* on A, so on a book we are already short
  // A it pushes further the wrong way — an ask ladder answerable only to what is
  // held would walk straight through the limit the bids are respecting, and the
  // cap would bound nothing at all.
  const sellable = {
    a: Math.max(0, Math.min(stocked.a, net + config.maxNet)),
    b: Math.max(0, Math.min(stocked.b, config.maxNet - net)),
  };
  desired.push(...askLadder(SIDE_A, clamp(center + config.spread, MIN_TICK, MAX_TICK), sellable.a, config));
  desired.push(...askLadder(SIDE_B, clamp(100 - center + config.spread, MIN_TICK, MAX_TICK), sellable.b, config));

  /* --- bids: two corners, leaning away from whatever we are heavy on ------ */

  // The cap is one-directional on purpose. Long A past the limit stops us
  // *buying* A; it does not stop us buying B, because that trade takes the
  // exposure down. A symmetric "stop quoting" would freeze the book at exactly
  // the moment we most want someone to take the other side.
  const bids: QuoteIntent[] = [];
  if (net < config.maxNet) bids.push(...bidLadder(SIDE_A, center - config.spread, config));
  if (-net < config.maxNet) bids.push(...bidLadder(SIDE_B, 100 - center - config.spread, config));

  // Whatever the stock did not take. Bids are the cheaper half of the book to
  // hold — a bid at 34¢ ties up 34¢ where a share of stock ties up a whole unit
  // — so they are funded out of the remainder rather than competing for it.
  desired.push(...fitBudget(bids, Math.max(0, cap - matched - mint)));

  /* --- reconcile against what is already there --------------------------- */

  const wanted = new Map<string, QuoteIntent>();
  for (const quote of desired) {
    const key = keyOf(quote.side, quote.isBuy, quote.price);
    const existing = wanted.get(key);
    if (existing) existing.shares += quote.shares;
    else wanted.set(key, { ...quote });
  }

  const restingByKey = new Map<string, RestingOrder[]>();
  for (const order of resting) {
    const key = keyOf(order.side, order.isBuy, order.price);
    const bucket = restingByKey.get(key);
    if (bucket) bucket.push(order);
    else restingByKey.set(key, [order]);
  }

  const cancel: bigint[] = [];
  const place: QuoteIntent[] = [];
  const kept: QuoteIntent[] = [];

  for (const [key, quote] of wanted) {
    const bucket = restingByKey.get(key) ?? [];
    const live = bucket.reduce((sum, order) => sum + order.shares, 0);
    if (live >= quote.shares * KEEP_FRACTION && live <= quote.shares) {
      kept.push({ ...quote, shares: live });
      continue;
    }
    // Too thin to count, or bigger than we now mean to show. Oversized matters
    // for asks especially: escrowed shares are not spendable, so a rung left
    // standing above the ladder starves the rungs beside it and they revert on
    // `placeSellOrder`. Pull what is there and re-post the rung whole.
    for (const order of bucket) cancel.push(order.orderId);
    place.push(quote);
  }

  for (const [key, bucket] of restingByKey) {
    if (wanted.has(key)) continue;
    for (const order of bucket) cancel.push(order.orderId);
  }

  /* --- the self-trade guard ---------------------------------------------- */

  // A bid we decided to keep can still sit at or above an ask we are about to
  // post, if the lean moved a long way in one pass. Dropping the ask is the
  // conservative fix: the bid is already funded and working, the ask is the new
  // thing, and skipping it costs a pass of flattening rather than a fee.
  const highestKeptBid = new Map<number, number>();
  for (const quote of [...kept, ...place]) {
    if (!quote.isBuy) continue;
    const best = highestKeptBid.get(quote.side);
    if (best === undefined || quote.price > best) highestKeptBid.set(quote.side, quote.price);
  }
  const safe = place.filter((quote) => {
    if (quote.isBuy) return true;
    const bid = highestKeptBid.get(quote.side);
    return bid === undefined || quote.price > bid;
  });

  const committed = [...kept, ...safe]
    .filter((quote) => quote.isBuy)
    .reduce((sum, quote) => sum + (quote.price * quote.shares) / 100, 0);

  return { cancel, place: safe, mint, fair, lean, center, net, committed };
}

/* ------------------------------------------------------------------- risk */

/** What this position is worth at settlement, both ways.
 *
 * Matched pairs pay a unit each whatever happens — including a draw, which pays
 * half on both sides — so the only thing in doubt is the overhang. Handed back
 * as the two ends of the range rather than an expectation, because the point of
 * looking is to see the bad end. */
export function positionValue(inventory: { a: number; b: number }) {
  const matched = Math.min(inventory.a, inventory.b);
  const net = inventory.a - inventory.b;
  return {
    matched,
    net,
    /** Side A wins. */
    ifA: inventory.a,
    /** Side B wins. */
    ifB: inventory.b,
    /** A draw voids the bout and pays half a unit on every share. */
    ifDraw: (inventory.a + inventory.b) / 2,
    worst: Math.min(inventory.a, inventory.b),
    best: Math.max(inventory.a, inventory.b),
  };
}
