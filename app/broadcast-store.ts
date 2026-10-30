"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BroadcastClock,
  type DivisionState,
  type ScheduledBout,
  PLAYBACK_DELAY_MS,
  leagueNow,
  tickForTime,
} from "./broadcast-model.ts";
import {
  BOXING_MODEL,
  type BoutState,
  type Fighter,
  type WeightClassId,
} from "./fight-model.ts";
import { TIMELINE_CHUNK_TICKS } from "./fight-timeline.ts";
import { GENESIS_BILL } from "./genesis-bill.ts";
import { requestAccount, signMessage, subscribeAccount } from "./market.ts";
import { applyRingNames, withRingName } from "./ring-names.ts";
import {
  OPERATOR_PASS_MS,
  isOperator,
  operatorPassMessage,
  parseOperatorPass,
} from "./operator.ts";
import type { VoiceSource } from "./announcer-caption.ts";
import { createTimelinePlayer, type TimelinePlayer } from "./timeline-play.ts";

/** The viewer's end of the broadcast.
 *
 * The server sends the card — who is in there and when the opening bell rang —
 * and the fight itself arrives as recorded five-second chunks from
 * `/api/timeline`, fetched as the league clock airs them. Every browser plays
 * the same recording one chunk behind the live edge, so two viewers on
 * opposite sides of the world see the same frame, a reload rejoins mid-round
 * instead of starting over, and nothing that could name the winner early —
 * no seed, no engine, no unaired frame — is ever on this side of the wire. */

const POLL_MS = 5000;
const FRAME_MS = BOXING_MODEL.physicsStepSeconds * 1000;
const CHUNK_MS = TIMELINE_CHUNK_TICKS * FRAME_MS;
/** The viewer's distance behind the bell — defined in broadcast-model.ts so
 *  the worker's maker can price the frame the viewer is seeing, re-exported
 *  here for the pages that keep countdowns, verdicts and card results in step
 *  with the picture. */
export { PLAYBACK_DELAY_MS };
/** How often the numbers around the picture are allowed to move.
 *
 * The canvas takes every frame — that is the fight moving, and it reads them
 * off a ref inside its own animation loop without React in the way. Nothing
 * else needs them at that rate. Publishing the frame and the league clock as
 * state fifty times a second re-rendered the entire broadcast fifty times a
 * second — both scoreboards, both rails, the telemetry, the card, the
 * standings — for readings no eye can tell apart, and on a phone that work came
 * straight out of the frames the canvas was trying to draw. Ten a second is
 * what the whole broadcast ran at before the engine moved to 50 Hz, and nobody
 * ever called the scoreboard choppy. */
const READOUT_MS = 100;
const ADMIN_PASS_KEY = "forge-league-admin-pass";

interface StoredPass {
  message: string;
  signature: string;
}

function readStoredPass(): StoredPass | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ADMIN_PASS_KEY);
    if (!raw) return null;
    const pass = JSON.parse(raw) as StoredPass;
    return pass.message && pass.signature ? pass : null;
  } catch {
    // A pass that will not parse is a pass that will not verify either.
    return null;
  }
}

/** Whether this pass is still the operator's and still in date. The server
 *  checks all of this again over the signature — this is only so the panel
 *  knows to ask for a fresh one before a command is refused. */
function passHolds(pass: StoredPass | null, address: string | null) {
  if (!pass || !isOperator(address)) return false;
  const claim = parseOperatorPass(pass.message);
  return Boolean(
    claim &&
    isOperator(claim.address) &&
    claim.address.toLowerCase() === address?.toLowerCase() &&
    claim.expires > Date.now(),
  );
}

/** Mutating controls all carry the pass signed in the broadcast admin panel.
 *  The message travels base64'd because it has newlines in it and a header
 *  cannot; the signature is over the text, not the encoding. */
export function adminRequestHeaders() {
  const pass = readStoredPass();
  return {
    "content-type": "application/json",
    "x-forge-pass": pass ? btoa(pass.message) : "",
    "x-forge-pass-signature": pass?.signature ?? "",
  };
}

export interface BoutSummary {
  id: number;
  division: WeightClassId;
  kind: "contender" | "title";
  blueId: string;
  redId: string;
  startsAt: number;
  endsAt: number;
  totalRounds: number;
  result: {
    winnerId: string | null;
    finish: "KO" | "TKO" | "Decision" | "Draw";
    round: number;
    ticks: number;
    blueLanded: number;
    redLanded: number;
  } | null;
  status: "final" | "live" | "scheduled";
}

interface BroadcastFeed {
  ok: true;
  serverTime: number;
  leagueTime: number;
  clock: BroadcastClock;
  season: number;
  week: number;
  night: number;
  weekStartedAt: number;
  rosterVersion: number;
  boutsCompleted: number;
  divisions: DivisionState[];
  live: ScheduledBout | null;
  upcoming: ScheduledBout | null;
  card: BoutSummary[];
  adminConfigured: boolean;
}

export type BroadcastStatus = "connecting" | "live" | "intermission" | "offline";

/** The exact fight the card is publishing, not merely which bout it is.
 *
 * A slot can be republished — an admin ringing the bell early, or a card this
 * tab hydrated a moment before the server settled on a different one — and when
 * it is, the airtime or the corner instructions move. Carrying on from the old
 * replay state would then be a private fight: the result panel goes up over a
 * round still in progress, and two browsers disagree about who won. Any change
 * here restarts the replay from the opening bell, which costs a few hundred
 * milliseconds and is always right. Exported for the test that pins the one
 * exception below. */
export function fightIdentity(bout: ScheduledBout | null | undefined) {
  if (!bout) return null;
  return [
    bout.id,
    bout.startsAt,
    bout.endsAt,
    bout.result?.ticks ?? -1,
    bout.directives.length,
  ].join(":");
}

/** True when `next` is `held` with the spoiler mask lifted, not a republish.
 *
 * The live row hides `result` and pads `endsAt` until the final bell has gone
 * on the league clock, so at that moment the identity above moves — same slot,
 * same bell, same fight, just the truth where the placeholder was. Treating
 * that as a republish dropped the athlete snapshots and unmounted the whole
 * stage to "between fights" for a poll cycle, straight across the knockout
 * count the viewer was ten seconds from seeing. */
export function revealOf(held: string, next: string) {
  const a = held.split(":");
  const b = next.split(":");
  return a[0] === b[0] && a[1] === b[1] && a[4] === b[4] &&
    a[3] === "-1" && b[3] !== "-1";
}

export function useBroadcast() {
  const [feed, setFeed] = useState<BroadcastFeed | null>(null);
  const [status, setStatus] = useState<BroadcastStatus>("connecting");
  const [bout, setBout] = useState<BoutState | null>(null);
  // The signed roster, not the live one — the division renders on the server
  // and on the first paint, then the careers snap to whatever the league has
  // actually done as soon as the first poll lands. The bill is generated data
  // (see scripts/build-genesis-bill.ts): fabricating it live used to mean
  // shipping the whole engine, weights and all, just for this first paint.
  const [roster, setRoster] = useState<Fighter[]>(() => applyRingNames(GENESIS_BILL.roster));
  const [leagueTime, setLeagueTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** Athlete snapshots keyed by bout, so a poll never re-downloads 30 KB of
   * policy matrices for a fight already on screen.
   *
   * Stamped with the exact fight they arrived with, not just the bout number.
   * The server only sends snapshots this tab does not claim to hold, so a stale
   * pair would never be corrected: the tab would keep replaying two men who
   * fought a version of the bout nobody else is watching, and no amount of
   * rebuilding from the bell would fix it. Dropping the entry un-claims it, and
   * the next poll brings the right one. */
  const profiles = useRef(new Map<number, { fight: string; pair: [Fighter, Fighter] }>());
  /** serverTime − Date.now(); every replay is timed against the server. */
  const clockSkew = useRef(0);
  const feedRef = useRef<BroadcastFeed | null>(null);
  const boutRef = useRef<BoutState | null>(null);
  /** The picture's own supply of frames, written every tick and read by the
   *  canvas on its next animation frame — see READOUT_MS. `bout` below is the
   *  same fight at a rate a person can read. */
  const frames = useRef<BoutState | null>(null);
  /** The chunk player for the fight on air, swapped out when the card moves on. */
  const playerRef = useRef<TimelinePlayer | null>(null);
  const rosterVersion = useRef(-1);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);
  useEffect(() => {
    boutRef.current = bout;
  }, [bout]);

  /** Re-attaches the cached athlete snapshots the server left out. */
  const hydrate = useCallback((scheduled: ScheduledBout | null) => {
    if (!scheduled) return null;
    const fight = fightIdentity(scheduled)!;
    if (scheduled.profiles) {
      // Ring names go on as the snapshots come off the wire, so every reader
      // downstream — stage, canvas, market — sees one name.
      const pair = scheduled.profiles.map(withRingName) as [Fighter, Fighter];
      profiles.current.set(scheduled.id, { fight, pair });
      return { ...scheduled, profiles: pair };
    }
    const cached = profiles.current.get(scheduled.id);
    if (!cached) return scheduled;
    // Snapshots held for a different cut of this bout are worse than none:
    // replaying them produces a fight of this tab's own. Let them go and the
    // next poll re-sends the pair this fight was actually fought by — unless
    // the only thing that moved is the reveal, in which case these are still
    // the right two men and dropping them cuts the stream at the finish.
    if (cached.fight !== fight) {
      if (!revealOf(cached.fight, fight)) {
        profiles.current.delete(scheduled.id);
        return scheduled;
      }
      profiles.current.set(scheduled.id, { fight, pair: cached.pair });
    }
    return { ...scheduled, profiles: cached.pair };
  }, []);

  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      try {
        const have = [...profiles.current.keys()].join(",");
        const response = await fetch(`/api/league?have=${have}`, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json() as BroadcastFeed;
        if (!mounted || !payload.ok) return;

        clockSkew.current = payload.serverTime - Date.now();
        const live = hydrate(payload.live);
        const upcoming = hydrate(payload.upcoming);
        // Only the fight on air and the one after it can still be needed.
        const keep = new Set([live?.id, upcoming?.id].filter(Boolean) as number[]);
        for (const id of profiles.current.keys()) {
          if (!keep.has(id)) profiles.current.delete(id);
        }

        setFeed({ ...payload, live, upcoming });
        setStatus(live ? "live" : "intermission");
        setError(null);

        if (payload.rosterVersion !== rosterVersion.current) {
          rosterVersion.current = payload.rosterVersion;
          const rosterResponse = await fetch("/api/league/roster", { cache: "no-store" });
          if (rosterResponse.ok && mounted) {
            const rosterPayload = await rosterResponse.json() as { roster: Fighter[] };
            setRoster(applyRingNames(rosterPayload.roster ?? []));
          }
        }
      } catch {
        if (!mounted) return;
        setStatus("offline");
        setError("The league broadcast is unreachable.");
      }
    };

    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [hydrate]);

  // The playback loop. Each frame asks the shared clock what tick the fight is
  // on, holds two chunks behind it, and draws whatever the player has loaded —
  // the player itself quietly fetches chunks as they air.
  //
  // The league clock is published as state rather than read during render:
  // `Date.now()` and the skew ref are both things a render must not touch, and
  // the intermission countdown needs it ticking even when no bout is on air.
  const liveId = feed?.live?.id ?? null;
  useEffect(() => {
    /** Wall time the readouts were last handed anything. */
    let published = 0;

    const frame = () => {
      const current = feedRef.current;
      if (!current) return;
      const wall = Date.now();
      const now = leagueNow(current.clock, wall + clockSkew.current);
      // Wall time rather than league time: a paused or half-speed clock must
      // not slow the page down with it, and a doubled one must not speed it up.
      const due = wall - published >= READOUT_MS;
      if (due) {
        published = wall;
        setLeagueTime(now);
      }

      const live = current.live;
      if (!live) {
        playerRef.current?.stop();
        playerRef.current = null;
        frames.current = null;
        if (boutRef.current) setBout(null);
        return;
      }
      // The viewer's bell rings two chunks after the real one, so the countdown
      // simply runs those seconds longer and playback only ever needs chunks
      // that have fully aired.
      const delayed = now - PLAYBACK_DELAY_MS;
      if (delayed < live.startsAt - CHUNK_MS) {
        frames.current = null;
        if (boutRef.current) setBout(null);
        return;
      }
      if (!playerRef.current || playerRef.current.boutId !== live.id) {
        playerRef.current?.stop();
        playerRef.current = createTimelinePlayer(live.id);
      }
      const player = playerRef.current;
      const target = tickForTime(live, delayed);
      player.ensure(target, tickForTime(live, now));
      if (delayed < live.startsAt) {
        // The last countdown seconds: the opening chunk has aired by now, so
        // the player above is already warming it up and the first frame is on
        // hand at the bell rather than a round trip late.
        frames.current = null;
        if (boutRef.current) setBout(null);
        return;
      }
      // A fetch that has not landed yet is not a blank screen: `boutAt` holds
      // the newest loaded frame and playback catches up when the chunk lands.
      const next = player.boutAt(target);
      if (!next) return;
      const held = frames.current;
      if (held && held.id === next.id && held.tick >= next.tick) return;
      frames.current = next;
      // The readouts take a frame ten times a second. The frame the fight ends
      // on is the exception: the verdict hangs off it, the recording has no
      // later frame to carry it, and being a tenth of a second late with a
      // knockout is not the same as being a tenth of a second late with a
      // punch count.
      const shown = boutRef.current;
      if (!due && next.running && shown && shown.id === next.id) return;
      setBout(next);
    };

    frame();
    const timer = window.setInterval(frame, FRAME_MS);
    return () => {
      window.clearInterval(timer);
      playerRef.current?.stop();
      playerRef.current = null;
    };
  }, [liveId]);

  /** The recorded call for whatever the player is showing. A stable function
   *  rather than the lines themselves: they grow as chunks land, and the stage
   *  reads them on its own frame rather than re-rendering for each arrival. */
  const voice = useCallback<VoiceSource>(() => playerRef.current?.voice() ?? null, []);

  const fighters = useMemo(() => {
    const live = feed?.live;
    if (!live?.profiles) return null;
    const [first, second] = live.profiles;
    return first.id === live.blueId
      ? { blue: first, red: second }
      : { blue: second, red: first };
  }, [feed?.live]);

  return {
    feed,
    bout,
    /** Hand this to the stage: it is the same fight as `bout`, every tick of
     *  it, for the one thing on the page that can use them all. */
    frames,
    voice,
    fighters,
    roster,
    status,
    error,
    leagueTime,
    paused: (feed?.clock.rate ?? 1) === 0,
    rate: feed?.clock.rate ?? 1,
  };
}

/** The league's controls, held by a wallet rather than a password.
 *
 * `operator` is whether the address this tab is connected as is the one that
 * runs the league — the panel is not drawn at all for anybody else. `unlocked`
 * is the stronger thing: a pass this address signed, still in date, kept in
 * storage so a night on the desk is one wallet popup rather than one per
 * click. The server verifies that signature on every command; nothing here is
 * the security, it only decides what is worth drawing. */
export function useAdmin() {
  const [address, setAddress] = useState<string | null>(null);
  // Read straight out of storage on the first render rather than in an effect,
  // so a returning operator never sees the panel flash locked.
  const [pass, setPass] = useState<StoredPass | null>(readStoredPass);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => subscribeAccount(setAddress), []);

  const command = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setMessage(null);
      try {
        const response = await fetch("/api/league", {
          method: "POST",
          headers: adminRequestHeaders(),
          body: JSON.stringify(body),
        });
        const payload = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          setMessage(payload.error ?? "The command was refused.");
          return false;
        }
        return true;
      } catch {
        setMessage("The command could not be sent.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /** Ask the operator's wallet for a pass, then check the server agrees before
   *  the panel opens: a signature this deployment will not accept should fail
   *  here rather than on the first command that matters. */
  const unlock = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const signer = address ?? await requestAccount();
      if (!isOperator(signer)) {
        setMessage("That wallet does not run this league.");
        return false;
      }
      const text = operatorPassMessage(signer, Date.now() + OPERATOR_PASS_MS);
      const signed: StoredPass = { message: text, signature: await signMessage(signer, text) };
      window.localStorage.setItem(ADMIN_PASS_KEY, JSON.stringify(signed));
      setPass(signed);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The wallet refused to sign.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [address]);

  const lock = useCallback(() => {
    window.localStorage.removeItem(ADMIN_PASS_KEY);
    setPass(null);
  }, []);

  return {
    operator: isOperator(address),
    unlocked: passHolds(pass, address),
    busy,
    message,
    setMessage,
    command,
    unlock,
    lock,
  };
}
