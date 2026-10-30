/** The shared vocabulary of a fight, split out from the engine.
 *
 * Everything here is what a bout LOOKS like -- the types, the ring constants,
 * and the pure formatters the renderer and site chrome read. None of it can
 * step a simulation: the engine in simulation.ts imports this file, never the
 * other way around, so code that only draws fights can depend on this module
 * without pulling the brain along with it. */
import {
  STRATEGY_FOCI,
  type OpponentDossier,
  type StrategyDirective,
  type StrategyFocus,
} from "./strategy.ts";

export const ACTIONS = [
  "advance",
  "retreat",
  "circleLeft",
  "circleRight",
  "pivotLeft",
  "pivotRight",
  "jabHead",
  "crossHead",
  "hookHead",
  "jabBody",
  "crossBody",
  "hookBody",
  "uppercut",
  "guard",
  "slip",
  "duck",
  "weave",
  "recover",
] as const;

export type FighterAction = (typeof ACTIONS)[number];
export type Corner = "blue" | "red";
export type PunchTarget = "head" | "body";
export type ImpactZone =
  | "guard"
  | "jaw"
  | "chin"
  | "nose"
  | "temple"
  | "forehead"
  | "cheek"
  | "chest"
  | "solarPlexus"
  | "ribs"
  | "liver"
  | "abdomen";

export const TACTICAL_INTENTS = STRATEGY_FOCI;

export type TacticalIntent = StrategyFocus;

export const BOXING_MODEL = {
  ringLengthMeters: 6.1,
  ringDepthMeters: 6.1,
  // EXPERIMENT (2026-08-07): 50 Hz trial, was 0.1. The damage decays and the
  // flash bar are tick-rate-compensated where they are applied (identity at
  // 0.1), so stoppage rates hold near the 10 Hz targets — measured 25/60/64%
  // by division on the trained roster. A bout recorded at one tick rate still
  // does not replay at another. Restore 0.1 to get the 10 Hz league back
  // exactly.
  physicsStepSeconds: 0.02,
  roundSeconds: 180,
  totalRounds: 3,
  // How long the fighters are held at the bell while the round call is on screen.
  roundIntroSeconds: 1.6,
  // The stool between rounds. Short of a real minute on purpose — it is dead
  // air on a broadcast — but it is airtime, so anything sizing a fight has to
  // count it.
  cornerBreakSeconds: 6,
  gloveRadiusMeters: 0.07,
  // Anatomical half-widths of what a punch can actually hit. The head was 0.13,
  // which models a 26 cm wide skull — with the glove that made a 40 cm contact
  // window no amount of head movement could clear. The body is the ribs and
  // solar plexus a punch is aimed at, not the full span of the shoulders.
  headRadiusMeters: 0.10,
  bodyRadiusMeters: 0.15,
  // The pulse width peak force is read off, not the time the glove is touching.
  // A gloved punch stays on the target for about 14 ms, and the force over that
  // contact is roughly a half sine rather than a flat push — so the peak runs
  // π/2 above the mean, and 14 ms ÷ (π/2) = 8.9 ms is the width that turns the
  // delivered impulse straight into a peak. Used for the readout only: nothing
  // in the fight itself reads this.
  contactDurationSeconds: 0.009,
  observationFeatures: 28,
  neuralHiddenUnits: 16,
  recurrentUnits: 8,
  tacticalIntents: TACTICAL_INTENTS.length,
} as const;

export interface FighterStats {
  power: number;
  speed: number;
  cardio: number;
  defense: number;
  ringIq: number;
  reaction: number;
}

export interface FighterRecord {
  wins: number;
  losses: number;
  draws: number;
  knockouts: number;
}

export type WeightClassId = "featherweight" | "middleweight" | "heavyweight";

/** The three sanctioned divisions.
 *
 * A division is the unit the whole broadcast is organised around: it owns its
 * own contender ladder, its own champion, and its own weekly title fight. */
export const WEIGHT_CLASSES: {
  id: WeightClassId;
  label: string;
  limit: number;
}[] = [
  { id: "featherweight", label: "Featherweight", limit: 126 },
  { id: "middleweight", label: "Middleweight", limit: 160 },
  { id: "heavyweight", label: "Heavyweight", limit: 250 },
];

export function weightClassLabel(id: WeightClassId) {
  return WEIGHT_CLASSES.find((division) => division.id === id)?.label ?? id;
}

/** Experience needed to reach the next level, which grows as the athlete does. */
export function xpForNextLevel(level: number) {
  return 100 + (level - 1) * 45;
}

export interface ConditioningProfile {
  lowerBodyPower: number;
  lowerBodyEndurance: number;
  kineticChain: number;
  shoulderEndurance: number;
  workloadSteps: number;
  adaptationCycles: number;
}

export interface ArticulatedBodyState {
  leadFootOffset: number;
  rearFootOffset: number;
  leadKneeFlexion: number;
  rearKneeFlexion: number;
  hipRotation: number;
  shoulderRotation: number;
  centerOfMassHeight: number;
  leadGroundForceN: number;
  rearGroundForceN: number;
  resultantGroundForceN: number;
  forwardGroundForceN: number;
  lateralGroundForceN: number;
  previousGroundForceN: number;
  rateOfForceDevelopment: number;
  kineticChainEfficiency: number;
  gaitPhase: number;
  plantedFoot: "lead" | "rear" | "both";
}

export interface PolicyModel {
  architecture: "recurrent-28x16x8x6x18";
  weights: number[][];
  bias: number[];
  hiddenWeights: number[][];
  hiddenBias: number[];
  recurrentHiddenWeights: number[][];
  memoryInputWeights: number[][];
  memoryWeights: number[][];
  memoryBias: number[];
  intentWeights: number[][];
  intentMemoryWeights: number[][];
  intentBias: number[];
  outputWeights: number[][];
  outputMemoryWeights: number[][];
  intentActionWeights: number[][];
  generation: number;
  evaluatedBouts: number;
  // Decisions this brain has actually been credited for. Sparring generations
  // are a coarse count of search attempts; this is the number of individual
  // choices a reward has been assigned to, and it is what the neural influence
  // dial rides on.
  learnedDecisions: number;
  fitness: number;
}

export interface Fighter {
  id: string;
  seed: number;
  firstName: string;
  lastName: string;
  nickname: string;
  hometown: string;
  stance: "Orthodox" | "Southpaw";
  archetype: string;
  weightClass: WeightClassId;
  age: number;
  height: number;
  weight: number;
  reach: number;
  rating: number;
  // Career progression earned by fighting, separate from `rating` (which is the
  // scouting read) and from `policy` (which is what training changed).
  level: number;
  xp: number;
  confidence: number;
  trainingBouts: number;
  lastTrainingGain: number;
  record: FighterRecord;
  stats: FighterStats;
  policy: PolicyModel;
  /** Display-safe tendencies supplied when the learned matrices stay server-side. */
  publicActionPreferences?: { action: FighterAction; value: number }[];
  opponentDossiers: Record<string, OpponentDossier>;
  conditioning: ConditioningProfile;
  /* ---- Exhibition handicaps ----------------------------------------------
   *
   * Both are absent on every athlete the league itself books, and both are read
   * only where they are absent-checked, so a real bout computes exactly what it
   * computed before either field existed. They exist because a person cannot be
   * given a slower nervous system to make a fight fair, so the fight has to be
   * handicapped around them instead — and none of that may leak into a result
   * anybody's record or money depends on. */

  /** Overrides the reaction stat's perception lag, in seconds. Lets an
   *  exhibition opponent be given a reaction far outside anything the stat
   *  curve can express, which is the only way a human is in the same fight. */
  reactionOverrideSeconds?: number;
  /** Multiplies how fast this athlete walks, circles and backs off. Nothing
   *  else scales with it — punches, recovery and every commitment stay put. */
  movementScale?: number;
  /** Multiplies what landed punches take off the health bar.
   *
   *  The league's bar is honest boxing: trauma accumulates slowly and a
   *  twenty-punch round moves it a sliver, which is what real ten-round
   *  attrition looks like and exactly what a person holding a controller
   *  reads as "my hits do nothing". An exhibition trades that realism for a
   *  bar that visibly answers a combination. It scales only the derived bar
   *  (and so the stoppage that watches it) — balance, knockdowns, stun and
   *  cuts read the same punch they always did. */
  damageScale?: number;
  /** What an empty tank costs.
   *
   *  Two thresholds, not one. A fighter drops into the gassed state only once
   *  he is genuinely out at `gassedAt`, and he does not climb back out of it
   *  until he has banked his way up to `recoveredAt` — without that gap he sits
   *  on a single threshold and flickers in and out of it every second, which
   *  reads as a fighter who has forgotten how to box rather than one who is
   *  tired. A quarter of a tank is not tired: at 25 or 30 he throws everything
   *  he owns, and only near empty does he lose the power shots and drop to one
   *  jab per `jabCooldownSeconds`.
   *
   *  `hitStaminaCost` is what absorbing a clean punch takes out of him, scaled
   *  by how hard it landed.
   *
   *  `windScale` discounts what his own work costs — punches, footwork, and
   *  evasions, never punishment taken — and its presence is also what turns on
   *  the freshness ramp and the fresh-legs regen boost. An exhibition runs a
   *  cheaper engine than a broadcast bout, because a fight against a thumb
   *  has no corner, no camp, and no pacing brain on the player's side.
   *
   *  The engine's own stamina lockout has never fired: it masks punches whose
   *  `staminaCost` exceeds 3.4, and the heaviest punch in the game is the
   *  uppercut at 3.0. Rather than change that threshold — which would rewrite
   *  every stoppage rate in the league — exhaustion is opt-in and lives here. */
  exhaustionRules?: {
    gassedAt: number;
    recoveredAt: number;
    jabCooldownSeconds: number;
    hitStaminaCost: number;
    windScale?: number;
  };
}

export interface LeagueState {
  version: 10;
  season: number;
  week: number;
  boutsCompleted: number;
  roster: Fighter[];
}

export interface SensorySnapshot {
  x: number;
  y: number;
  velocity: number;
  velocityY: number;
  stamina: number;
  balance: number;
  health: number;
  // How badly the man is buzzed, as it LOOKS from the other side of the ring —
  // legs, hands and head carriage. This is what tells an opponent to jump on
  // him, and it is observable long before a health bar would show anything.
  hurt: number;
  action: FighterAction;
  headOffset: number;
  headLevel: number;
  handExtension: number;
  actionProgress: number;
  // Which hand the shot is coming off, in his own frame. Visible from across the
  // ring long before the glove is — it is the shoulder that gives it away.
  punchSide: number;
  heightM: number;
}

export interface RoundMetrics {
  cleanBlows: number;
  impactEnergy: number;
  defense: number;
  control: number;
  knockdowns: number;
}

export interface BoutFighter {
  fighterId: string;
  corner: Corner;
  x: number;
  y: number;
  facingDirection: -1 | 1;
  velocity: number;
  velocityY: number;
  health: number;
  stamina: number;
  // 1 at the opening bell, fading to 0 by the start of round three and staying
  // there. The engine stamps it for every bout, but only exhibition wind
  // pricing reads it (via `exhaustionRules`): fresh legs work cheaper and
  // reload faster early, and by round three the exhibition costs what it
  // always did. A booked bout prices every round the same — the league
  // measured freshness relief and it bought double-digit stoppage jumps.
  freshness: number;
  balance: number;
  body: ArticulatedBodyState;
  headTrauma: number;
  bodyTrauma: number;
  neurologicalLoad: number;
  bodyShock: number;
  stunSeconds: number;
  /** Exhibition only: how long until an exhausted fighter may throw again.
   *  Stays at zero for the whole of any bout the league books. */
  punchLockSeconds: number;
  /** Exhibition only: latched while he is out of air, so the two exhaustion
   *  thresholds behave as a band rather than a line he flickers across. */
  gassed: boolean;
  /** Exhibition only: the hands are up as a posture rather than as this tick's
   *  action, so a player can hold his guard and still work his feet. The engine
   *  takes one action per corner per tick and `guard` is a whole-body
   *  commitment, so without this, holding block roots a fighter to the spot. */
  guardHeld: boolean;
  // Seconds left in a visible HURT state — legs gone, hands dropping. A hurt
  // fighter defends worse and moves worse, and the other man can see it, so a
  // big shot opens a finishing window instead of instantly ending the fight.
  hurtSeconds: number;
  // 1 = a fresh chin, falling as the head absorbs punishment. The knockdown bar
  // scales with this, so early one-punch finishes are rare and late ones are not.
  chinIntegrity: number;
  // The combination currently being thrown, and how far through it we are.
  comboPlan: FighterAction[];
  comboIndex: number;
  // Consecutive guard decisions, used to stop a fighter turtling all round.
  guardStreak: number;
  // Seconds spent welded to the opponent in tight, which drives the in-and-out
  // rhythm — the longer he has been in there the more he wants to reset out.
  pocketSeconds: number;
  downCountSeconds: number;
  recoveryTargetSeconds: number;
  knockout: boolean;
  knockoutCause: string;
  score: number;
  judgePoints: number[];
  action: FighterAction;
  lastAction: FighterAction;
  // How heavily each action has been leaned on lately, decayed every decision.
  // `lastAction` only ever caught a shot thrown twice running, which is why the
  // ring kept showing a man alternating two punches with a step between them.
  actionRecency: number[];
  tacticalIntent: TacticalIntent;
  decisionConfidence: number;
  decisionMargin: number;
  decisionCount: number;
  brainActivity: number;
  workingMemory: number[];
  memoryActivity: number;
  memoryUpdates: number;
  currentPlan: StrategyDirective;
  planRevision: number;
  attackSequence: number;
  actionElapsed: number;
  actionDuration: number;
  previousHandExtension: number;
  handExtension: number;
  handVelocity: number;
  headOffset: number;
  headLevel: number;
  punchAimOffset: number;
  punchAimHeight: number;
  punchAimZone: ImpactZone;
  // Which hand is throwing. The jab and cross are fixed to the lead and rear
  // hand; hooks and uppercuts alternate off the previous punch so a combination
  // visibly comes off both hands instead of one arm pumping repeatedly.
  punchHand: "lead" | "rear";
  // Which side of his own body the live hand is swinging from: +1 his left, -1
  // his right, 0 when he is not punching. Stance is what decides it — an
  // orthodox jab comes off the left hand, a southpaw jab off the right — and it
  // is the one thing the other man needs in order to slip the correct way.
  punchSide: number;
  punchDirectionX: number;
  punchDirectionY: number;
  punchExtensionTarget: number;
  punchResolved: boolean;
  // The side he committed his head to when this evasion started, read off the
  // punch he thought was coming. Fixed for the duration of the movement: a slip
  // is one decisive move off the line, not a head that keeps shopping around.
  evadeDirection: number;
  landed: number;
  thrown: number;
  blocked: number;
  knockdowns: number;
  cleanImpactJ: number;
  absorbedImpactJ: number;
  lastImpactJ: number;
  peakImpactJ: number;
  peakHandSpeed: number;
  /** Hardest shot this man has landed, as force through the guard rather than
   *  energy. Kept beside `peakImpactJ` and measured the same way — what got
   *  through, not what was thrown — so a blocked haymaker cannot post a headline
   *  number the opponent never actually felt. */
  peakForceN: number;
  lastImpactZone: ImpactZone;
  lastStrikeKind: FighterAction | "none";
  lastImpactSpeed: number;
  lastRotationalImpulse: number;
  lastPowerShot: boolean;
  /** Whether the last impact caught the other man inside his own punch — the
   * engine's counter flag, carried so the broadcast can call it. */
  lastImpactCounter: boolean;
  recentHeadImpact: number;
  recentBodyImpact: number;
  sustainedPressure: number;
  heightM: number;
  reachM: number;
  massKg: number;
  round: RoundMetrics;
  lastRound: RoundMetrics;
  actionCounts: Record<FighterAction, number>;
  rangeSampleTotal: number;
  rangeSamples: number;
  sensoryHistory: SensorySnapshot[];
}

export interface FightEvent {
  id: number;
  time: string;
  tone: "neutral" | Corner | "warning";
  text: string;
}

export interface JudgeRoundScore {
  judge: number;
  left: number;
  right: number;
}

export interface RoundCard {
  round: number;
  judges: JudgeRoundScore[];
  leftCleanBlows: number;
  rightCleanBlows: number;
  leftImpactJ: number;
  rightImpactJ: number;
}

export interface BoutState {
  id: number;
  // Varies the opening geometry so the same matchup is not the same fight
  // twice, without giving up reproducibility — see `createBoutFighter`.
  seed: number;
  tick: number;
  round: number;
  roundTime: number;
  roundLength: number;
  totalRounds: number;
  breakTime: number;
  // The bell has gone but the fighters are still held: "ROUND n" then "FIGHT!"
  // is on screen and nobody may throw until it clears.
  introSeconds: number;
  running: boolean;
  speed: 1 | 4 | 12;
  left: BoutFighter;
  right: BoutFighter;
  roundCards: RoundCard[];
  events: FightEvent[];
  winnerId: string | null;
  finish: "KO" | "TKO" | "Decision" | "Draw" | null;
  careerCommitted: boolean;
}

export interface ImpactInput {
  effectiveMassKg: number;
  closingVelocityMps: number;
  guardAbsorption?: number;
  rotationalFactor?: number;
  directness?: number;
  momentArmMeters?: number;
  anatomicalVulnerability?: number;
}

export interface ImpactResult {
  effectiveMassKg: number;
  closingVelocityMps: number;
  impulseNs: number;
  transmittedImpulseNs: number;
  impactEnergyJ: number;
  transmittedEnergyJ: number;
  peakForceN: number;
  rotationalImpulseNms: number;
  neurologicalLoad: number;
  powerScore: number;
}

export function formatImpactZone(zone: ImpactZone) {
  return zone === "solarPlexus"
    ? "solar plexus"
    : zone.replace(/([A-Z])/g, " $1").toLowerCase();
}

/** How the brain earns its ring time.
 *
 * A debutant sits at the floor: the hand-written boxing brain leads and the net
 * only flavours it, which is the only safe setting for weights that have never
 * been rewarded for anything. Every credited decision moves the dial up along a
 * saturating curve, so an athlete who has been through a few hundred rounds is
 * steering most of his own fight and one who has just turned over is not. */
const NEURAL_INFLUENCE = {
  floor: 0.3,
  range: 0.9,
  // Credited decisions at which the dial has climbed halfway up its range. A
  // fight is worth a few hundred, so this is roughly a full season of learning.
  halfLife: 25000,
} as const;

/** Takes only the count it reads, so anything explaining the dial can ask what a
 *  debut is worth without having to build a whole policy to ask with. */
export function neuralInfluence(policy: Pick<PolicyModel, "learnedDecisions">) {
  const credited = Math.max(0, policy.learnedDecisions);
  const share =
    NEURAL_INFLUENCE.floor +
    NEURAL_INFLUENCE.range *
      (credited / (credited + NEURAL_INFLUENCE.halfLife));
  // `+ 0` collapses negative zero, matching the engine's own rounding habit.
  return Math.round(share * 1e4) / 1e4 + 0;
}

/** Readable tendencies for an athlete as the public knows him.
 *
 * The engine computes these server-side when a fighter is let out the door
 * (`publicFighter`); on this side of the wire the learned matrices are empty,
 * so the served list is all there is — and all there needs to be. */
export function actionPreferencesOf(fighter: Fighter) {
  return fighter.publicActionPreferences ?? [];
}
