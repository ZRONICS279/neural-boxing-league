"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openingOdds } from "./opening-line.ts";
import type { Fighter } from "./fight-model.ts";
import {
  type BookLevel,
  type CardFeed,
  type CardOdds,
  type MarketFeed,
  type MarketQuote,
  type OpenOrder,
  type PricePoint,
  type Trade,
  SELECTORS,
  SIDE_BLUE,
  SIDE_RED,
  SIZE_STEP,
  approveCalldata,
  cancelCalldata,
  encodeCall,
  ensureChain,
  estimateGas,
  explainError,
  faucetCalldata,
  formatUnits,
  getWallet,
  payoutMultiple,
  readOpenOrders,
  redeemCalldata,
  requestAccount,
  ORDER_FAK,
  ORDER_GTC,
  sellCalldata,
  sendTransaction,
  subscribeAccount,
  subscribeWallets,
  buyCalldata,
  waitForReceipt,
  walkBook,
  walletCall,
  withdrawCalldata,
} from "./market.ts";

/** The book, under the fight it is a book on.
 *
 * Everything public here — odds, depth, the trades the bout has printed — comes
 * from `/api/market`, which is one cached read for however many people are
 * watching. Everything private goes straight from the browser to the wallet's
 * own node, so an address and a position are never something the league is in a
 * position to log.
 *
 * The panel is a `<details>` and it is closed by default. The fight is the
 * page; a trading screen that shoulders its way in front of the ring on load
 * would be the tail wagging the dog. */

/** Refetch cadence while the panel is open. The worker caches for four
 *  seconds, so anything faster than this is asking the same question twice. */
const POLL_MS = 6_000;
/** The card rail's own beat. Slower than the open panel's: a row is a number
 *  somebody glances at, not a screen they are trading off. */
const CARD_POLL_MS = 15_000;
/** How much play money one tap of the faucet is worth, in whole collateral.
 *  Enough to take a real position on several fights and lose them all, which
 *  is the point of a testnet; small enough that nobody's balance turns the
 *  numbers on screen into scientific notation. */
const FAUCET_AMOUNT = 1_000n;
/** How far back each range button looks. */
const RANGES = [
  { id: "1h", label: "1H", ms: 60 * 60_000 },
  { id: "6h", label: "6H", ms: 6 * 60 * 60_000 },
  { id: "all", label: "ALL", ms: Infinity },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
/** Price levels shown on each half of the ladder. Deeper than this is not a
 *  price anybody is trading against — it is the tail of a seeded book. */
const DEPTH_ROWS = 7;
/** Stakes the amount field offers outright, in whole collateral. */
const QUICK_STAKES = [5, 25, 100];
/** Cents of slippage a market order will tolerate.
 *
 * The book fills a taker at what is actually resting and refunds the rest, so
 * this is a ceiling and never a cost: an order sent at 58 into a book still
 * offering 56 pays 56. What it buys is the order surviving the seconds between
 * reading the price and the wallet signing for it — sent on the nose, a market
 * order is a bet that nobody traded in between. Three cents is roughly a rung
 * and a half of the league's own ladder. */
const SLIPPAGE = 3;

/* -------------------------------------------------------------- the feed */

/** One fight's book, polled while somebody is looking at it.
 *
 * Shared by the board and by the between-fights preview, so the two never
 * disagree about a price and never poll the same fight twice over. */
export function useMarketFeed(
  night: number,
  blueId: string,
  redId: string,
  active: boolean,
  onFeed?: (feed: MarketFeed | null) => void,
  /** A fight that is over, on a card that is over. The worker scans further
   *  back for it and believes the answer for far longer, and the panel asking
   *  has no reason to keep asking — a settled book only moves when the wallet
   *  looking at it moves it. */
  settled = false,
) {
  const [feed, setFeed] = useState<MarketFeed | null>(null);
  /** Bumped after anything that changes the chain, to re-poll at once instead
   *  of waiting out the interval behind a confirmed trade. */
  const [refresh, setRefresh] = useState(0);
  const bump = useCallback(() => setRefresh((count) => count + 1), []);

  useEffect(() => {
    if (!active) return;
    let mounted = true;

    const poll = async () => {
      const params = new URLSearchParams({ night: String(night), blue: blueId, red: redId });
      if (settled) params.set("settled", "1");
      try {
        const response = await fetch(`/api/market?${params}`, { cache: "no-store" });
        const payload = (await response.json()) as MarketFeed;
        if (mounted) { setFeed(payload); onFeed?.(payload); }
      } catch {
        const failed = { ok: false, error: "The market is unreachable." } as const;
        if (mounted) { setFeed(failed); onFeed?.(failed); }
      }
    };

    void poll();
    // A settled book is read once and then only after this wallet has changed
    // it, which `refresh` covers. Polling it would be asking a question whose
    // answer is a fact.
    if (settled) return () => { mounted = false; };
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
    // `onFeed` is deliberately not a dependency: a parent that passes a fresh
    // closure each render would otherwise restart the poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, night, blueId, redId, refresh, settled]);

  const booked = feed?.ok && feed.booked ? feed : null;
  return { feed, booked, quote: booked?.quote ?? null, refresh, bump };
}

/* ------------------------------------------------------------------- chart */

/** The price line, drawn the way a prediction market draws it.
 *
 * Two curves that mirror each other about the middle, because they must: the
 * two shares of a bout are funded out of one collateral unit, so blue at 74
 * *is* red at 26. Drawing both is redundant and it is also the point — it is
 * how a glance tells you which way the money is leaning.
 *
 * The SVG carries the lines and nothing else. It is stretched to the plot box
 * with `preserveAspectRatio="none"`, which would distort any text or circle
 * inside it, so the end-of-line markers and the labels are HTML sitting on top
 * at the same percentage. */
function MarketChart({
  history,
  blue,
  red,
  blueOdds,
  redOdds,
  volume,
  symbol,
  note,
}: {
  history: PricePoint[];
  blue: Fighter;
  red: Fighter;
  blueOdds: number;
  redOdds: number;
  volume: number;
  symbol: string;
  /** Replaces the volume line when the number beside it is not a traded price
   *  — an unquoted book, or a fight that has already been scored. */
  note: string | null;
}) {
  const [range, setRange] = useState<RangeId>("all");

  // Measured back from the last print rather than from the reader's clock. A
  // bout's book is only live for the hours before its bell, so "the last hour"
  // has to mean the last hour of trading — anchoring it to now would empty the
  // chart the moment the fight starts, which is exactly when people look at it.
  const samples = useMemo(() => {
    const span = RANGES.find((entry) => entry.id === range)?.ms ?? Infinity;
    const latest = history[history.length - 1]?.at ?? 0;
    const inRange = history.filter((point) => point.at >= latest - span);
    // A range with one print in it is not a line. Fall back to everything
    // rather than drawing a dot and calling it a chart.
    return inRange.length >= 2 ? inRange : history;
  }, [history, range]);

  // The mid is where the market is *now*, which is not necessarily where the
  // last trade printed — so the line is walked out to it. That is the join
  // between the chart and the number beside it.
  const points = useMemo(() => {
    const values = samples.map((point) => point.blue);
    values.push(blueOdds);
    if (values.length === 1) values.push(blueOdds);
    const step = 100 / (values.length - 1);
    return values.map((value, index) => `${(index * step).toFixed(2)},${(100 - value).toFixed(2)}`).join(" ");
  }, [samples, blueOdds]);

  const mirrored = useMemo(() => {
    const values = samples.map((point) => 100 - point.blue);
    values.push(100 - blueOdds);
    if (values.length === 1) values.push(100 - blueOdds);
    const step = 100 / (values.length - 1);
    return values.map((value, index) => `${(index * step).toFixed(2)},${(100 - value).toFixed(2)}`).join(" ");
  }, [samples, blueOdds]);

  const first = samples[0]?.at ?? 0;
  const last = samples[samples.length - 1]?.at ?? 0;

  return (
    <div className="market-chart">
      <div className="market-chart__plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline className="market-chart__line market-chart__line--blue" points={points} />
          <polyline className="market-chart__line market-chart__line--red" points={mirrored} />
        </svg>
        {[0, 25, 50, 75, 100].map((mark) => (
          <span key={mark} className="market-chart__grid" style={{ top: `${100 - mark}%` }}>
            <i>{mark}%</i>
          </span>
        ))}
        <b className="market-chart__tag market-chart__tag--blue" style={{ top: `${100 - blueOdds}%` }}>
          <em />
          <span>{blue.lastName}</span>
          <strong>{Math.round(blueOdds)}%</strong>
        </b>
        <b className="market-chart__tag market-chart__tag--red" style={{ top: `${100 - redOdds}%` }}>
          <em />
          <span>{red.lastName}</span>
          <strong>{Math.round(redOdds)}%</strong>
        </b>
      </div>
      <footer className="market-chart__foot">
        <span>
          {note ?? (history.length === 0
            ? "No trades yet"
            : `${formatUnits(volume)} ${symbol} vol`)}
        </span>
        {first > 0 && last > first ? (
          <time>
            {new Date(first).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            {" → "}
            {new Date(last).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
        ) : null}
        <div className="market-chart__ranges">
          {RANGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={range === entry.id ? "is-active" : ""}
              onClick={() => setRange(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------- the book */

/** Levels with the depth behind them, nearest the spread first. */
function cumulative(levels: BookLevel[]) {
  let running = 0;
  return levels.slice(0, DEPTH_ROWS).map((level) => {
    running += level.shares;
    return { ...level, depth: running };
  });
}

/** One corner's ladder: what is offered above the mid, what is bid below it.
 *
 * Rows are buttons. A price on a ladder is the one number in the whole ticket
 * somebody means to copy exactly, and making them retype it is how a limit ends
 * up a cent the wrong side of the fill it was aiming at — so a click puts the
 * ticket on that corner at that price. */
function BookSide({
  fighter,
  tone,
  side,
  bids,
  asks,
  mid,
  onPick,
}: {
  fighter: Fighter;
  tone: "blue" | "red";
  side: 0 | 1;
  bids: BookLevel[];
  asks: BookLevel[];
  mid: number;
  onPick: (side: 0 | 1, price: number) => void;
}) {
  const offers = cumulative(asks);
  const takes = cumulative(bids);
  const most = Math.max(1, ...offers.map((level) => level.depth), ...takes.map((level) => level.depth));

  const row = (level: { price: number; shares: number; depth: number }, kind: "ask" | "bid") => (
    <button
      key={`${kind}-${level.price}`}
      type="button"
      className={`market-book__row market-book__row--${kind}`}
      onClick={() => onPick(side, level.price)}
      title={`${formatUnits(level.depth)} shares within ${level.price}¢`}
    >
      <i style={{ width: `${(level.depth / most) * 100}%` }} aria-hidden="true" />
      <span>{level.price}¢</span>
      <b>{formatUnits(level.shares)}</b>
      <em>{formatUnits(level.depth)}</em>
    </button>
  );

  return (
    <div className={`market-book__col market-book__col--${tone}`}>
      <strong className="market-book__corner">{fighter.lastName}</strong>
      <header className="market-book__head">
        <span>Price</span>
        <span>Shares</span>
        <span>Depth</span>
      </header>

      <span className="market-book__label market-book__label--ask">Asks</span>
      <div className="market-book__side">
        {offers.length > 0
          // High to low, so the best offer sits against the mid.
          ? [...offers].reverse().map((level) => row(level, "ask"))
          : <p className="market-book__empty">No ask orders</p>}
      </div>

      <div className="market-book__mid">{Math.round(mid)}¢</div>

      <span className="market-book__label market-book__label--bid">Bids</span>
      <div className="market-book__side">
        {takes.length > 0
          ? takes.map((level) => row(level, "bid"))
          : <p className="market-book__empty">No bid orders</p>}
      </div>
    </div>
  );
}

/** Both corners of the book, side by side.
 *
 * They are one market written down twice — every bid on red is already folded
 * into blue's offers before this sees it — and showing both is the point: the
 * pair is how you read which way the depth is stacked without doing the
 * hundred-minus in your head. */
function OrderBook({
  quote,
  blue,
  red,
  onPick,
}: {
  quote: MarketQuote;
  blue: Fighter;
  red: Fighter;
  onPick: (side: 0 | 1, price: number) => void;
}) {
  return (
    <section className="market-book" aria-label="Order book">
      <header className="market-book__title">
        <span className="eyebrow">Order book</span>
        <small>
          {quote.bestBidBlue > 0 && quote.bestAskBlue > 0
            ? `${quote.bestAskBlue - quote.bestBidBlue}¢ spread`
            : "One-sided book"}
        </small>
      </header>
      <div className="market-book__pair">
        <BookSide
          fighter={blue}
          tone="blue"
          side={SIDE_BLUE}
          bids={quote.bidsBlue}
          asks={quote.asksBlue}
          mid={quote.blue}
          onPick={onPick}
        />
        <BookSide
          fighter={red}
          tone="red"
          side={SIDE_RED}
          bids={quote.bidsRed}
          asks={quote.asksRed}
          mid={quote.red}
          onPick={onPick}
        />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- the tape */

/** Every fill the bout has printed, newest first.
 *
 * Kept on the corner it happened on rather than folded onto blue like the
 * chart line: "bought Salvatore at 40¢" is what somebody did, and the same
 * trade rewritten as blue at 60¢ is true about the price and wrong about the
 * trade. */
function RecentFills({ trades, blue, red }: { trades: Trade[]; blue: Fighter; red: Fighter }) {
  return (
    <section className="market-tape" aria-label="Recent fills">
      <header className="market-book__title">
        <span className="eyebrow">Recent fills</span>
        <small>{trades.length ? `last ${trades.length}` : ""}</small>
      </header>
      {trades.length === 0 ? (
        <p className="market-book__empty">No fills yet</p>
      ) : (
        <>
          <header className="market-tape__head">
            <span>Time</span>
            <span>Side</span>
            <span>Shares</span>
            <span>Price</span>
          </header>
          <ol>
            {trades.map((trade, index) => (
              <li
                key={`${trade.at}-${index}`}
                className={`market-tape__row market-tape__row--${trade.takerBought ? "buy" : "sell"}`}
              >
                <time>
                  {trade.at > 0
                    ? new Date(trade.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                    : "—"}
                </time>
                <span className={`market-tape__side market-tape__side--${trade.blueSide ? "blue" : "red"}`}>
                  {trade.takerBought ? "Bought" : "Sold"}{" "}
                  {trade.blueSide ? blue.lastName : red.lastName}
                </span>
                <b>{formatUnits(trade.shares)}</b>
                <strong>{trade.price}¢</strong>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------- what you're on */

/** The wallet's own side of this fight, under the chart.
 *
 * What it holds, what that is worth at the line right now, what it pays if the
 * man wins — and what is still sitting on the book unfilled, with a way to pull
 * it back. There is no cost basis here on purpose: working one out means
 * replaying every fill this address was ever part of, and a "profit" figure
 * quoted off a basis the page guessed at is worse than no figure at all. What
 * is shown instead is the honest version — the gain from here if it lands. */
function YourTrades({
  account,
  address,
  unreadable,
  orders,
  quote,
  blue,
  red,
  unit,
  symbol,
  busy,
  onCancel,
  onClaim,
}: {
  account: Account | null;
  address: string | null;
  unreadable: boolean;
  orders: OpenOrder[];
  quote: MarketQuote;
  blue: Fighter;
  red: Fighter;
  unit: bigint;
  symbol: string;
  busy: string | null;
  onCancel: (order: OpenOrder) => void;
  onClaim: () => void;
}) {
  const whole = (amount: bigint) => Number(amount) / Number(unit);
  const corners = ([
    { fighter: blue, shares: account?.blueShares ?? 0n, price: quote.blue, tone: "blue" },
    { fighter: red, shares: account?.redShares ?? 0n, price: quote.red, tone: "red" },
  ] as const).filter((corner) => corner.shares > 0n);

  // Every settled market gets a claim, whether or not this wallet is owed
  // anything on it. A resolved fight with the button quietly missing reads as
  // "there is nothing here" when what it means is "you did not win this one" —
  // and the two look identical from the outside.
  const settled = quote.resolved;
  const owed = account?.claimable ?? 0n;

  return (
    <section className="market-mine" aria-label="Your position on this fight">
      <header className="market-book__title">
        <span className="eyebrow">Your trades</span>
        <small>
          {account
            ? `${corners.length} position${corners.length === 1 ? "" : "s"}${orders.length ? ` · ${orders.length} resting` : ""}`
            : ""}
        </small>
      </header>

      {!account ? (
        <p className="market-book__empty">
          {address
            ? unreadable ? "Position unavailable. Retry the position read above." : "Reading your position…"
            : "Connect a wallet to see your side of this fight"}
        </p>
      ) : corners.length === 0 && orders.length === 0 ? (
        <p className="market-book__empty">Nothing riding on this one yet</p>
      ) : (
        <div className="market-mine__rows">
          {corners.map(({ fighter, shares, price, tone }) => {
            const worth = (shares * BigInt(Math.round(price))) / 100n;
            return (
              <article key={tone} className={`market-mine__row market-mine__row--${tone}`}>
                <div className="market-mine__head">
                  <strong>{formatUnits(whole(shares))} {fighter.lastName}</strong>
                  <em>{Math.round(price)}¢ now</em>
                </div>
                <dl>
                  <div>
                    <dt>Worth now</dt>
                    <dd>{formatUnits(whole(worth))} {symbol}</dd>
                  </div>
                  <div>
                    <dt>Pays if {fighter.lastName} wins</dt>
                    <dd>{formatUnits(whole(shares))} {symbol}</dd>
                  </div>
                  <div>
                    <dt>Gain from here</dt>
                    <dd className="is-good">+{formatUnits(whole(shares - worth))} {symbol}</dd>
                  </div>
                </dl>
              </article>
            );
          })}

          {orders.length > 0 ? (
            <div className="market-mine__resting">
              <span className="market-book__label">Still on the book</span>
              <ul>
                {orders.map((order) => (
                  <li key={order.id}>
                    <span className={order.side === SIDE_BLUE ? "is-blue" : "is-red"}>
                      {order.isBuy ? "Buy" : "Sell"}{" "}
                      {order.side === SIDE_BLUE ? blue.lastName : red.lastName}
                    </span>
                    <b>{formatUnits(whole(order.shares))} at {order.price}¢</b>
                    <button type="button" disabled={busy !== null} onClick={() => onCancel(order)}>
                      {busy === "Cancel" ? "Cancelling…" : "Cancel"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {settled && account ? (
        <button
          type="button"
          className={owed > 0n ? "button button--amber button--full" : "button button--full"}
          disabled={busy !== null || owed === 0n}
          onClick={onClaim}
        >
          {busy === "Claim"
            ? "Claiming…"
            : owed > 0n
              ? `Claim ${formatUnits(whole(owed))} ${symbol}`
              : "Nothing to claim on this fight"}
        </button>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------ the ticket */

interface Account {
  address: string;
  balance: bigint;
  allowance: bigint;
  blueShares: bigint;
  redShares: bigint;
  /** Shares behind a resting sell order. Still owned, and `redeem` pulls them
   *  back before it settles — so a position read that ignores them tells
   *  somebody with an unfilled offer on the book that they held nothing. */
  blueEscrow: bigint;
  redEscrow: bigint;
  claimable: bigint;
  pending: bigint;
}

/** The chain first, then the wallet.
 *
 * Asking for an estimate before asking for a signature buys two things. The
 * revert reason is one: a transaction that cannot succeed comes back as "the
 * book is closed", in time to put on screen instead of in front of a
 * signature. The gas limit is the other — a wallet that cannot estimate does
 * not stop, it falls back to the block gas limit, and this chain's is 2^50. At
 * the going rate that prints a five-figure network fee under a red warning
 * over a transaction whose real cost is a fraction of a cent. The pad covers
 * the drift between the estimate and the state the transaction lands in. */
async function submit(
  booked: { chainId: number; rpcUrl: string; explorer: string },
  from: string,
  to: string,
  data: string,
) {
  await ensureChain(booked.chainId, booked.rpcUrl, booked.explorer);
  const gas = await estimateGas(from, to, data);
  return waitForReceipt(await sendTransaction(from, to, data, (gas * 5n) / 4n));
}

/** What the connected wallet holds against this bout.
 *
 * Read through the wallet's own provider rather than through the league, which
 * is why it is a separate call from the quote and not part of the feed. */
async function readAccount(
  address: string,
  clob: string,
  reader: string,
  collateral: string,
  boutId: number,
): Promise<Account> {
  const [balance, allowance, position, pending] = await Promise.all([
    walletCall(collateral, encodeCall(SELECTORS.balanceOf, [address])),
    walletCall(collateral, encodeCall(SELECTORS.allowance, [address, clob])),
    walletCall(reader, encodeCall(SELECTORS.getPosition, [boutId, address])),
    walletCall(clob, encodeCall(SELECTORS.pendingWithdrawal, [address])),
  ]);
  // PositionView: boutId, sharesA, sharesB, escrowA, escrowB, claimable
  return {
    address,
    balance: balance[0] ?? 0n,
    allowance: allowance[0] ?? 0n,
    blueShares: position[1] ?? 0n,
    redShares: position[2] ?? 0n,
    blueEscrow: position[3] ?? 0n,
    redEscrow: position[4] ?? 0n,
    claimable: position[5] ?? 0n,
    pending: pending[0] ?? 0n,
  };
}

/** The market for one fight: chart, book, tape, ticket, position.
 *
 * Rendered inline under the live bout and inside the popup that the card rail
 * opens for a fight that has not started yet. Both want the same thing, and a
 * second copy of the order-entry maths is the kind of duplication that ends
 * with two screens quoting different prices for the same trade. */
function MarketBoard({
  night,
  blue,
  red,
  active,
  opensOn = SIDE_BLUE,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  /** False when nothing is looking at it: the board stays mounted, stops
   *  polling, and stops costing the chain anything. */
  active: boolean;
  /** Which corner the ticket starts on. Clicking a fighter's odds on the card
   *  rail should land on that fighter — but only as a starting point, since
   *  the other side is one tap away and often the trade somebody meant. */
  opensOn?: 0 | 1;
}) {
  const { feed, booked, quote, refresh, bump } = useMarketFeed(night, blue.id, red.id, active);
  const [account, setAccount] = useState<Account | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  /** This wallet's resting orders on this bout, so they can be pulled back
   *  from the same screen they were placed on. */
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [side, setSide] = useState<0 | 1>(opensOn);
  const [action, setAction] = useState<"buy" | "sell">("buy");
  /** Market takes whatever the book is showing; limit is a price somebody
   *  typed. Two states rather than one empty field that silently means "best
   *  available", which read as an unfilled input people felt obliged to fill. */
  const [pricing, setPricing] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("25");
  const [limit, setLimit] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [faucet, setFaucet] = useState<string | null>(null);

  /** The league's own read of the fight, for a book that has not spoken yet.
   *
   * A bout nobody has quoted has no price, and answering "50/50" to a fight
   * that is plainly not even is worse than answering nothing — it is a wrong
   * number wearing the same clothes as a right one. The operator seeds this
   * same line onto the book within seconds of a card being announced, so the
   * two agree; this is what fills the gap in between, and what shows if seeding
   * is turned off entirely. */
  const line = useMemo(() => openingOdds(blue, red), [blue, red]);

  /* ----------------------------------------------------------- the wallet */

  const clob = booked?.clob;
  const reader = booked?.reader;
  const collateral = booked?.collateral;
  const boutId = quote?.boutId;

  useEffect(() => subscribeAccount((account) => {
    setAddress(account);
    setAccount(null);
    setUnreadable(false);
    setOrders([]);
    bump();
  }), [bump]);

  useEffect(() => {
    if (!active) return;
    let mounted = true;

    const read = async () => {
      const account = address;
      if (!mounted) return;
      setUnreadable(false);
      if (!account) {
        // The first render still has a null address when the subscription
        // above restores it. Clear holdings without overwriting that account.
        setAccount(null);
        return;
      }
      if (!clob || !reader || !collateral || boutId === undefined) return;
      try {
        const [next, resting] = await Promise.all([
          readAccount(account, clob, reader, collateral, boutId),
          readOpenOrders(reader, clob, account),
        ]);
        if (!mounted) return;
        setAccount(next);
        // The reader answers for every bout at once; this screen is one fight.
        setOrders(resting.filter((order) => order.boutId === boutId));
      } catch {
        // A wallet on the wrong chain answers eth_call with nonsense rather
        // than an error. Dropping the numbers beats showing wrong ones.
        if (mounted) { setAccount(null); setOrders([]); setUnreadable(true); }
      }
    };

    void read();
    return () => { mounted = false; };
  }, [active, address, clob, reader, collateral, boutId, refresh]);

  // A wallet switching accounts under the panel has to move the position with
  // it, or somebody reads somebody else's shares as their own. A wallet
  // switching chains has to re-read for the opposite reason: the numbers it
  // was refusing to answer on the wrong chain are readable now, and a position
  // that stays blank is one the ticket has to treat as unknown.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const unsubscribe = subscribeWallets(() => {
      cleanup?.();
      const wallet = getWallet();
      wallet?.on?.("chainChanged", bump);
      cleanup = () => wallet?.removeListener?.("chainChanged", bump);
    });
    return () => {
      unsubscribe();
      cleanup?.();
    };
  }, [bump]);

  const connect = async () => {
    if (!booked) return;
    setError(null);
    try {
      await requestAccount();
      await ensureChain(booked.chainId, booked.rpcUrl, booked.explorer);
    } catch (caught) {
      setError(explainError(caught));
    }
  };

  /* ------------------------------------------------------------ the maths */

  const unit = booked ? 10n ** BigInt(booked.collateralDecimals) : 10n ** 6n;
  const symbol = booked?.collateralSymbol ?? "tUSD";

  // Whether this chain's collateral will hand itself out, and how. Probed
  // against the connected account rather than assumed from the chain id, so
  // the button cannot appear over a token that would only revert on it.
  useEffect(() => {
    if (!active || !address || !collateral) return;
    let mounted = true;
    void faucetCalldata(collateral, address, FAUCET_AMOUNT * unit).then((data) => {
      if (mounted) setFaucet(data);
    });
    return () => { mounted = false; };
    // Re-probed after every write: `TestUSD` rate-limits its drip, and a
    // button that stays lit through the cooldown only fails on the click.
  }, [active, address, collateral, unit, refresh]);

  /** The price this ticket goes in at.
   *
   * On market it takes the other side of the book — the price you would
   * actually get right now — and falls back to the mid on a bout where nothing
   * is resting yet, which is every bout for its first few minutes. */
  const restingPrice = quote
    ? action === "buy"
      ? (side === SIDE_BLUE ? quote.bestAskBlue : quote.bestAskRed)
      : (side === SIDE_BLUE ? quote.bestBidBlue : quote.bestBidRed)
    : 0;
  const marketPrice = quote && quote.quoted
    ? (side === SIDE_BLUE ? quote.blue : quote.red)
    : (side === SIDE_BLUE ? line.blue : line.red);
  const bestPrice = restingPrice || Math.round(marketPrice);
  const price = Math.max(1, Math.min(99,
    pricing === "limit" ? Number(limit) || bestPrice : bestPrice,
  ));

  /** What the order is actually sent as, which is not always what it is priced
   *  at on screen.
   *
   * A market order names a *worst acceptable* price, not an exact one. The book
   * fills it at whatever is really resting and charges the difference back — so
   * padding the limit a few cents costs nothing when the price has not moved
   * and is the whole reason the order still fills when it has. Sent exactly on
   * the nose, a market order is a bet that nothing trades between the read and
   * the signature.
   *
   * And it goes as fill-and-kill, never GTC. An unfilled market order should be
   * nothing at all; as GTC it silently becomes a resting limit order at a price
   * the buyer never chose, and they walk away believing they have a position. */
  const orderType = pricing === "market" ? ORDER_FAK : ORDER_GTC;
  const sendPrice = pricing === "limit"
    ? price
    : Math.max(1, Math.min(99, price + (action === "buy" ? SLIPPAGE : -SLIPPAGE)));

  /** Take a price off the ladder. Moves the corner too: a click on red's book
   *  means red, and leaving the ticket on blue would price the trade off the
   *  wrong side of the fight. */
  const pickPrice = (corner: 0 | 1, cents: number) => {
    setSide(corner);
    setPricing("limit");
    setLimit(String(Math.max(1, Math.min(99, Math.round(cents)))));
  };

  const ladder: BookLevel[] = quote
    ? action === "buy"
      ? (side === SIDE_BLUE ? quote.asksBlue : quote.asksRed)
      : (side === SIDE_BLUE ? quote.bidsBlue : quote.bidsRed)
    : [];

  const held = account ? (side === SIDE_BLUE ? account.blueShares : account.redShares) : 0n;

  /** Shares, in base units, rounded down to something the contract accepts. */
  const shares = useMemo(() => {
    if (action === "sell") {
      const wanted = BigInt(Math.floor((Number(amount) || 0) * Number(unit)));
      const capped = wanted > held ? held : wanted;
      return capped - (capped % SIZE_STEP);
    }
    const spend = BigInt(Math.floor((Number(amount) || 0) * Number(unit)));
    const raw = (spend * 100n) / BigInt(price);
    return raw - (raw % SIZE_STEP);
  }, [action, amount, unit, price, held]);

  const cost = (shares * BigInt(price)) / 100n;
  /** The most this can cost, which is the price actually sent, not the one on
   *  screen. A padded market limit that the approval does not cover is an order
   *  that reverts on the transfer for the one reason the padding exists. */
  const worstCost = (shares * BigInt(sendPrice)) / 100n;
  /** What the wallet actually has to be good for.
   *
   * The book charges the taker fee on whatever fills — `spend` in the contract
   * is `fillValue + fee` — and charges nothing on the part that rests. Which
   * of the two an order is depends on the book at the moment it lands, so the
   * approval has to cover the worse case: all of it filling. Approving the
   * bare cost is why a marketable buy reverted on the transfer while the same
   * size resting on the book went through. */
  const feeBps = BigInt(booked?.takerFeeBps ?? 0);
  const fee = (worstCost * feeBps + 9_999n) / 10_000n;
  const maxSpend = worstCost + fee;
  const toWin = Number(shares) / Number(unit);
  const needsApproval =
    action === "buy" && account !== null && account.allowance < maxSpend;
  const walked = walkBook(ladder, toWin);

  /* ----------------------------------------------------------- the writes */

  const run = async (label: string, to: string, data: string) => {
    if (!address || !booked) return;
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await submit(booked, address, to, data);
      setNote(`${label} confirmed.`);
      // Both polls re-run off this rather than waiting out their interval, so
      // the book and the position catch up with a confirmed trade at once.
      bump();
    } catch (caught) {
      setError(explainError(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Read the position again, on the book's own chain.
   *
   * Null means the wallet would not answer, which is a reason not to trade
   * rather than a zero. */
  const readPosition = async () => {
    if (!address || !booked || !clob || !reader || !collateral || boutId === undefined) return null;
    try {
      await ensureChain(booked.chainId, booked.rpcUrl, booked.explorer);
      const next = await readAccount(address, clob, reader, collateral, boutId);
      setAccount(next);
      setUnreadable(false);
      return next;
    } catch (caught) {
      setError(explainError(caught));
      setUnreadable(true);
      return null;
    }
  };

  /** Fire the ticket.
   *
   * `account` carries the allowance and it is read through the wallet, so it
   * is null whenever that read failed — a wallet still sitting on another
   * chain when it was last asked, most often, which is what connecting from
   * the header rather than from here leaves behind. Buying on an unknown
   * allowance sends a transaction that can only revert, and a wallet that
   * cannot estimate a revert falls back to the block gas limit: on an Orbit
   * chain that prints a five-figure fee under a red warning. So read it again
   * first, on the right chain, and take the approval branch if it is short. */
  const place = async () => {
    if (!booked || !quote || shares === 0n) return;
    let holding = account;
    if (action === "buy" && holding === null) {
      setError(null);
      setBusy("Order");
      holding = await readPosition();
      setBusy(null);
      if (!holding) return;
    }
    if (action === "buy" && holding !== null && holding.allowance < maxSpend) {
      // Approve exactly what this ticket needs, fee included. An unlimited
      // approval is one fewer click and a standing permission over every token
      // the wallet will ever hold; this is a testnet book, not a reason for
      // that trade.
      void run("Approval", booked.collateral, approveCalldata(booked.clob, maxSpend));
      return;
    }
    const data = action === "buy"
      ? buyCalldata(quote.boutId, side, sendPrice, shares, orderType)
      : sellCalldata(quote.boutId, side, sendPrice, shares, orderType);
    void run(action === "buy" ? "Order" : "Sale", booked.clob, data);
  };

  /* -------------------------------------------------------------- render */

  const blueOdds = quote && quote.quoted ? quote.blue : line.blue;
  const redOdds = 100 - blueOdds;
  const tradingOpen = Boolean(quote && !quote.closed && !quote.resolved);
  const winner = quote?.outcome === "blue" ? blue : quote?.outcome === "red" ? red : null;
  const holder = side === SIDE_BLUE ? blue : red;

  if (feed && feed.ok === false) {
    return <p className="market-panel__empty">{feed.error}</p>;
  }
  if (feed && feed.ok && !feed.booked) {
    return (
      <p className="market-panel__empty">
        {feed.reason === "unconfigured"
          ? "No market is wired up to this league yet."
          : "Nobody has put a book up against this fight."}
      </p>
    );
  }
  if (!booked || !quote) {
    return <p className="market-panel__empty">Reading the book…</p>;
  }

  return (
    <div className="market-panel__body">
      <div className="market-board__main">
        <MarketChart
          history={quote.history}
          blue={blue}
          red={red}
          blueOdds={blueOdds}
          redOdds={redOdds}
          volume={quote.volume}
          symbol={symbol}
          note={
            quote.resolved
              ? winner
                ? `Settled · ${winner.lastName}`
                : "Settled · draw, every share pays half"
              : quote.quoted
                ? null
                : "The league's opening line · nothing has traded"
          }
        />
      </div>

      <div className="market-board__side">
        <form
          className="market-ticket"
          onSubmit={(event) => {
            event.preventDefault();
            void place();
          }}
        >
          <div className="market-ticket__sides">
            {([SIDE_BLUE, SIDE_RED] as const).map((corner) => {
              const fighter = corner === SIDE_BLUE ? blue : red;
              const odds = corner === SIDE_BLUE ? blueOdds : redOdds;
              return (
                <button
                  key={corner}
                  type="button"
                  className={`market-side market-side--${corner === SIDE_BLUE ? "blue" : "red"}${side === corner ? " is-active" : ""}`}
                  onClick={() => { setSide(corner); setPricing("market"); setLimit(""); }}
                  aria-pressed={side === corner}
                >
                  <span>{fighter.lastName}</span>
                  <strong>{Math.round(odds)}¢</strong>
                  {/* The same number read the way a punter reads it. One
                      winning share pays one usdc, so 60¢ is 1.67 back. */}
                  <em>{payoutMultiple(odds).toFixed(2)}x</em>
                </button>
              );
            })}
          </div>

          {/* Which way you are going on the left, how you are pricing it on the
              right. One row, because they are the two halves of the same
              sentence and stacking them made the ticket read like a form. */}
          <div className="market-ticket__mode">
            <div className="market-ticket__tabs" role="tablist">
              {(["buy", "sell"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={action === mode}
                  className={action === mode ? "is-active" : ""}
                  onClick={() => {
                    setAction(mode);
                    setAmount(mode === "buy" ? "25" : "0");
                    setPricing("market");
                    setLimit("");
                  }}
                >
                  {mode === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>
            <div className="market-pricing__modes" role="tablist" aria-label="Order price">
              {([
                ["market", bestPrice ? `Market ${bestPrice}¢` : "Market"],
                ["limit", "Limit"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={pricing === mode}
                  className={pricing === mode ? "is-active" : ""}
                  onClick={() => {
                    setPricing(mode);
                    if (mode === "limit" && !limit) setLimit(String(bestPrice));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="market-field market-field--amount">
            <span>{action === "buy" ? `Amount (${symbol})` : `${holder.lastName} shares`}</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
            />
          </label>

          {/* Additive, the way a betting slip works — you top up to a number
              rather than replacing one. Max is the one people get wrong by
              hand: "all of it" is a share count with two decimals on it, and
              typing it a digit short leaves a dusting behind. */}
          <div className="market-quick">
            {action === "buy"
              ? QUICK_STAKES.map((stake) => (
                  <button
                    key={stake}
                    type="button"
                    onClick={() => setAmount(String(Math.round(((Number(amount) || 0) + stake) * 100) / 100))}
                  >
                    +{stake}
                  </button>
                ))
              : null}
            <button
              type="button"
              disabled={action === "buy" ? !account : held === 0n}
              onClick={() =>
                setAmount(
                  action === "buy"
                    ? String(Number(account?.balance ?? 0n) / Number(unit))
                    : String(Number(held) / Number(unit)),
                )
              }
            >
              Max
            </button>
          </div>

          {pricing === "limit" ? (
            <label className="market-field">
              <span>Limit price (¢)</span>
              <input
                inputMode="numeric"
                placeholder={String(bestPrice)}
                value={limit}
                onChange={(event) => setLimit(event.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
          ) : null}

          <dl className="market-ticket__maths">
            <div>
              <dt>{action === "buy" ? "Shares" : "Proceeds"}</dt>
              <dd>
                {action === "buy"
                  ? formatUnits(toWin)
                  : `${formatUnits(Number(cost) / Number(unit))} ${symbol}`}
              </dd>
            </div>
            <div>
              <dt>{action === "buy" ? "Cost" : "Holding"}</dt>
              <dd>
                {action === "buy"
                  ? `${formatUnits(Number(cost) / Number(unit))} ${symbol}`
                  : formatUnits(Number(held) / Number(unit))}
              </dd>
            </div>
            {/* The number people are actually buying. One winning share pays
                one collateral unit, so this is the whole return, not a
                profit — and it is exact, not a projection. */}
            <div>
              <dt>{action === "buy" ? "Pays if right" : "Best bid"}</dt>
              <dd>
                {action === "buy"
                  ? `${formatUnits(toWin)} ${symbol}`
                  : restingPrice ? `${restingPrice}¢` : "—"}
              </dd>
            </div>
          </dl>

          {/* Resting depth only reaches so far. Saying so before the click is
              the difference between a partial fill and a surprise. */}
          {tradingOpen && action === "buy" && toWin > 0 && walked.filled < toWin ? (
            <p className="market-ticket__hint">
              {walked.filled > 0
                ? `Only ${formatUnits(walked.filled)} shares are offered at ${price}¢ or better. The rest waits on the book until somebody takes it.`
                : `Nothing is offered at ${price}¢, so this order waits on the book.`}
            </p>
          ) : null}

          {/* The fee lands on whatever fills, so the cost above is the floor
              and this is the ceiling. A trader who approved the first number
              and then took an offer would be short by exactly this much. */}
          {tradingOpen && action === "buy" && fee > 0n ? (
            <p className="market-ticket__hint">
              A fill pays {Number(feeBps) / 100}% taker fee, up to{" "}
              {formatUnits(Number(fee) / Number(unit))} {symbol}, so{" "}
              {formatUnits(Number(maxSpend) / Number(unit))} {symbol} is approved.
            </p>
          ) : null}

          {address === null ? (
            <button type="button" className="button button--amber market-ticket__go" onClick={() => void connect()}>
              Connect wallet
            </button>
          ) : !tradingOpen ? (
            <p className="market-ticket__hint">
              {!quote.resolved
                ? "This book is not matching orders right now. The rest of the card is still trading."
                : winner
                  ? `Settled: ${winner.lastName}. Winning shares pay ${formatUnits(1)} ${symbol} each. Claim below.`
                  : "Settled a draw. Every share pays half a unit. Claim below."}
            </p>
          ) : (
            <button
              type="submit"
              className="button button--amber market-ticket__go"
              disabled={busy !== null || shares === 0n}
            >
              {busy
                ? `${busy}…`
                : needsApproval
                  ? `Approve ${formatUnits(Number(maxSpend) / Number(unit))} ${symbol}`
                  : action === "buy"
                    ? `Buy ${formatUnits(toWin)} ${holder.lastName} at ${price}¢`
                    : `Sell ${formatUnits(toWin)} at ${price}¢`}
            </button>
          )}

          {error ? <p className="market-ticket__error">{error}</p> : null}
          {note ? <p className="market-ticket__note">{note}</p> : null}
        </form>

        <div className="market-account">
          <div className="market-account__head">
            <span className="eyebrow">Your account</span>
            <strong>
              {address
                ? `${address.slice(0, 6)}…${address.slice(-4)}`
                : "Not connected"}
            </strong>
          </div>
          {account ? (
            <>
              <dl>
                <div><dt>{blue.lastName}</dt><dd>{formatUnits(Number(account.blueShares) / Number(unit))}</dd></div>
                <div><dt>{red.lastName}</dt><dd>{formatUnits(Number(account.redShares) / Number(unit))}</dd></div>
                <div><dt>Wallet</dt><dd>{formatUnits(Number(account.balance) / Number(unit))} {symbol}</dd></div>
                <div><dt>Claimable</dt><dd>{formatUnits(Number(account.claimable) / Number(unit))} {symbol}</dd></div>
              </dl>
              <div className="market-account__actions">
                {/* The claim lives under the chart with the position it pays
                    out on, not here — one button, where somebody looking at
                    what they hold will actually find it. */}
                {account.pending > 0n ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy !== null}
                    onClick={() => void run("Withdrawal", booked.clob, withdrawCalldata())}
                  >
                    Withdraw {formatUnits(Number(account.pending) / Number(unit))} {symbol}
                  </button>
                ) : null}
                {faucet ? (
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={busy !== null}
                    onClick={() => void run("Faucet", booked.collateral, faucet)}
                  >
                    Get {FAUCET_AMOUNT.toString()} test {symbol}
                  </button>
                ) : null}
              </div>
            </>
          ) : address ? (
            <>
              <p className="market-panel__empty">
                {unreadable
                  ? "Your wallet is connected, but its position could not be read. Retry to check the market's network."
                  : "Reading your position…"}
              </p>
              {unreadable ? (
                <button type="button" className="button" onClick={() => void readPosition()}>
                  Retry position
                </button>
              ) : null}
            </>
          ) : (
            <p className="market-panel__empty">
              Connect a wallet to see what you hold on this fight.
            </p>
          )}
          {booked.explorer ? (
            <a
              className="market-account__link"
              href={`${booked.explorer.replace(/\/$/, "")}/address/${booked.clob}`}
              target="_blank"
              rel="noreferrer"
            >
              Bout #{quote.boutId} on chain ↗
            </a>
          ) : null}
        </div>
      </div>

      {/* Below the chart, full width: what you are on, then the book that
          priced it and the fills that moved it. Reading order — your money,
          then the market's. */}
      <YourTrades
        account={account}
        address={address}
        unreadable={unreadable}
        orders={orders}
        quote={quote}
        blue={blue}
        red={red}
        unit={unit}
        symbol={symbol}
        busy={busy}
        onCancel={(order) => void run("Cancel", booked.clob, cancelCalldata(order.id))}
        onClaim={() => void run("Claim", booked.clob, redeemCalldata(quote.boutId))}
      />

      <div className="market-board__depth">
        <OrderBook quote={quote} blue={blue} red={red} onPick={pickPrice} />
        <RecentFills trades={quote.trades} blue={blue} red={red} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the board */

/** Live odds for every fight on a night, for the card rail to draw against.
 *
 * One request for the whole night rather than one per row. Eighteen rows each
 * polling for their own price would be eighteen fetches every few seconds
 * against a rate-limited public node, to render a number that came out of a
 * single contract call in the first place. */
export function useCardOdds(night: number, enabled: boolean) {
  const [board, setBoard] = useState<CardOdds[]>([]);

  useEffect(() => {
    if (!enabled || !night) return;
    let mounted = true;

    const poll = async () => {
      try {
        const response = await fetch(`/api/market?night=${night}`, { cache: "no-store" });
        const payload = (await response.json()) as CardFeed;
        if (mounted) setBoard(payload.ok && payload.booked ? payload.bouts : []);
      } catch {
        if (mounted) setBoard([]);
      }
    };

    void poll();
    const timer = window.setInterval(poll, CARD_POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [night, enabled]);

  return board;
}

/* ---------------------------------------------------------- the two shells */

/** The winnings, put in front of whoever won them.
 *
 * There is no market panel under the live fight any more and there should not
 * be: the in-play strip on the ring page is the live ticket. What the moment
 * after a fight is actually for is collecting — and a payout that can only be
 * found by opening a wallet menu is a payout people leave on the contract.
 *
 * Draws nothing at all unless this wallet is owed something on the fight that
 * just ended, which is the only state where it has anything to say. */
export function ClaimPrompt({
  night,
  blue,
  red,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [claimable, setClaimable] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Waved away. The money does not go anywhere — it is still on the fight's
   *  own popup and in the wallet menu — so this only has to be offered once. */
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLDialogElement | null>(null);
  /** Set once the answer for this bout is known and cannot change on its own.
   *
   * A fight is scored by the operator a moment after its final bell, so this
   * has to keep asking until the book agrees the bout is settled — and then
   * stop. Left polling it would hold a six-second beat open for the whole gap
   * between cards, which is hours, to re-read a number that is now a fact. */
  const [settledKnown, setSettledKnown] = useState(false);
  const { booked, quote } = useMarketFeed(night, blue.id, red.id, !settledKnown);

  const clob = booked?.clob;
  const reader = booked?.reader;
  const collateral = booked?.collateral;
  const boutId = quote?.boutId;
  const resolved = quote?.resolved ?? false;

  useEffect(() => subscribeAccount((account) => {
    setAddress(account);
    setClaimable(0n);
    setSettledKnown(false);
    setDismissed(false);
  }), []);

  // Only ever asked once the fight is scored — before that `claimable` is zero
  // by construction and the read is a call nobody needs.
  useEffect(() => {
    if (!address || !resolved || !clob || !reader || !collateral || boutId === undefined) return;
    let mounted = true;
    void (async () => {
      try {
        const next = await readAccount(address, clob, reader, collateral, boutId);
        if (mounted) { setClaimable(next.claimable); setSettledKnown(true); }
      } catch {
        // Wrong chain, or no wallet. Either way there is nothing to offer, and
        // the answer stays unknown so a wallet that arrives later is still
        // asked about on the next poll.
        if (mounted) setClaimable(0n);
      }
    })();
    return () => { mounted = false; };
  }, [address, resolved, clob, reader, collateral, boutId]);

  const show = Boolean(booked && quote && resolved && address && claimable > 0n && !dismissed);

  // Opened from an effect rather than the `open` attribute: `showModal` is what
  // gets the top layer, the backdrop, the focus trap and Escape, and none of
  // those are worth reimplementing over one button.
  useEffect(() => {
    const dialog = ref.current;
    if (show && dialog && !dialog.open) dialog.showModal();
  }, [show]);

  if (!show || !booked || !quote || !address) return null;

  const unit = 10n ** BigInt(booked.collateralDecimals);
  const winner = quote.outcome === "blue" ? blue : quote.outcome === "red" ? red : null;
  const amount = `${formatUnits(Number(claimable) / Number(unit))} ${booked.collateralSymbol}`;

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      await submit(booked, address, booked.clob, redeemCalldata(quote.boutId));
      // Redeemed shares are burnt, so there is nothing left to re-read: the
      // prompt has done its job and takes itself off the stage.
      setClaimable(0n);
    } catch (caught) {
      setError(explainError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="claim-dialog" ref={ref} onClose={() => setDismissed(true)}>
      <span className="claim-dialog__label">You won</span>
      <strong className="claim-dialog__amount">{amount}</strong>
      <span className="claim-dialog__line">
        {winner
          ? `${blue.lastName} v ${red.lastName} went to ${winner.lastName}, and you were on him.`
          : `${blue.lastName} v ${red.lastName} was a draw. Every share pays half a unit.`}
      </span>
      <button
        type="button"
        className="button button--amber button--full"
        disabled={busy}
        onClick={() => void claim()}
      >
        {busy ? "Claiming…" : `Claim ${amount}`}
      </button>
      <button
        type="button"
        className="claim-dialog__later"
        disabled={busy}
        onClick={() => ref.current?.close()}
      >
        Claim later
      </button>
      {error ? <p className="market-ticket__error">{error}</p> : null}
    </dialog>
  );
}

/* ------------------------------------------------------- the settled book */

/** The counter, on a fight that is over.
 *
 * A past fight has no ticket and should not pretend to: the book shut when
 * the fight did and nothing on it can be traded again. What is left is money —
 * winning shares to redeem, and whatever redeeming or cancelling has already
 * pushed into the pending balance the contract holds for this address. Both are
 * one button, and the pair of them is the only reason the market appears on an
 * archived fight at all.
 *
 * Deliberately drawn even when this wallet is owed nothing. "You did not win
 * this one" and "there is nothing here" are different answers, and a panel that
 * hides itself gives the second one to both questions. */
export function SettledMarket({
  night,
  blue,
  red,
  winnerId,
}: {
  night: number;
  blue: { id: string; lastName: string };
  red: { id: string; lastName: string };
  /** The league's own verdict, which is what the page says while the book is
   *  being read — and the fallback if the chain never answers. */
  winnerId: string | null;
}) {
  const { feed, booked, quote, bump } = useMarketFeed(
    night, blue.id, red.id, true, undefined, true,
  );
  const [address, setAddress] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  /** The wallet answered with something this panel cannot stand behind — nearly
   *  always a wallet parked on another chain, where every read decodes as a
   *  zero. "You had nothing on this fight" is the one sentence here that must
   *  never be a guess. */
  const [unreadable, setUnreadable] = useState(false);
  /** A claim confirmed in this tab. Nothing on chain tells a winner who has
   *  already collected apart from somebody who never held a share — redeem
   *  burns the winning side either way — so the panel remembers instead of
   *  reporting the second thing to a reader who just did the first. */
  const [claimed, setClaimed] = useState(false);
  /** Ask the wallet again. `bump` refreshes the public feed, which is a
   *  different question: a wallet that has just been moved onto the book's chain
   *  answers the position read it was refusing a moment ago, and nothing else
   *  about the page has changed to make that happen. */
  const [reread, setReread] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const clob = booked?.clob;
  const reader = booked?.reader;
  const collateral = booked?.collateral;
  const boutId = quote?.boutId;

  // The header's button is what connects, and it does it long after this panel
  // has mounted and asked once. Subscribing is the difference between a page
  // that answers the moment a wallet arrives and one that still says "connect a
  // wallet" to somebody who just did.
  useEffect(() => subscribeAccount(setAddress), []);

  useEffect(() => {
    if (!address) {
      setAccount(null);
      setUnreadable(false);
      setClaimed(false);
      return;
    }
    if (!clob || !reader || !collateral || boutId === undefined) return;
    let mounted = true;
    void (async () => {
      try {
        const next = await readAccount(address, clob, reader, collateral, boutId);
        if (mounted) { setAccount(next); setUnreadable(false); }
      } catch {
        if (mounted) { setAccount(null); setUnreadable(true); }
      }
    })();
    return () => { mounted = false; };
  }, [address, clob, reader, collateral, boutId, busy, reread]);

  if (feed && (!feed.ok || !feed.booked)) {
    return (
      <p className="market-panel__empty">
        {feed.ok === false
          ? feed.error
          : feed.reason === "unconfigured"
            ? "No market is wired up to this league."
            : "There was never a book on this fight, so there is nothing to collect."}
      </p>
    );
  }
  if (!booked || !quote) return <p className="market-panel__empty">Reading the book…</p>;

  const unit = 10n ** BigInt(booked.collateralDecimals);
  const symbol = booked.collateralSymbol;
  const whole = (amount: bigint) => Number(amount) / Number(unit);
  const owed = account?.claimable ?? 0n;
  const pending = account?.pending ?? 0n;
  const winner =
    quote.outcome === "blue" ? blue : quote.outcome === "red" ? red
      : winnerId === blue.id ? blue : winnerId === red.id ? red : null;
  const blueHeld = (account?.blueShares ?? 0n) + (account?.blueEscrow ?? 0n);
  const redHeld = (account?.redShares ?? 0n) + (account?.redEscrow ?? 0n);
  // Redeem only ever takes the winning side, so shares left on the loser are
  // the record of the bet that went down — the one thing on chain that can tell
  // a beaten ticket apart from no ticket at all.
  const lost = winner ? (winner.id === blue.id ? redHeld : blueHeld) : 0n;
  const beaten = winner ? (winner.id === blue.id ? red : blue) : null;
  /** What this wallet is being told, in the order the answers matter. */
  const standing = unreadable
    ? "unreadable"
    : account === null
      ? "reading"
      : owed > 0n
        ? "owed"
        : claimed
          ? "claimed"
          : lost > 0n
            ? "lost"
            : "none";

  const run = async (label: string, to: string, data: string) => {
    if (!address) return;
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await submit(booked, address, to, data);
      setNote(`${label} confirmed.`);
      if (label === "Claim") setClaimed(true);
      bump();
    } catch (caught) {
      setError(explainError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settled-market">
      <p className="settled-market__verdict">
        {winner
          ? <>Settled: <b>{winner.lastName}</b> won. Every share on him pays one {symbol}; the
              other side pays nothing.</>
          : <>Settled as a draw. Every share on either man pays half a {symbol}.</>}
      </p>

      {!address ? (
        <p className="settled-market__empty">
          Connect a wallet to see whether this fight owes you anything.
        </p>
      ) : (
        <>
          {/* One sentence about this wallet and this fight, before any button.
              The three-figure readout this replaced said 0.00 / 0.00 / None to a
              losing ticket, a wallet on the wrong chain and somebody who never
              bet — three different answers wearing the same face. */}
          <div className={`settled-market__standing settled-market__standing--${standing}`}>
            {standing === "reading" ? (
              <strong>Reading your position on this fight…</strong>
            ) : standing === "unreadable" ? (
              <>
                <strong>Cannot read this wallet&apos;s position</strong>
                <small>
                  Your wallet is on a different chain from the book, so its position
                  here can&apos;t be read. Switch chains and it will show.
                </small>
              </>
            ) : standing === "owed" ? (
              <>
                <strong>{formatUnits(whole(owed))} {symbol} to collect</strong>
                <small>
                  {winner
                    ? <>You are holding {formatUnits(whole(winner.id === blue.id ? blueHeld : redHeld))} shares
                        on {winner.lastName}, and he won. Every one of them pays one {symbol}.</>
                    : <>It was a draw, and a draw pays every share on either man half a {symbol}.</>}
                </small>
              </>
            ) : standing === "claimed" ? (
              <>
                <strong>Claimed</strong>
                <small>
                  {pending > 0n
                    ? <>{formatUnits(whole(pending))} {symbol} is sitting in your pending balance
                        on the book. Withdrawing sends it back to your wallet.</>
                    : <>This fight is settled up with you.</>}
                </small>
              </>
            ) : standing === "lost" ? (
              <>
                <strong>Nothing to collect. You had the other man</strong>
                <small>
                  {formatUnits(whole(lost))} shares on {beaten?.lastName}, who lost. Losing
                  shares pay nothing.
                </small>
              </>
            ) : (
              <>
                <strong>No shares on this fight</strong>
                <small>
                  This wallet never bet on this fight, so there is nothing to claim.
                </small>
              </>
            )}
          </div>

          {owed > 0n || pending > 0n ? (
            <div className="settled-market__actions">
              {owed > 0n ? (
                <button
                  type="button"
                  className="button button--amber"
                  disabled={busy !== null}
                  onClick={() => void run("Claim", booked.clob, redeemCalldata(quote.boutId))}
                >
                  {busy === "Claim"
                    ? "Claiming…"
                    : `Claim ${formatUnits(whole(owed))} ${symbol} now`}
                </button>
              ) : null}
              {pending > 0n ? (
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null}
                  onClick={() => void run("Withdrawal", booked.clob, withdrawCalldata())}
                >
                  {busy === "Withdrawal"
                    ? "Withdrawing…"
                    : `Withdraw ${formatUnits(whole(pending))} ${symbol}`}
                </button>
              ) : null}
            </div>
          ) : null}

          {standing === "unreadable" ? (
            <button
              type="button"
              className="button"
              disabled={busy !== null}
              onClick={() => {
                setError(null);
                void ensureChain(booked.chainId, booked.rpcUrl, booked.explorer)
                  .then(() => { setReread((count) => count + 1); bump(); })
                  .catch((caught) => setError(explainError(caught)));
              }}
            >
              Switch to the chain the book is on
            </button>
          ) : null}

          {/* The pending balance is the contract's, not this fight's: claiming
              here and on three other fights all lands in the same place, and
              one withdrawal takes the lot. Worth saying, because the two
              buttons otherwise read as one action split in half. */}
          {owed > 0n || pending > 0n ? (
            <p className="settled-market__note">
              Claiming moves winnings into your pending balance on the book. Withdrawing
              sends that whole balance, from this fight and any other, back to your wallet.
            </p>
          ) : null}

          {note ? <p className="market-ticket__note">{note}</p> : null}
          {error ? <p className="market-ticket__error">{error}</p> : null}
        </>
      )}
    </div>
  );
}

/** The whole book for one fight, as a section of a page rather than a popup.
 *
 * The same board the dialog wraps — chart, ticket, position, ladder, tape — so
 * a fight's own page and the card rail's popup can never quote different
 * numbers for the same trade. Always polling: a page you navigated to is a page
 * you are looking at. */
export function FightMarket({
  night,
  blue,
  red,
  opensOn,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  opensOn?: 0 | 1;
}) {
  return <MarketBoard night={night} blue={blue} red={red} active opensOn={opensOn} />;
}

/** The fight that is next, priced, while the ring is empty.
 *
 * The gap between bouts is the one stretch where the stage has nothing on it
 * and the whole card is still open — which makes it the best moment on the
 * page to bet, and it used to be a countdown and a sentence. The line for the
 * next fight goes here instead, with a button on each corner.
 *
 * Read-only on purpose: the ticket lives in the popup those buttons open, so
 * there is one order form on the site rather than two that can drift apart. */
export function NextFightMarket({
  night,
  blue,
  red,
  subtitle,
  countdown,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  /** Division and slot time, as the card rail words it. */
  subtitle: string;
  /** How long until the bell, already worded. */
  countdown: string | null;
}) {
  const { feed, booked, quote } = useMarketFeed(night, blue.id, red.id, true);
  const [trading, setTrading] = useState<0 | 1 | null>(null);

  const line = useMemo(() => openingOdds(blue, red), [blue, red]);
  const blueOdds = quote?.quoted ? quote.blue : line.blue;
  const redOdds = 100 - blueOdds;
  // Betting is open on every fight that has a book and has not been closed.
  // The one exception is the bout in the ring, and by definition that is not
  // this one.
  const openable = Boolean(quote && !quote.closed && !quote.resolved);

  return (
    <div className="next-fight">
      <header className="next-fight__head">
        <div>
          <span className="eyebrow">Next up{countdown ? ` · ${countdown}` : ""}</span>
          <strong>
            {blue.lastName} <em>v</em> {red.lastName}
          </strong>
        </div>
        <span className="next-fight__meta">{subtitle}</span>
      </header>

      {feed && (!feed.ok || !feed.booked) ? (
        <p className="market-panel__empty">
          {feed.ok === false
            ? feed.error
            : feed.reason === "unconfigured"
              ? "No market is wired up to this league yet."
              : "Nobody has put a book up against this fight."}
        </p>
      ) : !quote ? (
        <p className="market-panel__empty">Reading the book…</p>
      ) : (
        <>
          <MarketChart
            history={quote.history}
            blue={blue}
            red={red}
            blueOdds={blueOdds}
            redOdds={redOdds}
            volume={quote.volume}
            symbol={booked?.collateralSymbol ?? "tUSD"}
            note={quote.quoted ? null : "The league's opening line · nothing has traded"}
          />

          <div className="next-fight__bets">
            {([SIDE_BLUE, SIDE_RED] as const).map((corner) => {
              const fighter = corner === SIDE_BLUE ? blue : red;
              const odds = corner === SIDE_BLUE ? blueOdds : redOdds;
              return (
                <button
                  key={corner}
                  type="button"
                  className={`next-fight__bet next-fight__bet--${corner === SIDE_BLUE ? "blue" : "red"}`}
                  disabled={!openable}
                  onClick={() => setTrading(corner)}
                >
                  <span>Bet {fighter.lastName}</span>
                  <strong>{Math.round(odds)}¢</strong>
                  <em>{payoutMultiple(odds).toFixed(2)}x if he wins</em>
                </button>
              );
            })}
          </div>
        </>
      )}

      {trading !== null ? (
        <MarketDialog
          night={night}
          blue={blue}
          red={red}
          opensOn={trading}
          subtitle={subtitle}
          onClose={() => setTrading(null)}
        />
      ) : null}
    </div>
  );
}

/** The same market as a popup, for a fight that has not started yet.
 *
 * This is where most of the trading actually happens: a card is announced six
 * hours before its first bell, and the whole point of that gap is that the
 * line-up can be read — and priced — before anybody steps through the ropes.
 * Waiting for a fight to reach the stage to bet on it would miss the window
 * entirely. */
export function MarketDialog({
  night,
  blue,
  red,
  subtitle,
  opensOn,
  onClose,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  subtitle: string;
  /** The corner that was clicked to get here. */
  opensOn?: 0 | 1;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  // `showModal` rather than the `open` attribute: it is what gets the top
  // layer, the backdrop, the focus trap and Escape for free, and none of those
  // are worth reimplementing over a form with two inputs in it.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      className="market-dialog"
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop lands on the dialog itself, never on a child.
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <header className="market-dialog__head">
        <div>
          <span className="eyebrow">{subtitle}</span>
          <strong>{blue.lastName} <em>v</em> {red.lastName}</strong>
        </div>
        <button type="button" className="market-dialog__close" onClick={() => ref.current?.close()}>
          Close
        </button>
      </header>
      <MarketBoard night={night} blue={blue} red={red} active opensOn={opensOn} />
    </dialog>
  );
}
