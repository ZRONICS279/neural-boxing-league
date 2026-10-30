"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ArchiveFightFeed,
  type ArchiveListFeed,
  type ArchivedFight,
  type ReplaySpeed,
} from "./archive.ts";
import { BOXING_MODEL, type BoutState, type Fighter } from "./fight-model.ts";
import type { VoiceSource } from "./announcer-caption.ts";
import { withRingName } from "./ring-names.ts";
import { createTimelinePlayer, type TimelinePlayer } from "./timeline-play.ts";

/** The viewer's end of the archive.
 *
 * Nothing here is live, which is the whole difference from `broadcast-store`.
 * That hook is pinned to a clock every viewer shares, because the point of a
 * live card is that two people are on the same round. A rewatch has no such
 * obligation: it is one person's own copy of a fight that is already over, so it
 * runs on a timer this tab owns and can be paused, restarted or hurried without
 * that meaning anything to anybody else. */

const FRAME_MS = BOXING_MODEL.physicsStepSeconds * 1000;
/** How often the transport bar and the numbers around the ring are allowed to
 *  move — the canvas takes every frame off `frames` regardless. A rewatch is
 *  the worst case for this: at 12× the playhead crosses twelve ticks a frame,
 *  and re-rendering the whole stage for each of them is how a phone ends up
 *  playing a fast-forward slower than real time. Same reasoning, and the same
 *  rate, as the live broadcast's. */
const READOUT_MS = 100;

/* ------------------------------------------------------------- the listing */

/** One page of the archive. No state of its own — see `usePastFights`. */
async function readPage(pageSize: number, cursor: number | null) {
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (cursor !== null) params.set("before", String(cursor));
  const response = await fetch(`/api/archive?${params}`, { cache: "no-store" });
  return (await response.json()) as ArchiveListFeed;
}

/** Every fight the league has finished, newest first, a page at a time.
 *
 * The fetch is deliberately a plain function rather than something the hook
 * calls straight out of an effect body: every piece of state here is set from
 * inside the promise, once an answer exists, instead of a render being spent
 * announcing that a request has left. */
export function usePastFights(pageSize = 24) {
  const [fights, setFights] = useState<ArchivedFight[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  // Starts true rather than being raised by the first fetch: the first page is
  // always on its way, and saying so from the initial state costs no render.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Guards against a double-fire: two clicks on "older" while one page is in
   *  flight would otherwise append the same fights twice. */
  const inFlight = useRef(false);

  const take = useCallback(
    (payload: ArchiveListFeed, append: boolean) => {
      if (!payload.ok) {
        setError(payload.error);
        return;
      }
      setFights((held) => (append ? [...held, ...payload.fights] : payload.fights));
      setBefore(payload.nextBefore);
      setError(null);
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    inFlight.current = true;

    void (async () => {
      try {
        const payload = await readPage(pageSize, null);
        if (mounted) take(payload, false);
      } catch {
        if (mounted) setError("The archive is unreachable.");
      } finally {
        inFlight.current = false;
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [pageSize, take]);

  return {
    fights,
    loading,
    error,
    /** Null once the archive has been walked to its end. */
    more: before,
    loadMore: useCallback(() => {
      if (before === null || inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      void readPage(pageSize, before)
        .then((payload) => take(payload, true))
        .catch(() => setError("The archive is unreachable."))
        .finally(() => {
          inFlight.current = false;
          setLoading(false);
        });
    }, [before, pageSize, take]),
  };
}

/* ---------------------------------------------------------------- one fight */

export type ArchiveStatus = "loading" | "found" | "missing" | "offline";

/** One archived fight and the replay that goes with it, if it still has one.
 *
 * The answer is held as one object stamped with the bout it is about, rather
 * than three pieces of state cleared on the way in. A lookup that is still out
 * is then simply "the held answer is for a different fight", which needs no
 * render of its own — and, more to the point, cannot leave the previous fight's
 * replay on screen for a frame under the new fight's name. */
export function useArchivedFight(boutId: number, enabled: boolean) {
  const [held, setHeld] = useState<{
    boutId: number;
    fight: ArchivedFight | null;
    profiles: [Fighter, Fighter] | null;
    status: ArchiveStatus;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !boutId) return;
    let mounted = true;

    void (async () => {
      try {
        const response = await fetch(`/api/archive?bout=${boutId}`, { cache: "no-store" });
        const payload = (await response.json()) as ArchiveFightFeed;
        if (!mounted) return;
        setHeld(payload.ok
          ? {
              boutId,
              fight: payload.fight,
              profiles: payload.profiles
                ? (payload.profiles.map(withRingName) as [Fighter, Fighter])
                : payload.profiles,
              status: "found",
            }
          : {
              boutId,
              fight: null,
              profiles: null,
              status: response.status === 404 ? "missing" : "offline",
            });
      } catch {
        if (mounted) {
          setHeld({ boutId, fight: null, profiles: null, status: "offline" });
        }
      }
    })();

    return () => { mounted = false; };
  }, [boutId, enabled]);

  const current = held?.boutId === boutId ? held : null;
  return {
    fight: current?.fight ?? null,
    profiles: current?.profiles ?? null,
    status: current?.status ?? "loading",
  };
}

/* --------------------------------------------------------------- the replay */

export interface Rewatch {
  bout: BoutState | null;
  /** Every frame of the recording, for the canvas — see READOUT_MS. */
  frames: { current: BoutState | null };
  /** The ringside call as it was recorded with the fight, for the stage. */
  voice: VoiceSource;
  playing: boolean;
  speed: ReplaySpeed;
  /** 0–1, for a progress bar. Read off ticks rather than the clock, so it is
   *  right the instant a speed change lands. */
  progress: number;
  /** True once the replay has reached the final bell and stopped there. */
  ended: boolean;
  play: () => void;
  pause: () => void;
  restart: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
}

/** Plays an archived bout's recording the way the broadcast plays a live one.
 *
 * The same chunks the live page draws, fetched from the same route — which is
 * why a rewatch is frame-for-frame the fight that aired rather than a fresh
 * one between the same men. What changes is only where the target tick comes
 * from: the league clock for a live bout, and this tab's own accumulated
 * playhead for a rewatch. An archived fight has aired in full, so the player
 * is told the whole recording is fair game and a restart replays chunks it
 * already holds without touching the network.
 *
 * The playhead advances by wall time × speed rather than by a fixed number of
 * ticks a frame, so 12× is twelve times the fight per second whatever the
 * browser is doing with the timer — and a tab that gets throttled catches up in
 * one burst instead of quietly falling behind. */
export function useRewatch(fight: ArchivedFight | null): Rewatch {
  const [state, setState] = useState<BoutState | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [elapsed, setElapsed] = useState(0);

  /** Milliseconds of fight time played so far, and the wall instant that was
   *  last true at. Refs because the frame must not re-subscribe per tick. */
  const playhead = useRef(0);
  const lastFrame = useRef(0);
  const held = useRef<BoutState | null>(null);
  const player = useRef<TimelinePlayer | null>(null);
  const fightId = useRef<number | null>(null);

  const totalTicks = fight?.ticks ?? 0;
  const totalMs = totalTicks * FRAME_MS;

  const rewind = useCallback(() => {
    playhead.current = 0;
    lastFrame.current = Date.now();
    held.current = null;
    setElapsed(0);
    setState(null);
  }, []);

  // `held` is the newest frame the recording has produced; `state` is the one
  // the page is drawn from, which is the same frame ten times a second rather
  // than fifty. The canvas reads `held` directly on its own animation frames.

  // A different fight in the same player starts from its own opening bell.
  useEffect(() => {
    if (!fight) return;
    if (fightId.current === fight.id) return;
    fightId.current = fight.id;
    player.current?.stop();
    player.current = createTimelinePlayer(fight.id);
    rewind();
    setPlaying(true);
  }, [fight, rewind]);

  useEffect(() => {
    return () => {
      player.current?.stop();
      player.current = null;
    };
  }, []);

  useEffect(() => {
    if (!fight || !playing || totalTicks === 0) return;
    lastFrame.current = Date.now();
    /** When the transport bar and the stage were last handed anything. */
    let published = 0;

    const frame = () => {
      const now = Date.now();
      playhead.current = Math.min(totalMs, playhead.current + (now - lastFrame.current) * speed);
      lastFrame.current = now;
      const done = playhead.current >= totalMs;
      // The last frame is published whatever the clock says: it carries the
      // verdict, and nothing comes after it to carry it instead.
      const due = done || now - published >= READOUT_MS;
      if (due) {
        published = now;
        setElapsed(playhead.current);
      }

      const target = Math.min(totalTicks, Math.floor(playhead.current / FRAME_MS));
      const current = player.current;
      if (!current) return;
      current.ensure(target, Number.MAX_SAFE_INTEGER);
      const next = current.boutAt(target);
      if (next && (!held.current || held.current.tick < next.tick)) held.current = next;
      // Handing back the same frame is free — React drops a set that changes
      // nothing — so this does not have to know whether one has landed since.
      if (due && held.current) setState(held.current);
      if (done) setPlaying(false);
    };

    frame();
    const timer = window.setInterval(frame, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [fight, playing, speed, totalMs, totalTicks]);

  return {
    bout: state,
    frames: held,
    voice: useCallback(() => player.current?.voice() ?? null, []),
    playing,
    speed,
    progress: totalMs > 0 ? Math.min(1, elapsed / totalMs) : 0,
    ended: totalMs > 0 && elapsed >= totalMs,
    play: useCallback(() => {
      // Replaying from the end is the one case where "play" means "again".
      if (playhead.current >= totalMs) rewind();
      setPlaying(true);
    }, [rewind, totalMs]),
    pause: useCallback(() => setPlaying(false), []),
    restart: useCallback(() => {
      rewind();
      setPlaying(true);
    }, [rewind]),
    setSpeed,
  };
}
