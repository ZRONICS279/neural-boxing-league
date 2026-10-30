"use client";

import Link from "next/link";
import {
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Fighter,
  WEIGHT_CLASSES,
  type WeightClassId,
  neuralInfluence,
  weightClassLabel,
} from "./fight-model";
import {
  CARD_BOUTS,
  isAftermath,
  nextChallenger,
} from "./broadcast-model";
import { type BoutSummary, PLAYBACK_DELAY_MS, useBroadcast } from "./broadcast-store";
import { InfluenceFigure } from "./how-it-works-figures";
import {
  SiteFooter,
  SiteHeader,
  Ticker,
  heightLabel,
  recordLabel,
  slotTime,
  statLabel,
  waitLabel,
} from "./site-chrome";
import { WalletConnect } from "./wallet-button";
import { openingLine } from "./opening-line";
import { payoutMultiple } from "./market";
import { FighterPortrait } from "./fight-canvas";

/** The front door.
 *
 * Everything here is read off the same broadcast the ring page watches — the
 * champions are the league's champions and the upsets are fights that actually
 * happened tonight. Nothing on this page is written down anywhere: a homepage
 * that quotes a number the card disagrees with is worse than one that quotes
 * none, so when the feed has not landed yet these sections say so rather than
 * standing in with something invented. */

/* -------------------------------------------------------------------- upsets */

interface Upset {
  bout: BoutSummary;
  winner: Fighter;
  loser: Fighter;
  /** The winner's price going in, in cents, on the league's own line. */
  price: number;
}

/** Tonight's finals that went the wrong way, longest price first.
 *
 * The line is recomputed here rather than remembered, because nothing stores
 * what a fight was quoted at once it is over. That makes these *conservative*:
 * the win is already in the winner's record by the time this reads it, which
 * pulls his price up, so a dog shown at 38¢ went off at rather less. A fight
 * whose upset the record has since erased simply drops out — which is the right
 * way to be wrong on a page that is claiming somebody got paid. */
function upsetsFrom(card: BoutSummary[], roster: Fighter[], limit: number): Upset[] {
  const found: Upset[] = [];
  for (const bout of card) {
    if (!bout.result?.winnerId) continue;
    const blue = roster.find((fighter) => fighter.id === bout.blueId);
    const red = roster.find((fighter) => fighter.id === bout.redId);
    if (!blue || !red) continue;
    const blueLine = openingLine(blue, red);
    const blueWon = bout.result.winnerId === blue.id;
    const price = blueWon ? blueLine : 100 - blueLine;
    if (price >= 50) continue;
    found.push({
      bout,
      winner: blueWon ? blue : red,
      loser: blueWon ? red : blue,
      price,
    });
  }
  return found.sort((a, b) => a.price - b.price).slice(0, limit);
}

/** The longest price still to be fought, for a card whose first bell has not
 *  gone yet. A night with no results is not a night with nothing to say. */
function longestShot(card: BoutSummary[], roster: Fighter[]) {
  let best: { bout: BoutSummary; dog: Fighter; favourite: Fighter; price: number } | null = null;
  for (const bout of card) {
    if (bout.status === "final") continue;
    const blue = roster.find((fighter) => fighter.id === bout.blueId);
    const red = roster.find((fighter) => fighter.id === bout.redId);
    if (!blue || !red) continue;
    const blueLine = openingLine(blue, red);
    const blueIsDog = blueLine < 50;
    const price = blueIsDog ? blueLine : 100 - blueLine;
    if (best && price >= best.price) continue;
    best = {
      bout,
      dog: blueIsDog ? blue : red,
      favourite: blueIsDog ? red : blue,
      price,
    };
  }
  return best;
}

function UpsetRow({ upset }: { upset: Upset }) {
  const { bout, winner, loser, price } = upset;
  return (
    <li className={`upset upset--${bout.division}`}>
      <Link className="upset__link" href={`/fight/${bout.id}`}>
        <span className="eyebrow">
          {weightClassLabel(bout.division)}
          {bout.kind === "title" ? " · title" : ""}
        </span>
        <strong className="upset__names">
          {winner.lastName} <em>beat</em> {loser.lastName}
        </strong>
        <span className="upset__method">
          {bout.result?.finish === "Decision"
            ? `By decision after ${bout.totalRounds} rounds`
            : `By ${bout.result?.finish} in round ${bout.result?.round}`}
        </span>
        <span className="upset__price">
          <b>{price}¢</b>
          <small>going in</small>
        </span>
        <span className="upset__payout">
          <b>{payoutMultiple(price).toFixed(2)}x</b>
          <small>$100 → ${Math.round(payoutMultiple(price) * 100)}</small>
        </span>
      </Link>
    </li>
  );
}

/* ------------------------------------------------------------------- roster */

/** How the list is ordered. Rating is the league's own ranking and stays the
 *  default; the other two are the questions people actually arrive with. */
type RosterSort = "rating" | "wins" | "losses";

interface FighterSelection {
  fighter: Fighter;
  trigger: HTMLButtonElement;
  x: number;
  y: number;
  maxWidth: number;
  maxHeight: number;
  horizontal: "left" | "right";
  vertical: "above" | "below";
}

const SORTS: { id: RosterSort; label: string }[] = [
  { id: "rating", label: "Rating" },
  { id: "wins", label: "Most wins" },
  { id: "losses", label: "Most losses" },
];

function compareBy(sort: RosterSort, a: Fighter, b: Fighter) {
  if (sort === "wins") return b.record.wins - a.record.wins || b.rating - a.rating;
  if (sort === "losses") return b.record.losses - a.record.losses || b.rating - a.rating;
  return b.rating - a.rating || b.record.wins - a.record.wins;
}

function FighterScoutCard({
  selection,
  onClose,
}: {
  selection: FighterSelection;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { fighter } = selection;
  const autonomy = Math.min(100, Math.round(neuralInfluence(fighter.policy) * 100));
  const conditioning = Math.round((
    fighter.conditioning.lowerBodyPower
    + fighter.conditioning.lowerBodyEndurance
    + fighter.conditioning.kineticChain
    + fighter.conditioning.shoulderEndurance
  ) / 4);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <>
      <button
        className="fighter-scout__scrim"
        type="button"
        aria-label="Close athlete details"
        onClick={onClose}
      />
      <aside
        className={`fighter-scout fighter-scout--${fighter.weightClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`fighter-scout-${fighter.id}`}
        data-horizontal={selection.horizontal}
        data-vertical={selection.vertical}
        style={{
          left: selection.x,
          top: selection.y,
          maxWidth: selection.maxWidth,
          maxHeight: selection.maxHeight,
        }}
      >
        <header className="fighter-scout__head">
          <div>
            <span className="eyebrow">{weightClassLabel(fighter.weightClass)} · athlete file</span>
            <h2 id={`fighter-scout-${fighter.id}`}>
              {fighter.firstName} {fighter.lastName}
            </h2>
            <p>“{fighter.nickname}” · {fighter.hometown}</p>
          </div>
          <button
            ref={closeRef}
            className="fighter-scout__close"
            type="button"
            aria-label="Close athlete details"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="fighter-scout__scoreline">
          <div><span>Record</span><strong>{recordLabel(fighter)}</strong><small>{fighter.record.knockouts} KO</small></div>
          <div><span>Rating</span><strong>{Math.round(fighter.rating)}</strong><small>league scouting</small></div>
          <div><span>Level</span><strong>{fighter.level}</strong><small>career</small></div>
          <div><span>Conditioning</span><strong>{conditioning}</strong><small>camp average</small></div>
        </div>

        <dl className="fighter-scout__facts">
          <div><dt>Style</dt><dd>{fighter.archetype}</dd></div>
          <div><dt>Stance</dt><dd>{fighter.stance}</dd></div>
          <div><dt>Build</dt><dd>{heightLabel(fighter.height)} · {fighter.weight} lb</dd></div>
          <div><dt>Reach</dt><dd>{fighter.reach}&quot;</dd></div>
          <div><dt>Age</dt><dd>{fighter.age}</dd></div>
          <div><dt>Confidence</dt><dd>{Math.round(fighter.confidence)}%</dd></div>
        </dl>

        <section className="fighter-scout__attributes" aria-label="Athlete attributes">
          <div className="fighter-scout__label">
            <span>Scouting report</span>
            <small>current attributes</small>
          </div>
          <div className="fighter-scout__attribute-grid">
            {(Object.entries(fighter.stats) as [keyof Fighter["stats"], number][]).map(([stat, value]) => (
              <div className="fighter-scout__attribute" key={stat}>
                <span>{statLabel(stat)}</span>
                <i><b style={{ width: `${Math.min(100, value)}%` }} /></i>
                <strong>{Math.round(value)}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="fighter-scout__autonomy" aria-label="Autonomy progress">
          <div className="fighter-scout__label">
            <span>Earned autonomy</span>
            <strong>{autonomy}%</strong>
          </div>
          <div className="fighter-scout__chart">
            <InfluenceFigure
              learned={fighter.policy.learnedDecisions}
              name={fighter.lastName}
            />
          </div>
          <p>
            This goes up as he trains and fights. The more his brain has learned,
            the more of each fight it decides for itself.
          </p>
        </section>
      </aside>
    </>
  );
}

/** The whole roster, filtered and ordered. The row stays quick to scan; the
 * athlete file opens only when somebody asks for the deeper scouting read. */
function RosterBoard({ roster }: { roster: Fighter[] }) {
  const [division, setDivision] = useState<WeightClassId | "all">("all");
  const [sort, setSort] = useState<RosterSort>("rating");
  const [selection, setSelection] = useState<FighterSelection | null>(null);

  const closeSelection = () => {
    selection?.trigger.focus({ preventScroll: true });
    setSelection(null);
  };

  const openFighter = (
    fighter: Fighter,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.detail === 0;
    const x = fromKeyboard ? rect.left + rect.width / 2 : event.clientX;
    const y = fromKeyboard ? rect.top + rect.height / 2 : event.clientY;
    const horizontal = window.innerWidth - x >= x ? "right" : "left";
    const vertical = window.innerHeight - y >= y ? "below" : "above";
    const horizontalRoom = horizontal === "right" ? window.innerWidth - x : x;
    const verticalRoom = vertical === "below" ? window.innerHeight - y : y;
    setSelection({
      fighter,
      trigger: event.currentTarget,
      x,
      y,
      maxWidth: Math.max(300, Math.min(560, horizontalRoom - 28)),
      maxHeight: Math.max(180, Math.min(720, verticalRoom - 28)),
      horizontal,
      vertical,
    });
  };

  const shown = useMemo(() => {
    const filtered = division === "all"
      ? roster
      : roster.filter((fighter) => fighter.weightClass === division);
    return [...filtered].sort((a, b) => compareBy(sort, a, b));
  }, [division, sort, roster]);
  const liveSelection = selection
    ? {
        ...selection,
        fighter: roster.find((fighter) => fighter.id === selection.fighter.id)
          ?? selection.fighter,
      }
    : null;

  return (
    <>
      <div className="home-roster__controls">
        <div className="home-roster__control">
          <span>Division</span>
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
        </div>
        <div className="home-roster__control home-roster__control--sort">
          <span>Order</span>
          <div className="division-filter" role="tablist" aria-label="Sort the roster">
            {SORTS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={sort === option.id}
                className={sort === option.id ? "division-filter__tab division-filter__tab--active" : "division-filter__tab"}
                onClick={() => setSort(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {shown.length > 0 ? (
        <ol className="home-roster">
          <li className="home-roster__head" aria-hidden="true">
            <span>Rank</span>
            <span>Athlete</span>
            <span>Division</span>
            <span>Record</span>
            <span className="home-roster__head-stat">Rating</span>
            <span className="home-roster__head-stat">Level</span>
            <span className="home-roster__head-stat">Decisions</span>
          </li>
          {shown.map((fighter, index) => (
            <li className={`home-fighter home-fighter--${fighter.weightClass}`} key={fighter.id}>
              <button
                className="home-fighter__hit"
                type="button"
                aria-haspopup="dialog"
                aria-label={`View ${fighter.firstName} ${fighter.lastName}'s athlete file`}
                onClick={(event) => openFighter(fighter, event)}
              />
              <span className="home-fighter__rank">{String(index + 1).padStart(2, "0")}</span>
              <span className="home-fighter__name">
                <strong>{fighter.firstName} {fighter.lastName}</strong>
                <em>“{fighter.nickname}”</em>
              </span>
              <span className="home-fighter__division">{weightClassLabel(fighter.weightClass)}</span>
              <span className="home-fighter__record">
                <b>{recordLabel(fighter)}</b>
                <small>{fighter.record.knockouts} KO</small>
              </span>
              <span className="home-fighter__stat">
                <b>{Math.round(fighter.rating)}</b>
                <small>rating</small>
              </span>
              <span className="home-fighter__stat">
                <b>{fighter.level}</b>
                <small>level</small>
              </span>
              <span className="home-fighter__stat">
                <b>{fighter.policy.learnedDecisions.toLocaleString()}</b>
                <small>learned</small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="roster-section__note">Nobody signed in this division yet.</p>
      )}

      {liveSelection ? (
        <FighterScoutCard selection={liveSelection} onClose={closeSelection} />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------------- stats */

interface LeagueFigure {
  value: string;
  label: string;
  note: string;
}

function Figure({ value, label, note }: LeagueFigure) {
  return (
    <div className="figure">
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}

function LeagueFigures({ figures }: { figures: LeagueFigure[] }) {
  const railRef = useRef<HTMLElement>(null);
  const liveSetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const liveSet = liveSetRef.current;
    if (!rail || !liveSet) return;

    const mobile = window.matchMedia("(max-width: 640px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let advanceTimer: number | undefined;
    let resumeTimer: number | undefined;
    let scrollFrame = 0;

    const stop = () => {
      if (advanceTimer !== undefined) window.clearInterval(advanceTimer);
      advanceTimer = undefined;
    };

    const centre = () => {
      if (mobile.matches) rail.scrollLeft = liveSet.offsetLeft;
    };

    const start = () => {
      stop();
      if (!mobile.matches || reducedMotion.matches || document.hidden) return;
      advanceTimer = window.setInterval(() => {
        rail.scrollBy({ left: rail.clientWidth / 2, behavior: "smooth" });
      }, 2600);
    };

    const resume = () => {
      stop();
      if (resumeTimer !== undefined) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(start, 1400);
    };

    const loop = () => {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = window.requestAnimationFrame(() => {
        if (!mobile.matches) return;
        const setWidth = liveSet.offsetWidth;
        if (setWidth === 0) return;

        if (rail.scrollLeft < setWidth * 0.75) {
          rail.scrollLeft += setWidth;
        } else if (rail.scrollLeft > setWidth * 2.25) {
          rail.scrollLeft -= setWidth;
        }
      });
    };

    const touchStart = () => {
      stop();
      if (resumeTimer !== undefined) window.clearTimeout(resumeTimer);
    };
    const touchEnd = () => resume();
    const visibilityChange = () => (document.hidden ? stop() : start());
    const mediaChange = () => {
      centre();
      start();
    };
    const resizeObserver = new ResizeObserver(centre);

    centre();
    start();
    resizeObserver.observe(rail);
    rail.addEventListener("scroll", loop, { passive: true });
    rail.addEventListener("touchstart", touchStart, { passive: true });
    rail.addEventListener("touchend", touchEnd, { passive: true });
    rail.addEventListener("touchcancel", touchEnd, { passive: true });
    document.addEventListener("visibilitychange", visibilityChange);
    mobile.addEventListener("change", mediaChange);
    reducedMotion.addEventListener("change", start);

    return () => {
      stop();
      if (resumeTimer !== undefined) window.clearTimeout(resumeTimer);
      window.cancelAnimationFrame(scrollFrame);
      resizeObserver.disconnect();
      rail.removeEventListener("scroll", loop);
      rail.removeEventListener("touchstart", touchStart);
      rail.removeEventListener("touchend", touchEnd);
      rail.removeEventListener("touchcancel", touchEnd);
      document.removeEventListener("visibilitychange", visibilityChange);
      mobile.removeEventListener("change", mediaChange);
      reducedMotion.removeEventListener("change", start);
    };
  }, []);

  const figureSet = (copy: "before" | "live" | "after") => (
    <div
      className={`home-figures__set home-figures__set--${copy}`}
      ref={copy === "live" ? liveSetRef : undefined}
      aria-hidden={copy === "live" ? undefined : true}
      key={copy}
    >
      {figures.map((figure) => (
        <Figure {...figure} key={`${copy}-${figure.label}`} />
      ))}
    </div>
  );

  return (
    <section
      className="home-figures"
      ref={railRef}
      aria-label="The league in numbers. Swipe to browse."
      aria-roledescription="carousel"
    >
      {figureSet("before")}
      {figureSet("live")}
      {figureSet("after")}
    </section>
  );
}

/* ---------------------------------------------------------------------- page */

export function HomePage() {
  const { feed, roster, status, error, leagueTime, paused } = useBroadcast();

  const live = feed?.live ?? null;
  // On air as a viewer would see it: the picture starts a playback delay after
  // the real bell and the verdict lands the same delay after the real finish,
  // so both edges read the delayed clock the ring page draws on.
  const viewerTime = leagueTime - PLAYBACK_DELAY_MS;
  const onAir = live ? live.startsAt <= viewerTime && !isAftermath(live, viewerTime) : false;
  // A card whose first bout has not been fought is the next night rather than
  // this one — made and posted the moment the last one ended, then sat on for
  // the six hours in between. The same read the ring page makes.
  const doorsAt = feed?.card.length && feed.card[0].status === "scheduled"
    ? feed.card[0].startsAt
    : null;

  const career = useMemo(() => {
    const wins = roster.reduce((total, fighter) => total + fighter.record.wins, 0);
    const knockouts = roster.reduce((total, fighter) => total + fighter.record.knockouts, 0);
    const learned = roster.reduce(
      (total, fighter) => total + fighter.policy.learnedDecisions,
      0,
    );
    return { wins, knockouts, learned, stoppage: wins > 0 ? knockouts / wins : 0 };
  }, [roster]);

  const leagueFigures: LeagueFigure[] = [
    {
      value: String(roster.length),
      label: "Athletes",
      note: `${WEIGHT_CLASSES.length} divisions · ${WEIGHT_CLASSES.map((weightClass) => weightClass.label.toLowerCase()).join(", ")}`,
    },
    {
      value: (feed?.boutsCompleted ?? 0).toLocaleString(),
      label: "Bouts on record",
      note: "Every one of them aired live",
    },
    {
      value: career.learned.toLocaleString(),
      label: "Decisions learned",
      note: "Choices the roster was rewarded for and kept",
    },
    {
      value: career.wins > 0 ? `${Math.round(career.stoppage * 100)}%` : "—",
      label: "Wins by stoppage",
      note: "KO or TKO. The rest went to the judges",
    },
    {
      value: String(CARD_BOUTS),
      label: "Fights a card",
      note: "A new card every six hours, day and night",
    },
    {
      value: String(roster.length),
      label: "Independent brains",
      note: "One neural network per athlete",
    },
  ];

  const upsets = useMemo(
    () => upsetsFrom(feed?.card ?? [], roster, 3),
    [feed?.card, roster],
  );
  const shot = useMemo(
    () => (upsets.length > 0 ? null : longestShot(feed?.card ?? [], roster)),
    [upsets.length, feed?.card, roster],
  );

  const blue = live ? roster.find((fighter) => fighter.id === live.blueId) : undefined;
  const red = live ? roster.find((fighter) => fighter.id === live.redId) : undefined;

  return (
    <div className="page">
      <SiteHeader
        calendar={{ season: feed?.season ?? 1, week: feed?.week ?? 1 }}
        active="/"
        status={{
          label:
            status === "offline"
              ? "Broadcast offline"
              : onAir
                ? paused ? "Broadcast paused" : "Bout in progress"
                : doorsAt !== null
                  ? `Fight night ${feed?.night ?? 1} booked`
                  : "Between fights",
          detail: `${roster.length} athletes · ${(feed?.boutsCompleted ?? 0).toLocaleString()} bouts on record`,
        }}
        action={<WalletConnect roster={roster} />}
      />

      <main className="page__body home-page">
        <section className="home-hero" aria-label="Forge League">
          <span className="home-hero__blue" aria-hidden="true" />
          <span className="home-hero__red" aria-hidden="true" />
          <div className="home-hero__mark" aria-hidden="true"><i>F</i><i>L</i></div>
          <h1 className="home-hero__name"><span>Forge</span> League</h1>
          <p className="home-hero__slogan">
            INDEPENDENT NEURAL BRAINS · BUILT TO THINK · FORGED TO FIGHT
          </p>
          <p className="home-hero__lede">
            Forge League is the first of its kind live boxing league for athletes with neural brains.
            They train, study opponents, remember every fight, and gradually earn
            complete control of the way they compete. The athletes steer themselves, and
            their skills.
          </p>
          <div className="home-hero__cta">
            <Link className="button button--amber" href="/ring">
              {onAir ? "Watch the live bout" : "Go to the ring"}
            </Link>
            <Link className="button" href="/training">Watch training</Link>
          </div>
          {/* On a row of its own under the two: the long read is not a thing to
              do right now, and sitting beside them made it read as an equal
              choice. */}
          <div className="home-hero__cta home-hero__cta--secondary">
            <Link className="button button--quiet" href="/how-it-works">
              Learn more
            </Link>
          </div>
          <p className="home-hero__now">
            {status === "offline" ? (
              <>
                {error ?? "The league broadcast is unreachable."}
              </>
            ) : live && onAir && blue && red ? (
              <>
                <strong>In the ring now:</strong> {blue.lastName} v {red.lastName},{" "}
                {weightClassLabel(live.division)}
                {live.kind === "title" ? " title fight" : ""}.{" "}
                <Link href={`/fight/${live.id}`}>Watch this one →</Link>
              </>
            ) : doorsAt !== null ? (
              <>
                <strong>Fight night {feed?.night ?? 1} is made.</strong> {feed?.card.length ?? 0}{" "}
                fights, first bell {slotTime(feed?.clock, doorsAt)},{" "}
                {waitLabel(doorsAt - viewerTime)} away.
              </>
            ) : (
              <>
                <strong>Between fights.</strong> The next bout starts on its own.
              </>
            )}
          </p>
        </section>

        <LeagueFigures figures={leagueFigures} />

        <section className="roster-section home-belt-board" aria-label="Current champions">
          <div className="section-heading">
            <div>
              {/* <span className="eyebrow">The belts</span> */}
              <strong>Your champions</strong>
            </div>
            <span>Each belt is fought for at the end of the week.</span>
          </div>
          <div className="home-champs">
            {WEIGHT_CLASSES.map((weightClass) => {
              const division = feed?.divisions.find((entry) => entry.id === weightClass.id);
              const champion = roster.find((fighter) => fighter.id === division?.championId);
              const mandatory = division ? nextChallenger(division) : null;
              const challenger = roster.find((fighter) => fighter.id === mandatory);
              return (
                <article className={`home-champ home-champ--${weightClass.id}`} key={weightClass.id}>
                  <header>
                    <span className="eyebrow">{weightClass.label}</span>
                    <small>up to {weightClass.limit} lb</small>
                  </header>
                  {champion ? <FighterPortrait fighter={champion} className="home-champ__portrait" /> : null}
                  <div className="home-champ__body">
                    <span className="home-champ__belt" aria-hidden="true" />
                    <div>
                      <strong>
                        {champion ? `${champion.firstName} ${champion.lastName}` : "Vacant"}
                      </strong>
                      {champion ? <em>“{champion.nickname}”</em> : null}
                      <span>
                        {champion
                          ? `${recordLabel(champion)} · ${champion.record.knockouts} KO · level ${champion.level}`
                          : "No one has taken it yet"}
                      </span>
                    </div>
                  </div>
                  <footer>
                    <span>
                      {division && division.titleDefences > 0
                        ? `${division.titleDefences} defence${division.titleDefences > 1 ? "s" : ""}`
                        : "No defences yet"}
                    </span>
                    {challenger ? (
                      <span>Up next: {challenger.firstName} {challenger.lastName}</span>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        </section>

        <section className="roster-section home-market-board" aria-label="Upsets">
          <div className="section-heading">
            <div>
              <strong>{upsets.length > 0 ? "Tonight's underdogs" : "Longest Bets Tonight"}</strong>
            </div>
            <span>
              {upsets.length > 0
                ? "Prices are the league's line before the fight. A winning share is equal to 1 USDC."
                : "Shown from the original fights pricings."}
            </span>
          </div>
          {upsets.length > 0 ? (
            <ol className="home-upsets">
              {upsets.map((upset) => (
                <UpsetRow key={upset.bout.id} upset={upset} />
              ))}
            </ol>
          ) : shot ? (
            <ol className="home-upsets">
              <li className={`upset upset--${shot.bout.division}`}>
                <Link className="upset__link" href={`/fight/${shot.bout.id}`}>
                  <span className="eyebrow">
                    {weightClassLabel(shot.bout.division)}
                    {shot.bout.kind === "title" ? " · title" : ""}
                  </span>
                  <strong className="upset__names">
                    {shot.dog.lastName} <em>v</em> {shot.favourite.lastName}
                  </strong>
                  <span className="upset__method">
                    {shot.bout.status === "live"
                      ? "In the ring now"
                      : `First bell ${slotTime(feed?.clock, shot.bout.startsAt)}`}
                  </span>
                  <span className="upset__price">
                    <b>{shot.price}¢</b>
                    <small>{shot.dog.lastName}</small>
                  </span>
                  <span className="upset__payout">
                    <b>{payoutMultiple(shot.price).toFixed(2)}x</b>
                    <small>$100 → ${Math.round(payoutMultiple(shot.price) * 100)}</small>
                  </span>
                </Link>
              </li>
            </ol>
          ) : (
            <p className="roster-section__note">The card is being made.</p>
          )}
        </section>

        <section className="roster-section home-story" aria-label="What this is">
          <div className="section-heading">
            <div>
              {/* <span className="eyebrow">Why Forge League is different</span> */}
              <strong>Forging a new league of athletes</strong>
            </div>
            <Link className="home-story__link" href="/how-it-works">Learn more</Link>
          </div>
          <div className="home-story__rail">
            <article>
              {/* <span className="eyebrow">Individual brains</span> */}
              <strong>A mind of its own</strong>
              <p>Custom neural brains develop their own timing, habits, and style through training and fights.</p>
            </article>
            <article>
              {/* <span className="eyebrow">Persistent careers</span> */}
              <strong>Every fight Teaches</strong>
              <p>Memories and opponent knowledge carry forward, so every bout becomes part of a real career.</p>
            </article>
            <article>
              {/* <span className="eyebrow">Unscripted competition</span> */}
              <strong>Skill Based</strong>
              <p>Preparation, decisions, conditioning. All fights truly fought, no scripts.</p>
            </article>
            <article>
              {/* <span className="eyebrow">Betting</span> */}
              <strong>Bet who wins</strong>
              <p>Bet before or during the fight. Prices move with the market.</p>
            </article>
          </div>
        </section>

        <section className="roster-section home-roster-board" aria-label="The roster">
          <div className="section-heading">
            <div>
              {/* <span className="eyebrow">The roster</span> */}
              <strong>This Season&apos;s Roster</strong>
            </div>
            <span>
              {roster.length} athletes across {WEIGHT_CLASSES.length} divisions.
            </span>
          </div>
          <RosterBoard roster={roster} />
         
        </section>
      </main>
      <SiteFooter />

      <Ticker
        notice={
          error
            ? error
            : live && onAir && blue && red
              ? `${blue.lastName} vs ${red.lastName}, ${weightClassLabel(live.division)}${live.kind === "title" ? " title fight" : ""}.`
              : doorsAt !== null
                ? `Fight night ${feed?.night ?? 1}: ${feed?.card.length ?? 0} fights, first bell ${slotTime(feed?.clock, doorsAt)}.`
                : "Between fights on tonight's card."
        }
      />
    </div>
  );
}
