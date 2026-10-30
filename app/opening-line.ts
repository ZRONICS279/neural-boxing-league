import type { Fighter, FighterStats } from "./fight-model.ts";

/** The opening line.
 *
 * An empty book is not a market. The first person to look at a fight sees
 * 50/50 on a matchup that is plainly one-sided, and the second person takes
 * their money off them — which is not a market either, it is a tax on being
 * early. Somebody has to quote first, and on eighteen fights that turn over
 * every six hours that somebody cannot be a person.
 *
 * So this is the league's own read of a fight, in cents, made out of what the
 * card already knows: what the two of them can do, what they have done, and how
 * they measure up. It is a scouting line, not a solved model — the fights are
 * decided by a recurrent policy this does not run, and the whole point of the
 * six hours before the first bell is that people disagree with it. It only has
 * to be defensible enough that the first trade is an opinion rather than an
 * arbitrage.
 *
 * Deliberately free of the chain, the clock and the card: two fighters in, a
 * number out. The worker seeds a book with it and the browser falls back to it
 * on a fight nobody has traded yet, and those two must agree to the cent or the
 * panel would quote one price and the book another. */

/* ------------------------------------------------------------------ weights */

/** What the six stats are worth to a *result*, which is not what they are
 *  worth to a fighter.
 *
 * Ordered by how much the simulation actually leans on each. Reaction leads
 * because it decides whether a punch is seen coming at all, and defense follows
 * it because slipping is read off the punching hand. Cardio trails everything:
 * it shapes the late rounds of a fight that mostly does not reach them. */
const STAT_WEIGHTS: Record<keyof FighterStats, number> = {
  reaction: 1.35,
  defense: 1.15,
  speed: 1.05,
  ringIq: 1.0,
  power: 0.9,
  cardio: 0.55,
};

const STAT_WEIGHT_TOTAL = Object.values(STAT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

/** Reach, in points per inch of advantage. A six-inch arm on a fight this size
 *  is a real edge and not a decisive one, which is roughly three points. */
const REACH_POINTS_PER_INCH = 0.55;
/** Weight, per pound, inside a division that already bounds it. */
const WEIGHT_POINTS_PER_POUND = 0.12;
/** How much of a physical edge is allowed to count. Two very differently built
 *  men are still two men in the same weight class. */
const PHYSICAL_CAP = 6;

/** Fights of imaginary 50/50 prior added to a record before reading it, so a
 *  1-0 debutant is not quoted as unbeaten. */
const RECORD_PRIOR_FIGHTS = 4;
/** Points between a spotless record and a winless one, once the prior is in. */
const RECORD_SPAN = 18;
/** Points between stopping everyone and stopping nobody. Finishing is evidence
 *  of something the stat line half-measures, but it is weak evidence: a man who
 *  wins on the cards has still won. */
const KO_SPAN = 5;

/** Where a fighter's physical peak sits, and what a year either side costs. */
const PRIME_AGE = 28;
const AGE_POINTS_PER_YEAR = 0.45;
const AGE_CAP = 4;

/** Points per level of career progression. */
const LEVEL_POINTS = 0.9;
const LEVEL_CAP = 5;

/** Points for having been in more fights the policy learned from.
 *
 * Measured as a doubling rather than a difference: the step from 30 decisions
 * to 60 is the step from green to seasoned, and the step from 3,000 to 3,030 is
 * nothing at all. The offset keeps a debut from reading as infinitely worse
 * than a second fight. */
const LEARNING_POINTS_PER_DOUBLING = 1.6;
const LEARNING_OFFSET = 64;
const LEARNING_CAP = 4;

/** Points of edge that make the fight 73/27.
 *
 * The one number that sets how opinionated the whole line is: everything above
 * is measured in points and this is what turns points into a price, so widening
 * it flattens every fight on the card at once. Set from the roster rather than
 * from taste — the widest gap two men in the same division actually have is
 * about thirteen points, and that fight should open around 70/30 and not at the
 * clamp. A six-point edge lands on 61/39, which is what a clear favourite in a
 * competitive division ought to look like. */
const LOGISTIC_SCALE = 13.5;

/** How far from even the league is willing to quote.
 *
 * Not 1 and 99. A line is a starting point for trading and a 95¢ favourite is a
 * fight nobody takes the other side of — and this model is not good enough to
 * be that certain about a sport where a single clean shot ends the evening. */
export const MIN_LINE = 25;
export const MAX_LINE = 75;

/* -------------------------------------------------------------------- score */

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/** The weighted stat line, on the same 0–100 scale the stats themselves use. */
export function statScore(stats: FighterStats): number {
  let total = 0;
  for (const [key, weight] of Object.entries(STAT_WEIGHTS)) {
    total += stats[key as keyof FighterStats] * weight;
  }
  return total / STAT_WEIGHT_TOTAL;
}

/** A record read as a win rate, shrunk toward even by the prior. */
function recordScore(fighter: Fighter): number {
  const { wins, losses, draws } = fighter.record;
  const fights = wins + losses + draws;
  const won = wins + draws / 2 + RECORD_PRIOR_FIGHTS / 2;
  const rate = won / (fights + RECORD_PRIOR_FIGHTS);
  const finishes = wins > 0 ? fighter.record.knockouts / wins : 0;
  return (rate - 0.5) * RECORD_SPAN + (finishes - 0.5) * KO_SPAN * (wins > 0 ? 1 : 0);
}

function ageScore(fighter: Fighter): number {
  return clamp(-Math.abs(fighter.age - PRIME_AGE) * AGE_POINTS_PER_YEAR, -AGE_CAP, 0);
}

function experienceScore(fighter: Fighter): number {
  const learned = fighter.policy.learnedDecisions ?? 0;
  return (
    clamp(fighter.level * LEVEL_POINTS, 0, LEVEL_CAP) +
    clamp(
      Math.log2((learned + LEARNING_OFFSET) / LEARNING_OFFSET) * LEARNING_POINTS_PER_DOUBLING,
      0,
      LEARNING_CAP,
    )
  );
}

/** Everything about one fighter that does not depend on the opponent.
 *
 * Split out so the two halves of a line are comparable on their own — a corner
 * that scores 71 against a corner that scores 64 is a seven-point favourite
 * whoever else is on the card. */
export function formScore(fighter: Fighter): number {
  return (
    statScore(fighter.stats) +
    recordScore(fighter) +
    ageScore(fighter) +
    experienceScore(fighter)
  );
}

/** The part of the edge that only exists across the ropes. */
function physicalEdge(blue: Fighter, red: Fighter): number {
  const reach = (blue.reach - red.reach) * REACH_POINTS_PER_INCH;
  const weight = (blue.weight - red.weight) * WEIGHT_POINTS_PER_POUND;
  return clamp(reach + weight, -PHYSICAL_CAP, PHYSICAL_CAP);
}

/* --------------------------------------------------------------- the price */

/** Blue's opening price in cents. Red is 100 − this, by construction. */
export function openingLine(blue: Fighter, red: Fighter): number {
  const edge = formScore(blue) - formScore(red) + physicalEdge(blue, red);
  const probability = 1 / (1 + Math.exp(-edge / LOGISTIC_SCALE));
  return clamp(Math.round(probability * 100), MIN_LINE, MAX_LINE);
}

/** The same line as both sides of it, for anything drawing a pair. */
export function openingOdds(blue: Fighter, red: Fighter) {
  const line = openingLine(blue, red);
  return { blue: line, red: 100 - line };
}

/** The line for a fight, by athlete id, or null if either man is off the
 *  roster. Callers that hold a roster rather than two profiles — which is most
 *  of the browser — go through this. */
export function openingLineFor(
  roster: Fighter[],
  blueId: string,
  redId: string,
): number | null {
  const blue = roster.find((fighter) => fighter.id === blueId);
  const red = roster.find((fighter) => fighter.id === redId);
  if (!blue || !red) return null;
  return openingLine(blue, red);
}
