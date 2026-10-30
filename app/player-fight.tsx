"use client";

/** The one page on this site where a person is in the ring.
 *
 * Everything else here is a broadcast: the card is server-authoritative, the
 * engine lives in the worker, and the browser replays an encoded timeline it
 * had no hand in. None of that can work when the fight depends on what someone
 * does in the next twenty milliseconds, so this page runs the engine locally
 * and owns the whole bout.
 *
 * The trade that makes that safe is that nothing here is real. The opponent is
 * rebuilt from his public card with a fresh seeded policy — the learned
 * matrices never leave the worker — and no result is written anywhere. It is an
 * exhibition in the strict sense: the record books do not know it happened. */
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BOXING_MODEL,
  type BoutState,
  type Fighter,
  weightClassLabel,
} from "./fight-model";
import { FightCanvas } from "./fight-canvas";
import { applyRingNames } from "./ring-names";
import { SiteFooter, SiteHeader, getFighter, heightLabel, recordLabel, statLabel } from "./site-chrome";
import { SpeakerIcon } from "./fight-stage";
import { useSound } from "./sound";
import {
  BLOCK_KEY,
  DAMAGE_SCALE,
  DIFFICULTIES,
  DOUBLE_TAP_MS,
  EXHAUSTION,
  KEY_BINDINGS,
  PLAYER_STRIDE,
  TOUCH_BINDINGS,
  type ControlSnapshot,
  type DifficultyTier,
  type PlayerButton,
  type PlayerController,
  createPlayerController,
  emptySnapshot,
  isMovementKey,
  keyboardButton,
  movementAxes,
  resolvePlayerAction,
} from "./player-controls";

/** The engine, loaded only when somebody actually opens this page. It is the
 *  largest module in the project and no other client route needs a line of it,
 *  so it stays behind a dynamic import and out of the shared bundle. */
type Engine = typeof import("./simulation");

/** The HUD re-renders at a rate a person can read, not the rate the fight runs
 *  at. The canvas takes its frames off a ref and never waits for React. */
const HUD_HZ = 12;

/** Take the whole screen, the way a video does.
 *
 * Best-effort: it needs a live user gesture, and a phone browser can turn it
 * down for reasons the page never learns. The CSS covers the same ground on
 * its own, so a rejection costs a nicer experience rather than the page. Must
 * be called from inside the click handler, not from an effect that happens to
 * run afterwards: by then the gesture has expired. */
/** The last thing the fullscreen request actually did. Read by the `?debug=1`
 *  overlay; a phone is the one browser nobody can put a breakpoint in. */
let fullscreenReport = "not attempted";

/** A subscribe function for a store that never emits. */
const NEVER_CHANGES = () => () => {};

type Fullscreenable = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** One element, both spellings. WebKit still answers to the prefixed call on
 *  versions without the standard one, so ask for the plain form and fall back
 *  rather than deciding in advance what this browser can do. */
async function askForScreen(element: Fullscreenable, label: string) {
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    fullscreenReport = `${label}: granted`;
    return true;
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    await element.webkitRequestFullscreen();
    fullscreenReport = `${label}: granted (webkit)`;
    return true;
  }
  fullscreenReport = "neither call exists on this browser";
  return false;
}

async function enterArcadeMode(preferred?: HTMLElement | null): Promise<boolean> {
  // A phone browser will hand the screen to a named element after it has
  // stopped granting the whole document, so the ring is asked for first and
  // the root is only the fallback. Desktop passes nothing and keeps asking
  // for the document, which is the path that already works there.
  const candidates: [Fullscreenable, string][] = [];
  if (preferred) candidates.push([preferred as Fullscreenable, "ring"]);
  candidates.push([document.documentElement as Fullscreenable, "document"]);

  let won = false;
  for (const [element, label] of candidates) {
    try {
      won = await askForScreen(element, label);
    } catch (error) {
      // Refused, or already there. Either way the page still plays in the tab
      // — the stylesheet's fixed-position layout covers the same ground.
      fullscreenReport = `${label} refused: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`;
    }
    if (won) break;
  }
  // Deliberately no `screen.orientation.lock`. iOS refused it outright, and
  // where it did work it pinned the page to landscape so hard that turning the
  // phone upright did nothing at all — no rotate notice, no pause, and the only
  // way out was the system back button. Letting the orientation follow the
  // phone is what makes both of those work.
  return true;
}

/** Whether the browser is already out of the way — either because it granted
 *  fullscreen, or because this is the home-screen copy, which never had an
 *  address bar to give up in the first place. */
function subscribeToFullscreen(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}

/** Whether this is a browser embedded inside some other app rather than the
 *  device's own.
 *
 *  It matters because on iOS every one of them is a WKWebView the host app has
 *  to opt into fullscreen for, and none of them do — and none of them can put
 *  anything on the home screen either, so the advice that is right in Safari
 *  sends the player looking for a menu item that is not there. Safari proper
 *  is the only iOS browser that sends a `Version/` token; the embedded ones
 *  drop it, and the common ones name themselves on top of that. */
function inAppBrowser() {
  const ua = navigator.userAgent;
  if (!/iPhone|iPad|iPod/.test(ua)) return false;
  // A home-screen launch drops `Version/` as well, and it is emphatically not
  // an embedded browser — it is the thing this whole message exists to send
  // the player towards.
  if (isStandalone()) return false;
  return (
    /GSA\/|CriOS|FxiOS|EdgiOS|FBAN|FBAV|Instagram|LinkedInApp|Line\//.test(ua) ||
    !/Version\//.test(ua)
  );
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function useScreenIsOurs() {
  return useSyncExternalStore(
    subscribeToFullscreen,
    () => fullscreenElement() !== null || isStandalone(),
    () => true,
  );
}

/** Whether this is a thumb or a mouse, subscribed rather than sampled.
 *
 * It decides which control layer is mounted at all, so it has to survive the
 * server render (no `window`) and it has to notice a tablet being docked to a
 * keyboard rather than latching whatever was true on the first paint. */
const COARSE_POINTER = "(pointer: coarse)";

function subscribeToPointer(onChange: () => void) {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useTouchLayout() {
  return useSyncExternalStore(
    subscribeToPointer,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

/** Fullscreen is lost easily on a phone — a rotation, a system gesture, a
 *  notification — and it cannot be asked for again without a fresh user
 *  gesture. Every tap on the ring is one, so the first tap after dropping out
 *  quietly puts it back. A no-op while already fullscreen. */
function reenterFullscreen(preferred?: HTMLElement | null) {
  if (fullscreenElement()) return;
  void enterArcadeMode(preferred);
}

/** Whichever of the two spellings this browser answers to. */
function fullscreenElement() {
  const owner = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? owner.webkitFullscreenElement ?? null;
}

function leaveArcadeMode() {
  if (!fullscreenElement()) return;
  const owner = document as Document & { webkitExitFullscreen?: () => void };
  try {
    if (typeof document.exitFullscreen === "function") {
      void document.exitFullscreen().catch(() => {});
    } else {
      owner.webkitExitFullscreen?.();
    }
  } catch {
    // Already out, or the browser will not be told. Nothing else to do.
  }
}

interface FightSetup {
  opponent: Fighter;
  difficulty: DifficultyTier;
}

/** What this browser will actually do, shown on the device itself.
 *
 * Reached with `?debug=1`. A phone is the one browser nobody can attach a
 * debugger to, and fullscreen support varies by OS rather than by engine —
 * desktop Safari implements it for any element, Safari on iPhone only for
 * video — so the honest way to settle it is to make the device say so. */
function FullscreenDebug() {
  const [, tick] = useState(0);

  useEffect(() => {
    const bump = () => tick((n) => n + 1);
    const timer = window.setInterval(bump, 500);
    document.addEventListener("fullscreenchange", bump);
    document.addEventListener("webkitfullscreenchange", bump);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("fullscreenchange", bump);
      document.removeEventListener("webkitfullscreenchange", bump);
    };
  }, []);

  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: unknown;
  };
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const rows: [string, string][] = [
    ["requestFullscreen", typeof root.requestFullscreen === "function" ? "yes" : "MISSING"],
    ["webkitRequestFullscreen", typeof root.webkitRequestFullscreen === "function" ? "yes" : "MISSING"],
    ["last attempt", fullscreenReport],
    ["in fullscreen now", fullscreenElement() ? "yes" : "no"],
    ["pointer coarse", window.matchMedia("(pointer: coarse)").matches ? "yes" : "no"],
    ["orientation", window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait"],
    ["arena--touch applied", document.querySelector(".arena--touch") ? "yes" : "no"],
    ["viewport", `${window.innerWidth}x${window.innerHeight}`],
    ["screen", `${window.screen.width}x${window.screen.height}`],
    ["home-screen app", standalone ? "yes" : "no"],
    ["browser inside an app", inAppBrowser() ? "yes" : "no"],
  ];

  return (
    <div className="fs-debug" role="status">
      {rows.map(([label, value]) => (
        <div key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </div>
  );
}

/** The two control schemes, behind a tab rather than stacked. Nobody needs
 *  both, and a phone player scrolling past eight keycaps to reach their own
 *  layout is reading somebody else's manual. */
function ControlsPanel() {
  const touch = useTouchLayout();
  // Opens on whichever scheme the device actually has, and stays wherever the
  // reader put it once they have picked. Derived rather than synced in an
  // effect: the device answer is known at render, so storing it would only
  // create a frame where the wrong tab is showing.
  const [picked, setPicked] = useState<"touch" | "keyboard" | null>(null);
  const scheme = picked ?? (touch ? "touch" : "keyboard");
  const setScheme = setPicked;

  return (
    <section className="track" aria-label="Controls">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Controls</span>
          <strong>How you fight</strong>
        </div>
      </div>

      <div className="control-tabs" role="tablist" aria-label="Control scheme">
        <button
          type="button"
          role="tab"
          aria-selected={scheme === "touch"}
          onClick={() => setScheme("touch")}
        >
          Phone
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scheme === "keyboard"}
          onClick={() => setScheme("keyboard")}
        >
          Keyboard
        </button>
      </div>

      {scheme === "touch" ? (
        <div className="control-grid" role="tabpanel">
          {TOUCH_BINDINGS.map((binding) => (
            <div className="control-card" key={binding.label}>
              <span className="control-card__keys">
                {binding.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              </span>
              <strong>{binding.label}</strong>
              <small>{binding.does}</small>
              {binding.note ? <span className="control-card__note">{binding.note}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="control-grid" role="tabpanel">
          {KEY_BINDINGS.map((binding) => (
            <div className="control-card" key={binding.label}>
              <span className="control-card__keys">
                {binding.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              </span>
              <strong>{binding.label}</strong>
              <small>{binding.does}</small>
              {binding.note ? <span className="control-card__note">{binding.note}</span> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function reactionReadout(tier: DifficultyTier) {
  if (tier.readout) return tier.readout;
  if (tier.aiReactionSeconds === null) return "his league card";
  return `${Math.round(tier.aiReactionSeconds * 1000)} ms reaction`;
}

/** Three short rounds. A championship distance is the wrong shape for a thing
 *  somebody plays standing up, and nine minutes of holding a guard is not a
 *  demonstration of anything. */
const EXHIBITION_ROUNDS = 3;
const EXHIBITION_ROUND_SECONDS = 60;

/** The roster, read once and never written to.
 *
 * Deliberately not `useLeagueSync`: that hook polls `/api/training`, and a GET
 * there kicks `processTrainingQueue` behind the response — so a game page left
 * open would sit there driving real training turns into the database. This
 * route is read-only by construction. `/api/league/roster` is the one league
 * endpoint that serves state without scheduling any work behind it. */
function useReadOnlyRoster() {
  const [roster, setRoster] = useState<Fighter[]>([]);

  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/league/roster", { signal: abort.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { roster?: Fighter[] } | null) => {
        if (payload?.roster) setRoster(applyRingNames(payload.roster));
      })
      .catch(() => {
        // An exhibition with no roster simply has nobody to fight; the picker
        // says so on its own rather than the page failing.
      });
    return () => abort.abort();
  }, []);

  return roster;
}

export function PlayerFight() {
  const roster = useReadOnlyRoster();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [setup, setSetup] = useState<FightSetup | null>(null);
  // The server cannot see the query string, so a lazy initialiser reading it
  // renders a panel the server did not and fails hydration. This is the shape
  // that exists for exactly that: hydrate against the server's answer, then
  // re-render with the browser's. Never changes after that — the query string
  // cannot move without a navigation — so there is nothing to subscribe to.
  const debug = useSyncExternalStore(
    NEVER_CHANGES,
    () => new URLSearchParams(window.location.search).has("debug"),
    () => false,
  );

  useEffect(() => {
    let live = true;
    void import("./simulation").then((loaded) => {
      if (live) setEngine(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="page">
      <SiteHeader
        active="/play"
        status={{
          label: setup ? "Exhibition in progress" : "Exhibition ring open",
          detail: "Off the card · nothing is recorded",
        }}
        action={
          <Link className="button button--blue topbar__action" href="/training">
            <span aria-hidden="true">←</span>
            <span>Back to the lab</span>
          </Link>
        }
      />

      <main className="page__body">
        {setup && engine ? (
          <LiveExhibition
            engine={engine}
            opponent={setup.opponent}
            difficulty={setup.difficulty}
            onLeave={() => setSetup(null)}
          />
        ) : (
          <FightPicker
            roster={roster}
            ready={engine !== null}
            onStart={(opponent, difficulty) => setSetup({ opponent, difficulty })}
          />
        )}
      </main>
      {/* Not under a live exhibition: the ring is sized to the screen there. */}
      {setup ? null : <SiteFooter />}
      {debug ? <FullscreenDebug /> : null}
    </div>
  );
}

function FightPicker({
  roster,
  ready,
  onStart,
}: {
  roster: Fighter[];
  ready: boolean;
  onStart: (opponent: Fighter, difficulty: DifficultyTier) => void;
}) {
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [difficultyId, setDifficultyId] = useState("rookie");
  // Each step is roughly a screenful — on a phone the ladder alone is several —
  // so a choice made at the top of one leaves the next one out of sight and the
  // page looks like it did nothing. Picking walks the player down instead.
  // `scrollIntoView` is left to take its smoothness off the stylesheet, which
  // is also where reduced-motion turns it back off.
  const difficultyStep = useRef<HTMLElement | null>(null);
  const startButton = useRef<HTMLButtonElement | null>(null);

  // Softest first. The whole fantasy is walking in off the street, and the
  // ladder only reads as a ladder if the bottom rung is visibly the bottom.
  const ladder = useMemo(
    () => [...roster].sort((a, b) => a.rating - b.rating),
    [roster],
  );
  const opponent = opponentId ? getFighter(roster, opponentId) : ladder[0];
  const difficulty =
    DIFFICULTIES.find((tier) => tier.id === difficultyId) ?? DIFFICULTIES[0];

  return (
    <>
      <section className="orientation" aria-label="What this page does">
        <div className="orientation__lede">
          <span className="eyebrow">Exhibition</span>
          <h1>Player VS Machine</h1>
          <p>
            Fight against the league, fighters are fresh every fight so they havnt learned anything yet.
          </p>
        </div>
        {/* <div className="lab-target"> */}
          {/* <div className="training-now">
            <span>Your corner</span>
            <strong>The Challenger</strong>
            <small>Debut · no professional record</small>
          </div> */}
       
        {/* </div> */}
      </section>

      <section className="track" aria-label="Choose an opponent">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Step 01</span>
            <strong>Pick who you are fighting</strong>
          </div>
          <span className="loop-state loop-state--idle">{ladder.length} athletes</span>
        </div>
        <ol className="opponent-ladder">
          {ladder.map((fighter, index) => (
            <li key={fighter.id}>
              <button
                type="button"
                className={`opponent-card ${fighter.id === opponent?.id ? "opponent-card--picked" : ""}`}
                onClick={() => {
                  setOpponentId(fighter.id);
                  difficultyStep.current?.scrollIntoView({ block: "start" });
                }}
                aria-pressed={fighter.id === opponent?.id}
              >
                <span className="opponent-card__rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="opponent-card__name">
                  <strong>{fighter.firstName} {fighter.lastName}</strong>
                  <small>{weightClassLabel(fighter.weightClass)} · {recordLabel(fighter)}</small>
                </span>
                <span className="opponent-card__stats">
                  {(["power", "speed", "defense", "reaction"] as const).map((stat) => (
                    <span key={stat}>
                      <small>{statLabel(stat)}</small>
                      <b>{Math.round(fighter.stats[stat])}</b>
                    </span>
                  ))}
                </span>
                <span className="opponent-card__build">
                  {heightLabel(fighter.height)} · {fighter.reach}&Prime; reach
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="track picker-step" aria-label="Choose a difficulty" ref={difficultyStep}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">Step 02</span>
            <strong>Pick how sharp he is</strong>
          </div>
        </div>
        <p className="track__lede">
          The fight always runs at true speed. What difficulty changes is how long he takes to
          see a punch coming. His power, chin, reach and hand speed are his own at every tier.
          For scale: you are somewhere around 450 ms, and his real card is under 240.
        </p>
        <div className="difficulty-grid">
          {DIFFICULTIES.map((tier) => (
            <button
              key={tier.id}
              type="button"
              className={`difficulty-card ${tier.id === difficulty.id ? "difficulty-card--picked" : ""}`}
              onClick={() => {
                setDifficultyId(tier.id);
                // Centred rather than topped: the last step is one button, and
                // pinning it under the header hides the tier just chosen.
                startButton.current?.scrollIntoView({ block: "center" });
              }}
              aria-pressed={tier.id === difficulty.id}
            >
              <strong>{tier.label}</strong>
              <span>{reactionReadout(tier)}</span>
              <small>{tier.blurb}</small>
            </button>
          ))}
        </div>

        <button
          className="button button--full button--blue"
          type="button"
          ref={startButton}
          disabled={!ready || !opponent}
          onClick={() => {
            if (!opponent) return;
            void enterArcadeMode();
            onStart(opponent, difficulty);
          }}
        >
          {ready
            ? `Fight ${opponent?.lastName ?? ""} at ${difficulty.label}`
            : "Loading the engine…"}
        </button>
      </section>

      <ControlsPanel />
    </>
  );
}

/** One exhibition, from the opening bell to the card being read. */
function LiveExhibition({
  engine,
  opponent,
  difficulty,
  onLeave,
}: {
  engine: Engine;
  opponent: Fighter;
  difficulty: DifficultyTier;
  onLeave: () => void;
}) {
  const sound = useSound();
  const [hud, setHud] = useState<BoutState | null>(null);
  const [paused, setPaused] = useState(false);
  // When an attack press landed on an empty tank, so the stage can flash why
  // nothing came out. The timestamp doubles as the element key: a mash
  // restarts the animation instead of quietly extending an invisible one.
  const [gassedAt, setGassedAt] = useState(0);
  const touch = useTouchLayout();
  const screenIsOurs = useScreenIsOurs();
  // Set only when the browser turns the request down, which is the case worth
  // saying something about: the player can see perfectly well when it worked.
  const [fullscreenRefused, setFullscreenRefused] = useState(false);
  const [screenAskHidden, setScreenAskHidden] = useState(false);
  // Read once on mount rather than during render: the user agent cannot change
  // under a live page, and the server has no `navigator` to ask.
  const [embedded] = useState(() => typeof navigator !== "undefined" && inAppBrowser());
  const arenaRef = useRef<HTMLElement | null>(null);

  const frames = useRef<BoutState | null>(null);
  const boutRef = useRef<BoutState | null>(null);
  const controller = useRef<PlayerController>(createPlayerController());
  const held = useRef<Set<string>>(new Set());
  const taps = useRef<{ button: PlayerButton; at: number }[]>([]);
  const pausedRef = useRef(paused);

  // Both corners are rebuilt here rather than taken from the league: the public
  // roster arrives with its policy matrices emptied, so the opponent needs a
  // seeded brain before he can throw a punch at all. This is also where the two
  // exhibition handicaps are applied, and the only place they are ever set —
  // the athletes the league books carry neither field.
  const roster = useMemo(
    () => [
      engine.playerFighter(
        { firstName: "You", lastName: "Challenger" },
        opponent.weightClass,
        { movementScale: PLAYER_STRIDE, exhaustion: EXHAUSTION, damageScale: DAMAGE_SCALE },
      ),
      engine.exhibitionFighter(opponent, {
        reactionSeconds: difficulty.aiReactionSeconds ?? undefined,
        exhaustion: EXHAUSTION,
        damageScale: DAMAGE_SCALE,
      }),
    ],
    [engine, opponent, difficulty],
  );

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Turning the phone upright takes the ring off the screen and both thumbs off
  // the controls, so the fight stops with it rather than carrying on being lost
  // behind the rotate notice.
  useEffect(() => {
    if (!touch) return;
    const portrait = window.matchMedia("(orientation: portrait)");
    const onRotate = () => {
      if (portrait.matches) setPaused(true);
    };
    portrait.addEventListener("change", onRotate);
    return () => portrait.removeEventListener("change", onRotate);
  }, [touch]);

  // The stylesheet sizes the arena with `100dvh`, and Samsung's browser
  // answers that with a box about a toolbar taller than the screen it is
  // actually showing — which put the punch buttons and half the stick below
  // the bottom edge of an S22. The height that is really on the glass is what
  // the visualViewport reports, so it is measured here and handed to the
  // stylesheet, where `dvh` stays on only as the guess before this runs.
  // Keyed on the arena being on screen at all: the first render is null until
  // the HUD arrives, and an effect that only ran then would find no element.
  const arenaOnScreen = hud !== null;
  useEffect(() => {
    if (!touch || !arenaOnScreen) return;
    const arena = arenaRef.current;
    if (!arena) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const seen = viewport?.height ?? window.innerHeight;
      arena.style.setProperty("--seen-height", `${Math.round(seen)}px`);
    };
    measure();
    viewport?.addEventListener("resize", measure);
    window.addEventListener("resize", measure);
    document.addEventListener("fullscreenchange", measure);
    document.addEventListener("webkitfullscreenchange", measure);
    return () => {
      viewport?.removeEventListener("resize", measure);
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", measure);
      document.removeEventListener("webkitfullscreenchange", measure);
      arena.style.removeProperty("--seen-height");
    };
  }, [touch, arenaOnScreen]);

  // Deliberately NOT an unmount cleanup. React runs effects mount → cleanup →
  // mount in development, so a teardown here fired the instant the fight
  // started and handed back the fullscreen the click had just taken. Leaving
  // the ring is an explicit act, so it is the only thing that gives it up; a
  // browser drops fullscreen on navigation by itself anyway.
  const leave = useCallback(() => {
    leaveArcadeMode();
    onLeave();
  }, [onLeave]);

  const press = useCallback((button: PlayerButton) => {
    taps.current.push({ button, at: performance.now() });
    // The punch a gassed tank is about to eat says so on screen. The throttle
    // is silent by itself, and a silent throttle reads as broken buttons —
    // "sometimes the keys just don't work" was the actual bug report.
    if (button !== "block" && button !== "dodge" && boutRef.current?.left.gassed) {
      setGassedAt(performance.now());
    }
  }, []);

  // The whole bout lives in this effect. It is started once per exhibition and
  // torn down with it; nothing inside re-runs on a render.
  useEffect(() => {
    const bout = engine.createBout(roster[0].id, roster[1].id, Date.now(), {
      totalRounds: EXHIBITION_ROUNDS,
      roundSeconds: EXHIBITION_ROUND_SECONDS,
    });
    boutRef.current = bout;
    frames.current = bout;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    let hudAt = 0;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Clamped, because a backgrounded tab stops firing rAF entirely and comes
      // back with a gap of whatever length. Uncapped, that gap is spent as fight
      // time the moment the player looks back at the page.
      const elapsed = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (pausedRef.current || bout.finish) return;

      // The exhibition runs at true speed. Difficulty is the opponent's eyes,
      // not the clock: dilating time made the footwork crawl, and footwork is
      // most of what a player feels.
      carry += elapsed;
      let steps = 0;
      while (carry >= BOXING_MODEL.physicsStepSeconds && steps < 8 && !bout.finish) {
        carry -= BOXING_MODEL.physicsStepSeconds;
        steps += 1;

        const snapshot: ControlSnapshot = {
          ...emptySnapshot(),
          ...movementAxes(held.current),
          blockHeld: held.current.has(BLOCK_KEY),
          taps: taps.current,
        };
        taps.current = [];

        // The intro is the fighters walking to the middle, and it is the one
        // stretch the player does not drive: an empty override is what tells
        // the engine to run its own round call. From the bell on, the corner is
        // always named — leaving it out for even a tick hands the player's
        // fighter back to the neural policy.
        if (bout.introSeconds > 0) {
          engine.advanceBout(bout, roster);
          continue;
        }

        engine.advanceBout(
          bout,
          roster,
          {
            blue: resolvePlayerAction(
              controller.current,
              snapshot,
              bout.left,
              bout.right,
              now,
            ),
          },
          { blue: snapshot.blockHeld },
        );
      }

      frames.current = bout;
      if (now - hudAt > 1000 / HUD_HZ) {
        hudAt = now;
        setHud({ ...bout });
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, roster, difficulty]);

  // Keyboard. Movement keys are held, punches fire on the edge, and everything
  // bound here swallows its own event so the page never scrolls mid-exchange.
  useEffect(() => {
    let lastBlock = 0;
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "escape") {
        setPaused((current) => !current);
        return;
      }
      if (isMovementKey(key)) {
        held.current.add(key);
        event.preventDefault();
        return;
      }
      const button = keyboardButton(key);
      if (!button) return;
      event.preventDefault();
      // Block is a hold, and a second press inside the combo window is a dodge
      // instead — exactly the button on the phone, so the two schemes never
      // drift into being different games.
      if (button === "block") {
        const at = performance.now();
        if (at - lastBlock < DOUBLE_TAP_MS) {
          press("dodge");
          held.current.delete(BLOCK_KEY);
        } else {
          held.current.add(BLOCK_KEY);
        }
        lastBlock = at;
        return;
      }
      press(button);
    };
    const up = (event: KeyboardEvent) => {
      held.current.delete(event.key.toLowerCase());
    };
    const blur = () => held.current.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [press]);

  const blue = roster[0];
  const red = roster[1];
  if (!hud) return null;

  const finished = Boolean(hud.finish);
  const winnerName =
    hud.winnerId === null ? null : hud.winnerId === blue.id ? "You" : red.lastName;

  return (
    <section
      className={`arena ${touch ? "arena--touch" : ""}`}
      ref={arenaRef}
      aria-label="Exhibition bout"
    >
      {/* Names, health, wind, the round and the clock are all drawn inside the
          canvas, so this rail carries only the one thing that is not: who you
          picked to fight and how fast he is. */}
      <div className="arena__vitals">
        <span className="arena__tag">{difficulty.label} · {reactionReadout(difficulty)}</span>
      </div>

      <div
        className="arena__stage"
        onPointerDown={touch ? () => reenterFullscreen(arenaRef.current) : undefined}
      >
        <div className="ring ring--canvas">
          <FightCanvas
            bout={hud}
            frames={frames}
            left={blue}
            right={red}
            /* An exhibition in an empty building: every punch, block and whiff
               lands the same, and there is nobody in the seats to cheer it, no
               announcer to call the round and no referee counting over you. */
            arena={false}
            playbackRate={1}
          />
        </div>

        {gassedAt > 0 ? (
          <div className="arena__gassed" key={gassedAt} aria-hidden="true">
            GASSED
          </div>
        ) : null}

        {/* A second, explicit run at the screen. The request made in the click
            that started the fight is the one that should land, but a phone
            browser can turn it down for reasons the page never learns, and a
            silent refusal looks exactly like a bug. This is a fresh gesture,
            and if it is refused too it says so and names the way round. */}
        {touch && !screenIsOurs && !screenAskHidden ? (
          <div className="arena__screen">
            {fullscreenRefused ? (
              <p>
                <button
                  className="arena__screen-close"
                  type="button"
                  aria-label="Dismiss"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setScreenAskHidden(true)}
                >
                  ×
                </button>
                {embedded ? (
                  <>
                    A browser inside another app cannot take the screen. Tap{" "}
                    <strong>⋯</strong> → <strong>Open in Safari</strong>, then add Forge
                    to your Home Screen from there.
                  </>
                ) : (
                  <>
                    Safari would not give up the screen. Tap <strong>⋯</strong> → Share →
                    scroll to <strong>Add to Home Screen</strong>, then open Forge from
                    the icon: no address bar, no tabs, the whole screen.
                  </>
                )}
              </p>
            ) : null}
            <button
              className="arena__screen-ask"
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                void enterArcadeMode(arenaRef.current).then((won) => setFullscreenRefused(!won));
              }}
            >
              Fill the screen
            </button>
          </div>
        ) : null}

        <button
          className="ring-sound"
          type="button"
          onClick={sound.toggle}
          aria-pressed={!sound.muted}
          title={sound.muted ? "Turn the crowd on" : "Silence the ring"}
        >
          <SpeakerIcon muted={sound.muted} />
          <span className="sr-only">{sound.muted ? "Turn sound on" : "Turn sound off"}</span>
        </button>

        {touch ? <TouchControls onPress={press} onHold={(down) => {
          // BLOCK_KEY, not a letter: the loop only ever reads the one key the
          // keyboard writes, and when the guard moved off B this handler kept
          // writing the old letter — the button lit, the engine heard nothing,
          // and touch players fought a whole fight with no block at all.
          if (down) held.current.add(BLOCK_KEY);
          else held.current.delete(BLOCK_KEY);
        }} heldRef={held} /> : null}

        {finished ? (
          <div className="arena__result" role="status">
            <span className="eyebrow">{hud.finish}</span>
            <strong>{winnerName ? `${winnerName} ${winnerName === "You" ? "win" : "wins"}` : "Draw"}</strong>
            <small>
              {hud.left.landed} landed for you · {hud.right.landed} for him. Nothing was recorded.
            </small>
            <div className="arena__result-actions">
              <button className="button button--blue" type="button" onClick={leave}>
                Pick another fight
              </button>
            </div>
          </div>
        ) : null}

        {paused && !finished ? (
          <div className="arena__result" role="status">
            <span className="eyebrow">Paused</span>
            <strong>Take a breath</strong>
            <div className="arena__result-actions">
              <button className="button button--blue" type="button" onClick={() => setPaused(false)}>
                Back in
              </button>
              <button className="button" type="button" onClick={leave}>
                Leave the ring
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!touch ? (
        <div className="arena__keys" aria-hidden="true">
          {KEY_BINDINGS.map((binding) => (
            <span key={binding.label}>
              {binding.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              <small>{binding.label}</small>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The phone layout: a stick under the left thumb, three buttons under the
 *  right. Everything is pointer-driven rather than click-driven so a press
 *  registers on contact instead of on release, which at this speed is the
 *  difference between blocking a punch and being hit by it. */
function TouchControls({
  onPress,
  onHold,
  heldRef,
}: {
  onPress: (button: PlayerButton) => void;
  onHold: (down: boolean) => void;
  heldRef: { current: Set<string> };
}) {
  const stick = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pointer = useRef<number | null>(null);
  const lastBlock = useRef(0);

  const move = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pad = stick.current;
    if (!pad || pointer.current !== event.pointerId) return;
    const box = pad.getBoundingClientRect();
    const radius = box.width / 2;
    const dx = (event.clientX - (box.left + radius)) / radius;
    const dy = (event.clientY - (box.top + radius)) / radius;
    const length = Math.hypot(dx, dy);
    const clamped = length > 1 ? { x: dx / length, y: dy / length } : { x: dx, y: dy };
    setKnob(clamped);

    // The stick writes straight into the same held-key set the keyboard uses,
    // so the resolver never learns which one the player is holding.
    const keys = heldRef.current;
    for (const key of ["w", "a", "s", "d"]) keys.delete(key);
    if (Math.abs(clamped.x) >= 0.35) keys.add(clamped.x > 0 ? "d" : "a");
    if (Math.abs(clamped.y) >= 0.35) keys.add(clamped.y > 0 ? "s" : "w");
  }, [heldRef]);

  const release = useCallback(() => {
    pointer.current = null;
    setKnob({ x: 0, y: 0 });
    for (const key of ["w", "a", "s", "d"]) heldRef.current.delete(key);
  }, [heldRef]);

  return (
    // The context menu is Android's flavour of the same gesture steal the CSS
    // fends off on iOS: a long-press on any control pops it and takes the
    // pointer with it. One handler on the pad covers the stick and every
    // button.
    <div className="touchpad" onContextMenu={(event) => event.preventDefault()}>
      <div
        className="touchpad__stick"
        ref={stick}
        onPointerDown={(event) => {
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event);
        }}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
        role="application"
        aria-label="Movement stick"
      >
        <i style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }} />
      </div>

      {/* A diamond around the block, rather than a row.
          Three buttons in a line meant the thumb travelled the same distance to
          every punch and the guard sat at one end of it, which is the wrong way
          round: the hands are up more often than any single punch is thrown, so
          the guard is the resting position and everything else is a short push
          off it. It also makes the punches findable by direction — up is the
          hook, left is the jab, right is the cross, down is the power shot —
          which is what a thumb can actually do at this speed. */}
      <div className="touchpad__buttons">
        <button
          type="button"
          className="touchpad__button touchpad__button--hook"
          aria-label="Hook"
          onPointerDown={(event) => {
            event.preventDefault();
            onPress("hook");
          }}
        >
          HOOK
        </button>
        <button
          type="button"
          className="touchpad__button touchpad__button--jab"
          aria-label="Jab"
          onPointerDown={(event) => {
            event.preventDefault();
            onPress("jab");
          }}
        >
          JAB
        </button>
        <button
          type="button"
          className="touchpad__button touchpad__button--block"
          aria-label="Block, double tap to dodge"
          onPointerDown={(event) => {
            event.preventDefault();
            // Same capture the stick takes: a blocking thumb drifts, and
            // without capture its pointerup lands on whatever it drifted onto
            // — this button never hears it and the guard sticks on.
            event.currentTarget.setPointerCapture(event.pointerId);
            const now = performance.now();
            // A second tap inside the window is a dodge, not a block — one
            // button covering both is what keeps the guard in the middle
            // instead of spending a sixth position on it.
            if (now - lastBlock.current < DOUBLE_TAP_MS) {
              onPress("dodge");
              onHold(false);
            } else {
              onHold(true);
            }
            lastBlock.current = now;
          }}
          onPointerUp={() => onHold(false)}
          onPointerCancel={() => onHold(false)}
        >
          BLOCK
        </button>
        <button
          type="button"
          className="touchpad__button touchpad__button--cross"
          aria-label="Cross"
          onPointerDown={(event) => {
            event.preventDefault();
            onPress("cross");
          }}
        >
          CROSS
        </button>
        <button
          type="button"
          className="touchpad__button touchpad__button--power"
          aria-label="Power punch"
          onPointerDown={(event) => {
            event.preventDefault();
            onPress("power");
          }}
        >
          POWER
        </button>
      </div>
    </div>
  );
}
