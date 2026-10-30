"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Fighter } from "./fight-model.ts";
import {
  type BoutRef,
  type Holding,
  type OpenOrder,
  type PortfolioFeed,
  type WalletChoice,
  SIDE_BLUE,
  cancelAllCalldata,
  cancelCalldata,
  ensureChain,
  estimateGas,
  explainError,
  formatUnits,
  getWallet,
  readHoldings,
  readOpenOrders,
  redeemCalldata,
  requestAccount,
  selectWallet,
  selectedWalletRdns,
  sendTransaction,
  subscribeAccount,
  subscribeWallets,
  waitForReceipt,
  withdrawCalldata,
} from "./market.ts";

/** The header's wallet connect, and everything behind it.
 *
 * Every wallet the browser has announced gets a row, because a reader with
 * MetaMask and Rabby side by side is not asking to be handed whichever one
 * won the race to `window.ethereum`. Picking one points the market panel's
 * reads and writes at it too — the choice is the league's, not the panel's.
 *
 * Once connected the same button opens a portfolio: every fight the address
 * has a position on, what is still resting on the book, and what it can claim.
 * The ticket in the market panel only ever knew about the fight it was under,
 * which meant a winning bet on a bout that had left the stage was money you
 * had to go looking for.
 *
 * Nothing here reaches the league. The bout list is public and comes from
 * `/api/market`; the holdings are read straight out of the wallet against
 * those ids, so the address never leaves the tab. */

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A plain wallet, for a connected button whose wallet announced no icon of
 *  its own. Drawn for the same reason the speaker is: an emoji is a different
 *  picture on every OS. */
function WalletIcon() {
  return (
    <svg viewBox="0 0 20 18" width="15" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3 3.5h11.5a1 1 0 0 1 1 1V6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M2.2 5.5a1 1 0 0 1 1-1h13.6a1 1 0 0 1 1 1v9.3a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13.2 8.6h4.6v3.4h-4.6a1.7 1.7 0 0 1 0-3.4z" fill="currentColor" />
    </svg>
  );
}

/** A holding worth drawing, with the fight it is a holding on. */
interface Position {
  bout: BoutRef;
  holding: Holding;
}

/** Whether this bout still owes the wallet anything at all.
 *
 * Escrowed shares count: they are behind a resting sell order, not spent, and
 * a portfolio that ignored them would tell somebody they hold nothing while
 * the book holds their shares. */
function isLive(holding: Holding) {
  return (
    holding.sharesA > 0n || holding.sharesB > 0n ||
    holding.escrowA > 0n || holding.escrowB > 0n ||
    holding.claimable > 0n
  );
}

export function WalletConnect({ roster }: { roster: Fighter[] }) {
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [book, setBook] = useState<PortfolioFeed | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [pending, setPending] = useState(0n);
  /** Null until asked. False is a wallet parked on another chain, where every
   *  read answers for a contract that is not there — which decodes as an empty
   *  portfolio, i.e. as a lie. Better to say so and offer the switch. */
  const [onChain, setOnChain] = useState<boolean | null>(null);
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeWallets(setWallets), []);
  useEffect(() => subscribeAccount((account) => {
    setAddress(account);
    setPositions(null);
    setOrders([]);
    setPending(0n);
    setOnChain(null);
    setRefresh((count) => count + 1);
  }), []);

  // Whichever wallet the reader last picked, once it has announced itself.
  const current = wallets.find((wallet) => wallet.rdns === selectedWalletRdns()) ?? null;

  useEffect(() => {
    const wallet = getWallet();
    if (!wallet?.on) return;
    const onChain = () => setRefresh((count) => count + 1);
    wallet.on("chainChanged", onChain);
    return () => {
      wallet.removeListener?.("chainChanged", onChain);
    };
  }, [wallets]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* ------------------------------------------------------------ portfolio */

  // Which bouts exist, and where the book lives. Public, cached, and asked for
  // only once the menu is actually open — a header button should not be
  // scanning the chain on every page load for a reader who never clicks it.
  useEffect(() => {
    if (!open || !address || book) return;
    let mounted = true;
    void fetch("/api/market?scope=portfolio", { cache: "no-store" })
      .then((response) => response.json() as Promise<PortfolioFeed>)
      .then((payload) => { if (mounted) setBook(payload); })
      .catch(() => {
        if (mounted) setBook({ ok: false, error: "The market is unreachable." });
      });
    return () => { mounted = false; };
  }, [open, address, book]);

  const booked = book?.ok && book.booked ? book : null;
  const reader = booked?.reader;

  // The private half, read through the wallet's own node against the ids
  // above. Two calls for a whole portfolio, however many nights it spans.
  useEffect(() => {
    if (!open || !address || !booked || !reader) return;
    let mounted = true;

    void (async () => {
      try {
        const chainId = (await getWallet()?.request({ method: "eth_chainId" })) as string;
        if (!mounted) return;
        if (Number(BigInt(chainId ?? "0x0")) !== booked.chainId) {
          setOnChain(false);
          return;
        }
        setOnChain(true);
        const [{ holdings, pending }, resting] = await Promise.all([
          readHoldings(reader, address, booked.bouts.map((bout) => bout.boutId)),
          readOpenOrders(reader, booked.clob, address),
        ]);
        if (!mounted) return;
        const byId = new Map(booked.bouts.map((bout) => [bout.boutId, bout]));
        setPositions(
          holdings
            .filter(isLive)
            .map((holding) => ({ bout: byId.get(holding.boutId), holding }))
            .filter((row): row is Position => row.bout !== undefined),
        );
        setOrders(resting);
        setPending(pending);
      } catch {
        // A wallet on the wrong chain answers eth_call with nonsense rather
        // than an error. Null is "we could not read it", which the menu says
        // out loud instead of drawing an empty portfolio over a full one.
        if (mounted) setPositions(null);
      }
    })();

    return () => { mounted = false; };
  }, [open, address, booked, reader, refresh]);

  const connect = async (wallet: WalletChoice) => {
    setError(null);
    setBusy(wallet.rdns);
    selectWallet(wallet.rdns);
    try {
      await requestAccount();
    } catch (caught) {
      setError(explainError(caught));
    } finally {
      setBusy(null);
    }
  };

  /** EIP-1193 has no disconnect — the permission lives in the extension. Ask
   *  for it back where the wallet supports that, and forget the address here
   *  either way, which is what the button means everywhere else. */
  const disconnect = async () => {
    const wallet = getWallet();
    selectWallet(null);
    setOpen(false);
    try {
      await wallet?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Most wallets do not implement it. Forgetting still stands.
    }
  };

  /** Same shape as the market panel's writes, and for the same reasons: the
   *  chain first, then an estimate that turns a revert into a sentence, then
   *  a gas limit so the wallet cannot fall back to the block's. */
  const run = useCallback(async (label: string, to: string, data: string) => {
    if (!address || !booked) return;
    setBusy(label);
    setError(null);
    try {
      await ensureChain(booked.chainId, booked.rpcUrl, booked.explorer);
      const gas = await estimateGas(address, to, data);
      await waitForReceipt(await sendTransaction(address, to, data, (gas * 5n) / 4n));
      setRefresh((count) => count + 1);
    } catch (caught) {
      setError(explainError(caught));
    } finally {
      setBusy(null);
    }
  }, [address, booked]);

  /* --------------------------------------------------------------- render */

  const unit = booked ? 10n ** BigInt(booked.collateralDecimals) : 10n ** 6n;
  const symbol = booked?.collateralSymbol ?? "tUSD";
  const whole = (amount: bigint) => Number(amount) / Number(unit);
  const nameOf = (id: string) => roster.find((fighter) => fighter.id === id)?.lastName ?? id;

  const claimable = (positions ?? []).reduce((total, row) => total + row.holding.claimable, 0n);
  // What the open positions are worth if sold into the current line. Not a
  // profit — the portfolio has no cost basis, because working one out means
  // replaying every fill this address was ever part of.
  const atMarket = (positions ?? []).reduce((total, { bout, holding }) => {
    if (bout.resolved) return total;
    const a = holding.sharesA + holding.escrowA;
    const b = holding.sharesB + holding.escrowB;
    return total + (a * BigInt(Math.round(bout.priceA)) + b * BigInt(100 - Math.round(bout.priceA))) / 100n;
  }, 0n);

  return (
    <div className="wallet" ref={root}>
      <button
        type="button"
        className={
          address
            ? "button wallet__toggle wallet__toggle--account"
            : "button button--amber wallet__toggle"
        }
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {address ? (
          current?.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="wallet__icon" src={current.icon} alt="" width={16} height={16} />
          ) : (
            <WalletIcon />
          )
        ) : null}
        {address ? shortAddress(address) : "Connect wallet"}
        {address && claimable > 0n ? (
          <em className="wallet__badge">{formatUnits(whole(claimable))}</em>
        ) : null}
      </button>

      {open ? (
        <div className={address ? "wallet__menu wallet__menu--wide" : "wallet__menu"} role="menu">
          {address ? (
            <div className="wallet__account">
              <span className="eyebrow">{current?.name ?? "Connected"}</span>
              <strong>{address}</strong>
            </div>
          ) : (
            <p className="wallet__lede">
              Connect any wallet you have installed. The address stays between this
              tab and the extension. The league never sees it.
            </p>
          )}

          {address ? (
            <>
              <dl className="wallet__totals">
                <div>
                  <dt>Open positions</dt>
                  <dd>{formatUnits(whole(atMarket))} {symbol}</dd>
                </div>
                <div>
                  <dt>Claimable</dt>
                  <dd className={claimable > 0n ? "is-good" : undefined}>
                    {formatUnits(whole(claimable))} {symbol}
                  </dd>
                </div>
              </dl>

              <div className="wallet__section">
                <span className="eyebrow">Your predictions</span>
                {book && (!book.ok || !book.booked) ? (
                  <p className="wallet__empty">
                    {book.ok === false ? book.error : "No book is up against this league yet."}
                  </p>
                ) : onChain === false && booked ? (
                  <button
                    type="button"
                    className="button button--full"
                    disabled={busy !== null}
                    onClick={() => {
                      setError(null);
                      void ensureChain(booked.chainId, booked.rpcUrl, booked.explorer)
                        .then(() => setRefresh((count) => count + 1))
                        .catch((caught) => setError(explainError(caught)));
                    }}
                  >
                    Switch to the chain the book is on
                  </button>
                ) : positions === null ? (
                  <p className="wallet__empty">
                    {booked ? "Reading your positions…" : "Reading the card…"}
                  </p>
                ) : positions.length === 0 ? (
                  <p className="wallet__empty">
                    Nothing riding yet. Every fight on tonight&apos;s card takes bets
                    until it ends.
                  </p>
                ) : (
                  <ul className="wallet__positions">
                    {positions.map(({ bout, holding }) => {
                      const a = holding.sharesA + holding.escrowA;
                      const b = holding.sharesB + holding.escrowB;
                      const backed = a >= b ? bout.fighterA : bout.fighterB;
                      const shares = a >= b ? a : b;
                      const price = a >= b ? bout.priceA : 100 - bout.priceA;
                      // A settled bout is a verdict, not a price. `outcome` is
                      // quoted for fighter A the same way the row is.
                      const won = bout.resolved
                        ? bout.outcome === "void"
                          ? null
                          : (bout.outcome === "blue") === (a >= b)
                        : null;
                      return (
                        <li key={bout.boutId} className="wallet__position">
                          <div className="wallet__position-head">
                            <strong>
                              {nameOf(bout.fighterA)} <em>v</em> {nameOf(bout.fighterB)}
                            </strong>
                            <span
                              className={`wallet__chip wallet__chip--${
                                holding.claimable > 0n ? "claim"
                                  : !bout.resolved ? "open"
                                  : won ? "won" : "lost"
                              }`}
                            >
                              {holding.claimable > 0n
                                ? "Claimable"
                                : !bout.resolved
                                  ? bout.closed ? "In the ring" : "Open"
                                  : won === null ? "Void" : won ? "Won" : "Lost"}
                            </span>
                          </div>
                          <div className="wallet__position-line">
                            <span>
                              {formatUnits(whole(shares))} on {nameOf(backed)}
                            </span>
                            <b>{bout.resolved ? "—" : `${Math.round(price)}¢`}</b>
                            <em>
                              night {bout.night}
                              {holding.escrowA + holding.escrowB > 0n ? " · some resting" : ""}
                            </em>
                          </div>
                          {holding.claimable > 0n && booked ? (
                            <button
                              type="button"
                              className="button button--amber button--full"
                              disabled={busy !== null}
                              onClick={() => void run("Claim", booked.clob, redeemCalldata(bout.boutId))}
                            >
                              {busy === "Claim"
                                ? "Claiming…"
                                : `Claim ${formatUnits(whole(holding.claimable))} ${symbol}`}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {orders.length > 0 && booked ? (
                <div className="wallet__section">
                  <div className="wallet__section-head">
                    <span className="eyebrow">Still on the book</span>
                    {orders.length > 1 ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void run("Cancel all", booked.clob, cancelAllCalldata(orders))}
                      >
                        {busy === "Cancel all" ? "Cancelling…" : `Cancel all ${orders.length}`}
                      </button>
                    ) : null}
                  </div>
                  <ul className="wallet__orders">
                    {orders.map((order) => {
                      const bout = booked.bouts.find((entry) => entry.boutId === order.boutId);
                      const fighter = bout
                        ? nameOf(order.side === SIDE_BLUE ? bout.fighterA : bout.fighterB)
                        : `bout #${order.boutId}`;
                      return (
                        <li key={order.id}>
                          <span>
                            {order.isBuy ? "Buy" : "Sell"} {formatUnits(whole(order.shares))}{" "}
                            {fighter} at {order.price}¢
                          </span>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void run("Cancel", booked.clob, cancelCalldata(order.id))}
                          >
                            Cancel
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {pending > 0n && booked ? (
                <button
                  type="button"
                  className="button button--full"
                  disabled={busy !== null}
                  onClick={() => void run("Withdrawal", booked.clob, withdrawCalldata())}
                >
                  {busy === "Withdrawal"
                    ? "Withdrawing…"
                    : `Withdraw ${formatUnits(whole(pending))} ${symbol}`}
                </button>
              ) : null}
            </>
          ) : null}

          {wallets.length ? (
            wallets.map((wallet) => (
              <button
                key={wallet.rdns}
                type="button"
                role="menuitem"
                className="wallet__choice"
                onClick={() => void connect(wallet)}
                disabled={busy !== null}
              >
                {wallet.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={wallet.icon} alt="" width={22} height={22} />
                ) : (
                  <span className="wallet__glyph" aria-hidden="true">{wallet.name.slice(0, 1)}</span>
                )}
                <strong>{wallet.name}</strong>
                <small>
                  {busy === wallet.rdns
                    ? "Waiting…"
                    : address && wallet.rdns === current?.rdns
                      ? "Connected"
                      : "Connect"}
                </small>
              </button>
            ))
          ) : (
            <p className="wallet__empty">
              No wallet detected. Install MetaMask, Rabby, Coinbase Wallet or any other
              browser wallet, then reload this page.
            </p>
          )}

          {error ? <p className="wallet__error" role="alert">{error}</p> : null}

          {address ? (
            <button
              type="button"
              className="button button--quiet button--full"
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
