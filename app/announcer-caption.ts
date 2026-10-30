"use client";

import { useEffect, useRef, useState } from "react";
import { LULL_GAP_TICKS, createAnnouncer, type AnnouncerLine } from "./announcer.ts";
import { forgetClips, silenceSpeech, speakClip, warmClip } from "./announcer-speech.ts";
import { ANNOUNCER_VOICE } from "./feature-flags.ts";
import type { BoutState, Fighter } from "./fight-model";
import { TIMELINE_CHUNK_TICKS, type TimelineVoiceLine } from "./fight-timeline.ts";

/** The ringside voice, on the stage.
 *
 * The React side of the announcer: the lower-third caption as component state,
 * and the spoken clip that goes with it. The lines themselves come from one of
 * two places — the call the server recorded with the fight, read off the
 * timeline chunks, or, for footage that has none, the engine in announcer.ts
 * run over the frames the stage publishes, exactly as it always was. */

/** Where the stage reads the recorded call from, when there is one: the
 *  timeline player's lines for the chunks it has loaded, or null for footage
 *  that predates the call being written down with the fight — and for player
 *  mode, where the engine runs in the browser and there is no recording. With
 *  null this hook's own engine calls the fight off the frames, as it always
 *  did; with a script it reads the lines the server recorded and plays their
 *  clips, so what is heard is exactly what the recording pass said. */
export type VoiceSource = () => TimelineVoiceLine[] | null;

/* How far past the playhead clips are fetched, in ticks. The player holds one
 * chunk of read-ahead, so this is bounded by what is known anyway; the point is
 * that a clip is on hand before its tick rather than a round trip after it. */
const WARM_TICKS = 2 * TIMELINE_CHUNK_TICKS;

/** The caption as component state: feed it the stage's own bout reads and it
 *  holds the current line, then marks it leaving so the CSS can fade it out.
 *
 * `live` gates the voice the way `contactAudible` gates the punch sounds — a
 * fast-forwarded rewatch or a sped-up broadcast would turn the calls into a
 * drumroll. The engine still observes every frame so its baselines track, but
 * lines produced while not live are dropped rather than shown late. */
export function useAnnouncer(
  bout: BoutState | null,
  blue: Fighter | null,
  red: Fighter | null,
  live: boolean,
  voice?: VoiceSource,
) {
  const engineRef = useRef<ReturnType<typeof createAnnouncer> | null>(null);
  const timersRef = useRef<number[]>([]);
  /** The playhead's place in a recorded call: which fight, the tick this
   *  viewer joined at, and the last tick read past. Lines at or before the
   *  join are the backlog the engine's own priming discards. */
  const readRef = useRef<{ boutId: number; joinTick: number; readTick: number } | null>(null);
  const [caption, setCaption] = useState<(AnnouncerLine & { leaving: boolean }) | null>(null);

  // A new bout gets a clean bar, adjusted during render rather than in an
  // effect so the old fight's sentence never draws over the new one's opening.
  const [shownBoutId, setShownBoutId] = useState(bout?.id);
  if (bout?.id !== shownBoutId) {
    setShownBoutId(bout?.id);
    setCaption(null);
  }

  useEffect(() => {
    if (!bout || !blue || !red) return;
    const show = (line: AnnouncerLine) => {
      for (const timer of timersRef.current.splice(0)) window.clearTimeout(timer);
      setCaption({ ...line, leaving: false });
      timersRef.current.push(
        window.setTimeout(() => {
          setCaption((current) => (current?.id === line.id ? { ...current, leaving: true } : current));
        }, line.holdMs),
        window.setTimeout(() => {
          setCaption((current) => (current?.id === line.id ? null : current));
        }, line.holdMs + 450),
      );
    };

    const script = voice?.() ?? null;
    if (script) {
      let read = readRef.current;
      // A new fight, or a playhead that went backwards (a rewatch restarted
      // from the top), is a fresh join — nothing before it is owed.
      if (!read || read.boutId !== bout.id || bout.tick < read.readTick) {
        read = { boutId: bout.id, joinTick: bout.tick, readTick: bout.tick };
        readRef.current = read;
        if (ANNOUNCER_VOICE) forgetClips(bout.id, 0);
      }
      if (ANNOUNCER_VOICE) {
        for (const line of script) {
          if (line.tick > bout.tick && line.tick <= bout.tick + WARM_TICKS) warmClip(bout.id, line.line);
        }
      }
      const due = script.filter((line) => line.tick > read.readTick && line.tick <= bout.tick);
      read.readTick = bout.tick;
      if (due.length === 0 || !live) return;
      // The color clock starts at the join, as it does in the engine: filler
      // recorded for a viewer who was there all along is not owed to one who
      // has just sat down. Real moments are — a knockdown two seconds after
      // joining is still called. Several lines inside one readout is the
      // louder moment winning the frame, so the last one stands.
      const line = due
        .filter((entry) => entry.register !== "color" || entry.tick - read.joinTick >= LULL_GAP_TICKS)
        .at(-1);
      if (!line) return;
      show({
        id: line.line,
        text: line.text,
        register: line.register,
        corner: line.corner,
        holdMs: line.holdMs,
      });
      // And out loud, when the voice is on. speakClip re-checks mute at fire
      // time, like playCue; one line of slack behind the playhead, see
      // forgetClips.
      if (ANNOUNCER_VOICE) {
        speakClip(bout.id, line.line);
        forgetClips(bout.id, line.line - 1);
      }
      return;
    }

    engineRef.current ??= createAnnouncer();
    const line = engineRef.current.observe(bout, blue, red);
    if (!line || !live) return;
    show(line);
  }, [bout, blue, red, live, voice]);

  // An unmount leaves no timer talking, and no half-spoken sentence either.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      silenceSpeech();
    };
  }, []);

  return caption;
}
