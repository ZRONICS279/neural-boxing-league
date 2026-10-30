"use client";

import Link from "next/link";
import { type BroadcastClock, realTimeFor } from "./broadcast-model";
import { Fighter, FighterAction, TacticalIntent } from "./fight-model";

/** Header, footer, and the small shared readouts used by every page. */

export const ACTION_LABELS: Record<FighterAction, string> = {
  advance: "Closing range",
  retreat: "Making space",
  circleLeft: "Circle left",
  circleRight: "Circle right",
  pivotLeft: "Pivot left",
  pivotRight: "Pivot right",
  jabHead: "Head jab",
  crossHead: "Head cross",
  hookHead: "Head hook",
  jabBody: "Body jab",
  crossBody: "Body cross",
  hookBody: "Body hook",
  uppercut: "Uppercut",
  guard: "High guard",
  slip: "Slip",
  duck: "Duck under",
  weave: "Weave",
  recover: "Breathing",
};

export const INTENT_LABELS: Record<TacticalIntent, string> = {
  pressure: "Pressure",
  counter: "Counter",
  bodyWork: "Body work",
  outside: "Outside",
  recover: "Recover",
  evasive: "Evasive",
};

/** How long until something, read the way a wait is actually said out loud.
 *
 * Seconds are right for the gap between two fights and useless for the gap
 * between two cards — nobody reads "21600s" as six hours. */
export function waitLabel(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The slot a bout is booked into, in the viewer's own clock.
 *
 * League time is not wall time once an admin speeds the broadcast up or pauses
 * it, so this converts back through the shared clock rather than assuming the
 * two run together. */
export function slotTime(clock: BroadcastClock | undefined, leagueMs: number) {
  if (!clock) return "—";
  const real = realTimeFor(clock, leagueMs);
  if (real === null) return "paused";
  return new Date(real).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatClock(seconds: number) {
  const wholeSeconds = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function recordLabel(fighter: Fighter) {
  const { wins, losses, draws } = fighter.record;
  return `${wins}-${losses}${draws ? `-${draws}` : ""}`;
}

export function heightLabel(height: number) {
  return `${Math.floor(height / 12)}'${height % 12}\"`;
}

export function getFighter(roster: Fighter[], fighterId: string) {
  return roster.find((fighter) => fighter.id === fighterId) ?? roster[0];
}

export function statLabel(stat: keyof Fighter["stats"]) {
  return stat === "ringIq" ? "Ring IQ" : stat;
}

export function Meter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "blue" | "red" | "amber" | "green";
}) {
  return (
    <div className="meter">
      <div className="meter__label">
        <span>{label}</span>
        <strong>{Math.round(value)}</strong>
      </div>
      <div className="meter__track" aria-hidden="true">
        <span className={`meter__fill meter__fill--${tone}`} style={{ width: `${Math.max(0, value)}%` }} />
      </div>
    </div>
  );
}

const PAGES = [
  { href: "/ring", label: "Ring", blurb: "League fights" },
  { href: "/training", label: "Training", blurb: "Training camp" },
  { href: "/fights", label: "Past fights", blurb: "Rewatch bouts" },
  { href: "/play", label: "PVM", blurb: "Player vs machine" },
] as const;

export function SiteHeader({
  calendar,
  active,
  status,
  action,
}: {
  /** The league's own clock. Omitted by pages that stand outside the season —
   *  an exhibition has no week, and dating it against the card implies it
   *  counts toward something. */
  calendar?: { season: number; week: number };
  /** The nav tab to light up. A page under neither — the homepage, or one
   *  fight's own page — passes its own path and simply lights nothing; the
   *  brand at the left is how you get home from anywhere. */
  active: string;
  status: { label: string; detail: string };
  action?: React.ReactNode;
}) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Forge League home">
        <span className="brand__mark">FL</span>
        <span className="brand__name"><strong>Forge</strong> League</span>
      </Link>
      <nav className="topnav" aria-label="Site sections">
        {PAGES.map((page) => (
          <Link
            key={page.href}
            className={page.href === active ? "topnav__tab topnav__tab--active" : "topnav__tab"}
            href={page.href}
            aria-current={page.href === active ? "page" : undefined}
          >
            <strong>{page.label}</strong>
            <small>{page.blurb}</small>
          </Link>
        ))}
      </nav>
      {calendar ? (
        <div className="topbar__event">
          <span className="eyebrow">Autonomous boxing</span>
          <strong>Week {calendar.week} / Season {String(calendar.season).padStart(2, "0")}</strong>
        </div>
      ) : null}
      <div className="topbar__status">
        <span><strong>{status.label}</strong><small>{status.detail}</small></span>
      </div>
      {action}
    </header>
  );
}

/** Where the league talks off the site. Placeholders until the real accounts
 *  exist: swap the two hrefs here and every page's footer follows. */
const SOCIALS = [
  { href: "https://t.me/PLACEHOLDER", label: "Telegram", icon: <TelegramIcon /> },
  { href: "https://x.com/PLACEHOLDER", label: "X", icon: <XIcon /> },
] as const;

/** Drawn, not typed, for the same reason as the speaker: an emoji or a font
 *  glyph is a different picture on every OS. */
function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M21.9 4.3l-3.2 15.1c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.5 13.2l-4.7-1.5c-1-.3-1-1 .2-1.5L20.6 3c.9-.3 1.6.2 1.3 1.3z"
        fill="currentColor"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M18.2 2.3h3.3l-7.2 8.3 8.5 11.2h-6.6l-5.2-6.8-6 6.8H1.7l7.7-8.8L1.3 2.3h6.8l4.7 6.2zm-1.2 17.5h1.8L7.1 4.1h-2z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="site-footer__brand" href="/" aria-label="Forge League home">
        <span className="brand__mark">FL</span>
        <span className="brand__name"><strong>Forge</strong> League</span>
      </Link>
      <nav className="site-footer__nav" aria-label="Site sections">
        {PAGES.map((page) => (
          <Link key={page.href} href={page.href}>{page.label}</Link>
        ))}
        <Link href="/how-it-works">How it works</Link>
      </nav>
      <div className="site-footer__social">
        {SOCIALS.map((social) => (
          <a key={social.label} href={social.href} target="_blank" rel="noopener noreferrer">
            {social.icon}
            {social.label}
          </a>
        ))}
      </div>
    </footer>
  );
}

export function Ticker({ notice, meta }: { notice: string; meta?: string }) {
  return (
    <footer className="career-ticker" aria-live="polite">
      <span className="career-ticker__label">League wire</span>
      <p>{notice}</p>
      {meta ? <span className="career-ticker__meta">{meta}</span> : null}
    </footer>
  );
}
