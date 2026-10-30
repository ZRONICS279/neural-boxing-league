"use client";

import Link from "next/link";
import { useMemo } from "react";
import { type Fighter, weightClassLabel } from "./fight-model";
import { isAftermath } from "./broadcast-model";
import { useArchivedFight } from "./archive-store";
import { type BoutSummary, PLAYBACK_DELAY_MS, useBroadcast } from "./broadcast-store";
import { SiteFooter, SiteHeader, Ticker, slotTime, waitLabel } from "./site-chrome";
import { BoutTale, FightStage } from "./fight-stage";
import { FightReplay } from "./fight-replay";
import { FightMarket, SettledMarket } from "./market-panel";
import { ringLastName } from "./ring-names";
import { WalletConnect } from "./wallet-button";

/** One fight, on its own page: the stream of that bout and the book on it.
 *
 * The league page follows the card — whatever is in the ring is what you get.
 * This follows a bout. If it has not started you wait for it here with the
 * order book open beside you, which is the whole point: the hours before a
 * bell are when the price actually moves. When the bell goes the same stage
 * the league page uses takes over, and it will only ever show this fight.
 *
 * The replay is not rebuilt here. `useBroadcast` steps whichever bout the card
 * is publishing, and this page draws it only when that bout is this one — so
 * two people on this URL see the same round as each other and as everybody
 * watching the league page. A fight cannot be made to run early by opening its
 * page, and it does not stop when the page is closed. */
export function FightPage({ boutId }: { boutId: number }) {
  const { feed, bout, frames, voice, fighters, roster, status, error, leagueTime, paused } =
    useBroadcast();

  const onAir = feed?.live?.id === boutId;
  // The card is the only place a bout that is not on air can be read from: the
  // server sends full fight state for the live bout and the next one, and a
  // summary for everything else on the night.
  const slot: BoutSummary | null = feed?.card.find((entry) => entry.id === boutId) ?? null;

  // Once a fight is over the card stops being the place to read it from: the
  // athlete snapshots come off within a tick or two of the final bell, and the
  // whole listing is torn down when the night ends. The archive is where it
  // goes, so this asks there for anything that is not on air and not still to
  // come — which covers both a bout from earlier tonight and one from a card
  // three weeks gone.
  const archive = useArchivedFight(
    boutId,
    Boolean(feed) && !onAir && (slot === null || slot.status === "final"),
  );
  const filed = archive.fight;

  const blueId = onAir ? feed?.live?.blueId : slot?.blueId ?? filed?.blueId;
  const redId = onAir ? feed?.live?.redId : slot?.redId ?? filed?.redId;

  const pair = useMemo(() => {
    // While the bout is on air its own frozen snapshots are the truth — those
    // are the men who stepped through the ropes, not the levelled-up versions
    // the league is carrying now. A replay is the same argument after the fact,
    // which is why the archive keeps the pair rather than two ids.
    if (onAir && fighters) return fighters;
    if (archive.profiles && filed) {
      const [first, second] = archive.profiles;
      return first.id === filed.blueId
        ? { blue: first, red: second }
        : { blue: second, red: first };
    }
    const blue = roster.find((entry) => entry.id === blueId);
    const red = roster.find((entry) => entry.id === redId);
    return blue && red ? { blue, red } : null;
  }, [onAir, fighters, archive.profiles, filed, roster, blueId, redId]);

  // The picture runs a playback delay behind the league clock, and the verdict
  // panel follows the picture: the playhead flips `running` off exactly when
  // the finish is drawn, with the delayed clock covering the moments the
  // player has nothing loaded yet.
  const viewerTime = leagueTime - PLAYBACK_DELAY_MS;
  const aftermath = onAir && feed?.live
    ? bout ? !bout.running : isAftermath(feed.live, viewerTime)
    : false;
  // `feed.live` is whatever is in the ring right now, which is only this fight
  // while it is on air. Reading billing off it otherwise put the current bout's
  // division and slot time on the page of an archived one.
  const live = onAir ? feed?.live : null;
  const verdict = slot?.result
    ?? live?.result
    ?? (filed
      ? { winnerId: filed.winnerId, finish: filed.finish, round: filed.round }
      : null);
  // A fight old enough to have lost its athlete snapshots still has a winner —
  // it is only the rewatch that goes, never the result. The names come off the
  // archive row rather than the roster for the same reason.
  const winnerName = verdict?.winnerId
    ? pair
      ? (verdict.winnerId === pair.blue.id ? pair.blue.lastName : pair.red.lastName)
      : filed
        ? (verdict.winnerId === filed.blueId
          ? ringLastName(filed.blueId, filed.blueName)
          : ringLastName(filed.redId, filed.redName))
        : null
    : null;
  const winner: Fighter | null = verdict?.winnerId && pair
    ? (verdict.winnerId === pair.blue.id ? pair.blue : pair.red)
    : null;

  const division = slot?.division ?? live?.division ?? filed?.division ?? null;
  const kind = slot?.kind ?? live?.kind ?? filed?.kind ?? "contender";
  const startsAt = slot?.startsAt ?? live?.startsAt ?? 0;
  const settled = slot?.status === "final" || Boolean(verdict);
  // A slot on the card is a time on the league clock, converted back through
  // the clock every viewer shares. An archived fight is not: its bell went on a
  // clock that has since been re-anchored and possibly re-rated, so the only
  // honest reading of when it happened is the wall time it was filed at.
  const when = slot || live
    ? slotTime(feed?.clock, startsAt)
    : filed
      ? new Date(filed.airedAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  const subtitle = division
    ? `${weightClassLabel(division)}${kind === "title" ? " · title fight" : ""}${when ? ` · ${when}` : ""}`
    : "";

  const state = onAir && bout
    ? "live"
    : settled
      ? "final"
      : slot
        ? "waiting"
        : archive.status === "loading"
          ? "reading"
          : "missing";

  // Everything the archive needs to draw a rewatch. `replayable` goes false at
  // the far end of the record — and on a fight whose recording never landed,
  // until the league's own backfill closes the gap — and then this is a result
  // and a claim button.
  const rewatchable = state === "final" && filed?.replayable && pair;

  return (
    <div className="page">
      <SiteHeader
        calendar={{ season: feed?.season ?? 1, week: feed?.week ?? 1 }}
        active="/fight"
        status={{
          label:
            status === "offline"
              ? "Broadcast offline"
              : state === "live"
                ? paused ? "Broadcast paused" : "This bout is on air"
                : state === "final"
                  ? "This bout is over"
                  : "This bout is booked",
          detail: pair ? `${pair.blue.lastName} v ${pair.red.lastName}` : "Reading the card",
        }}
        action={<WalletConnect roster={roster} />}
      />

      <main className="page__body">
        <section className="fight-head" aria-label="This fight">
          <Link className="fight-head__back" href="/ring">
            ← The whole card
          </Link>
          <div>
            {subtitle ? <span className="eyebrow">{subtitle}</span> : null}
            <strong>
              {pair ? (
                <>{pair.blue.lastName} <em>v</em> {pair.red.lastName}</>
              ) : (
                "Reading the card…"
              )}
            </strong>
          </div>
          <span className="fight-head__state">
            {state === "live"
              ? paused ? "Paused" : "Live now"
              : state === "final"
                ? winnerName ? `${winnerName} won` : "Draw"
                : state === "waiting"
                  ? `First bell ${slotTime(feed?.clock, startsAt)}`
                  : ""}
          </span>
        </section>

        <section
          className="stage broadcast"
          id="live-bout"
          aria-label={pair ? `${pair.blue.lastName} versus ${pair.red.lastName}` : "Bout"}
        >
          {state === "live" && bout && pair ? (
            <FightStage
              bout={bout}
              frames={frames}
              voice={voice}
              blue={pair.blue}
              red={pair.red}
              winnerName={winner?.lastName ?? null}
              verdict={aftermath ? (
                <div className="bout-final" role="status" aria-live="polite">
                  <span className="bout-final__label">Final</span>
                  <strong className="bout-final__winner">
                    {winner ? `${winner.firstName} ${winner.lastName}` : "Draw"}
                  </strong>
                  <span className="bout-final__method">
                    {verdict && (verdict.finish === "Decision" || verdict.finish === "Draw")
                      ? `by ${verdict.finish.toLowerCase()} after ${bout.totalRounds} rounds`
                      : `by ${verdict?.finish} in round ${verdict?.round}`}
                  </span>
                  <BoutTale bout={bout} blue={pair.blue} red={pair.red} />
                </div>
              ) : null}
            />
          ) : rewatchable ? (
            /* Not on air and not gone: the archive kept it, so it can be
               watched again from the opening bell at whatever speed suits. */
            <FightReplay
              fight={filed!}
              blue={pair!.blue}
              red={pair!.red}
            />
          ) : (
            <div className="broadcast__waiting" role="status">
              <strong>
                {status === "offline"
                  ? "The league broadcast is unreachable."
                  : state === "reading"
                    ? "Looking this fight up"
                    : state === "missing"
                      ? "This fight is not on tonight's card"
                      : state === "final"
                        ? winnerName ? `${winnerName} won it` : "It was a draw"
                        : "Waiting on the bell"}
              </strong>
              <small>
                {error
                  ? error
                  : state === "reading"
                    ? "Reading the record."
                    : state === "missing"
                      ? "Cards are made a night at a time, and this one has moved on. Every fight the league has finished is on the past fights page; the card on the ring page is the one still to be fought."
                      : state === "final"
                        ? `${
                            verdict
                              ? verdict.finish === "Decision" || verdict.finish === "Draw"
                                ? `By ${verdict.finish.toLowerCase()} after ${verdict.round} rounds. `
                                : `By ${verdict.finish} in round ${verdict.round}. `
                              : ""
                          }${
                            /* Deliberately silent about why. Most fights with
                               no rewatch are simply past the end of the
                               recording horizon, but a fight can also have
                               aired without its recording landing, and telling
                               a viewer that their fight from this afternoon was
                               too old to keep is worse than telling them
                               nothing. */
                            filed && !filed.replayable
                              ? "There is no rewatch on this one. Anything you were owed is claimable below."
                              : "The book has settled. Anything you were owed is claimable below."
                          }`
                        : `${slotTime(feed?.clock, startsAt)}, ${waitLabel(startsAt - viewerTime)} away. It will start here on its own.`}
              </small>
            </div>
          )}
        </section>

        {/* The book, under the fight it is a book on. Betting rides the whole
            fight now — the maker reprices it as it airs — and only shuts
            moments before the verdict, so the market is as much a reason to
            stay as to arrive early.

            Once it has settled there is no reason to draw a trading screen:
            nothing on it can be filled, and a ticket on a fight that is over
            is an invitation to a transaction the contract will refuse. A
            settled fight gets the counter instead — claim, and withdraw. */}
        {state === "final" && (filed || pair) ? (
          <section className="fight-book" aria-label="Collecting on this fight">
            <div className="section-heading">
              <div>
                <strong>Settled</strong>
              </div>
              <span>Trading closed when the fight ended. Winnings can be claimed here.</span>
            </div>
            <SettledMarket
              night={filed?.night ?? feed?.night ?? 1}
              blue={pair
                ? { id: pair.blue.id, lastName: pair.blue.lastName }
                : { id: filed!.blueId, lastName: ringLastName(filed!.blueId, filed!.blueName) }}
              red={pair
                ? { id: pair.red.id, lastName: pair.red.lastName }
                : { id: filed!.redId, lastName: ringLastName(filed!.redId, filed!.redName) }}
              winnerId={verdict?.winnerId ?? null}
            />
          </section>
        ) : pair && feed ? (
          <section className="fight-book" aria-label="The book on this fight">
            <div className="section-heading">
              <div>
                <strong>Odds and trading</strong>
              </div>
              <span>
                {state === "waiting"
                  ? "Open now, and in-play once the bell goes."
                  : "In-play. Betting stays open until the fight ends."}
              </span>
            </div>
            <FightMarket night={feed.night} blue={pair.blue} red={pair.red} />
          </section>
        ) : null}
      </main>
      <SiteFooter />

      <Ticker
        notice={
          pair
            ? `${pair.blue.lastName} vs ${pair.red.lastName}${division ? `, ${weightClassLabel(division)}` : ""}${kind === "title" ? " title fight" : ""}.`
            : "Reading the card."
        }
      />
    </div>
  );
}
