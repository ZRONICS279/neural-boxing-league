import type { RoundCard } from "../app/fight-model.ts";
import type { TimelineFighterFrame, TimelineFrame } from "../app/fight-timeline.ts";

/** The in-play line.
 *
 * Once the bell goes the opening line is stale on purpose: the whole point of
 * keeping the book open through a fight is that the fight itself is the news.
 * This reprices a bout from what has actually been shown — the aired frame and
 * the revealed round cards — so the maker's quotes follow the action instead of
 * sitting at a pre-fight number a viewer can pick off the moment somebody gets
 * dropped.
 *
 * The one rule that matters more than any weight below: **nothing in here may
 * read the result.** The server knows how the fight ends; the market must not.
 * A fair that used the known winner would walk the quotes toward him minutes
 * early, and the book itself would become the spoiler the whole streaming
 * cutover exists to prevent. Everything this takes as input is data any viewer
 * has already been served.
 *
 * Like the opening line, it is a scouting read and not a solved model. It has
 * one job: keep the standing quote close enough to the visible state of the
 * fight that flow against it is an opinion rather than an arbitrage. The
 * weights were fitted against captured bouts rather than taste: over 18
 * training fights and 15 held-out ones (priced every five seconds), Brier
 * 0.143/0.102 against 0.185/0.217 for holding the opening line, improving
 * with every phase of the fight — early 0.17, late 0.02–0.12. Re-fit with the
 * scratchpad calibration harness if combat tuning moves health or the cards.
 *
 * The early temper below post-dates that fit and deliberately costs a little
 * early-phase calibration (which the fit showed was barely better than the
 * prior anyway): a line that reads 87 midway through round two is calling the
 * fight before the fight has said so, and watchability outranks a few points
 * of Brier the same way it did when pricing moved to the viewer's frame. */

/* ------------------------------------------------------------------ weights */

/** Log-odds per net round banked on the judges' cards, at the final bell.
 *
 * Scaled by fight progress on the way in: a round up with two still to fight is
 * a lead, a round up with one to fight is nearly the decision. Cards are the
 * only signal that decides a fight all on its own, so it carries the most. */
const CARD_POINTS = 1.5;
/** Log-odds per full bar of health advantage. Health folds the trauma model in
 *  (the engine derives it from head and body trauma), so this is the one
 *  number that says who is winning the damage fight. */
const HEALTH_POINTS = 3.2;
/** Extra log-odds as one man's tank runs toward the stoppage floor. The engine
 *  arms its finishing logic off absolute condition, not off the difference —
 *  a fighter at 30 health is in danger even against a man at 55. */
const DANGER_POINTS = 1.7;
/** Where "in danger" starts, on the engine's 0–100 health bar. */
const DANGER_FLOOR = 45;
/** Log-odds per knockdown scored. Deliberately modest: a knockdown banks a
 *  10-8 card and drains health, and both of those are already counted. This is
 *  only the extra "he has shown he can drop him" on top. */
const KNOCKDOWN_POINTS = 0.45;
/** Log-odds while the opponent is visibly compromised right now. A count in
 *  progress is most of a finish; a stun is a finishing window; hurt is legs
 *  gone but still defending. These are transient — the price comes back down
 *  when the man survives — which is exactly how an in-play book behaves. */
const DOWN_POINTS = 1.9;
const STUN_POINTS = 1.0;
const HURT_POINTS = 0.45;

/** How much of the banked evidence — cards, the health edge, knockdowns — the
 *  line trusts at the opening bell. A man a round and thirty bars up in round
 *  two holds a lead, not a verdict: fights turn, and a price that reads 87
 *  with half the fight left is calling it early. Trust climbs with the square
 *  of progress, so the discount stays heavy through the middle rounds and is
 *  gone by the final bell. The transient signals are deliberately outside
 *  this: a count in progress, a stun, a man near the stoppage floor are
 *  danger *now*, whatever the round. */
const EARLY_TRUST = 0.25;
/** Banked evidence past this many log-odds is a beating too one-sided to
 *  discount — the excess above it passes through the early temper at full
 *  weight, so a genuine early massacre still prices like one. A soft knee,
 *  not a cap. */
const OBVIOUS_POINTS = 2.2;

/** How far from certain the line will go while the fight is still on. The
 *  model is not allowed to call a fight over before the referee does. */
export const MIN_INPLAY_LINE = 4;
export const MAX_INPLAY_LINE = 96;

/* -------------------------------------------------------------------- score */

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/** Net rounds on the cards, judged the way the verdict will be: each revealed
 *  round goes to whichever man a majority of its judges scored ahead, and a
 *  split judge is half a vote each way. Positive favours `left`. */
function cardLead(cards: RoundCard[]): number {
  let net = 0;
  for (const card of cards) {
    let left = 0;
    let right = 0;
    for (const judge of card.judges) {
      if (judge.left > judge.right) left += 1;
      else if (judge.right > judge.left) right += 1;
    }
    if (left > right) net += 1;
    else if (right > left) net -= 1;
  }
  return net;
}

/** How compromised a man looks right now, worth log-odds to the other corner.
 *  Severity saturates fast — the first second of a stun is the information. */
function peril(fighter: TimelineFighterFrame): number {
  return (
    DOWN_POINTS * clamp(fighter.downCountSeconds > 0 ? 1 : 0, 0, 1) +
    STUN_POINTS * clamp(fighter.stunSeconds / 1.5, 0, 1) +
    HURT_POINTS * clamp(fighter.hurtSeconds / 1.5, 0, 1)
  );
}

/** How close a man is to the stoppage floor, 0 while he is fresh. */
function danger(fighter: TimelineFighterFrame): number {
  return clamp((DANGER_FLOOR - fighter.health) / DANGER_FLOOR, 0, 1);
}

/* --------------------------------------------------------------- the price */

/** Blue's in-play price in cents, as a float for the caller to round.
 *
 * `prior` is the opening line — the pre-fight read stays in as the anchor and
 * the fight's own evidence accumulates on top of it, so the price at the
 * opening bell IS the opening line and drifts from there as the rounds go. */
export function inPlayLine(
  prior: number,
  frame: TimelineFrame,
  cards: RoundCard[],
): number {
  const blue = frame.left.corner === "blue" ? frame.left : frame.right;
  const red = frame.left.corner === "blue" ? frame.right : frame.left;
  const blueIsLeft = frame.left.corner === "blue";

  // How much of the scheduled distance has been fought. `roundTime` counts
  // down, so the elapsed part of the current round is what has come off it.
  const total = frame.totalRounds * frame.roundLength;
  const elapsed =
    (frame.round - 1) * frame.roundLength + (frame.roundLength - frame.roundTime);
  const progress = clamp(total > 0 ? elapsed / total : 0, 0, 1);

  const p = clamp(prior, MIN_INPLAY_LINE, MAX_INPLAY_LINE) / 100;
  let logit = Math.log(p / (1 - p));

  // The banked evidence: rounds on the cards (worth more the fewer remain to
  // win one back), the health edge, knockdowns scored. It accumulates slowly
  // and it can still be undone, so early in the fight only a fraction of it
  // reaches the price — except the part past OBVIOUS_POINTS, which is a
  // beating nobody needs the third round to believe.
  const lead = cardLead(cards) * (blueIsLeft ? 1 : -1);
  let banked = CARD_POINTS * lead * progress;
  banked += HEALTH_POINTS * ((blue.health - red.health) / 100);
  banked += KNOCKDOWN_POINTS * (blue.knockdowns - red.knockdowns);
  const trust = EARLY_TRUST + (1 - EARLY_TRUST) * progress * progress;
  logit +=
    Math.sign(banked) *
    (Math.min(Math.abs(banked), OBVIOUS_POINTS) * trust +
      Math.max(Math.abs(banked) - OBVIOUS_POINTS, 0));

  // Danger now, at full weight whatever the round: a man near the stoppage
  // floor, and whatever state the two of them are in this second.
  logit += DANGER_POINTS * (danger(red) - danger(blue));
  logit += peril(red) - peril(blue);

  const probability = 1 / (1 + Math.exp(-logit));
  return clamp(probability * 100, MIN_INPLAY_LINE, MAX_INPLAY_LINE);
}
