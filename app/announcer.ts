// No client directive, and nothing browser-side imported here, on purpose: the
// recorder in worker/fight-timeline.ts runs this same engine over every frame it
// writes down, so the module has to import cleanly on the server. The React
// side — the caption, and the spoken clips — lives in announcer-caption.ts.
import type { BoutState, Corner, Fighter, FighterAction } from "./fight-model";

/** The ringside voice, as text.
 *
 * A play-by-play layer over the fight the viewer is already watching: it sees
 * the same `BoutState` frames the stage draws — broadcast playback and a
 * rewatch alike — and turns the moments in them into called lines for a
 * lower-third caption. Presentation only, like the sound layer: the simulation
 * never reads it, nothing here can change a tick, and a viewer with the
 * captions ignored is watching the identical fight.
 *
 * Every line is picked deterministically. The seed for a call is built from
 * fight facts — the bout id, the corner, the value a counter had when the
 * punch landed — never from wall clock or Math.random, so two viewers watching
 * the same fight hear the same broadcast, and a replay calls the fight the way
 * it was called the first time.
 *
 * The engine mirrors the canvas's event ingestion: baseline every counter on
 * the first frame seen (a viewer joining in round three must not be told about
 * forty punches at once), react only to deltas after that, and reset the lot
 * when the bout id changes. The finish call carries the same `sawLive` gate as
 * the stoppage sting — arriving on the aftermath of a fight that ended minutes
 * ago is not a moment to announce. */

export type AnnouncerRegister = "call" | "alarm" | "color";

export interface AnnouncerLine {
  id: number;
  text: string;
  /** How the caption should carry itself: a call is routine play-by-play, an
   *  alarm is a knockdown or a stoppage, color is the filler between them. */
  register: AnnouncerRegister;
  /** Whose moment it was, for the caption's accent stripe. Null reads amber. */
  corner: Corner | null;
  /** How long the line owns the caption bar before it fades. */
  holdMs: number;
}

/* Impact thresholds, matched to the canvas's sound tiers so what the voice
 * calls big is what the ear heard as big. */
const POWER_IMPACT_J = 55;
const HAYMAKER_IMPACT_J = 65;

/* Cooldowns in ticks of the bout clock (50 Hz), so a paused fight is a paused
 * announcer. Routine calls stay sparse on purpose: a voice that names every
 * jab is a ticker, not a broadcast. */
const CALL_GAP_TICKS = 300;
const POWER_GAP_TICKS = 140;
const COMBO_GAP_TICKS = 900;
/* Exported for the caption hook, which applies the same clock to a recorded
 * call that this engine applies to its own. */
export const LULL_GAP_TICKS = 950;
/* A man hurt twice in one exchange is one story, not two alarms. The episode
 * flag alone was not enough: the hurt state blips off between shots, and every
 * blip started a fresh episode — three "he's hurt!" captions in ten seconds. */
const HURT_GAP_TICKS = 750;
/* Landings by one corner inside this window read as a combination. */
const COMBO_WINDOW_TICKS = 90;
const COMBO_LANDINGS = 2;
/* How long after a throw the contact window is considered shut. The sim does
 * not report a miss, so it is inferred the way the canvas infers it: the
 * punch went out and neither the landed nor the blocked counter ever moved. */
const WHIFF_SETTLE_TICKS = 30;

/** The defensive moves that earn the defender the credit for a miss. */
const EVASIONS = new Set<FighterAction>(["slip", "duck", "weave"]);

/** How a punch is said out loud, for the ones worth saying. */
const PUNCH_CALLS: Partial<Record<FighterAction, string>> = {
  jabHead: "jab",
  crossHead: "cross",
  hookHead: "hook",
  jabBody: "jab to the body",
  crossBody: "cross to the body",
  hookBody: "hook to the body",
  uppercut: "uppercut",
};

/** The same punches as one word each, for stringing a combination together. */
const PUNCH_SHORT: Partial<Record<FighterAction, string>> = {
  jabHead: "jab",
  crossHead: "cross",
  hookHead: "hook",
  jabBody: "jab",
  crossBody: "cross",
  hookBody: "hook",
  uppercut: "uppercut",
};

/** "jab-jab-cross to the face": the last few landings said as one shape, with
 *  the target named only when the whole combination agreed on it. */
function comboName(kinds: FighterAction[]) {
  const said = kinds.slice(-3).map((kind) => PUNCH_SHORT[kind] ?? "shot").join("-");
  const zones = kinds.slice(-3).map((kind) => (kind.endsWith("Body") ? "body" : "head"));
  if (zones.every((zone) => zone === "head")) return `${said} to the face`;
  if (zones.every((zone) => zone === "body")) return `${said} to the body`;
  return `${said} combination`;
}

/** A deterministic 32-bit mix of fight facts, so every viewer of the same
 *  bout draws the same line for the same moment. */
function seed32(...parts: number[]) {
  let h = 0x9e3779b9;
  for (const part of parts) {
    h ^= Math.imul(part | 0, 0x85ebca6b) + 0x1b873593;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/** What a line is built from: the two men as this line will say them, and the
 *  punch (or combination shape) the moment was about. */
interface Say {
  a: string;
  d: string;
  p: string;
}

/** The voice itself: sentences assembled from parts rather than drawn whole.
 *
 * A fixed bank of five lines per moment sounds like a slot machine by the
 * third round — the same sentences in a different order. Here each call picks
 * a sentence shape, then fills its slots from their own part banks (openers,
 * verbs, tails that only sometimes appear), so a fight's worth of jab calls
 * shares a register without sharing sentences. Every pick remembers what the
 * bank chose recently and refuses it, and every pick is seeded from fight
 * facts, so the variety is still the same broadcast for every viewer. */
function createVoice() {
  const recent = new Map<string, number[]>();

  const pickIndex = (key: string, length: number, seed: number) => {
    if (length <= 1) return 0;
    const used = recent.get(key) ?? [];
    let index = seed % length;
    let steps = 0;
    while (used.includes(index) && steps < length) {
      index = (index + 1) % length;
      steps += 1;
    }
    recent.set(key, [...used, index].slice(-Math.min(2, length - 1)));
    return index;
  };

  /** One option out of a bank, avoiding the bank's recent picks. */
  const choose = (key: string, options: string[], seed: number) =>
    options[pickIndex(key, options.length, seed)];

  /** A tail that only sometimes shows up — silence is an option on purpose,
   *  so the cadence breathes instead of every sentence carrying a clause. */
  const maybe = (key: string, options: string[], seed: number, oneIn: number) =>
    seed32(seed, 71) % oneIn === 0 ? ` ${choose(key, options, seed32(seed, 72))}` : "";

  const clean = (c: Say, seed: number) => {
    const body = choose(
      "clean",
      [
        `${c.a} sticks the ${c.p}.`,
        `${c.a} pops the ${c.p} through.`,
        `${c.a} snaps the ${c.p} home.`,
        `The ${c.p} lands for ${c.a}.`,
        `${c.a} touches ${c.d} with the ${c.p}.`,
        `${c.a} catches ${c.d} with a ${c.p}.`,
        `Sharp ${c.p} from ${c.a}.`,
        `Good ${c.p} by ${c.a}.`,
        `${c.a} finds a home for the ${c.p}.`,
        `There's that ${c.p} from ${c.a} again.`,
        `${c.a} measures him with the ${c.p}.`,
        `${c.a} works behind the ${c.p}.`,
      ],
      seed,
    );
    return (
      body +
      maybe(
        "clean-tail",
        [
          `${c.d} takes it on the way in.`,
          `Tidy work.`,
          `${c.d} has no answer yet.`,
          `Nothing flashy, but it scores.`,
        ],
        seed,
        5,
      )
    );
  };

  const power = (c: Say, seed: number) => {
    const opener = choose("power-open", ["", "", "", "Oh!", "Big shot!", "There it is!"], seed32(seed, 1));
    const body = choose(
      "power",
      [
        `${c.a} cracks ${c.d} with the ${c.p}!`,
        `${c.a} lands the ${c.p} flush!`,
        `a heavy ${c.p} from ${c.a}!`,
        `${c.a} puts his weight into that ${c.p}!`,
        `that ${c.p} got all of ${c.d}!`,
        `${c.d} eats a big ${c.p}!`,
        `${c.a} rips the ${c.p} in!`,
        `the ${c.p} gets through, flush!`,
        `${c.a} drives the ${c.p} right through the guard!`,
        `thudding ${c.p} by ${c.a}!`,
      ],
      seed,
    );
    const capped = body.charAt(0).toUpperCase() + body.slice(1);
    const sentence = opener ? `${opener} ${capped}` : capped;
    return (
      sentence +
      maybe(
        "power-tail",
        [
          `${c.d} steps straight back.`,
          `${c.d} won't want another of those.`,
          `You could hear that one at ringside.`,
          `The crowd is up.`,
        ],
        seed,
        4,
      )
    );
  };

  const haymaker = (c: Say, seed: number) => {
    const opener = choose("hay-open", ["OH!", "GOOD LORD!", "WOW!", "OHH!"], seed32(seed, 1));
    const body = choose(
      "haymaker",
      [
        `${c.a} nearly takes his head off with the ${c.p}!`,
        `${c.a} detonates a ${c.p} on ${c.d}!`,
        `A massive ${c.p} lands for ${c.a}!`,
        `${c.d} gets caught with everything ${c.a} has!`,
        `That ${c.p} landed with bad intentions!`,
        `${c.a} throws the kitchen sink and the ${c.p} lands!`,
      ],
      seed,
    );
    return `${opener} ${body}`;
  };

  const counter = (c: Say, seed: number) =>
    choose(
      "counter",
      [
        `${c.a} times him perfectly with the counter ${c.p}!`,
        `${c.d} walks straight into the ${c.p}!`,
        `Beautiful counter ${c.p} by ${c.a}!`,
        `${c.a} catches him coming in with the ${c.p}!`,
        `The counter ${c.p} lands, and ${c.d} never saw it!`,
      ],
      seed,
    );

  const liver = (c: Say, seed: number) =>
    choose(
      "liver",
      [
        `${c.a} goes downstairs to the liver, and ${c.d} felt that.`,
        `Right to the liver from ${c.a}!`,
        `${c.a} digs one into the liver!`,
        `That's the liver. ${c.d} does not want another there.`,
      ],
      seed,
    );

  /* `p` carries the whole named shape here — "jab-jab-cross to the face". */
  const combo = (c: Say, seed: number) =>
    choose(
      "combo",
      [
        `A ${c.p} from ${c.a}!`,
        `${c.a} puts together the ${c.p}!`,
        `Beautiful ${c.p} by ${c.a}!`,
        `${c.a} goes to work with the ${c.p}!`,
        `${c.p} from ${c.a}, all of it landing!`,
        `${c.a} strings it together: ${c.p}!`,
      ],
      seed,
    ).replace(/^([a-z])/, (m) => m.toUpperCase());

  /* The defender's moment: he made the punch miss, and how he did it is what
   * gets called. `d` is the man who moved, `a` the man who hit air. */
  const dodge = (c: Say, evade: FighterAction | null, seed: number) => {
    const body =
      evade === "slip"
        ? choose(
            "dodge-slip",
            [
              `${c.d} slips the ${c.p} clean!`,
              `Beautiful slip from ${c.d}!`,
              `What head movement by ${c.d}!`,
              `${c.d} slips it by an inch, no more than he needed.`,
            ],
            seed,
          )
        : evade === "duck"
          ? choose(
              "dodge-duck",
              [
                `${c.d} ducks right under the ${c.p}!`,
                `${c.d} gets low, and nothing gets home for ${c.a}.`,
                `The ${c.p} sails over ${c.d}'s head!`,
              ],
              seed,
            )
          : evade === "weave"
            ? choose(
                "dodge-weave",
                [
                  `${c.d} weaves out of the way!`,
                  `${c.d} rolls under it. What a dodge!`,
                  `${c.d} sways off the line and the ${c.p} finds nothing.`,
                ],
                seed,
              )
            : choose(
                "dodge",
                [`What a dodge from ${c.d}!`, `${c.a} hits nothing but air!`],
                seed,
              );
    return body + maybe("dodge-tail", [`${c.a} is starting to reach.`, `Make him miss, make him pay.`], seed, 5);
  };

  /* Being hurt comes in sizes, and the words have to match the damage on the
   * board — see the tiering where these are called. */
  const wobble = (c: Say, seed: number) =>
    choose(
      "wobble",
      [
        `${c.d} felt that one.`,
        `That got ${c.d}'s attention.`,
        `A little wobble from ${c.d}, but he shakes it off.`,
        `${c.d} takes a step back to clear his head.`,
        `${c.d} didn't like that one.`,
      ],
      seed,
    );

  const hurt = (c: Say, seed: number) =>
    choose(
      "hurt",
      [
        `${c.d} is hurt!`,
        `${c.d} is wobbled! His legs dipped for a second!`,
        `${c.a} has ${c.d} hurt!`,
        `${c.d} is in trouble!`,
        `${c.d}'s legs are not right!`,
      ],
      seed,
    );

  const grave = (c: Say, seed: number) =>
    choose(
      "grave",
      [
        `${c.d} is badly hurt! His legs have gone!`,
        `${c.d} is in serious trouble!`,
        `${c.d} is out on his feet!`,
        `One more clean shot could end this. ${c.d} is barely standing!`,
        `${c.a} is a punch away from ending it. ${c.d} is hurt bad!`,
      ],
      seed,
    );

  const knockdown = (c: Say, seed: number) =>
    choose(
      "down",
      [
        `DOWN GOES ${c.d.toUpperCase()}!`,
        `${c.d} IS DOWN! The ${c.p} put him on the canvas!`,
        `${c.a} DROPS ${c.d}!`,
        `${c.d} hits the canvas! The ${c.p} did it!`,
        `${c.d} is down! What a shot from ${c.a}!`,
      ],
      seed,
    );

  const rise = (d: string, n: number, seed: number) =>
    choose(
      "rise",
      [
        `${d} beats the count at ${n}.`,
        `${d} is back on his feet at ${n}.`,
        `He's up at ${n}, and ${d} fights on.`,
        `${d} climbs off the canvas at ${n}.`,
      ],
      seed,
    );

  return {
    choose,
    clean,
    power,
    haymaker,
    counter,
    liver,
    combo,
    dodge,
    wobble,
    hurt,
    grave,
    knockdown,
    rise,
    reset: () => recent.clear(),
  };
}

export function createAnnouncer() {
  let boutId = -1;
  let primed = false;
  let sawLive = false;
  let finishCalled = false;
  let introCalled = false;
  let roundCalled = 0;
  let breakCalled = 0;
  let lineId = 0;
  let lastLineTick = -1e9;
  let joinTick = -1e9;
  let lastComboTick: Record<Corner, number> = { blue: -1e9, red: -1e9 };
  const voice = createVoice();

  interface SideTrack {
    landed: number;
    thrown: number;
    knockdowns: number;
    roundStartLanded: number;
    hurtSpoken: boolean;
    lastHurtTick: number;
    recentLands: { tick: number; kind: FighterAction }[];
    /** A punch in the air: opened by the thrown counter, closed by contact,
     *  and a window that settles shut untouched is a miss. The evade is
     *  whichever defensive move the other man was seen making under it. */
    pendingWhiff: {
      at: number;
      landed: number;
      blocked: number;
      punch: string;
      evade: FighterAction | null;
    } | null;
    downPeak: number;
    wasDown: boolean;
  }
  const freshTrack = (): SideTrack => ({
    landed: 0,
    thrown: 0,
    knockdowns: 0,
    roundStartLanded: 0,
    hurtSpoken: false,
    lastHurtTick: -1e9,
    recentLands: [],
    pendingWhiff: null,
    downPeak: 0,
    wasDown: false,
  });
  const sides: Record<Corner, SideTrack> = { blue: freshTrack(), red: freshTrack() };

  const reset = (bout: BoutState) => {
    boutId = bout.id;
    primed = false;
    sawLive = false;
    finishCalled = false;
    introCalled = false;
    roundCalled = 0;
    breakCalled = 0;
    lastLineTick = -1e9;
    lastComboTick = { blue: -1e9, red: -1e9 };
    voice.reset();
  };

  const speak = (
    text: string,
    register: AnnouncerRegister,
    corner: Corner | null,
    holdMs: number,
    tick: number,
  ): AnnouncerLine => {
    lastLineTick = tick;
    lineId += 1;
    return { id: lineId, text, register, corner, holdMs };
  };

  const observe = (bout: BoutState, blue: Fighter, red: Fighter): AnnouncerLine | null => {
    if (bout.id !== boutId) reset(bout);

    const tick = bout.tick;
    const names: Record<Corner, string> = { blue: blue.lastName, red: red.lastName };
    const profiles: Record<Corner, Fighter> = { blue, red };
    /** How this line says the man: usually the surname, sometimes the full
     *  name, once in a while the nickname — a real caller doesn't lean on one
     *  form all night, and a big moment earns the fuller ones more often. */
    const sayName = (corner: Corner, seed: number, big = false) => {
      const profile = profiles[corner];
      // Mononym fighters have an empty first name; joining blindly put a
      // stray leading space in front of half the roster.
      const full = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
      const roll = seed32(seed, corner === "blue" ? 21 : 22) % 10;
      if (big) {
        if (roll >= 8 && profile.nickname) return profile.nickname;
        if (roll >= 6) return full;
        return profile.lastName;
      }
      if (roll === 9 && profile.nickname) return profile.nickname;
      if (roll === 8) return full;
      return profile.lastName;
    };
    const fighters = [bout.left, bout.right] as const;

    if (!primed) {
      for (const fighter of fighters) {
        const track = sides[fighter.corner];
        track.landed = fighter.landed;
        track.thrown = fighter.thrown;
        track.knockdowns = fighter.knockdowns;
        track.roundStartLanded = fighter.landed;
        track.hurtSpoken = fighter.hurtSeconds > 0;
        track.lastHurtTick = -1e9;
        track.recentLands = [];
        track.pendingWhiff = null;
        track.downPeak = 0;
        track.wasDown = fighter.downCountSeconds > 0;
      }
      roundCalled = bout.round;
      breakCalled = bout.breakTime > 0 ? bout.round : 0;
      finishCalled = bout.finish !== null;
      // The introductions belong to a viewer who is there for them. Joining
      // anywhere past the walk-out primes them away with everything else.
      introCalled = !(bout.round === 1 && bout.introSeconds > 0 && bout.tick < 400);
      sawLive = bout.finish === null;
      // The color clock starts at the join, not at minus infinity — a voice
      // that greets every viewer with filler is a voice people mute. Real
      // moments are left alone: a knockdown two seconds in is still called.
      joinTick = tick;
      primed = true;
      return null;
    }

    if (!bout.finish) sawLive = true;

    /* Contact-window bookkeeping, ahead of every early return so a moment
     * that speaks first cannot make the announcer lose track of a punch that
     * was in the air under it. */
    for (const fighter of fighters) {
      const track = sides[fighter.corner];
      const defender = fighter.corner === "blue" ? bout.right : bout.left;
      const pending = track.pendingWhiff;
      if (pending) {
        if (fighter.landed > pending.landed || fighter.blocked > pending.blocked) {
          track.pendingWhiff = null;
        } else if (EVASIONS.has(defender.action)) {
          pending.evade = defender.action;
        }
      }
      if (fighter.thrown > track.thrown) {
        track.thrown = fighter.thrown;
        track.pendingWhiff = {
          at: tick,
          landed: fighter.landed,
          blocked: fighter.blocked,
          punch:
            PUNCH_SHORT[fighter.action] ??
            PUNCH_SHORT[fighter.lastStrikeKind as FighterAction] ??
            "shot",
          evade: EVASIONS.has(defender.action) ? defender.action : null,
        };
      }
    }

    /* The verdict outranks everything, including whatever was mid-sentence. */
    if (bout.finish && !finishCalled) {
      finishCalled = true;
      if (!sawLive) return null;
      const winnerCorner: Corner | null =
        bout.winnerId === bout.left.fighterId
          ? "blue"
          : bout.winnerId === bout.right.fighterId
            ? "red"
            : null;
      // The verdict is the one moment the full name always earns.
      const winner = winnerCorner
        ? [profiles[winnerCorner].firstName, profiles[winnerCorner].lastName]
            .filter(Boolean)
            .join(" ")
        : null;
      const seed = seed32(bout.id, 13);
      let text: string;
      if (bout.finish === "KO" && winner) {
        text = voice.choose(
          "finish-ko",
          [
            `IT'S ALL OVER! ${winner} wins by knockout!`,
            `He's not getting up! A knockout win for ${winner}!`,
            `That is that! ${winner} by KO!`,
            `Goodnight! ${winner} ends it by knockout!`,
          ],
          seed,
        );
      } else if (bout.finish === "TKO" && winner) {
        text = voice.choose(
          "finish-tko",
          [
            `The referee has seen enough! ${winner} wins by TKO!`,
            `It's waved off! ${winner} by stoppage!`,
            `The referee steps in, and it's over! ${winner} by TKO!`,
          ],
          seed,
        );
      } else if (bout.finish === "Decision" && winner) {
        text = voice.choose(
          "finish-dec",
          [
            `We go to the scorecards... and it's ${winner} by decision.`,
            `After ${bout.totalRounds} rounds, the judges have it for ${winner} by decision.`,
            `It goes the distance, and the cards say ${winner}.`,
          ],
          seed,
        );
      } else {
        text = `We go to the scorecards... and it's a draw.`;
      }
      return speak(text, "alarm", winnerCorner, 6500, tick);
    }
    if (bout.finish) return null;

    /* Knockdowns, and the rise that ends them. */
    for (const fighter of fighters) {
      const track = sides[fighter.corner];
      const other = fighter.corner === "blue" ? bout.right : bout.left;
      if (fighter.knockdowns > track.knockdowns) {
        track.knockdowns = fighter.knockdowns;
        track.wasDown = true;
        track.downPeak = 0;
        const attacker = other.corner;
        const punch = PUNCH_CALLS[other.lastStrikeKind as FighterAction] ?? "shot";
        const seed = seed32(bout.id, fighter.corner === "blue" ? 0 : 1, fighter.knockdowns);
        const text = voice.knockdown(
          { a: sayName(attacker, seed, true), d: names[fighter.corner], p: punch },
          seed,
        );
        return speak(text, "alarm", attacker, 4500, tick);
      }
      if (fighter.downCountSeconds > 0) {
        track.downPeak = Math.max(track.downPeak, fighter.downCountSeconds);
      } else if (track.wasDown) {
        track.wasDown = false;
        // The sim's count reads 1 from the instant the man is off his feet.
        const beat = Math.min(9, Math.max(1, Math.floor(track.downPeak) + 1));
        const seed = seed32(bout.id, fighter.corner === "blue" ? 0 : 1, track.knockdowns, 3);
        const text = voice.rise(names[fighter.corner], beat, seed);
        track.downPeak = 0;
        return speak(text, "alarm", fighter.corner, 4000, tick);
      }
    }

    /* A man hurt on his feet. Once per episode — the state holds for seconds
     * and a voice that repeats itself every frame of them is a car alarm —
     * and sized to the damage on the board. The engine flags a hurt spell for
     * any decent shot, so a flash wobble on a fresh man in round one used to
     * get "he's in trouble!" while both condition bars still read 97; the
     * alarm register now waits for the scoreboard to agree that he is. */
    for (const fighter of fighters) {
      const track = sides[fighter.corner];
      if (fighter.hurtSeconds <= 0 && fighter.stunSeconds <= 0) {
        track.hurtSpoken = false;
        continue;
      }
      if (track.hurtSpoken || fighter.downCountSeconds > 0) continue;
      track.hurtSpoken = true;
      if (tick - track.lastHurtTick < HURT_GAP_TICKS) continue;
      const attacker: Corner = fighter.corner === "blue" ? "red" : "blue";
      const seed = seed32(bout.id, fighter.corner === "blue" ? 0 : 1, bout.round, Math.floor(bout.roundTime));
      const say: Say = {
        a: sayName(attacker, seed),
        d: names[fighter.corner],
        p: "",
      };
      // A stun alone is not "barely standing": a flash stun on a man whose
      // condition still reads 87 gets the hurt call, not the last-rites one.
      const stunned = fighter.stunSeconds > 0;
      if (fighter.health <= 45 || (stunned && fighter.health <= 65)) {
        track.lastHurtTick = tick;
        return speak(voice.grave(say, seed), "alarm", attacker, 4200, tick);
      }
      if (fighter.health <= 75 || stunned || fighter.hurtSeconds >= 1.5) {
        track.lastHurtTick = tick;
        return speak(voice.hurt(say, seed), "alarm", attacker, 4000, tick);
      }
      // A fresh man shaken for a beat: mostly let the picture tell it, and
      // when it is worth a word, keep the word small.
      if (seed % 4 === 0 && tick - lastLineTick >= POWER_GAP_TICKS) {
        track.lastHurtTick = tick;
        return speak(voice.wobble(say, seed), "call", attacker, 3200, tick);
      }
    }

    /* The break: score the round that just ended, once. The round number has
     * already turned over — the corner is planning for the NEXT one. */
    if (bout.breakTime > 0 && breakCalled !== bout.round) {
      breakCalled = bout.round;
      const ended = bout.round - 1;
      const blueRound = bout.left.landed - sides.blue.roundStartLanded;
      const redRound = bout.right.landed - sides.red.roundStartLanded;
      sides.blue.roundStartLanded = bout.left.landed;
      sides.red.roundStartLanded = bout.right.landed;
      const margin = blueRound - redRound;
      let text: string;
      let corner: Corner | null = null;
      const breakSeed = seed32(bout.id, bout.round, 7);
      if (Math.abs(margin) >= 3) {
        corner = margin > 0 ? "blue" : "red";
        const lead = names[corner];
        const [high, low] = margin > 0 ? [blueRound, redRound] : [redRound, blueRound];
        text = voice.choose(
          "break-lead",
          [
            `${lead} took round ${ended} on work rate, ${high} landed to ${low}.`,
            `That round belonged to ${lead}: ${high} punches home against ${low}.`,
            `Round ${ended} goes to ${lead} in my book. He out-landed him ${high} to ${low}.`,
          ],
          breakSeed,
        );
      } else {
        text = voice.choose(
          "break-even",
          [
            `Hard round to score. End of round ${ended}, and the corners have sixty seconds.`,
            `Round ${ended} could go either way. The corners go to work.`,
            `Nothing to split them in round ${ended}. Sixty seconds to fix that.`,
          ],
          breakSeed,
        );
      }
      return speak(text, "color", corner, 5000, tick);
    }

    /* The bell. Round one gets the introductions instead, once, and only for
     * a viewer who is actually there for them. */
    if (bout.breakTime <= 0 && bout.round !== roundCalled) {
      roundCalled = bout.round;
      sides.blue.roundStartLanded = bout.left.landed;
      sides.red.roundStartLanded = bout.right.landed;
      const seed = seed32(bout.id, bout.round);
      let text: string;
      if (bout.round >= bout.totalRounds) {
        text = voice.choose(
          "bell-final",
          [
            `The final round. Three minutes to settle it.`,
            `Last round. Whatever they have left, now is the time.`,
            `The final round is underway. Leave nothing in the tank.`,
          ],
          seed,
        );
      } else {
        text = voice.choose(
          "bell",
          [
            `Round ${bout.round}, here we go.`,
            `Round ${bout.round} is underway.`,
            `There's the bell for round ${bout.round}.`,
            `Round ${bout.round}. Back to work.`,
            `And we're back for round ${bout.round}.`,
          ],
          seed,
        );
      }
      return speak(text, "color", null, 3200, tick);
    }
    if (
      !introCalled &&
      bout.round === 1 &&
      bout.introSeconds > 0 &&
      tick < 400
    ) {
      introCalled = true;
      const blueFull = [blue.firstName, blue.lastName].filter(Boolean).join(" ");
      const redFull = [red.firstName, red.lastName].filter(Boolean).join(" ");
      const text = `Here we go, ${blueFull} against ${redFull}, ${bout.totalRounds} rounds.`;
      return speak(text, "color", null, 4500, tick);
    }

    /* Landed punches. One voice, so the louder moment wins the frame: a
     * haymaker or a counter interrupts, a power shot speaks over a short gap,
     * a routine landing waits its turn. */
    for (const fighter of fighters) {
      const track = sides[fighter.corner];
      if (fighter.landed <= track.landed) continue;
      track.landed = fighter.landed;
      track.recentLands = track.recentLands
        .filter((land) => tick - land.tick < COMBO_WINDOW_TICKS)
        .concat(
          fighter.lastStrikeKind === "none"
            ? []
            : { tick, kind: fighter.lastStrikeKind as FighterAction },
        );
      const defender = fighter.corner === "blue" ? bout.right : bout.left;
      const punch = PUNCH_CALLS[fighter.lastStrikeKind as FighterAction];
      const seed = seed32(bout.id, fighter.corner === "blue" ? 0 : 1, fighter.landed);
      const haymaker = fighter.lastImpactJ >= HAYMAKER_IMPACT_J;
      const power = fighter.lastImpactJ >= POWER_IMPACT_J;
      const sinceLast = tick - lastLineTick;
      const say: Say = {
        a: sayName(fighter.corner, seed, haymaker || power),
        d: names[defender.corner],
        p: punch ?? "shot",
      };

      if (haymaker) {
        return speak(voice.haymaker(say, seed), "call", fighter.corner, 4000, tick);
      }
      if (fighter.lastImpactCounter && power) {
        return speak(voice.counter(say, seed), "call", fighter.corner, 3800, tick);
      }
      if (power && sinceLast >= POWER_GAP_TICKS) {
        const text =
          fighter.lastImpactZone === "liver" ? voice.liver(say, seed) : voice.power(say, seed);
        return speak(text, "call", fighter.corner, 3600, tick);
      }
      if (
        track.recentLands.length >= COMBO_LANDINGS &&
        tick - lastComboTick[fighter.corner] >= COMBO_GAP_TICKS
      ) {
        lastComboTick[fighter.corner] = tick;
        const named = { ...say, p: comboName(track.recentLands.map((land) => land.kind)) };
        return speak(voice.combo(named, seed), "call", fighter.corner, 3400, tick);
      }
      if (punch && sinceLast >= CALL_GAP_TICKS) {
        return speak(voice.clean(say, seed), "call", fighter.corner, 3200, tick);
      }
    }

    /* Misses that were made to miss. The window has to settle before the call
     * — the punch may still be in the air at the sample that saw it thrown —
     * and only a miss the defender moved for gets the voice; a plain whiff is
     * the canvas's MISS tag, not a moment. */
    for (const fighter of fighters) {
      const track = sides[fighter.corner];
      const pending = track.pendingWhiff;
      if (!pending || tick - pending.at < WHIFF_SETTLE_TICKS) continue;
      track.pendingWhiff = null;
      if (fighter.landed > pending.landed || fighter.blocked > pending.blocked) continue;
      if (!pending.evade) continue;
      if (tick - lastLineTick < CALL_GAP_TICKS) continue;
      const defender = fighter.corner === "blue" ? bout.right : bout.left;
      const seed = seed32(bout.id, fighter.corner === "blue" ? 0 : 1, fighter.thrown, 5);
      const text = voice.dodge(
        {
          a: names[fighter.corner],
          d: sayName(defender.corner, seed),
          p: pending.punch,
        },
        pending.evade,
        seed,
      );
      return speak(text, "call", defender.corner, 3400, tick);
    }

    /* Nothing has earned a call in a while and the round is live: color. Read
     * off the fight rather than invented — the work-rate gap if there is one,
     * the pace if both tanks are low, patience if neither. */
    if (
      bout.breakTime <= 0 &&
      bout.introSeconds <= 0 &&
      tick - Math.max(lastLineTick, joinTick) >= LULL_GAP_TICKS &&
      bout.roundTime > 20
    ) {
      const seed = seed32(bout.id, Math.floor(tick / LULL_GAP_TICKS));
      const gap = bout.left.landed - bout.right.landed;
      let text: string;
      let corner: Corner | null = null;
      if (bout.left.stamina < 40 && bout.right.stamina < 40) {
        text = voice.choose(
          "lull-pace",
          [
            `Both men are breathing heavy now. This pace is telling.`,
            `The pace has caught up with both of them.`,
            `Two tired fighters out there, running on will.`,
          ],
          seed,
        );
      } else if (Math.abs(gap) >= 8) {
        corner = gap > 0 ? "blue" : "red";
        const lead = corner === "blue" ? bout.left : bout.right;
        text = voice.choose(
          "lull-lead",
          [
            `${names[corner]} is out-working him, ${lead.landed} punches landed already.`,
            `The work rate belongs to ${names[corner]}: ${lead.landed} landed so far.`,
            `${names[corner]} is winning the volume battle, ${lead.landed} punches home.`,
          ],
          seed,
        );
      } else {
        const who = names[seed % 2 === 0 ? "blue" : "red"];
        text = voice.choose(
          "lull",
          [
            `Cagey stretch here, both looking for an opening.`,
            `${who} circling, trying to find his range.`,
            `Not much between them in this round.`,
            `A quiet spell, both men measuring, neither committing.`,
            `${who} feinting, looking for the opening.`,
            `Chess for the moment. Somebody will blink.`,
          ],
          seed,
        );
      }
      return speak(text, "color", corner, 4200, tick);
    }

    return null;
  };

  return { observe };
}
