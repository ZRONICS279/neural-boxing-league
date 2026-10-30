"use client";

import { useCallback, useEffect, useState } from "react";

/** The broadcast's sound.
 *
 * This began as two stings — the bell and a stoppage — and grew once the fights
 * earned more: a hit for every clean punch, the thud of a man reaching the
 * canvas, and house music for the stretches where nobody is fighting. The music
 * is deliberately confined to those stretches; under a live round it would sit
 * on top of the punches, and a fight scored wall-to-wall is a fight you turn
 * the tab down for.
 *
 * Everything below is presentation. The simulation never reads it, nothing here
 * can change a tick, and a viewer on mute is watching the identical fight. */

export type Cue =
  | "fight"
  | "ko"
  | "jab"
  | "cross"
  | "hook"
  | "uppercut"
  | "bodyshot"
  | "powershot"
  | "haymaker"
  | "mat"
  | "block1"
  | "block2"
  | "miss1"
  | "miss2";

const SOURCES: Record<Cue, string> = {
  // A level-matched render of FIGHT.mp3, which was mastered 9 dB under the
  // punches and could not be brought up any other way — element volume only
  // goes down from 1. The original mp3 is kept beside it.
  fight: "/sounds/FIGHT.m4a",
  // And the same story for KO.mp3, which was mastered 9 dB under everything
  // else on the card. Element volume only goes down from 1, so the sting that
  // is supposed to be the loudest moment of the night could not be raised in
  // the mix at all — it had to be re-rendered. The original mp3 is kept beside
  // it.
  ko: "/sounds/KO.m4a",
  // AAC renders of the AIFF originals sitting beside them in the folder —
  // Chrome and Firefox will not decode AIFF at all.
  jab: "/sounds/punches/jab_1.m4a",
  cross: "/sounds/punches/cross_1.m4a",
  hook: "/sounds/punches/hook_1.m4a",
  uppercut: "/sounds/punches/uppercut_1.m4a",
  bodyshot: "/sounds/punches/bodyshot_1.m4a",
  powershot: "/sounds/punches/powershot_1.m4a",
  haymaker: "/sounds/punches/KNOCKDOWNPUNCH_1.m4a",
  mat: "/sounds/punches/bodyhittingmatafterknowdown_1.m4a",
  // Two of each so back-to-back blocks and whiffs do not sound like the same
  // sample on loop; the canvas flips between them.
  block1: "/sounds/punches/block1_1.m4a",
  block2: "/sounds/punches/block2_1.m4a",
  miss1: "/sounds/punches/swingandmiss1_1.m4a",
  miss2: "/sounds/punches/swingandmiss2_1.m4a",
};

/* The stings own the moment they mark, so a repeat is allowed to cut the last
 * one off — see playCue(). The punches must not: both men land inside the same
 * beat all night, and a jab that silences the cross behind it reads as a
 * dropped frame. Those rotate through a small pool of elements instead. */
const STINGS = new Set<Cue>(["fight", "ko"]);
const PUNCH_POOL = 3;

/* Mixed by hand. The raw punch samples run hot next to the produced stings,
 * and the two floor-shakers are meant to stand a head above a plain landing. */
const GAIN: Record<Cue, number> = {
  // The round call is the loudest thing on the broadcast on purpose: it is the
  // only cue that announces rather than reacts. Everything under it was pulled
  // down a step so it reads over the crowd instead of through it.
  fight: 0.75,
  ko: 1,
  jab: 0.5,
  cross: 0.5,
  hook: 0.5,
  uppercut: 0.5,
  bodyshot: 0.5,
  powershot: 0.68,
  // The rarest cue on the card — a landing most fights never produce — so it
  // is allowed to stand over even the floor-shakers.
  haymaker: 0.8,
  mat: 0.68,
  // Blocks and whiffs are texture, not events — half the punches thrown end in
  // one of these, and at landing volume they would bury the landings.
  block1: 0.42,
  block2: 0.42,
  miss1: 0.42,
  miss2: 0.42,
};

const STORAGE_KEY = "forge.sound";

/* Muted until asked otherwise.
 *
 * A page that starts making noise on arrival is a page people close, and
 * browsers block the first `play()` before a gesture anyway — so defaulting to
 * on would mean the first cue a viewer ever gets is a silent one they did not
 * ask for, followed by a loud one they also did not ask for. Off by default,
 * remembered once turned on. */
let muted = true;
let loaded = false;

/** Subscribers to the mute flag, so every toggle on the page agrees. */
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    muted = window.localStorage.getItem(STORAGE_KEY) !== "on";
  } catch {
    // Private mode, or storage disabled. Staying muted is the safe read.
    muted = true;
  }
  watchPage();
}

/* Leaving is not the same as turning the sound off, and on a phone the
 * difference is the difference between a broadcast and a haunting.
 * Backgrounding Safari freezes the page's timers but not its audio, so a
 * fade-out started on the way out never reaches the pause at the end of it and
 * the music plays on behind the home screen — from a tab that is no longer on
 * screen to be silenced. Hidden means stop, this instant, with no fade left
 * hanging; back in view means pick the music up again if anything still wants
 * it. The ring's own cues are not resumed — the canvas starts the next round's
 * crowd itself. */
function watchPage() {
  if (typeof document === "undefined") return;
  const halt = () => {
    stopFade();
    music?.pause();
    silenceRing();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) halt();
    else syncMusic();
  });
  // Safari does not reliably report a hidden document on the way out of a page.
  // `pagehide` is the one it always fires, bfcache included.
  window.addEventListener("pagehide", halt);
}

/* iOS hands out permission per element rather than per page: an element that
 * has never been played inside a user gesture refuses every later play(), no
 * matter how many buttons have been pressed since, and `load()` does not count
 * — only a play() does. So each one is started and stopped again on the spot,
 * at zero volume, on the same tap that unmutes. Without this the cues a fight
 * needs first — the second and third of a punch pool, the crowd, the music for
 * an intermission that is still ten minutes off — are all refused when their
 * moment comes, and the broadcast is silently half silent. */
function unlock(clip: HTMLAudioElement) {
  // Already playing means it has plainly been allowed, and stopping it to
  // prove the point would be the bug this exists to prevent.
  if (!clip.paused) return;
  // Both, because neither is enough on its own: iOS ignores writes to volume on
  // a media element — the property keeps the value it is given and the audio
  // comes out at full level regardless — and `muted` is the one thing a cue
  // that fires mid-unlock would not think to clear.
  const gain = clip.volume;
  clip.muted = true;
  clip.volume = 0;
  const started = clip.play();
  // Stopped in the same breath as the play, NOT in the promise's callback. The
  // permission is taken by the call itself, but the promise does not settle
  // until the file has actually begun — which on a cold cache is a network
  // round trip, and forty elements playing across it is the whole broadcast at
  // once: the crowd, the round call, the knockout sting and the referee's ten,
  // fired at somebody sitting in a waiting room between cards. Pausing here
  // means the grant is taken and nothing is ever heard.
  clip.pause();
  clip.currentTime = 0;
  const restore = () => {
    clip.muted = false;
    clip.volume = gain;
  };
  // An aborted play rejects — that is this pause, and it is the expected end.
  if (started && typeof started.then === "function") started.then(restore, restore);
  else restore();
}

export function isMuted() {
  load();
  return muted;
}

export function setMuted(next: boolean) {
  load();
  muted = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "off" : "on");
  } catch {
    // Not being able to remember the choice is not a reason to ignore it.
  }
  syncMusic();
  // Mute silences the crowd outright. It does not come back on unmute — its
  // bells only make sense from the top of a round, and the canvas will start
  // the next one. The count goes the same way and for the same reason: it only
  // means anything from the number it was cut off on.
  if (next && crowd && !crowd.paused) {
    haltCrowdFade();
    crowd.pause();
  }
  if (next && count && !count.paused) {
    haltCountFade();
    count.pause();
  }
  for (const listener of listeners) listener();
}

/* Elements per cue, created on first use and reused. A sting keeps a pool of
 * one — asked for again before the last has finished, the play call rewinds
 * rather than waiting, which is what a sting should do. A punch cue rotates
 * through its pool so back-to-back landings overlap instead of clipping. */
const clips = new Map<Cue, HTMLAudioElement[]>();
const cursors = new Map<Cue, number>();

function poolFor(cue: Cue) {
  let pool = clips.get(cue);
  if (!pool) {
    pool = Array.from({ length: STINGS.has(cue) ? 1 : PUNCH_POOL }, () => {
      const clip = new Audio(SOURCES[cue]);
      clip.preload = "auto";
      clip.volume = GAIN[cue];
      return clip;
    });
    clips.set(cue, pool);
  }
  return pool;
}

function clipFor(cue: Cue) {
  const pool = poolFor(cue);
  const cursor = (cursors.get(cue) ?? 0) % pool.length;
  cursors.set(cue, cursor + 1);
  return pool[cursor];
}

/** Fire a cue. Safe to call from a render loop; safe to call before the user
 *  has touched the page, where the browser will simply refuse it. */
export function playCue(cue: Cue) {
  if (typeof window === "undefined") return;
  load();
  if (muted) return;
  try {
    const clip = clipFor(cue);
    clip.currentTime = 0;
    // Autoplay policy rejects this until the page has been interacted with.
    // That is a normal outcome, not an error worth surfacing.
    void clip.play().catch(() => {});
  } catch {
    // No audio device, or a codec the browser will not take. Stay quiet.
  }
}

/** Warm the files up so the first bell is not the download, and take the
 *  browser's permission for every one of them while there is a gesture to take
 *  it with.
 *
 * Called off the same gesture that unmutes, which is also the gesture the
 * autoplay policy wants. Every element, not one per cue: a punch pool is three
 * deep and the two behind the first would have spent the night refused. */
export function primeCues() {
  if (typeof window === "undefined") return;
  for (const cue of Object.keys(SOURCES) as Cue[]) {
    for (const clip of poolFor(cue)) unlock(clip);
  }
  unlock(crowdEl());
  unlock(countEl());
  unlock(musicEl());
}

/* ------------------------------------------------------------------ the crowd */

/* The round's crowd bed, with the three-ring bell baked onto the front of it.
 * WHEN it starts is a timing contract owned by the fight canvas — the bells
 * have to die exactly as the FIGHT sting fires — so this end only knows how to
 * start from the top, keep out of the punches' way, and get off the air fast
 * when the round is over. Three minutes long, which is one full round: it is
 * never looped, because a loop would ring the bell in the middle of a round. */
const CROWD_SRC = "/sounds/cheeringwithbell_2.m4a";
/* A room, not a mix element. It sits under the punches by a clear margin —
 * loud enough that a silent round would be noticed, quiet enough that nothing
 * in the fight has to shout over it. */
const CROWD_GAIN = 0.24;
/* Six 50 ms steps, which is what the old step-wise fade came to. */
const CROWD_FADE_MS = 300;

let crowd: HTMLAudioElement | null = null;
let crowdFade: number | null = null;

function crowdEl() {
  if (!crowd) {
    crowd = new Audio(CROWD_SRC);
    crowd.preload = "auto";
  }
  return crowd;
}

function haltCrowdFade() {
  if (crowdFade !== null) window.clearInterval(crowdFade);
  crowdFade = null;
}

/** Roll the tape. From the top the bells ring first; given an offset it drops
 *  in mid-crowd instead — that is the join-in-progress path, where a bell out
 *  of nowhere would be a lie about the round. Safe to call mid fade-out. */
export function startCrowd(fromSeconds = 0) {
  if (typeof window === "undefined") return;
  load();
  if (muted) return;
  const el = crowdEl();
  haltCrowdFade();
  el.volume = CROWD_GAIN;
  el.currentTime = fromSeconds;
  void el.play().catch(() => {});
  holdRing();
}

/** Whether the tape is rolling, for the canvas's join-in-progress check. */
export function crowdLive() {
  return crowd !== null && !crowd.paused;
}

/** A quick fade rather than a cut: the round is over, not the broadcast. */
export function stopCrowd() {
  const el = crowd;
  if (!el || el.paused || crowdFade !== null) return;
  // On the clock, for the reason fadeMusicTo is: waiting for the level to fall
  // to nothing waits for ever on a platform that will not move the level, and
  // what is waiting here is the pause. The tape has to come off the air at the
  // end of the round on every phone, ramp or no ramp.
  const from = el.volume;
  const started = Date.now();
  crowdFade = window.setInterval(() => {
    const progress = Math.min(1, (Date.now() - started) / CROWD_FADE_MS);
    el.volume = from * (1 - progress);
    if (progress < 1) return;
    el.pause();
    haltCrowdFade();
  }, 50);
}

/** Cut everything the ring makes, this instant, no fade.
 *
 * Walking off the page is not the end of a round. A fade there outlives the
 * navigation and the crowd follows you onto a page with no fight on it, as does
 * whichever punch happened to be in the air. The music is deliberately left
 * alone: it belongs to the reasons set, and the page being arrived at may want
 * it still playing. */
export function silenceRing() {
  if (typeof window === "undefined") return;
  haltCrowdFade();
  crowd?.pause();
  haltCountFade();
  count?.pause();
  for (const pool of clips.values()) {
    for (const clip of pool) if (!clip.paused) clip.pause();
  }
}

/* --------------------------------------------------------------- the lease */

/* The arena belongs to a picture, and the only thing that knows a fight is
 * still being drawn is the thing drawing it.
 *
 * Both of the ring's long tapes outlive the frame that started them by design —
 * the crowd bed runs three minutes for a three-minute round, the count carries
 * its own cheering tail — so anything that stops the canvas without stopping
 * them leaves a room playing over a page with no fight on it. The unmount path
 * handles the case it knows about; this covers the ones it does not. The canvas
 * renews a lease on every frame it draws, and the tapes cut themselves off when
 * nobody has renewed it — a loop that stopped being called, a second canvas
 * that lost the argument, a pause that did not take.
 *
 * Comfortably longer than a frame at any rate a browser will run one, and short
 * enough that "there is no fight on" and "the sound stopped" are the same
 * moment to a listener. */
const RING_LEASE_MS = 1500;
let ringHeldAt = 0;
let ringLease: number | null = null;

/** Renewed by the fight canvas, once per drawn frame. */
export function keepRing() {
  ringHeldAt = Date.now();
}

/** Whether either of the long tapes is still rolling. A punch is a moment and
 *  ends on its own; these are rooms, and a room is what gets left behind. */
function ringSounding() {
  return crowdLive() || (count !== null && !count.paused);
}

/** Watch the lease for as long as a tape is rolling. */
function holdRing() {
  keepRing();
  if (typeof window === "undefined" || ringLease !== null) return;
  ringLease = window.setInterval(() => {
    if (ringSounding() && Date.now() - ringHeldAt < RING_LEASE_MS) return;
    window.clearInterval(ringLease!);
    ringLease = null;
    if (!ringSounding()) return;
    // Nothing has drawn a fight for a second and a half and the arena is still
    // playing: whoever started it is gone. The music is left alone — it belongs
    // to the reasons set, and over an empty ring it is the right thing to hear.
    silenceRing();
  }, RING_LEASE_MS / 3);
}

/* ----------------------------------------------------------------- the count */

/* The referee's ten, spoken over its own room, with five seconds of cheering on
 * the tail for the count nobody beats.
 *
 * One tape rather than ten cues. The numbers were recorded as a single take and
 * they have to keep the take's own beat — fired one at a time off the render
 * loop they would land on whichever animation frame noticed the second turn
 * over, and a referee whose counting stutters is the one thing on the broadcast
 * nobody would forgive. So the tape is started once, at the knockdown, and the
 * only thing this end ever does to it afterwards is stop it. */
const COUNT_SRC = "/sounds/COUNT.mp3";
/* Under the arena, not over it. The tape carries its own room, so at anything
 * like sting level it stops reading as a referee heard across a ring and starts
 * reading as a second crowd dropped on top of the first. */
const COUNT_GAIN = 0.46;
/* The count arrives rather than cuts in: a man goes down, the room turns, and
 * the counting is what is left. Opened at a fraction of its level and walked up
 * to full — "one" is present but distant, and by three or four the referee owns
 * the arena and stays there for the rest of the count. */
const COUNT_OPEN_SHARE = 0.3;
const COUNT_FADE_IN_MS = 2800;
/* The tape clears its throat before it starts — "one" lands a third of a second
 * in — while the sim's count reads 1 from the instant the man is off his feet.
 * Rolled in that far, the voice and the number on the canvas speak together;
 * from the top the voice ends up a full number behind by the back half of the
 * count, which is exactly where anybody is watching. */
const COUNT_LEAD_SECONDS = 0.35;
/* He is up, so the count is over — but taken off the air in a tenth of a second
 * it did not read as a count ending, it read as the audio dropping out. What a
 * referee actually does is stop mid-number and let the room come back up, so
 * the tape leaves on roughly the length of the number it was cut off on: gone
 * before the man has his guard back, slow enough to be a decision rather than a
 * fault. */
const COUNT_FADE_MS = 520;

let count: HTMLAudioElement | null = null;
let countFade: number | null = null;
/* Which way the ramp currently runs. The two share a timer, and the direction
 * is what keeps a stop from being swallowed: the earliest a man is allowed off
 * the canvas is the count of three, which is still inside the fade-in, so
 * "already fading" cannot be the test for whether the tape is on its way out. */
let countClosing = false;

function countEl() {
  if (!count) {
    count = new Audio(COUNT_SRC);
    count.preload = "auto";
  }
  return count;
}

function haltCountFade() {
  if (countFade !== null) window.clearInterval(countFade);
  countFade = null;
}

/* Both ramps, on the clock rather than on the level, for the reason fadeMusicTo
 * is: iOS ignores writes to volume on a media element and keeps reporting the
 * old value, so a loop that waits for the level to arrive waits for ever — and
 * what waits on the end of the fade-out is the pause. A referee counting on
 * over a fight that has restarted is worse than any click. */
function rampCount(target: number, over: number, done?: () => void) {
  const el = countEl();
  haltCountFade();
  const from = el.volume;
  const started = Date.now();
  countFade = window.setInterval(() => {
    const progress = Math.min(1, (Date.now() - started) / over);
    el.volume = from + (target - from) * progress;
    if (progress < 1) return;
    haltCountFade();
    done?.();
  }, 20);
}

/** Start the count, from the beat the man hit the canvas. */
export function startCount() {
  if (typeof window === "undefined") return;
  load();
  if (muted) return;
  const el = countEl();
  countClosing = false;
  el.currentTime = COUNT_LEAD_SECONDS;
  el.volume = COUNT_GAIN * COUNT_OPEN_SHARE;
  void el.play().catch(() => {});
  rampCount(COUNT_GAIN, COUNT_FADE_IN_MS);
  holdRing();
}

/** He beat it. The referee stops mid-number and so does the tape — including
 *  the cheering on the end of it, which belongs to a count that ran out. */
export function stopCount() {
  const el = count;
  if (!el || el.paused || countClosing) return;
  countClosing = true;
  rampCount(0, COUNT_FADE_MS, () => el.pause());
}

/* ---------------------------------------------------------------- the playlist */

/* The house tracks: between fights, between cards, and under the training gym.
 * Never inside a bout — a corner break is sixty seconds long and dropping a
 * song into it only to yank it back out at the bell made the fight feel like it
 * kept being interrupted. One element, one track at a time, faded rather than
 * snapped because a bell that also slams the music off reads as the tab
 * crashing. */
const MUSIC_TRACKS = Array.from(
  { length: 9 },
  (_, i) => `/sounds/forgeLeagueMusic/BetweenRoundMusic${i + 1}.mp3`,
);
const MUSIC_GAIN = 0.4;
const MUSIC_FADE_IN_MS = 700;
/* Off far quicker than on. Nothing withdraws the music except leaving the page
 * it belonged to, and a music bed that is still audible on the page after is
 * heard as the site failing to stop rather than as a graceful exit. Short
 * enough to read as immediate, long enough not to click. */
const MUSIC_FADE_OUT_MS = 250;
const MUSIC_FADE_STEP_MS = 50;

/* Who wants music right now. A set of names rather than a counter because the
 * wanters are React effects, which must be able to assert their wish again on
 * re-render without double-counting themselves. The music plays while any name
 * is present and the broadcast is unmuted. */
const musicReasons = new Set<string>();
let music: HTMLAudioElement | null = null;
/* Tracks left in the current shuffle, drawn from the back. Picking uniformly at
 * random each time is random but does not sound it — a nine-track night hands
 * you the same song three times and never reaches two others. A bag plays every
 * track once, in a fresh order each pass. */
let musicBag: number[] = [];
let musicTrack = -1;
/** The armed track has been loaded but not yet heard, so the next start plays
 *  it rather than drawing over the top of it. See `musicEl`. */
let musicCued = false;
let fadeTimer: number | null = null;

function stopFade() {
  if (fadeTimer !== null) window.clearInterval(fadeTimer);
  fadeTimer = null;
}

function fadeMusicTo(target: number, done?: () => void) {
  const el = music;
  if (!el) return;
  stopFade();
  const from = el.volume;
  const over = target > from ? MUSIC_FADE_IN_MS : MUSIC_FADE_OUT_MS;
  const started = Date.now();
  // Driven by the clock rather than by reading the volume back. iOS ignores
  // writes to volume on a media element and keeps reporting 1, so a loop that
  // waits for the value to reach its target waits for ever — and the thing
  // waiting on the end of the fade-out is the pause. That is a bed that plays
  // on after the page that wanted it is gone. On the clock the fade ends when
  // it is over whether or not the level moved, so the music always stops; a
  // platform that honours volume still hears the ramp.
  fadeTimer = window.setInterval(() => {
    const progress = Math.min(1, (Date.now() - started) / over);
    el.volume = from + (target - from) * progress;
    if (progress < 1) return;
    stopFade();
    done?.();
  }, MUSIC_FADE_STEP_MS);
}

/** The next track out of the bag. */
function drawTrack() {
  if (musicBag.length === 0) {
    musicBag = MUSIC_TRACKS.map((_, i) => i);
    for (let i = musicBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [musicBag[i], musicBag[j]] = [musicBag[j], musicBag[i]];
    }
    // A refilled bag can open on the song that just closed the last one; push it
    // back a slot so the seam is not the one repeat the ear is listening for.
    if (musicBag.length > 1 && musicBag[musicBag.length - 1] === musicTrack) {
      const last = musicBag.length - 1;
      [musicBag[last], musicBag[last - 1]] = [musicBag[last - 1], musicBag[last]];
    }
  }
  return musicBag.pop()!;
}

/** The music element, already loaded with whatever it will open on.
 *
 * The track is chosen here rather than at the moment of playing so that the
 * unlock on the sound gesture has something real to start: an element with no
 * source cannot be played, so it cannot be given permission, and on iOS an
 * intermission that arrives ten minutes after the tap then gets none. `preload`
 * is off for the same reason it is on everywhere else — these are three-megabyte
 * files, and arming one is not a reason to pull it down a phone connection
 * before anybody has asked for music. */
function musicEl() {
  if (!music) {
    music = new Audio();
    music.preload = "none";
    // A track that runs out mid-intermission hands off to the next one.
    music.addEventListener("ended", () => {
      if (!muted && musicReasons.size > 0) startTrack();
    });
    musicTrack = drawTrack();
    music.src = MUSIC_TRACKS[musicTrack];
    musicCued = true;
  }
  return music;
}

/** Put on a fresh track — never the one that just played, so a night of
 *  intermissions is not one song. */
function startTrack() {
  const el = musicEl();
  // The armed track has not been heard yet, so this is its turn. Everything
  // after it draws its own.
  if (!musicCued) {
    musicTrack = drawTrack();
    el.src = MUSIC_TRACKS[musicTrack];
  }
  musicCued = false;
  el.volume = 0;
  // Refused before the first gesture, like the cues; the unmute retries it.
  void el.play().catch(() => {});
  fadeMusicTo(MUSIC_GAIN);
}

/* Whether the arena is still up at full — playing, and not already on its way
 * out. A tape that has begun its fade is one the music can come up underneath;
 * one at full level is a room, and a song started over a room is two broadcasts
 * at once. */
function arenaHolding() {
  const crowdUp = crowd !== null && !crowd.paused && crowdFade === null;
  const countUp = count !== null && !count.paused && !countClosing;
  return crowdUp || countUp;
}

/* How often the music asks whether the arena has started letting go. Short
 * enough that the hand-over reads as a cut between two things rather than a
 * hole in the broadcast. */
const ARENA_POLL_MS = 250;
let arenaWatch: number | null = null;

/** Hold the music at the door until the arena begins to empty, then sync. */
function waitForArena() {
  if (typeof window === "undefined" || arenaWatch !== null) return;
  arenaWatch = window.setInterval(() => {
    if (arenaHolding() && !muted && musicReasons.size > 0) return;
    window.clearInterval(arenaWatch!);
    arenaWatch = null;
    syncMusic();
  }, ARENA_POLL_MS);
}

function syncMusic() {
  if (typeof window === "undefined") return;
  const wanted = !muted && musicReasons.size > 0;
  // The end of a fight is a sequence, and the music is the last thing in it:
  // the referee's ten, the stoppage sting, the arena holding for nine seconds
  // over the man on the floor — and only then a track, fading up as the crowd
  // fades down. The page raises its hand for music on the frame the fight stops
  // moving, which is the front of that sequence, not the back of it.
  if (wanted && arenaHolding()) {
    waitForArena();
    return;
  }
  if (wanted) {
    // Paused means a past intermission ended cleanly, so this one opens with a
    // fresh track; still audible means we were caught mid fade-out at a round
    // that reversed itself, and the same track simply comes back up.
    if (!music || music.paused) startTrack();
    else fadeMusicTo(MUSIC_GAIN);
  } else if (music && !music.paused) {
    if (muted) {
      // Mute is a request for silence now, not for a fade toward it.
      stopFade();
      music.pause();
    } else {
      fadeMusicTo(0, () => music?.pause());
    }
  }
}

/** Declare whether one part of the page wants music at the moment. Keyed so
 *  that several can want it at once — the stage during a round break, the
 *  league page between fights — and it plays while any one of them holds. */
export function setMusicWanted(reason: string, wanted: boolean) {
  if (typeof window === "undefined") return;
  load();
  if (wanted === musicReasons.has(reason)) return;
  if (wanted) musicReasons.add(reason);
  else musicReasons.delete(reason);
  syncMusic();
}

/** setMusicWanted as an effect: asserted while mounted and true, withdrawn on
 *  unmount so a page navigation cannot leave the music orphaned. */
export function useMusic(reason: string, wanted: boolean) {
  useEffect(() => {
    setMusicWanted(reason, wanted);
    return () => setMusicWanted(reason, false);
  }, [reason, wanted]);
}

/** The mute flag as component state, kept in step across every toggle. */
export function useSound() {
  const [mutedState, setMutedState] = useState(true);

  useEffect(() => {
    const sync = () => setMutedState(isMuted());
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !isMuted();
    setMuted(next);
    if (!next) primeCues();
  }, []);

  return { muted: mutedState, toggle };
}
