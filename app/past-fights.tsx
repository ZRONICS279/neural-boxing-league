"use client";

import Link from "next/link";
import { useMemo } from "react";
import { type ArchivedFight, verdictLabel } from "./archive";
import { usePastFights } from "./archive-store";
import { useBroadcast } from "./broadcast-store";
import { payoutMultiple } from "./market";
import { openingLineFor } from "./opening-line";
import { ringLastName } from "./ring-names";
import { type Fighter, weightClassLabel } from "./fight-model";
import { SiteFooter, SiteHeader, Ticker } from "./site-chrome";
import { WalletConnect } from "./wallet-button";

/** Every fight the league has ever had, after its card is gone.
 *
 * A card is torn down the moment its last bout has been fought, so up to now a
 * result existed for about as long as it took the next night to be drawn up.
 * This is the rest of it: one row a fight, kept for as long as the league runs,
 * with a way back into each one — to watch it again, and to collect on it.
 *
 * The prices here are the league's own line rather than the book's. Reading the
 * real close on a hundred settled fights would be a hundred trips to the chain
 * to render a list, and the number that actually matters — what a fight paid —
 * is on the fight's own page, one click away, read off the book itself. */

/* --------------------------------------------------------------- one fight */

function ArchiveBout({
  fight,
  roster,
}: {
  fight: ArchivedFight;
  roster: Fighter[];
}) {
  // The line the league quoted going in, recomputed off careers that have since
  // moved on — so it is a read of the matchup rather than a record of the close.
  // Conservative in the same direction every time: the winner's own win is
  // already in the record by the time this sees it, which shortens his price.
  const line = useMemo(
    () => openingLineFor(roster, fight.blueId, fight.redId),
    [roster, fight.blueId, fight.redId],
  );

  const corner = (side: "blue" | "red") => {
    const id = side === "blue" ? fight.blueId : fight.redId;
    const name = ringLastName(id, side === "blue" ? fight.blueName : fight.redName);
    const price = line === null ? null : side === "blue" ? line : 100 - line;
    return (
      <span
        key={side}
        className={`card-bout__side card-bout__side--${side}`}
        data-won={String(fight.winnerId === id)}
      >
        <span className="card-bout__name">{name}</span>
        {price !== null ? (
          <>
            <span className="card-bout__pay">{payoutMultiple(price).toFixed(2)}x</span>
            <strong className="card-bout__pct">{Math.round(price)}%</strong>
            <i className="card-bout__bar" style={{ width: `${Math.round(price)}%` }} />
          </>
        ) : (
          <span className="card-bout__pay">—</span>
        )}
      </span>
    );
  };

  return (
    <li
      className={[
        "card-bout",
        "card-bout--final",
        `card-bout--${fight.division}`,
        fight.kind === "title" ? "card-bout--title" : "",
      ].filter(Boolean).join(" ")}
    >
      {/* The whole tile is the link, because on a page of finished fights there
          is exactly one thing to do with a row. On the live card rail the
          corners are their own buttons and the tile is not, since there a tap
          on a man means a ticket on him. */}
      <Link className="archive-bout" href={`/fight/${fight.id}`}>
        <span className="card-bout__head">
          <span className={`card-bout__weight card-bout__weight--${fight.division}`}>
            {weightClassLabel(fight.division)}
          </span>
          {fight.kind === "title" ? <i className="card-bout__belt">title</i> : null}
          <time dateTime={new Date(fight.airedAt).toISOString()}>
            {new Date(fight.airedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </span>

        {corner("blue")}
        {corner("red")}

        <span className="card-bout__foot">
          <span>{verdictLabel(fight)}</span>
          <i className="card-bout__trade">
            {fight.replayable ? "Watch · claim →" : "Claim →"}
          </i>
        </span>
      </Link>
    </li>
  );
}

/* ---------------------------------------------------------------- one night */

function NightGroup({
  night,
  fights,
  roster,
  open,
}: {
  night: number;
  fights: ArchivedFight[];
  roster: Fighter[];
  open: boolean;
}) {
  const stoppages = fights.filter(
    (fight) => fight.winnerId && fight.finish !== "Decision",
  ).length;
  const date = new Date(fights[0].airedAt);

  return (
    <details className="card-rail" open={open}>
      <summary>
        <span className="eyebrow">Fight night {night}</span>
        <strong className="card-rail__title">
          {date.toLocaleDateString([], { month: "short", day: "numeric" })}
        </strong>
        <span className="card-rail__count">
          {fights.length} fight{fights.length === 1 ? "" : "s"} · {stoppages} by stoppage ·
          season {String(fights[0].season).padStart(2, "0")}, week {fights[0].week}
        </span>
      </summary>
      <ol className="card-rail__list">
        {fights.map((fight) => (
          <ArchiveBout key={fight.id} fight={fight} roster={roster} />
        ))}
      </ol>
    </details>
  );
}

/* -------------------------------------------------------------------- page */

export function PastFightsPage() {
  const { feed, roster, status } = useBroadcast();
  const { fights, loading, error, more, loadMore } = usePastFights();

  // Nights in the order the archive returned them, which is newest first. A map
  // keeps that order for free and does not care that a page boundary can land
  // in the middle of a card.
  const nights = useMemo(() => {
    const grouped = new Map<number, ArchivedFight[]>();
    for (const fight of fights) {
      const held = grouped.get(fight.night);
      if (held) held.push(fight);
      else grouped.set(fight.night, [fight]);
    }
    return [...grouped.entries()];
  }, [fights]);

  const stoppages = fights.filter(
    (fight) => fight.winnerId && fight.finish !== "Decision",
  ).length;

  return (
    <div className="page">
      <SiteHeader
        calendar={{ season: feed?.season ?? 1, week: feed?.week ?? 1 }}
        active="/fights"
        status={{
          label: status === "offline" ? "Broadcast offline" : "The record",
          detail: `${(feed?.boutsCompleted ?? 0).toLocaleString()} bouts on record`,
        }}
        action={<WalletConnect roster={roster} />}
      />

      <main className="page__body">
        <section className="archive-head" aria-label="Past fights">
          <div>
            <strong>Past fights</strong>
          </div>
          <p>
            Rewatch old fights, and claim any left over winnings
          </p>
        </section>

        {error ? (
          <p className="roster-section__note">{error}</p>
        ) : fights.length === 0 ? (
          <p className="roster-section__note">
            {loading
              ? "Reading the record…"
              : "Nothing has been filed yet. The archive starts with the next fight to finish."}
          </p>
        ) : (
          <>
            <div className="archive-nights">
              {nights.map(([night, group], index) => (
                <NightGroup
                  key={night}
                  night={night}
                  fights={group}
                  roster={roster}
                  open={index < 2}
                />
              ))}
            </div>

            <div className="archive-more">
              <span>
                {fights.length} fight{fights.length === 1 ? "" : "s"} shown ·{" "}
                {stoppages} by stoppage
              </span>
              {more !== null ? (
                <button
                  type="button"
                  className="button"
                  disabled={loading}
                  onClick={loadMore}
                >
                  {loading ? "Reading…" : "Older fights"}
                </button>
              ) : (
                <span className="archive-more__end">That is the whole record.</span>
              )}
            </div>
          </>
        )}
      </main>
      <SiteFooter />

      <Ticker
        notice={
          fights.length > 0
            ? `${ringLastName(fights[0].blueId, fights[0].blueName)} v ${ringLastName(fights[0].redId, fights[0].redName)} was the last one filed.`
            : "The record is being written."
        }
        meta="Claims stay open after the bell"
      />
    </div>
  );
}
