"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  type Fighter,
  WEIGHT_CLASSES,
  type WeightClassId,
  actionPreferencesOf,
  weightClassLabel,
  xpForNextLevel,
} from "./fight-model";
import {
  type BroadcastClock,
  type DivisionState,
  airtimeEnd,
  isAftermath,
} from "./broadcast-model";
import { type BoutSummary, PLAYBACK_DELAY_MS, useAdmin, useBroadcast } from "./broadcast-store";
import {
  ACTION_LABELS,
  SiteFooter,
  SiteHeader,
  Ticker,
  heightLabel,
  recordLabel,
  slotTime,
  statLabel,
  waitLabel,
} from "./site-chrome";
import { speciesLabel } from "./fight-canvas";
import { BoutTale, FightStage, SpeakerIcon } from "./fight-stage";
import { useMusic, useSound } from "./sound";
import { ClaimPrompt, MarketDialog, NextFightMarket, useCardOdds, useMarketFeed } from "./market-panel";
import { oddsForFight, payoutMultiple, SIDE_BLUE, SIDE_RED, type PricePoint } from "./market";
import { WalletConnect } from "./wallet-button";
import { openingLineFor, openingOdds } from "./opening-line";

/** The public face of the league.
 *
 * Nothing on this page starts a fight. The card is on the server and every
 * browser is a viewer of it, which is why two people watching see the same
 * round, and why closing the tab does not stop the night. */

function nameOf(roster: Fighter[], id: string | null | undefined) {
  if (!id) return "—";
  return roster.find((fighter) => fighter.id === id)?.lastName ?? id;
}

function boutsLabel(count: number) {
  return `${count} bout${count === 1 ? "" : "s"} on record`;
}


/* ------------------------------------------------------------------ divisions */

const DivisionBoard = memo(function DivisionBoard({
  divisions,
  roster,
}: {
  divisions: DivisionState[];
  roster: Fighter[];
}) {
  return (
    <div className="division-grid">
      {WEIGHT_CLASSES.map((weightClass) => {
        const division = divisions.find((entry) => entry.id === weightClass.id);
        if (!division) return null;
        const champion = roster.find((fighter) => fighter.id === division.championId);
        return (
          <article className={`division-card division-card--${weightClass.id}`} key={weightClass.id}>
            <header>
              <span className="eyebrow">{weightClass.label}</span>
              <small>up to {weightClass.limit} lb</small>
            </header>
            <div className="division-card__champion">
              <span className="belt" aria-hidden="true" />
              <div>
                <small>Champion</small>
                <strong>{champion ? `${champion.firstName} ${champion.lastName}` : "Vacant"}</strong>
                <em>
                  {champion ? `${recordLabel(champion)} · L${champion.level}` : "—"}
                  {division.titleDefences > 0 ? ` · ${division.titleDefences} defence${division.titleDefences > 1 ? "s" : ""}` : ""}
                </em>
              </div>
            </div>
            <ol className="division-card__ladder">
              {division.ladder.slice(0, 9).map((id, index) => {
                const fighter = roster.find((entry) => entry.id === id);
                return (
                  <li key={id}>
                    <b>{index + 1}</b>
                    <span>{fighter ? `${fighter.firstName} ${fighter.lastName}` : id}</span>
                    <small>{fighter ? `${recordLabel(fighter)} · L${fighter.level}` : ""}</small>
                  </li>
                );
              })}
            </ol>
            <footer>
              {division.titleFightThisWeek
                ? "Title settled this week"
                : "Title fight due at the end of the week"}
            </footer>
          </article>
        );
      })}
    </div>
  );
});

/* ----------------------------------------------------------------------- card */


/** Tonight's card end to end: what has been fought, what is on now, and what is
 *  still booked — with the verdict landing in its own slot as it lands.
 *
 *  A `<details>`, so the whole night can be folded away when the fight is what
 *  you actually came for. */
/** The trading popup for a row of the card.
 *
 * Its own component only so the roster lookup has somewhere to fail safely: a
 * bout naming an athlete this browser has not been sent yet simply does not
 * open, rather than rendering a ticket with a blank fighter on one side of it. */
function CardTradeDialog({
  trading,
  roster,
  night,
  clock,
  onClose,
}: {
  trading: { bout: BoutSummary; side: 0 | 1 } | null;
  roster: Fighter[];
  night: number;
  clock: BroadcastClock | undefined;
  onClose: () => void;
}) {
  if (!trading) return null;
  const { bout, side } = trading;
  const blue = roster.find((fighter) => fighter.id === bout.blueId);
  const red = roster.find((fighter) => fighter.id === bout.redId);
  if (!blue || !red) return null;
  return (
    // Keyed on the bout, so switching fights rebuilds the ticket rather than
    // carrying one fight's amount and limit price onto another's book.
    <MarketDialog
      key={bout.id}
      night={night}
      blue={blue}
      red={red}
      opensOn={side}
      subtitle={`${weightClassLabel(bout.division)}${bout.kind === "title" ? " · title fight" : ""} · ${slotTime(clock, bout.startsAt)}`}
      onClose={onClose}
    />
  );
}

/** One fight on the card, priced.
 *
 * Two rows, one per corner, each its own button: the bar is the market's read
 * of that man and clicking him opens the ticket already on his side. Only a
 * starting point — the popup still has both corners on it, because the trade
 * somebody meant is often the one they were about to talk themselves out of. */
function CardBout({
  bout,
  roster,
  clock,
  odds,
  onTrade,
}: {
  bout: BoutSummary;
  roster: Fighter[];
  clock: BroadcastClock | undefined;
  odds: { blue: number; red: number; closed: boolean; resolved: boolean } | null;
  onTrade: ((side: 0 | 1) => void) | null;
}) {
  const winnerId = bout.result?.winnerId ?? null;
  const decided = Boolean(bout.result);

  const corner = (side: 0 | 1) => {
    const id = side === SIDE_BLUE ? bout.blueId : bout.redId;
    const percent = odds ? (side === SIDE_BLUE ? odds.blue : odds.red) : null;
    const tone = side === SIDE_BLUE ? "blue" : "red";
    const won = decided ? winnerId === id : undefined;
    return (
      <button
        key={side}
        type="button"
        className={`card-bout__side card-bout__side--${tone}`}
        data-won={won === undefined ? undefined : String(won)}
        disabled={onTrade === null}
        onClick={(event) => {
          event.stopPropagation();
          onTrade?.(side);
        }}
      >
        <span className="card-bout__name">{nameOf(roster, id)}</span>
        {percent !== null ? (
          <>
            <span className="card-bout__pay">{payoutMultiple(percent).toFixed(2)}x</span>
            <strong className="card-bout__pct">{Math.round(percent)}%</strong>
            {/* The bar is the same number as the pill beside it, which is the
                point — a column of these reads as a shape before it reads as
                digits, and that is how you spot the mismatch worth trading. */}
            <i className="card-bout__bar" style={{ width: `${Math.round(percent)}%` }} />
          </>
        ) : (
          <span className="card-bout__pay">—</span>
        )}
      </button>
    );
  };

  return (
    <li
      className={[
        "card-bout",
        `card-bout--${bout.division}`,
        `card-bout--${bout.status}`,
        bout.kind === "title" ? "card-bout--title" : "",
      ].filter(Boolean).join(" ")}
    >
      <header className="card-bout__head">
        {/* The division is the way in to the fight's own page — the stream of
            that bout and nothing else, with the whole book under it. The two
            corners below stay what they were: a tap on a man is a tap on his
            price, and opens the ticket over the card rather than leaving it. */}
        <Link
          className={`card-bout__weight card-bout__weight--${bout.division}`}
          href={`/fight/${bout.id}`}
        >
          {weightClassLabel(bout.division)}
        </Link>
        {bout.kind === "title" ? <i className="card-bout__belt">title</i> : null}
        <time>
          {bout.status === "live" ? "Live" : slotTime(clock, bout.startsAt)}
        </time>
      </header>

      {corner(SIDE_BLUE)}
      {corner(SIDE_RED)}

      <footer className="card-bout__foot">
        <span>
          {bout.result
            ? bout.result.winnerId
              ? `${bout.result.finish} · R${bout.result.round}`
              : `Draw · ${bout.result.round} rounds`
            : bout.status === "live"
              ? "In the ring"
              : `${bout.totalRounds} rounds`}
        </span>
        {odds ? (
          <i className="card-bout__trade">
            {/* `decided` as well as `closed`: the book truly shuts the second
                the finish happens on the league clock, seconds before that
                finish reaches this screen's delayed picture — and "Betting
                shut" on a row still marked Live announces it. The chip waits
                for the picture; the ticket behind it tells the truth. */}
            {odds.resolved ? "Claim →" : odds.closed && decided ? "Betting shut" : "Trade →"}
          </i>
        ) : null}
      </footer>
    </li>
  );
}

function CardRail({
  card,
  clock,
  roster,
  night,
  viewerTime,
}: {
  card: BoutSummary[];
  clock: BroadcastClock | undefined;
  roster: Fighter[];
  night: number;
  /** The picture's clock — the league clock less the playback delay. */
  viewerTime: number;
}) {
  const [trading, setTrading] = useState<{ bout: BoutSummary; side: 0 | 1 } | null>(null);
  // The whole night's prices in one request, so fifteen cards cost one call.
  const board = useCardOdds(night, card.length > 0);
  // A slot the server has settled but whose finish has not aired on this
  // screen yet still reads as live: the rail sits right under the canvas, and
  // a result row here would name the winner seconds before the picture does.
  const seen = (bout: BoutSummary) => bout.status !== "final" || bout.endsAt <= viewerTime;
  const fought = card.filter((bout) => bout.status === "final" && seen(bout)).length;
  // A card whose first bell has not gone yet is the next night, not this one:
  // it is made and posted the moment the previous night ends, and then sits
  // there to be read for the six hours in between.
  const doorsAt = card.length > 0 && card[0].status === "scheduled"
    ? card[0].startsAt
    : null;
  return (
    <details className="card-rail" open>
      <summary>
        {doorsAt !== null ? <span className="eyebrow">Fight night {night}</span> : null}
        <strong className="card-rail__title">
          {doorsAt === null ? "Tonight's fights" : "Next card"}
        </strong>
        <span className="card-rail__count">
          {card.length === 0
            ? "building…"
            : doorsAt !== null
              ? `${card.length} fights · first bell ${slotTime(clock, doorsAt)}, ${waitLabel(doorsAt - viewerTime)} away`
              : `${fought}/${card.length} fought · times shift as fights end early`}
        </span>
      </summary>
      <ol className="card-rail__list">
        {card.length === 0 ? (
          <li className="card-rail__empty">The card is being made.</li>
        ) : null}
        {card.map((slot) => {
          const bout = seen(slot) ? slot : { ...slot, status: "live" as const, result: null };
          const booked = oddsForFight(board, bout.blueId, bout.redId);
          // A book nobody has quoted yet shows the league's own line rather
          // than an even-money price it does not mean. Only for fights still to
          // come: a settled one has a real number on it, and 99/1 is that.
          const line = booked?.quoted ? null : openingLineFor(roster, bout.blueId, bout.redId);
          const odds = booked && line !== null
            ? { ...booked, blue: line, red: 100 - line }
            : booked;
          // Every fight with a book opens, including the ones that are over.
          // Trading stops at the bell, but a winning ticket has to be
          // reachable afterwards or the money is stranded — the fight it was
          // bought on has left the ring, and this row is the only way back to
          // it. Every other fight on the card keeps trading meanwhile: only the
          // bout in the ring closes at its own bell.
          const openable = odds !== null;
          return (
            <CardBout
              key={bout.id}
              bout={bout}
              roster={roster}
              clock={clock}
              odds={odds}
              onTrade={openable ? (side) => setTrading({ bout, side }) : null}
            />
          );
        })}
      </ol>

      <CardTradeDialog
        trading={trading}
        roster={roster}
        night={night}
        clock={clock}
        onClose={() => setTrading(null)}
      />
    </details>
  );
}

/* ---------------------------------------------------------------------- admin */

function AdminPanel({
  divisions,
  rate,
  paused,
  waiting,
}: {
  divisions: DivisionState[];
  rate: number;
  paused: boolean;
  /** True while the card is made but its first bell has not gone yet. */
  waiting: boolean;
}) {
  const admin = useAdmin();
  const [open, setOpen] = useState(false);

  // Not the operator's wallet — and for everybody else on the site that means
  // there is nothing here at all, not a locked door with a button on it.
  if (!admin.operator) return null;

  // The button is the whole panel until it is asked for. Folded away, the
  // operator's own view of the league is the one everybody else is watching.
  if (!open) {
    return (
      <section className="admin-panel" aria-label="Admin">
        <button className="admin-panel__toggle" type="button" onClick={() => setOpen(true)}>
          Admin +
        </button>
      </section>
    );
  }

  if (!admin.unlocked) {
    return (
      <section className="admin-panel" aria-label="Admin">
        <button className="admin-panel__toggle" type="button" onClick={() => setOpen(false)}>
          Admin −
        </button>
        <div className="admin-panel__unlock">
          <p>Sign a pass with the operator wallet to take the card.</p>
          <button
            className="button button--blue"
            type="button"
            disabled={admin.busy}
            onClick={() => void admin.unlock()}
          >
            {admin.busy ? "Waiting on the wallet…" : "Sign in as operator"}
          </button>
          {admin.message ? <p className="admin-panel__message">{admin.message}</p> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="admin-panel admin-panel--unlocked" aria-label="Admin controls">
      <div className="admin-panel__bar">
        <span className="eyebrow">Admin · you are driving the card</span>
        <button className="button button--quiet" type="button" onClick={() => setOpen(false)}>Hide</button>
        <button className="button button--quiet" type="button" onClick={admin.lock}>Lock</button>
      </div>

      <div className="admin-panel__row">
        <button
          className="button button--quiet"
          type="button"
          disabled={admin.busy}
          onClick={() => void admin.command({ action: paused ? "resume" : "pause" })}
        >
          {paused ? "Resume broadcast" : "Pause broadcast"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={admin.busy}
          onClick={() => void admin.command({ action: "skip" })}
        >
          End current bout
        </button>
        {/* The six hours between cards are a schedule, not a rule. */}
        <button
          className="button button--quiet"
          type="button"
          disabled={admin.busy || !waiting}
          onClick={() => void admin.command({ action: "doors" })}
        >
          Start fight night now
        </button>
        <button
          className="button button--stop"
          type="button"
          disabled={admin.busy}
          onClick={() => {
            if (!window.confirm(
              "Reset the current card? Running and scheduled bouts will be replaced, then the new card will start after a five-minute countdown.",
            )) return;
            void admin.command({ action: "reset" });
          }}
        >
          Reset card & start in 5 min
        </button>
        <fieldset className="speed-control">
          <legend>Broadcast speed</legend>
          {[1, 2, 4].map((value) => (
            <button
              key={value}
              type="button"
              className={rate === value ? "speed-control__button speed-control__button--active" : "speed-control__button"}
              aria-pressed={rate === value}
              disabled={admin.busy}
              onClick={() => void admin.command({ action: "rate", rate: value })}
            >
              {value === 1 ? "Live" : `${value}×`}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="admin-panel__row">
        {divisions.map((division) => (
          <button
            key={division.id}
            className="button button--quiet"
            type="button"
            disabled={admin.busy}
            onClick={() => void admin.command({ action: "title", division: division.id })}
          >
            Force {weightClassLabel(division.id)} title
          </button>
        ))}
        <button
          className="button button--quiet"
          type="button"
          disabled={admin.busy}
          onClick={() => void admin.command({ action: "week" })}
        >
          Advance week
        </button>
      </div>

      {admin.message ? <p className="admin-panel__message">{admin.message}</p> : null}
    </section>
  );
}

/* --------------------------------------------------------------------- roster */

const RosterCard = memo(function RosterCard({
  fighter,
  rank,
  liveCorner,
}: {
  fighter: Fighter;
  rank: number;
  liveCorner: "blue" | "red" | null;
}) {
  const tendencies = useMemo(
    () => actionPreferencesOf(fighter).slice(0, 3),
    [fighter],
  );
  const nextLevel = xpForNextLevel(fighter.level);

  return (
    <article className={`roster-card${liveCorner ? ` roster-card--live roster-card--live-${liveCorner}` : ""}`}>
      <header className="roster-card__head">
        <span className="roster-card__rank">{String(rank).padStart(2, "0")}</span>
        <div className="roster-card__name">
          {/* Mononyms — the ring names have no first line to print. */}
          {fighter.firstName ? <span>{fighter.firstName}</span> : null}
          <strong>{fighter.lastName}</strong>
          <em>“{fighter.nickname}”</em>
        </div>
        <div className="roster-card__rating">
          <strong>{Math.round(fighter.rating)}</strong>
          <small>rating</small>
        </div>
      </header>

      {liveCorner ? (
        <p className={`roster-card__live roster-card__live--${liveCorner}`}>
          Fighting now in the {liveCorner} corner
        </p>
      ) : null}

      <div className="roster-card__level">
        <span>Level {fighter.level}</span>
        <i><b style={{ width: `${Math.min(100, (fighter.xp / nextLevel) * 100)}%` }} /></i>
        <small>{fighter.xp}/{nextLevel} xp</small>
      </div>

      <dl className="roster-card__facts">
        <div><dt>Record</dt><dd>{recordLabel(fighter)} <small>({fighter.record.knockouts} KO)</small></dd></div>
        <div><dt>Style</dt><dd>{fighter.archetype}</dd></div>
        <div><dt>Stance</dt><dd>{fighter.stance}</dd></div>
        <div><dt>Age</dt><dd>{fighter.age}</dd></div>
        <div><dt>Build</dt><dd>{heightLabel(fighter.height)} · {fighter.weight} lb</dd></div>
        <div><dt>Reach</dt><dd>{fighter.reach}&quot;</dd></div>
        <div><dt>Species</dt><dd>{speciesLabel(fighter.seed)}</dd></div>
        {/* Every fight on the card teaches both men, so this is the number that
            actually moves. `evaluatedBouts` counts guarded gym sparring instead;
            the autonomous rotation keeps those two learning records separate. */}
        <div><dt>Learned</dt><dd>{fighter.policy.learnedDecisions.toLocaleString()} decisions</dd></div>
      </dl>

      <div className="roster-card__block">
        <span className="eyebrow">Attributes</span>
        <div className="stat-grid">
          {(Object.entries(fighter.stats) as [keyof Fighter["stats"], number][]).map(([stat, value]) => (
            <div className="compact-stat" key={stat}>
              <span>{statLabel(stat)}</span>
              <strong>{Math.round(value)}</strong>
              <i><b style={{ width: `${value}%` }} /></i>
            </div>
          ))}
        </div>
      </div>

      <div className="roster-card__block">
        <span className="eyebrow">Conditioning</span>
        <div className="stat-grid">
          {([
            ["Leg power", fighter.conditioning.lowerBodyPower],
            ["Leg endurance", fighter.conditioning.lowerBodyEndurance],
            ["Kinetic chain", fighter.conditioning.kineticChain],
            ["Shoulders", fighter.conditioning.shoulderEndurance],
          ] as const).map(([label, value]) => (
            <div className="compact-stat" key={label}>
              <span>{label}</span>
              <strong>{value.toFixed(1)}</strong>
              <i><b style={{ width: `${value}%` }} /></i>
            </div>
          ))}
        </div>
        <small>{fighter.conditioning.workloadSteps.toLocaleString()} force-integrated steps · {fighter.conditioning.adaptationCycles} adaptations</small>
      </div>

      <div className="roster-card__block">
        <span className="eyebrow">Favourite punches</span>
        <ul className="roster-card__tendencies">
          {tendencies.map(({ action, value }) => (
            <li key={action}>
              <span>{ACTION_LABELS[action]}</span>
              <i><b style={{ width: `${Math.min(100, value * 4.4)}%` }} /></i>
              <strong>{value}%</strong>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
});

const RosterBoard = memo(function RosterBoard({
  roster,
  liveBlueId,
  liveRedId,
}: {
  roster: Fighter[];
  liveBlueId: string | null;
  liveRedId: string | null;
}) {
  const [division, setDivision] = useState<WeightClassId | "all">("all");
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const filtered = division === "all"
      ? roster
      : roster.filter((fighter) => fighter.weightClass === division);
    // The number beside an athlete is where he stands in the list he was
    // filtered into, so it is fixed before the search runs — otherwise typing
    // a name promotes whoever matches to 01.
    const ranked = [...filtered]
      .sort((a, b) => b.rating - a.rating || b.record.wins - a.record.wins)
      .map((fighter, index) => ({ fighter, rank: index + 1 }));
    // A name and a nickname are the two things anybody is looking at on the
    // card, so both answer to the box.
    const term = search.trim().toLowerCase();
    if (!term) return ranked;
    return ranked.filter(({ fighter }) =>
      `${fighter.firstName} ${fighter.lastName} ${fighter.nickname}`
        .toLowerCase()
        .includes(term),
    );
  }, [division, roster, search]);

  return (
    <>
      <div className="roster-filter">
        <div className="division-filter" role="tablist" aria-label="Filter by division">
          <button
            type="button"
            role="tab"
            aria-selected={division === "all"}
            className={division === "all" ? "division-filter__tab division-filter__tab--active" : "division-filter__tab"}
            onClick={() => setDivision("all")}
          >
            All {roster.length}
          </button>
          {WEIGHT_CLASSES.map((weightClass) => (
            <button
              key={weightClass.id}
              type="button"
              role="tab"
              aria-selected={division === weightClass.id}
              className={division === weightClass.id ? "division-filter__tab division-filter__tab--active" : "division-filter__tab"}
              onClick={() => setDivision(weightClass.id)}
            >
              {weightClass.label}
            </button>
          ))}
        </div>
        <label className="roster-search">
          <span className="sr-only">Search athletes by name</span>
          <input
            type="search"
            value={search}
            placeholder="Search by name"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {search.trim() && shown.length === 0 ? (
        <p className="roster-empty">No athlete answers to “{search.trim()}”.</p>
      ) : null}
      <div className="roster-grid">
        {shown.map(({ fighter, rank }) => (
          <RosterCard
            key={fighter.id}
            fighter={fighter}
            rank={rank}
            liveCorner={
              liveBlueId === fighter.id ? "blue" : liveRedId === fighter.id ? "red" : null
            }
          />
        ))}
      </div>
    </>
  );
});

/* ----------------------------------------------------------------------- page */

/** The width below which the stage has no full-size version to offer.
 *
 * The compact rules live inside a `min-width: 1181px` block, because compact is
 * about fitting three columns and a fight on one screen — on a phone there is
 * one column either way. Below this the control was a button that changed
 * nothing, so it is not drawn, and the state it would have set is assumed. */
const COMPACT_ONLY = "(max-width: 1180px)";

function useCompactOnly() {
  // False on the server and on the first paint, then corrected. The button is
  // hidden by CSS at the same breakpoint, so nothing flashes in or out — this
  // is only about the class the stage carries.
  const [only, setOnly] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_ONLY);
    const read = () => setOnly(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  return only;
}

/** One corner of the next bout, standing beside the intermission tape.
 *
 * The tape at its natural size leaves two dark shoulders on a wide stage, and
 * dead air next to a "we'll be right back" card reads as a layout accident.
 * The matchup is the one thing a viewer waiting through the break actually
 * wants, so each shoulder is a betting card: one man's tale of the tape with
 * his live price under it — blue on the left, red on the right, the same
 * corners the loading screen itself wears. */
/** One fighter's price over the book's life, on a fixed 0–100 scale — toward
 *  the top he is becoming the favourite, toward the bottom the long shot. The
 *  big chart below auto-fits its range; this one deliberately does not, so the
 *  slope IS the story. Same stretched-SVG scheme as the confidence trend. */
function CornerSpark({ series }: { series: number[] }) {
  const step = 100 / (series.length - 1);
  const points = series
    .map((value, index) => {
      const clamped = Math.max(0, Math.min(100, value));
      return `${(index * step).toFixed(2)},${(28 - (clamped / 100) * 26).toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      className="intermission-corner__spark"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline className="intermission-corner__spark-glow" points={points} />
      <polyline points={points} />
    </svg>
  );
}

function IntermissionCorner({
  fighter,
  corner,
  odds,
  history,
  tag,
  openable,
  onBet,
}: {
  fighter: Fighter;
  corner: "blue" | "red";
  odds: number;
  history: PricePoint[];
  tag: string;
  openable: boolean;
  onBet: () => void;
}) {
  // His side of every priced moment; before anything has traded, the opening
  // line drawn flat.
  const series = useMemo(() => {
    const mine = history.map((point) => (corner === "blue" ? point.blue : 100 - point.blue));
    return mine.length >= 2 ? mine : [odds, odds];
  }, [corner, history, odds]);

  return (
    <aside className={`intermission-corner intermission-corner--${corner}`}>
      <span className="eyebrow">{corner} corner · {tag}</span>
      <strong>{fighter.firstName} {fighter.lastName}</strong>
      <small><em>&ldquo;{fighter.nickname}&rdquo;</em> · {fighter.stance} · L{fighter.level}</small>
      <dl>
        <div><dt>Record</dt><dd>{recordLabel(fighter)} ({fighter.record.knockouts} KO)</dd></div>
        <div><dt>Rating</dt><dd>{Math.round(fighter.rating)}</dd></div>
        <div><dt>Build</dt><dd>{heightLabel(fighter.height)} · {fighter.weight} lb</dd></div>
        <div><dt>Reach</dt><dd>{fighter.reach}&quot;</dd></div>
        <div><dt>Style</dt><dd>{fighter.archetype}</dd></div>
      </dl>
      <button
        type="button"
        className={`next-fight__bet next-fight__bet--${corner}`}
        disabled={!openable}
        onClick={onBet}
      >
        <span>Bet {fighter.lastName}</span>
        <strong>{Math.round(odds)}¢</strong>
        <em>{payoutMultiple(odds).toFixed(2)}x if he wins</em>
        <CornerSpark series={series} />
      </button>
    </aside>
  );
}

/** The idle tape. There are three of them, but cutting between them every
 *  time one ends reads as a stutter rather than a channel, so each runs a long
 *  block of loops before the swap. A looping <video> never fires "ended", so
 *  the block is counted by replaying by hand and remounting on the change —
 *  autoplay only picks the new tape up from a fresh element.
 *
 *  Which tape opens is a coin toss; from there the order is fixed, so a viewer
 *  who sits through an intermission still sees all three. The reel only mounts
 *  once the feed says we're at intermission, so the server never renders it and
 *  the random pick can't disagree with a hydrated one. */
const REEL_TAPES = ["/BetweenCardsLoadingScreen.mp4", "/BetweenCardsLoadingScreen1.mp4", "/BetweenCardsLoadingScreen2.mp4"];
const REEL_LOOPS = 20;

function BroadcastReel() {
  const [tape, setTape] = useState(() => Math.floor(Math.random() * REEL_TAPES.length));
  const loops = useRef(0);

  return (
    <video
      key={tape}
      className="broadcast__reel"
      src={REEL_TAPES[tape]}
      autoPlay
      muted
      // Two of the three tapes carry an audio track of their own, and `muted`
      // above is a React prop — set on the element, never rendered as the
      // attribute a parser would see. Asserted here as well so the tape cannot
      // find a way onto the air under the house music.
      ref={(el) => {
        if (el) el.muted = true;
      }}
      playsInline
      aria-hidden="true"
      onEnded={(event) => {
        loops.current += 1;
        if (loops.current < REEL_LOOPS) {
          void event.currentTarget.play();
          return;
        }
        loops.current = 0;
        setTape((current) => (current + 1) % REEL_TAPES.length);
      }}
    />
  );
}

/** The intermission stage: the tape in the middle, a betting card on each
 *  shoulder, and one trade ticket shared between them.
 *
 * Same book, same fallback line and same dialog as the next fight's panel
 * below — this is a second window onto that market, not a second market. */
function IntermissionMatchup({
  night,
  blue,
  red,
  tag,
  subtitle,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  /** Why THIS fight is on the stage: "most traded" when the money picked it,
   *  "next bout" when nothing has traded and the schedule did. */
  tag: string;
  subtitle: string;
}) {
  const { quote } = useMarketFeed(night, blue.id, red.id, true);
  const [trading, setTrading] = useState<0 | 1 | null>(null);

  const line = useMemo(() => openingOdds(blue, red), [blue, red]);
  const blueOdds = quote?.quoted ? quote.blue : line.blue;
  const openable = Boolean(quote && !quote.closed && !quote.resolved);

  return (
    <div className="broadcast__intermission">
      <IntermissionCorner
        fighter={blue}
        corner="blue"
        odds={blueOdds}
        history={quote?.history ?? []}
        tag={tag}
        openable={openable}
        onBet={() => setTrading(SIDE_BLUE)}
      />
      <BroadcastReel />
      <IntermissionCorner
        fighter={red}
        corner="red"
        odds={100 - blueOdds}
        history={quote?.history ?? []}
        tag={tag}
        openable={openable}
        onBet={() => setTrading(SIDE_RED)}
      />
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

/** The live fight's book, riding under the stage while the fight airs.
 *
 * In-play: the book no longer shuts at the opening bell — it trades through
 * the whole fight, with the league's maker repricing it off what has aired,
 * so these two numbers move with the action on the canvas above them. The
 * strip never says "closed" while the fight is on the canvas: the book truly
 * shuts the second the finish happens on the league clock, which is seconds
 * before that finish reaches the viewer's delayed picture, and a strip going
 * quiet in that window is an announcement that the fight is decided. So the
 * last quote stands on screen until the verdict panel takes the stage, and an
 * order sent into the shut book comes back unfilled — the way a book that
 * closed under you should read. Same book and same ticket as every other
 * window — the buttons open the shared `MarketDialog`. */
function InPlayMarket({
  night,
  blue,
  red,
  subtitle,
}: {
  night: number;
  blue: Fighter;
  red: Fighter;
  subtitle: string;
}) {
  const { quote } = useMarketFeed(night, blue.id, red.id, true);
  const [trading, setTrading] = useState<0 | 1 | null>(null);

  const line = useMemo(() => openingOdds(blue, red), [blue, red]);
  const blueOdds = quote?.quoted ? quote.blue : line.blue;
  // Deliberately not `!quote.closed`: the close happens while the finish is
  // still airing, and a strip that greys out then is the spoiler this whole
  // component is built not to be.
  const openable = Boolean(quote && !quote.resolved);

  // No book on the fight at all — a deployment without a market wired up
  // should show a clean stage, not an empty strip.
  if (!quote) return null;

  const bet = (corner: 0 | 1) => {
    const fighter = corner === SIDE_BLUE ? blue : red;
    const odds = corner === SIDE_BLUE ? blueOdds : 100 - blueOdds;
    return (
      <button
        type="button"
        className={`next-fight__bet next-fight__bet--${corner === SIDE_BLUE ? "blue" : "red"} inplay-market__bet`}
        disabled={!openable}
        onClick={() => setTrading(corner)}
      >
        <span>{fighter.lastName}</span>
        <strong>{Math.round(odds)}¢</strong>
        <em>{payoutMultiple(odds).toFixed(2)}x</em>
      </button>
    );
  };

  return (
    <div className="inplay-market">
      {bet(SIDE_BLUE)}
      <div className="inplay-market__state">
        <strong>In-play</strong>
        <small>The book trades until the verdict is read</small>
      </div>
      {bet(SIDE_RED)}
      {/* The line itself, drawn: blue holds the left of the rail for as long as
          the market has him ahead, and the seam between the two colours slides
          as the maker reprices. The same number as the two prices above it —
          a shape is quicker to read across a room than a pair of digits. */}
      <i
        className="inplay-market__line"
        style={{ width: `${Math.round(blueOdds)}%` }}
        aria-hidden="true"
      />
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

export function ForgeLeague() {
  const { feed, bout, frames, voice, fighters, roster, status, error, leagueTime, paused, rate } =
    useBroadcast();
  // Full size is how the ring is meant to be watched, so that is the default;
  // the corner control drops it to a compact stage for anyone who wants the
  // standings and the card on screen at the same time. On a phone there is no
  // choice to make — the stage is one column at any setting — so it is compact
  // and the control is not offered.
  const [compact, setCompact] = useState(false);
  const compactOnly = useCompactOnly();
  const stageCompact = compact || compactOnly;

  const live = feed?.live ?? null;
  // The clock the picture runs on. Playback holds PLAYBACK_DELAY_MS behind the
  // league clock, so everything shown around the canvas — countdowns, the
  // verdict, settled card slots — reads this clock instead, or it announces
  // things the viewer has not seen yet. Only the market stays on the real
  // clock: the book genuinely closes when the chain says it does.
  const viewerTime = leagueTime - PLAYBACK_DELAY_MS;
  // Seconds until the next bell the viewer will actually see. In the stretch
  // where the real bell has gone but the picture is still counting down, the
  // bout already in the ring is the one to count to — `feed.upcoming` has
  // moved on to the fight after it.
  const secondsToNext = live && !bout
    ? Math.max(0, Math.round((live.startsAt - viewerTime) / 1000))
    : feed?.upcoming
      ? Math.max(0, Math.round((feed.upcoming.startsAt - viewerTime) / 1000))
      : null;
  // Between cards rather than between fights: the next night is already made
  // and on the board, and the first bell of it is hours rather than seconds off.
  const doorsAt = feed?.card.length && feed.card[0].status === "scheduled"
    ? feed.card[0].startsAt
    : null;

  // The fight the empty ring is waiting on — the one after this if the card is
  // mid-run, the first of the night if the doors have not opened yet. Its book
  // is open either way, and the gap is the best moment on the page to read it.
  const nextBout = feed?.upcoming
    ?? feed?.card.find((slot) => slot.status === "scheduled")
    ?? null;
  const nextFighters = nextBout
    ? {
        blue: roster.find((fighter) => fighter.id === nextBout.blueId),
        red: roster.find((fighter) => fighter.id === nextBout.redId),
      }
    : null;

  // Which matchup flanks the intermission tape. The next bout is the default
  // story, but if the money is three slots down the card — a title fight
  // everybody is pricing — that is the book worth putting on the stage. The
  // busiest open book wins; a night where nothing has traded yet falls back
  // to the next bout.
  const board = useCardOdds(feed?.night ?? 0, Boolean(feed?.card.length) && !live);
  const featuredBout = useMemo(() => {
    let best: BoutSummary | null = null;
    let bestVolume = 0;
    for (const row of board) {
      if (row.closed || row.resolved || row.volume <= bestVolume) continue;
      const slot = feed?.card.find(
        (bout) =>
          (bout.blueId === row.fighterA && bout.redId === row.fighterB) ||
          (bout.blueId === row.fighterB && bout.redId === row.fighterA),
      );
      if (!slot || slot.status !== "scheduled") continue;
      best = slot;
      bestVolume = row.volume;
    }
    return best;
  }, [board, feed]);

  const stageBout = featuredBout ?? nextBout;
  const stageFighters = stageBout
    ? {
        blue: roster.find((fighter) => fighter.id === stageBout.blueId),
        red: roster.find((fighter) => fighter.id === stageBout.redId),
      }
    : null;

  // The fight that has just been decided: the one still standing on the stage
  // through the aftermath, or the last the card finished once the ring is
  // empty again. Its book is settled, which is the only window where anybody
  // has winnings to collect on it.
  const justFought = [...(feed?.card ?? [])].reverse().find((slot) => slot.status === "final")
    ?? null;
  const settledFighters = justFought
    ? {
        blue: roster.find((fighter) => fighter.id === justFought.blueId),
        red: roster.find((fighter) => fighter.id === justFought.redId),
      }
    : null;

  // The stretch after the final bell where the verdict stays on the stage, so
  // there is time to read who won and how before the card moves on. The
  // playhead decides when it starts — the replayed frames flip `running` off
  // exactly when the finish is drawn — with the delayed clock covering the
  // moments the player has nothing loaded, like joining mid-aftermath.
  const aftermath = live
    ? bout ? !bout.running : isAftermath(live, viewerTime)
    : false;
  const holdSeconds = live
    ? Math.max(0, Math.round((airtimeEnd(live) - leagueTime) / 1000))
    : 0;

  // House music for the empty ring — between fights, between cards, over the
  // aftermath while the verdict stands, and through the last countdown seconds
  // where the real bell has rung but the picture has not caught up yet. Gated
  // on the feed so a page still connecting does not open with a song about
  // nothing.
  //
  // What a viewer hears follows what that viewer can see, so the test is the
  // stage's own rather than the card's: the picture runs a playback delay
  // behind the league clock, and a bout whose recording or whose athletes have
  // not arrived draws nothing at all while the card says it is on air. Asked of
  // `live`, this left an empty stage with no music over it — silence that reads
  // as the sound being broken.
  const ringIsLive = Boolean(bout && fighters && bout.running);
  useMusic("intermission", Boolean(feed) && !ringIsLive);
  // The stage's speaker only exists while a bout is up, but between fights is
  // exactly when the music plays — so the idle notice carries its own.
  const sound = useSound();

  const boutState = !live
    ? doorsAt !== null ? "Between cards" : "Between fights"
    : aftermath
      ? "Final"
      : bout && bout.breakTime > 0
        ? "Between rounds"
        : paused
          ? "Broadcast paused"
          : bout
            ? "Fighting"
            : "Seconds to the bell";

  // The verdict's timing belongs to the playhead — the panel goes up when the
  // finish is drawn, never sooner — but the verdict itself is still read off
  // the card: the server named the winner a full playback delay ago, so the
  // result row is always on the feed by the time the panel is due. (It used to
  // be the other way round — clock-timed panel over a throttled replay — and
  // that printed a verdict of "by null".)
  const verdict = aftermath ? live?.result ?? null : null;
  const winnerId = verdict ? verdict.winnerId : bout?.winnerId ?? null;
  const finish = verdict?.finish ?? bout?.finish ?? null;
  const finishRound = verdict?.round ?? bout?.round ?? 0;
  const winner = winnerId && fighters
    ? (winnerId === fighters.blue.id ? fighters.blue : fighters.red)
    : null;
  const winnerName = winner?.lastName ?? null;

  return (
    <div className="page">
      <SiteHeader
        calendar={{ season: feed?.season ?? 1, week: feed?.week ?? 1 }}
        active="/ring"
        status={{
          label:
            status === "offline"
              ? "Broadcast offline"
              : live
                ? paused ? "Broadcast paused" : "Bout in progress"
                : doorsAt !== null
                  ? `Fight night ${feed?.night ?? 1} booked`
                  : "Between fights",
          detail: `${roster.length} athletes · ${boutsLabel(feed?.boutsCompleted ?? 0)}`,
        }}
        action={<WalletConnect roster={roster} />}
      />

      <main className="page__body">
        <section className="ring-masthead" aria-label="Forge League">
          <span className="ring-masthead__blue" aria-hidden="true" />
          <div className="ring-masthead__mark" aria-hidden="true"><i>F</i><i>L</i></div>
          <strong><span>Forge</span> League</strong>
          <small>AI athletes · Real skill · Unscripted fights</small>
          <span className="ring-masthead__red" aria-hidden="true" />
        </section>

        <section
          className={stageCompact ? "stage broadcast broadcast--compact" : "stage broadcast"}
          id="live-bout"
          aria-label="Live bout"
        >
          <div className="section-heading section-heading--stage">
            <div>
              {live ? (
                <span className="eyebrow">
                  {`${weightClassLabel(live.division)}${live.kind === "title" ? " · title fight" : " · contender bout"}`}
                </span>
              ) : null}
              <strong>Live bout</strong>
            </div>
            <span>
              {boutState}
              {live ? ` · Sanction FL-${feed?.season}${feed?.week}-${String(live.id).padStart(4, "0")}` : ""}
            </span>
            <button
              className="stage-size"
              type="button"
              onClick={() => setCompact((value) => !value)}
              aria-pressed={compact}
              title={compact ? "Expand the ring to full size" : "Shrink the ring"}
            >
              <span aria-hidden="true">{compact ? "⤢" : "⤡"}</span>
              {compact ? "Full size" : "Compact"}
            </button>
          </div>

          {/* There is no market panel beside the ring any more, and there
              should not be — the in-play strip under the canvas is the live
              ticket. What the stretch after a fight is for is collecting, and
              this draws nothing at all unless the wallet watching is owed
              something on the bout that just ended. */}
          {settledFighters?.blue && settledFighters?.red && (aftermath || !live) ? (
            <ClaimPrompt
              key={justFought?.id}
              night={feed?.night ?? 1}
              blue={settledFighters.blue}
              red={settledFighters.red}
            />
          ) : null}

          {bout && fighters ? (
            <FightStage
              bout={bout}
              frames={frames}
              voice={voice}
              blue={fighters.blue}
              red={fighters.red}
              winnerName={winnerName}
              /* The live book rides under the canvas for as long as the fight
                 does, above the event feed rather than below it. Betting no
                 longer stops at the opening bell — the maker reprices the
                 fight as it airs — so this is the page's one in-play window.
                 Gone in the aftermath: by then the book is closed and the
                 stage belongs to the verdict and the claim. */
              market={live && !aftermath ? (
                <InPlayMarket
                  night={feed?.night ?? 1}
                  blue={fighters.blue}
                  red={fighters.red}
                  subtitle={`${weightClassLabel(live.division)}${live.kind === "title" ? " · title fight" : ""} · in-play`}
                />
              ) : null}
              verdict={aftermath ? (
                <div className="bout-final" role="status" aria-live="polite">
                  <span className="bout-final__label">Final</span>
                  <strong className="bout-final__winner">
                    {winnerName ? `${winner?.firstName} ${winnerName}` : "Draw"}
                  </strong>
                  <span className="bout-final__method">
                    {finish === "Decision" || finish === "Draw"
                      ? `by ${finish.toLowerCase()} after ${bout.totalRounds} rounds`
                      : `by ${finish} in round ${finishRound}`}
                  </span>
                  {/* Land / miss / thrown for each man, then the hardest shot
                      either of them landed all night. */}
                  <BoutTale bout={bout} blue={fighters.blue} red={fighters.red} />
                  <span className="bout-final__next">
                    Next fight in {waitLabel(holdSeconds * 1000)}
                  </span>
                </div>
              ) : null}
            />
          ) : (
            <div className="broadcast__idle">
              <button
                className="ring-sound"
                type="button"
                onClick={sound.toggle}
                aria-pressed={!sound.muted}
                title={sound.muted ? "House music while the ring is empty" : "Silence the broadcast"}
              >
                <SpeakerIcon muted={sound.muted} />
                <span className="sr-only">{sound.muted ? "Turn sound on" : "Turn sound off"}</span>
              </button>
              {(() => {
                const notice = (
                  <div className="broadcast__waiting" role="status">
                    <strong>
                      {status === "offline"
                        ? "The league broadcast is unreachable."
                        : status === "connecting"
                          ? "Joining the broadcast…"
                          : doorsAt !== null
                            ? `Fight night ${feed?.night ?? 1} is made`
                            : "Between fights"}
                    </strong>
                    <small>
                      {error
                        ? error
                        : doorsAt !== null
                          ? `First bell ${slotTime(feed?.clock, doorsAt)}, ${waitLabel(doorsAt - viewerTime)} away. The whole card is on the board below.`
                          : secondsToNext !== null
                            ? `Next bout in ${waitLabel(secondsToNext * 1000)}.`
                            : "The next matchup is being made."}
                    </small>
                  </div>
                );
                // Between cards the wait is hours, not seconds, and a channel
                // idles on a loop rather than a paragraph against a black
                // wall. The tape sits centre at its natural size — blown up to
                // the stage it went soft — and the next bout's two corners
                // flank it, so the space either side is the matchup rather
                // than dead air. (intermission-reel.tsx still holds the
                // drawn-live version of this screen.) Muted and looping is
                // what lets the browser autoplay the tape; any sound here is
                // the house playlist's job.
                if (doorsAt === null || status !== "intermission") return notice;
                return stageBout && stageFighters?.blue && stageFighters?.red ? (
                  <IntermissionMatchup
                    night={feed?.night ?? 1}
                    blue={stageFighters.blue}
                    red={stageFighters.red}
                    tag={featuredBout ? "most traded" : "next bout"}
                    subtitle={`${weightClassLabel(stageBout.division)}${stageBout.kind === "title" ? " · title fight" : ""} · ${slotTime(feed?.clock, stageBout.startsAt)}`}
                  />
                ) : (
                  <div className="broadcast__intermission">
                    <span />
                    <BroadcastReel />
                    <span />
                  </div>
                );
              })()}

              {/* The night's clock, out from under the stage heading where it
                  used to crowd the title: the tape above says "we'll be right
                  back", this row says exactly when. */}
              {doorsAt !== null && status === "intermission" ? (
                <div className="broadcast__doors" role="status">
                  <span className="eyebrow">Fight night {feed?.night ?? 1} is made</span>
                  <strong>{`First bell ${slotTime(feed?.clock, doorsAt)}, ${waitLabel(doorsAt - viewerTime)} away`}</strong>
                  <small>The whole card is on the board below.</small>
                </div>
              ) : null}

              {/* An empty ring is the one moment the whole card is open and
                  nothing is competing for the stage. The next fight's line
                  goes here rather than a countdown on its own. */}
              {nextBout && nextFighters?.blue && nextFighters?.red ? (
                <NextFightMarket
                  key={nextBout.id}
                  night={feed?.night ?? 1}
                  blue={nextFighters.blue}
                  red={nextFighters.red}
                  subtitle={`${weightClassLabel(nextBout.division)}${nextBout.kind === "title" ? " · title fight" : ""} · ${slotTime(feed?.clock, nextBout.startsAt)}`}
                  countdown={
                    feed?.upcoming
                      ? `${waitLabel(nextBout.startsAt - viewerTime)} to the bell`
                      : nextBout.startsAt > viewerTime
                        ? `${waitLabel(nextBout.startsAt - viewerTime)} away`
                        : null
                  }
                />
              ) : null}
            </div>
          )}
        </section>

        <AdminPanel
          divisions={feed?.divisions ?? []}
          rate={rate}
          paused={paused}
          waiting={doorsAt !== null}
        />

        <CardRail
          card={feed?.card ?? []}
          clock={feed?.clock}
          roster={roster}
          night={feed?.night ?? 1}
          viewerTime={viewerTime}
        />

        <section className="roster-section" id="divisions" aria-label="Divisions">
          <div className="section-heading">
            <div>
              <strong>Champions and contender ladders</strong>
            </div>
            {/* <span>Beat the man above you and you take his place. Weekly the number one gets the belt.</span> */}
          </div>
          <DivisionBoard divisions={feed?.divisions ?? []} roster={roster} />
        </section>

        <section className="roster-section" id="roster" aria-label="League roster">
          <div className="section-heading">
            <div>
              <strong>Every boxer in the league</strong>
            </div>
            <span>{roster.length} athletes · {boutsLabel(feed?.boutsCompleted ?? 0)}</span>
          </div>
          <p className="roster-section__note">
            Attributes grow as an athlete levels up.
          </p>
          <RosterBoard
            roster={roster}
            liveBlueId={live?.blueId ?? null}
            liveRedId={live?.redId ?? null}
          />
        </section>
      </main>
      <SiteFooter />

      <Ticker
        notice={
          error
            ? error
            : live
              ? `${nameOf(roster, live.blueId)} vs ${nameOf(roster, live.redId)}, ${weightClassLabel(live.division)}${live.kind === "title" ? " title fight" : ""}.`
              : doorsAt !== null
                ? `Fight night ${feed?.night ?? 1}: ${feed?.card.length ?? 0} fights, first bell ${slotTime(feed?.clock, doorsAt)}.`
                : "Between fights on tonight's card."
        }
      />
    </div>
  );
}
