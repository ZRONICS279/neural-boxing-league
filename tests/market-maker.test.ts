import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAKER_CONFIG,
  SIDE_A,
  SIDE_B,
  type MakerConfig,
  type MakerInput,
  type RestingOrder,
  leanFor,
  planQuotes,
  positionValue,
} from "../worker/market-maker.ts";

/** The maker quotes with the league's money on eighteen fights at a time and
 *  nobody watches it do it. The properties worth pinning are the ones whose
 *  failure costs money silently: it must never trade with itself, never lean so
 *  far it is quoting a price it does not hold, never spend past its budget, and
 *  never keep adding to a position it has already capped. */

const config = DEFAULT_MAKER_CONFIG;

function input(over: Partial<MakerInput> = {}): MakerInput {
  return {
    fair: 60,
    inventory: { a: 0, b: 0 },
    resting: [],
    cash: 1000,
    config,
    ...over,
  };
}

function order(
  orderId: number,
  side: number,
  isBuy: boolean,
  price: number,
  shares: number,
): RestingOrder {
  return { orderId: BigInt(orderId), side, isBuy, price, shares };
}

/* ------------------------------------------------------------- the ladder */

test("a fresh fight is quoted on both corners, both ways", () => {
  const plan = planQuotes(input());
  for (const side of [SIDE_A, SIDE_B]) {
    assert.ok(plan.place.some((q) => q.side === side && q.isBuy), `no bid on ${side}`);
    // Asks are the half a market order can actually walk: complementary
    // matching only fires at the one price exactly mirroring the taker's limit,
    // so a bids-only book is unreachable to anyone who allows any slippage.
    assert.ok(plan.place.some((q) => q.side === side && !q.isBuy), `no ask on ${side}`);
  }
});

test("a fresh fight mints the stock it needs to offer", () => {
  const plan = planQuotes(input());
  assert.ok(plan.mint > 0, "nothing minted, so there is nothing to sell");
  assert.ok(plan.mint <= config.stock);
});

test("minting never moves the exposure", () => {
  // A complete set is a share of each corner. It costs money and changes no
  // risk whatsoever, which is what makes it safe to fund out of the budget.
  const plan = planQuotes(input({ inventory: { a: 40, b: 0 } }));
  const after = { a: 40 + plan.mint, b: 0 + plan.mint };
  assert.equal(after.a - after.b, 40, "minting changed the net position");
});

test("a fully stocked book mints nothing more", () => {
  const plan = planQuotes(input({ inventory: { a: config.stock, b: config.stock } }));
  assert.equal(plan.mint, 0);
});

test("the two bid corners never sum to a whole unit", () => {
  // Placing the second bid is an incoming order, and an incoming buy of B at
  // 38 matches a resting bid on A at 62 complementarily. At exactly 100 the
  // league buys both sides of its own fight and pays the taker fee to do it.
  // (Asks are exempt: nothing matches two resting orders against each other,
  // and a sell only ever looks at bids on its own corner.)
  for (let fair = 25; fair <= 75; fair += 1) {
    const plan = planQuotes(input({ fair }));
    const bids = plan.place.filter((q) => q.isBuy);
    const bestA = Math.max(...bids.filter((q) => q.side === SIDE_A).map((q) => q.price));
    const bestB = Math.max(...bids.filter((q) => q.side === SIDE_B).map((q) => q.price));
    assert.ok(bestA + bestB < 100, `${fair}: ${bestA} + ${bestB} crosses`);
  }
});

test("every price is a tick the contract will take", () => {
  for (let fair = 1; fair <= 99; fair += 1) {
    for (const net of [-200, -40, 0, 40, 200]) {
      const plan = planQuotes(input({ fair, inventory: { a: Math.max(0, net), b: Math.max(0, -net) } }));
      for (const quote of plan.place) {
        assert.ok(quote.price >= 1 && quote.price <= 99, `tick ${quote.price} out of range`);
        assert.ok(quote.shares >= 1, "sub-share order");
        assert.ok(Number.isInteger(quote.shares), `fractional size ${quote.shares}`);
      }
    }
  }
});

test("the ladder gets deeper the further it is from fair", () => {
  // Budget raised out of the way: this is about the shape of an untrimmed
  // ladder, and the default budget deliberately clips the outermost rung.
  const plan = planQuotes(input({ cash: 100000, config: { ...config, budget: 100000 } }));
  const rungs = plan.place
    .filter((quote) => quote.side === SIDE_A && quote.isBuy)
    .sort((left, right) => right.price - left.price);
  assert.ok(rungs.length > 1, "one rung is a price, not a book");
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i].shares >= rungs[i - 1].shares, "depth should grow outward");
  }
});

/* ---------------------------------------------------------------- the lean */

test("being long a corner makes that corner the worse bid", () => {
  const flat = planQuotes(input());
  const longA = planQuotes(input({ inventory: { a: 40, b: 0 } }));

  const bestOf = (plan: typeof flat, side: number) =>
    Math.max(...plan.place.filter((q) => q.side === side && q.isBuy).map((q) => q.price));

  assert.ok(bestOf(longA, SIDE_A) < bestOf(flat, SIDE_A), "A bid should fall when long A");
  assert.ok(bestOf(longA, SIDE_B) > bestOf(flat, SIDE_B), "B bid should rise when long A");
});

test("the lean is bounded however lopsided the book gets", () => {
  for (const net of [-10000, -500, 500, 10000]) {
    const lean = leanFor(net, config);
    assert.ok(Math.abs(lean) <= config.maxSkew, `lean ${lean} past the cap`);
  }
});

test("a matched position is flat and does not lean at all", () => {
  // 200 of each is a guaranteed unit a pair at settlement. There is nothing to
  // hedge and the quote should not move an inch.
  const plan = planQuotes(input({ inventory: { a: 200, b: 200 } }));
  assert.equal(plan.net, 0);
  assert.equal(plan.lean, 0);
  const asks = plan.place.filter((quote) => !quote.isBuy);
  assert.equal(new Set(asks.map((q) => q.side)).size, 2, "a flat book still offers both corners");
});

/* ---------------------------------------------------------------- the caps */

test("past the net cap the maker stops bidding the heavy corner", () => {
  const plan = planQuotes(input({ inventory: { a: config.maxNet + 5, b: 0 } }));
  const bidsOnA = plan.place.filter((quote) => quote.side === SIDE_A && quote.isBuy);
  assert.equal(bidsOnA.length, 0, "still adding to a capped position");

  // But it must keep quoting the corner that would flatten it — freezing the
  // whole book is how the position gets stuck rather than worked off.
  const bidsOnB = plan.place.filter((quote) => quote.side === SIDE_B && quote.isBuy);
  assert.ok(bidsOnB.length > 0, "stopped quoting the corner that helps");
});

test("nothing is offered that is not actually held", () => {
  // Selling shares we do not own reverts on `placeSellOrder`, which would kill
  // the whole quoting pass for that fight.
  for (const inventory of [{ a: 0, b: 0 }, { a: 5, b: 0 }, { a: 0, b: 7 }, { a: 3, b: 90 }]) {
    const plan = planQuotes(input({ inventory, cash: 0 }));
    for (const side of [SIDE_A, SIDE_B]) {
      const offered = plan.place
        .filter((quote) => !quote.isBuy && quote.side === side)
        .reduce((sum, quote) => sum + quote.shares, 0);
      const held = side === SIDE_A ? inventory.a : inventory.b;
      assert.ok(offered <= held, `offered ${offered} of ${held} held`);
    }
  }
});

test("the net cap bounds selling as well as buying", () => {
  // Selling A takes the position down on A. On a book already short A, an ask
  // ladder sized only by what is held walks straight through the limit the bids
  // are respecting — and then the cap bounds nothing at all.
  for (const net of [-200, -80, -config.maxNet, 0, config.maxNet, 80, 200]) {
    const inventory = { a: 150 + Math.max(0, net), b: 150 + Math.max(0, -net) };
    const plan = planQuotes(input({ inventory, cash: 0 }));
    const sold = (side: number) => plan.place
      .filter((quote) => !quote.isBuy && quote.side === side)
      .reduce((sum, quote) => sum + quote.shares, 0);

    // A position already outside the cap may not be pushed further out; one
    // inside it may not be pushed through. Both are the same rule stated
    // against wherever the book actually starts.
    const actualNet = inventory.a - inventory.b;
    assert.ok(actualNet - sold(SIDE_A) >= Math.min(actualNet, -config.maxNet) - 1e-9,
      `selling ${sold(SIDE_A)} of A from net ${actualNet} breaks the cap`);
    assert.ok(actualNet + sold(SIDE_B) <= Math.max(actualNet, config.maxNet) + 1e-9,
      `selling ${sold(SIDE_B)} of B from net ${actualNet} breaks the cap`);
  }
});

test("being long a corner offers more of it than of the other", () => {
  const plan = planQuotes(input({ inventory: { a: 90, b: 20 } }));
  const offered = (side: number) => plan.place
    .filter((quote) => !quote.isBuy && quote.side === side)
    .reduce((sum, quote) => sum + quote.shares, 0);
  assert.ok(offered(SIDE_A) > offered(SIDE_B), "not working the heavy corner down");
});

test("the maker never crosses its own book", () => {
  // Every combination of fair and inventory: no ask may land at or below a bid
  // on the same corner, whether that bid is new or one we decided to keep.
  for (let fair = 20; fair <= 80; fair += 5) {
    for (const net of [-120, -60, -20, 0, 20, 60, 120]) {
      const inventory = { a: Math.max(0, net) + 30, b: Math.max(0, -net) + 30 };
      const resting = [
        order(1, SIDE_A, true, fair - 1, 20),
        order(2, SIDE_B, true, 100 - fair - 1, 20),
      ];
      const plan = planQuotes(input({ fair, inventory, resting }));
      const cancelled = new Set(plan.cancel.map(String));
      const bids = [
        ...plan.place.filter((q) => q.isBuy),
        ...resting.filter((o) => o.isBuy && !cancelled.has(String(o.orderId))),
      ];
      for (const ask of plan.place.filter((quote) => !quote.isBuy)) {
        for (const bid of bids.filter((quote) => quote.side === ask.side)) {
          assert.ok(ask.price > bid.price, `ask ${ask.price} crosses bid ${bid.price}`);
        }
      }
    }
  }
});

/* -------------------------------------------------------------- the budget */

test("resting bids never tie up more than the budget", () => {
  for (const cash of [0, 1, 5, 20, 100, 100000]) {
    const plan = planQuotes(input({ cash }));
    const spend = plan.place
      .filter((quote) => quote.isBuy)
      .reduce((sum, quote) => sum + (quote.price * quote.shares) / 100, 0);
    assert.ok(spend <= config.budget + 1e-9, `spent ${spend} of ${config.budget}`);
    assert.ok(spend <= cash + 1e-9, `spent ${spend} with ${cash} in hand`);
  }
});

test("a broke maker quotes nothing rather than reverting", () => {
  const plan = planQuotes(input({ cash: 0 }));
  assert.equal(plan.place.filter((quote) => quote.isBuy).length, 0);
  assert.equal(plan.mint, 0, "minted stock it could not pay for");
});

test("a thin budget still quotes both corners", () => {
  // Trimming down one corner at a time would leave a one-way book, which is the
  // exposure the whole design exists to avoid.
  const plan = planQuotes(input({ cash: 6 }));
  const corners = new Set(plan.place.filter((quote) => quote.isBuy).map((quote) => quote.side));
  assert.equal(corners.size, 2, "a thin book went one-way");
});

test("stock never eats the whole budget", () => {
  // Both halves have to exist: stock is what a buyer walks, bids are what a
  // seller hits. All of one and none of the other is half a market.
  for (const cash of [3, 6, 15, 40, 1000]) {
    const plan = planQuotes(input({ cash }));
    assert.ok(
      plan.place.some((quote) => quote.isBuy),
      `${cash} in hand and no bids at all`,
    );
  }
});

/* ----------------------------------------------------------- reconciliation */

test("a book that is already right is left alone", () => {
  const first = planQuotes(input());
  const resting = first.place.map((quote, index) =>
    order(index + 1, quote.side, quote.isBuy, quote.price, quote.shares),
  );
  const second = planQuotes(input({ resting }));
  assert.equal(second.place.length, 0, "re-posted a book that was already correct");
  assert.equal(second.cancel.length, 0, "cancelled a book that was already correct");
});

test("a half-eaten rung is left, a nearly-eaten one is replaced", () => {
  const first = planQuotes(input());
  const top = first.place.find((quote) => quote.side === SIDE_A && quote.isBuy);
  assert.ok(top);

  const half = planQuotes(input({
    resting: first.place.map((quote, index) =>
      order(index + 1, quote.side, quote.isBuy, quote.price,
        quote === top ? Math.ceil(quote.shares * 0.6) : quote.shares),
    ),
  }));
  assert.ok(
    !half.place.some((quote) => quote.price === top.price && quote.side === SIDE_A),
    "churned a rung that was still more than half there",
  );

  const dust = planQuotes(input({
    resting: first.place.map((quote, index) =>
      order(index + 1, quote.side, quote.isBuy, quote.price,
        quote === top ? 1 : quote.shares),
    ),
  }));
  assert.ok(
    dust.place.some((quote) => quote.price === top.price && quote.side === SIDE_A),
    "left a rung standing as dust",
  );
});

test("orders at prices we no longer want are pulled", () => {
  const stale = [order(99, SIDE_A, true, 12, 40), order(98, SIDE_B, true, 9, 40)];
  const plan = planQuotes(input({ resting: stale }));
  assert.ok(plan.cancel.includes(99n), "left a stale bid on A");
  assert.ok(plan.cancel.includes(98n), "left a stale bid on B");
});

/* ------------------------------------------------------------ the position */

test("a matched pair is worth a unit whatever happens", () => {
  const value = positionValue({ a: 25, b: 25 });
  assert.equal(value.ifA, 25);
  assert.equal(value.ifB, 25);
  assert.equal(value.ifDraw, 25);
  assert.equal(value.worst, 25);
});

test("an overhang is the only thing at risk", () => {
  const value = positionValue({ a: 25, b: 10 });
  assert.equal(value.net, 15);
  assert.equal(value.worst, 10, "the matched part is never at risk");
  assert.equal(value.best, 25);
  assert.equal(value.ifDraw, 17.5, "a void pays half on every share, both sides");
});

/* ------------------------------------------------------ the whole envelope */

test("no configuration of a live book produces an unfillable plan", () => {
  const wild: MakerConfig = { ...config, spread: 1, step: 1, levels: 5, size: 3, budget: 5, stock: 4 };
  for (let fair = 1; fair <= 99; fair += 1) {
    for (const net of [-500, -75, -3, 0, 3, 75, 500]) {
      const plan = planQuotes({
        fair,
        inventory: { a: Math.max(0, net), b: Math.max(0, -net) },
        resting: [],
        cash: 12,
        config: wild,
      });
      for (const quote of plan.place) {
        assert.ok(quote.price >= 1 && quote.price <= 99);
        assert.ok(quote.shares >= 1 && Number.isInteger(quote.shares));
      }
      const bidA = plan.place.filter((q) => q.side === SIDE_A && q.isBuy).map((q) => q.price);
      const bidB = plan.place.filter((q) => q.side === SIDE_B && q.isBuy).map((q) => q.price);
      if (bidA.length && bidB.length) {
        assert.ok(Math.max(...bidA) + Math.max(...bidB) < 100, `${fair}/${net} crosses`);
      }
    }
  }
});
