"use client";

import { isMuted } from "./sound.ts";

/** The ringside voice, out loud.
 *
 * The call is written down with the fight (see worker/fight-timeline.ts) and
 * spoken on the server ahead of the bell, one clip per line, so this end never
 * synthesizes a word: it fetches the clips the viewer is about to hear, keeps
 * them by the ring, and plays the one whose line has just landed. The fight
 * the viewer sees is identical either way, and a clip that never arrives is a
 * line the caption carries alone.
 *
 * House rules are the sound layer's rules: nothing speaks while the broadcast
 * is muted (checked at speak time, like playCue), the unmute gesture is what
 * unlocks the element on iOS, and a hidden page goes silent immediately.
 * Nothing interrupts a sentence in progress — a voice that cuts itself off
 * mid-word reads as a glitch, however big the moment — so a line that lands
 * while another is being read is never spoken: by the time the mouth is free
 * it would be stale news. */

/* One element, because there is one caller. iOS grants playback per element
 * and only to one that has been played inside a gesture, so this is unlocked
 * on the unmute tap exactly the way the punch pools are — on the hair of
 * silence baked in below rather than on a clip that may not have downloaded
 * yet. The grant stays with the element as its src moves from clip to clip. */
const SILENCE =
  "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
/* A head above the punches (0.5) and level with the round call (0.75): the
 * voice is the one thing on the broadcast meant to be listened to. */
const GAIN = 0.85;
/** How long to wait before asking once more for a clip the server did not
 *  have: the render pass may simply not have reached that line yet. */
const RETRY_MS = 2500;
/** How late a clip may land and still be worth reading. Past this the caption
 *  it belongs to is already fading, and a voice that catches up on old news
 *  is worse than one that skipped it. */
const STALE_MS = 1500;

let mouth: HTMLAudioElement | null = null;
let watching = false;
/** Which line is meant to be read next, so a clip that finishes downloading
 *  after a later line has spoken does not barge in behind it. */
let wanted: string | null = null;
/** Object URLs by `bout:line`, kept from the moment a line is warmed until the
 *  playhead is past it. A promise rather than a URL so a speak that arrives
 *  mid-download can wait on the same fetch instead of starting another. */
const clips = new Map<string, Promise<string | null>>();

function element() {
  if (!mouth) {
    mouth = new Audio(SILENCE);
    mouth.preload = "auto";
    mouth.volume = GAIN;
  }
  return mouth;
}

function keyOf(boutId: number, line: number) {
  return `${boutId}:${line}`;
}

/* Hidden means quiet, this instant, same contract as the rest of the ring's
 * sound: a caption nobody can see must not go on being read to the home
 * screen. `pagehide` for the Safari exits that never report hidden. */
function watchPage() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) silenceSpeech();
  });
  window.addEventListener("pagehide", silenceSpeech);
}

async function download(boutId: number, line: number, retry = true): Promise<string | null> {
  try {
    const response = await fetch(`/api/voice?bout=${boutId}&line=${line}`, { cache: "force-cache" });
    if (response.status === 404 && retry) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      return download(boutId, line, false);
    }
    if (!response.ok) return null;
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

/** Fetch a clip ahead of its line, so the read starts on the tick rather than
 *  a round trip after it. Idempotent; safe to call every frame. */
export function warmClip(boutId: number, line: number) {
  if (typeof window === "undefined") return;
  const key = keyOf(boutId, line);
  if (!clips.has(key)) clips.set(key, download(boutId, line));
}

/** Let go of clips the playhead has passed — everything from another fight,
 *  and this fight's lines before `fromLine`. The one being read is never in
 *  that range: callers keep a line of slack behind the playhead, since Safari
 *  streams a media element's blob and a URL revoked under it goes silent. */
export function forgetClips(boutId: number, fromLine: number) {
  for (const [key, pending] of clips) {
    const [bout, line] = key.split(":").map(Number);
    if (bout === boutId && line >= fromLine) continue;
    clips.delete(key);
    void pending.then((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }
}

/** Take the platform's permission while there is a gesture to take it with —
 *  called off the same tap that unmutes the broadcast, exactly like
 *  primeCues, and for the same reason: an element that has never played
 *  inside a gesture refuses every later play(). Muted and paused in the same
 *  breath, so nothing is heard; see `unlock` in sound.ts. */
export function primeSpeech() {
  if (typeof window === "undefined") return;
  watchPage();
  const el = element();
  if (!el.paused) return;
  el.muted = true;
  const started = el.play();
  el.pause();
  el.currentTime = 0;
  const restore = () => {
    el.muted = false;
  };
  if (started && typeof started.then === "function") started.then(restore, restore);
  else restore();
}

/** The voice off the air, mid-word if that is where it was. For mute, and for
 *  the stage unmounting under it. */
export function silenceSpeech() {
  wanted = null;
  mouth?.pause();
}

/** Read one line of the call aloud. Safe to call for every line the stage
 *  shows; this end decides what actually gets voiced. */
export function speakClip(boutId: number, line: number) {
  if (typeof window === "undefined") return;
  if (isMuted()) return;
  watchPage();
  const el = element();
  if (!el.paused && !el.ended) return;

  const key = keyOf(boutId, line);
  warmClip(boutId, line);
  wanted = key;
  const asked = Date.now();
  void clips.get(key)!.then((url) => {
    if (!url || wanted !== key || isMuted()) return;
    if (Date.now() - asked > STALE_MS) return;
    if (!el.paused && !el.ended) return;
    el.src = url;
    el.currentTime = 0;
    // Autoplay policy rejects this until the page has been interacted with.
    // That is a normal outcome, not an error worth surfacing.
    void el.play().catch(() => {});
  });
}
