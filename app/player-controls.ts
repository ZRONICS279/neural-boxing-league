/** Everything between a thumb and a `FighterAction`, with no React in it.
 *
 * The engine takes one action per corner per tick and otherwise decides for
 * itself, so a controller cannot simply be sampled — a press lands somewhere in
 * the middle of a 0.44 s hook and has to survive until the tick the engine will
 * actually accept it. That is what the buffer below is for, and it is the whole
 * difference between controls that feel responsive and controls that feel like
 * they are dropping half your inputs.
 *
 * Two other things are resolved here rather than in the UI. A single dodge
 * button has to choose between slip, duck and weave, and every punch button has
 * to choose between the head and the body; both read the ring instead of asking
 * the player, because the whole point of the layout is that a thumb picks a
 * punch and not a target. Neither choice rolls a die — the sim has no
 * randomness anywhere in it and this file is not going to be the first place it
 * appears. */
import { type BoutFighter, type FighterAction } from "./fight-model.ts";

export type PlayerButton = "jab" | "hook" | "cross" | "power" | "block" | "dodge";

/** How long a press stays live while the engine is busy with the last action.
 *
 * Every action in this engine is a commitment, and the long ones are footwork
 * and the guard rather than the punches: circling and holding a guard are both
 * 0.55 s, recovery is 0.65 s. A buffer shorter than that silently eats almost
 * every punch pressed while walking a man down, which is most of them — the
 * first cut of this was 320 ms and a jabbing player landed five punches a
 * round. It has to outlast the longest thing the player can be caught inside. */
const BUFFER_MS = 700;

/** Two taps inside this chain into a combination rather than one replacing the
 *  other, and are what turns a block into a dodge. Shared by both control
 *  schemes so a double tap means the same thing under a thumb and a finger. */
export const DOUBLE_TAP_MS = 260;
const COMBO_MS = DOUBLE_TAP_MS;

/** How many punches a chain may reach.
 *
 * A mashing thumb should not be able to bank a sequence that keeps playing out
 * after they have stopped pressing — past three the fighter is no longer doing
 * what the player is currently asking for. */
const COMBO_MAX = 3;

export interface DifficultyTier {
  id: string;
  label: string;
  /** The opponent's perception lag in seconds, or null to leave his card alone.
   *
   * Slowing the bout was the first way this was done and it was wrong: it made
   * the whole fight — footwork most visibly — crawl, when the only thing that
   * ever needed widening was the gap between a punch starting and a person
   * answering it. Handicapping his eyes instead leaves the fight at full speed
   * and puts the difficulty where a difficulty setting belongs. His stats,
   * reach, power and chin are untouched at every tier. */
  aiReactionSeconds: number | null;
  /** What the tier advertises about him, when a raw millisecond figure is not
   *  the thing to lead with. */
  readout?: string;
  blurb: string;
}

export const DIFFICULTIES: DifficultyTier[] = [
  { id: "rookie", label: "Rookie", aiReactionSeconds: 0.45, blurb: "Half a beat behind you. Room to work." },
  { id: "amateur", label: "Amateur", aiReactionSeconds: 0.325, blurb: "Getting sharper now. He will read the slow ones." },
  { id: "pro", label: "Pro", aiReactionSeconds: 0.2, blurb: "Sharper than you. He can read your muscle twitches." },
  { id: "championship", label: "Championship", aiReactionSeconds: 0.09, readout: "his real fighting level", blurb: "Superhuman, this is AI athletes." },
];

/** How much faster a player walks the ring than his card says.
 *
 * Footwork is the one place the engine's realism reads as sluggish under a
 * thumb: a real fighter's ring craft is spent over three minutes, and a player
 * wants to be somewhere else now. Punches, recovery and every commitment stay
 * exactly as they are. */
export const PLAYER_STRIDE = 2;

/** What running out of air costs, for both corners alike.
 *
 * The engine's own stamina lockout never fires, so without this a fighter on an
 * empty tank keeps throwing uppercuts at the same rate he did in round one.
 *
 * The numbers matter more than they look. A guard regenerates 1.9 stamina a
 * second and a reset nearly 9, so a single threshold anywhere near a third of a
 * tank has a fighter crossing it several times a round and spending most of the
 * fight unable to throw — which is a man who has forgotten how to box, not a
 * tired one. He drops out of the fight only at 6, which is genuinely empty, and
 * has to bank his way back to 15 before the power shots return. At a quarter or
 * a third of a tank he is untouched by any of this and throws everything he
 * owns.
 *
 * `windScale` runs the exhibition on a cheaper engine than a broadcast bout —
 * work costs 20% less here, and the engine's freshness ramp (exhibition-only,
 * like everything on this object) takes a further 20% off at the opening bell.
 * The league measured this relief and rejected it: fresher legs punch harder,
 * and every division's stoppage rate jumped by double digits. An exhibition
 * has no stoppage rate to protect — it has a person who pressed a button and
 * wants to still be boxing in round three. Both corners get it alike, and
 * punishment taken costs exactly what it always does. */
export const EXHAUSTION = {
  gassedAt: 6,
  recoveredAt: 15,
  jabCooldownSeconds: 2,
  hitStaminaCost: 1.15,
  windScale: 0.8,
};

/** How much a landed punch takes off the bar here, against the league's 1.
 *
 * The league's bar is ten-round attrition, and under a thumb it reads as
 * nothing happening: a player who banked a twenty-punch combination watched
 * the bar give up less than a quarter and concluded his hits did not work.
 * An exhibition is a video game about boxing, not a broadcast — the bar has
 * to answer the combination that was just landed. Both corners alike, so it
 * ends fights in either direction rather than being a hidden buff; the
 * knockdown physics and the stun are untouched, only what the accumulated
 * punishment costs on the bar (and the stoppage that watches it). */
export const DAMAGE_SCALE = 2;

interface ControlBinding {
  keys: string[];
  label: string;
  does: string;
  note?: string;
}

/** Named punches, because which punch you throw is the decision.
 *
 * The first cut of this had one jab button and one power button that read the
 * range and picked between the cross, the hook and the uppercut for you — which
 * meant the guard a punch carries while it is out was chosen by the range and
 * never by the player. Those numbers are the whole tactical spread: a jab
 * covers 0.30 while it is thrown, a hook 0.17, a cross 0.08. Handing the player
 * a button that silently spent that budget for them was hiding the fight.
 *
 * The fourth button is the power shot, and is the one place the range still
 * gets a say: it is the uppercut in the pocket, where an uppercut reaches, and
 * the heaviest hook or cross that reaches from anywhere else. It is not named
 * after a punch because it is not one punch. Head or body is read off the range
 * everywhere — a button picks a punch, not a target. */
export const KEY_BINDINGS: ControlBinding[] = [
  { keys: ["A", "D"], label: "Left / right", does: "Always the screen, never his side of the ring" },
  { keys: ["W", "S"], label: "Far / near", does: "Up and down the ring" },
  {
    keys: ["J"],
    label: "Jab",
    does: "Fast, safe, and the best guard of anything you can throw",
    note: "Tap a second punch inside a quarter-second to chain it: J then K is the one-two.",
  },
  {
    keys: ["K"],
    label: "Cross",
    does: "Your longest, hardest straight, and it leaves you wide open",
    note: "Almost no guard while it is out. Throw it on an opening, not on a guess.",
  },
  {
    keys: ["L"],
    label: "Hook",
    does: "Heavy and round, and still covers half of what a jab does",
    note: "Digs to the body from inside, goes upstairs from anywhere else.",
  },
  {
    keys: ["I"],
    label: "Power punch",
    does: "The uppercut inside, and the heaviest hook or cross that reaches from further out",
    note: "Nothing covers less. This is the one that ends a round.",
  },
  {
    keys: ["Space"],
    label: "Block, or dodge",
    does: "Hold to keep the hands up. You can still walk while you cover",
    note: "Double tap it to dodge instead: the slip, duck or weave gets picked for you.",
  },
  { keys: ["Esc"], label: "Pause", does: "Stops the clock" },
];

/** What the touch controls do. The buttons themselves carry their own names. */
export const TOUCH_BINDINGS: ControlBinding[] = [
  {
    keys: ["Stick"],
    label: "Move",
    does: "Always the screen: left is left, up is the far side of the ring",
  },
  {
    keys: ["Jab"],
    label: "Jab",
    does: "Fast, safe, and the best guard of anything you can throw",
    note: "Tap a second punch inside a quarter-second to chain it: Jab then Cross is the one-two.",
  },
  {
    keys: ["Hook"],
    label: "Hook",
    does: "Heavy and round, and still covers half of what a jab does",
    note: "Digs to the body from inside, goes upstairs from anywhere else.",
  },
  {
    keys: ["Cross"],
    label: "Cross",
    does: "Your longest, hardest straight, and it leaves you wide open",
    note: "Almost no guard while it is out. Throw it on an opening, not on a guess.",
  },
  {
    keys: ["Power"],
    label: "Power punch",
    does: "The uppercut inside, and the heaviest hook or cross that reaches from further out",
    note: "Nothing covers less. This is the one that ends a round.",
  },
  {
    keys: ["Block"],
    label: "Block, or dodge",
    does: "Hold to keep the hands up. You can still walk while you cover",
    note: "Double tap it to dodge instead: the slip, duck or weave gets picked for you.",
  },
];

/** Which fight button a key is.
 *
 * J K L run along the home row in the order the punches get longer and the
 * guard behind them gets thinner — jab, cross, hook — with the power shot on I
 * above them and the guard on the space bar, under a thumb that is not holding
 * anything else. Movement is handled separately, and anything not listed here
 * is left to the browser. */
const KEY_BUTTONS: Record<string, PlayerButton> = {
  " ": "block",
  j: "jab",
  k: "cross",
  l: "hook",
  i: "power",
};

export function keyboardButton(key: string): PlayerButton | null {
  return KEY_BUTTONS[key.toLowerCase()] ?? null;
}

export const BLOCK_KEY = " ";

/** What the UI hands over each tick. Axes are already normalised; the taps are
 *  edge-triggered presses collected since the last resolve, oldest first.
 *
 * The axes are in SCREEN space, not relative to the opponent: +x is always the
 * right-hand side of the ring and +y is always the near side, whichever corner
 * the player currently happens to be standing in. */
export interface ControlSnapshot {
  /** -1 toward the left of the ring, +1 toward the right. */
  x: number;
  /** -1 toward the far side of the ring, +1 toward the near side. */
  y: number;
  blockHeld: boolean;
  taps: { button: PlayerButton; at: number }[];
}

export function emptySnapshot(): ControlSnapshot {
  return { x: 0, y: 0, blockHeld: false, taps: [] };
}

export interface PlayerController {
  queue: FighterAction[];
  /** The action still waiting for the engine to take it, and when it expires. */
  pending: FighterAction | null;
  pendingUntil: number;
  lastTap: { button: PlayerButton; at: number } | null;
  /** Rotates the power button through its options so a held-down thumb does not
   *  produce the same punch forever. Deterministic on purpose. */
  powerRotation: number;
}

export function createPlayerController(): PlayerController {
  return {
    queue: [],
    pending: null,
    pendingUntil: 0,
    lastTap: null,
    powerRotation: 0,
  };
}

/** How far away he is, in arm lengths. Everything below reads this, because
 *  `PUNCH_SPECS.reachFactor` is in the same units. */
function reachRatio(player: BoutFighter, opponent: BoutFighter) {
  const reach = Math.max(0.4, player.reachM);
  return Math.hypot(opponent.x - player.x, opponent.y - player.y) / reach;
}

/** The punch a single power button should throw from here.
 *
 * Read off range rather than rolled, so backing a man onto the ropes and
 * ripping an uppercut is something the player did, not something that happened
 * to them. The ratios track `PUNCH_SPECS.reachFactor`: the uppercut only
 * reaches at 0.6 of arm length, the hook at ~0.7, the cross past that — so it
 * is the uppercut in the pocket and the heaviest thing that reaches from
 * further out, which is what stops the press being spent on air.
 *
 * Inside the pocket it is the uppercut and nothing else. It used to rotate
 * between the uppercut and a body hook there; the hook has its own button now,
 * and spending this press on a shot the player could already ask for by name
 * was the wrong half of the trade. */
export function powerPunchFor(
  player: BoutFighter,
  opponent: BoutFighter,
  rotation: number,
): FighterAction {
  const ratio = reachRatio(player, opponent);
  if (ratio <= 0.62) return "uppercut";
  if (ratio <= 0.80) return rotation % 2 === 0 ? "hookHead" : "hookBody";
  return rotation % 3 === 0 ? "crossBody" : "crossHead";
}

/** Head or body for a punch the player has already named.
 *
 * The button chooses the punch and the range chooses the target: every body
 * variant reaches a little shorter than its head variant, so a man who has
 * stepped inside digs downstairs and a man at the end of his arm goes
 * upstairs. The jab is the exception and always goes to the head — it is the
 * range-finder, and a jab that quietly turned into a body shot at close
 * quarters cost the player the one punch they throw to keep him honest. */
export function namedPunchFor(
  button: "jab" | "hook" | "cross",
  player: BoutFighter,
  opponent: BoutFighter,
): FighterAction {
  if (button === "jab") return "jabHead";
  const ratio = reachRatio(player, opponent);
  if (button === "hook") return ratio <= 0.5 ? "hookBody" : "hookHead";
  return ratio <= 0.72 ? "crossBody" : "crossHead";
}

/** Which evasion answers what is actually coming.
 *
 * A player pressing one dodge button has not told us anything about the shot,
 * so the shot has to be read here. Slip is the default because it is the
 * shortest commitment of the three — guessing wrong with a weave leaves a man
 * folded over for a third of a second. */
export function dodgeFor(opponent: BoutFighter): FighterAction {
  switch (opponent.action) {
    case "hookHead":
    case "uppercut":
      return "duck";
    case "jabBody":
    case "crossBody":
    case "hookBody":
      return "weave";
    default:
      return "slip";
  }
}

/** The footwork that actually carries a man where the stick is pointing.
 *
 * The engine has no absolute movement. `advance` means "toward the other man",
 * `circleLeft` means "ninety degrees off that bearing", and every one of them
 * is defined against a vector that reverses the moment the two fighters trade
 * sides of the ring. Bound naively, D walks you right for half a fight and left
 * for the other half, and the moment it flips is the moment you were trying to
 * get off the ropes.
 *
 * So the stick is read as a direction on screen and matched to whichever of the
 * four commitments actually points nearest to it. The engine keeps its relative
 * vocabulary; the player never has to think in it. */
function movementAction(
  snapshot: ControlSnapshot,
  player: BoutFighter,
  opponent: BoutFighter,
): FighterAction | null {
  const { x, y } = snapshot;
  if (Math.hypot(x, y) < 0.35) return null;

  const dx = opponent.x - player.x;
  const dy = opponent.y - player.y;
  const distance = Math.max(0.0001, Math.hypot(dx, dy));
  const forwardX = dx / distance;
  const forwardY = dy / distance;

  // Exactly the four vectors `updateMotion` will apply, in the same terms it
  // defines them: left is the forward bearing turned a quarter turn.
  const options = [
    ["advance", forwardX, forwardY],
    ["retreat", -forwardX, -forwardY],
    ["circleLeft", -forwardY, forwardX],
    ["circleRight", forwardY, -forwardX],
  ] as const;

  // Nearest bearing wins outright rather than blending: these are separate
  // whole-body commitments, and alternating between two of them every tick
  // roots a fighter to the spot instead of moving him diagonally.
  let best: FighterAction | null = null;
  let bestDot = -Infinity;
  for (const [action, optionX, optionY] of options) {
    const dot = x * optionX + y * optionY;
    if (dot > bestDot) {
      bestDot = dot;
      best = action;
    }
  }
  return best;
}

/** Whether this press extends the last one instead of replacing it. Only a
 *  punch chains onto a punch: a jab thrown straight after a block is a counter
 *  and wants to leave now, not to queue up behind the 0.55 s the guard takes. */
function chains(previous: { button: PlayerButton; at: number } | null, tap: { button: PlayerButton; at: number }) {
  if (!previous || previous.button === "block" || previous.button === "dodge") return false;
  return tap.at - previous.at <= COMBO_MS;
}

/** Turns one tick of controller state into the action to force this tick.
 *
 * This always names an action, and that is the whole contract: the engine reads
 * an absent override as "nobody is driving this corner" and hands it straight
 * back to the neural policy. A resolver that returned nothing on a quiet tick
 * meant a player who stopped pressing was silently replaced by the brain — his
 * own fighter would start boxing on its own, and the fighter with his hands
 * down took *less* damage than the one holding a guard, because the AI had
 * quietly taken over the idle corner and was doing a better job than he was.
 *
 * The resting action is `recover`, not `guard`. Guard is the only genuinely
 * stationary action in the whole vocabulary, which made it the obvious idle —
 * and that quietly handed the player a permanent free block, because a guard
 * absorbs 0.42–0.52 before stats and anything at or above 0.6 is scored as a
 * clean block. Resting on `recover` instead gives the partial coverage a boxer
 * actually carries between exchanges (0.28 head, 0.12 body, hard-capped at 0.58
 * so it can never cross the block line), restores wind, and leaves B as the
 * only way to genuinely put the hands up. The cost is that he drifts slightly
 * while nobody is touching the controls, which is what `recover` has always
 * done and is the closest this engine has to standing and breathing. */
export function resolvePlayerAction(
  controller: PlayerController,
  snapshot: ControlSnapshot,
  player: BoutFighter,
  opponent: BoutFighter,
  now: number,
): FighterAction {
  // A buffered action that the engine has since started is done with; anything
  // still waiting past its window is a press the player has stopped expecting.
  if (controller.pending) {
    if (player.action === controller.pending) {
      controller.pending = null;
      controller.queue.shift();
    } else if (now > controller.pendingUntil) {
      controller.pending = null;
      controller.queue = [];
    }
  }

  for (const tap of snapshot.taps) {
    if (tap.button === "block") {
      controller.queue = ["guard"];
      controller.lastTap = tap;
      break;
    }
    if (tap.button === "dodge") {
      controller.queue = [dodgeFor(opponent)];
      controller.lastTap = tap;
      break;
    }
    controller.powerRotation += 1;
    const punch =
      tap.button === "power"
        ? powerPunchFor(player, opponent, controller.powerRotation)
        : namedPunchFor(tap.button, player, opponent);

    // A second punch inside the window is a combination and chains onto the
    // first; anything later replaces it. There is no table of canned sequences
    // any more — with every punch on its own button the player writes the
    // combination themselves, and a jab–cross is two presses rather than a
    // double tap that has to be memorised. A press that arrives on a full chain
    // starts a new one rather than being dropped: the thumb is still pressing,
    // and the three punches already banked are the stale ones.
    if (chains(controller.lastTap, tap) && controller.queue.length < COMBO_MAX) {
      controller.queue.push(punch);
    } else {
      controller.queue = [punch];
    }
    controller.lastTap = tap;
  }

  if (controller.queue.length > 0) {
    const next = controller.queue[0];
    if (controller.pending !== next) {
      controller.pending = next;
      controller.pendingUntil = now + BUFFER_MS;
    }
    return next;
  }

  // Nothing queued. A held block no longer outranks the feet: the guard rides
  // along as a posture the caller applies, so the stick keeps working under it
  // and a player can cover up and walk out of a corner at the same time. With
  // no stick input the guard becomes the action in its own right.
  if (snapshot.blockHeld) return movementAction(snapshot, player, opponent) ?? "guard";
  return movementAction(snapshot, player, opponent) ?? "recover";
}

export function isMovementKey(key: string) {
  return ["w", "a", "s", "d"].includes(key.toLowerCase());
}

/** WASD as directions on the screen, never as directions relative to anybody.
 *
 * A is the left of the ring, D is the right, W is the far side and S is the
 * near one, and none of that changes when the two fighters swap corners.
 * `movementAction` is what turns these back into the engine's relative
 * commitments. */
export function movementAxes(held: Set<string>) {
  const x = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
  const y = (held.has("s") ? 1 : 0) - (held.has("w") ? 1 : 0);
  return { x, y };
}
