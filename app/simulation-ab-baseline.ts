import {
  normalizeStrategyDirective,
  type OpponentDossier,
  type StrategyContext,
  type StrategyDirective,
} from "./strategy.ts";
import {
  ACTIONS,
  BOXING_MODEL,
  neuralInfluence,
  TACTICAL_INTENTS,
  formatImpactZone,
  xpForNextLevel,
  type ArticulatedBodyState,
  type BoutFighter,
  type BoutState,
  type ConditioningProfile,
  type Corner,
  type Fighter,
  type FighterAction,
  type FighterRecord,
  type FighterStats,
  type ImpactInput,
  type ImpactResult,
  type ImpactZone,
  type JudgeRoundScore,
  type LeagueState,
  type PolicyModel,
  type PunchTarget,
  type RoundCard,
  type RoundMetrics,
  type SensorySnapshot,
  type TacticalIntent,
  type WeightClassId,
} from "./fight-model.ts";

export * from "./fight-model.ts";

/* The tempo ladder is the point of a weight class: a featherweight gets off
 * the line visibly faster than a middleweight, and a heavyweight visibly
 * slower. Applied to evasion onset only — reads and dodge choices stay
 * stat-driven. Each division then carries its own flash-bar floor, because
 * dodge speed and the knockdown bar are one coupled system: faster dodges
 * starve finishes, so the quicker division fights on a softer bar to hold its
 * stoppage rate. Measured together at 50 Hz on the trained roster: 28/62/72%
 * stoppage by division against the 37/64/70% the 10 Hz league aired. The
 * bar's response is violently non-linear — retune the pair only with the
 * sweep harness, never by eye. */
const DIVISION_EVADE_TEMPO: Record<WeightClassId, number> = {
  featherweight: 1.22,
  middleweight: 1.0,
  heavyweight: 0.82,
};

const DIVISION_FLASH_FLOOR: Record<WeightClassId, number> = {
  featherweight: 0.77,
  middleweight: 0.78,
  heavyweight: 0.785,
};

export interface TrainingConfig {
  generations?: number;
  population?: number;
  opponents?: number;
  evaluationSeconds?: number;
}

export interface TrainingResult {
  league: LeagueState;
  bouts: number;
  physicsSteps: number;
  generations: number;
  candidates: number;
  fitnessBefore: number;
  fitnessAfter: number;
  gain: number;
}

export interface TrainingObservation {
  fighterId: string;
  opponentId: string;
  corner: Corner;
  tick: number;
  round: number;
  roundTime: number;
  actionReady: boolean;
  currentAction: FighterAction;
  lastAction: FighterAction;
  actionRecency: number[];
  attackSequence: number;
  distanceMeters: number;
  stamina: number;
  balance: number;
  hurtSeconds: number;
  guardStreak: number;
  pocketSeconds: number;
  comboPlan: FighterAction[];
  comboIndex: number;
  workingMemory: number[];
  strategy: StrategyDirective;
  opponentAction: FighterAction;
  opponentPunchTarget: PunchTarget | null;
  incomingThreat: number;
  features: number[];
  actionMask: boolean[];
}

export interface TrainingEnvironment {
  traineeId: string;
  opponentId: string;
  traineeCorner: Corner;
  bout: BoutState;
  cumulativeReward: number;
}

export interface TrainingTransition {
  environment: TrainingEnvironment;
  observation: TrainingObservation;
  reward: number;
  done: boolean;
}

export interface PolicyDecision {
  action: FighterAction;
  intent: TacticalIntent;
  intentIndex: number;
  confidence: number;
  margin: number;
  brainActivity: number;
  memoryActivity: number;
  nextMemory: number[];
  hiddenActivations: number[];
  actionScores: number[];
  // The net's own logits, before the boxing brain and the hard constraints are
  // folded in. Learning has to credit what the brain actually said, not the
  // blended score the fighter acted on.
  neuralActionScores: number[];
  intentScores: number[];
}

/** One choice, with everything needed to assign credit to it after the fact. */
export interface DecisionRecord {
  features: number[];
  hidden: number[];
  previousMemory: number[];
  memory: number[];
  mask: boolean[];
  actionIndex: number;
  actionScores: number[];
  intentIndex: number;
  intentScores: number[];
  // The reward potential at the moment of the choice. Differences between
  // consecutive records are what the decision actually earned.
  value: number;
}

/** Every decision one athlete made in one bout, plus how it ended. */
export interface DecisionEpisode {
  fighterId: string;
  records: DecisionRecord[];
  finalValue: number;
  terminalBonus: number;
}

/** Collects decisions as a bout runs.
 *
 * It is passed alongside the bout rather than stored on it: `stepBout` clones
 * the whole state every tick, and a growing trace inside that would turn a
 * three-round fight into a quadratic copy. */
export interface DecisionLedger {
  tracked: string[] | null;
  records: Map<string, DecisionRecord[]>;
}

interface PunchSpec {
  target: PunchTarget;
  duration: number;
  contactPhase: number;
  reachFactor: number;
  velocityFactor: number;
  massFactor: number;
  staminaCost: number;
  rotationalFactor: number;
  /** The share of a guard the punch leaves in place while it is in the air.
   * A jab's rear hand never moves and the lead shoulder rides high, so most
   * of the shell survives the shot; a hook keeps the off hand home but opens
   * the side it swings from; a cross takes the whole shoulder line with it;
   * an uppercut drops both hands to drive off the legs and keeps nothing.
   * This is what makes shot selection a defensive decision: the openings the
   * punches trade away are read by `punchExposure` and cashed by
   * `guardAbsorption`. */
  coverage: number;
}

interface ImpactCandidate {
  attacker: Corner;
  defender: Corner;
  blocked: boolean;
  target: PunchTarget;
  zone: ImpactZone;
  strike: FighterAction;
  impactPoint: { x: number; y: number; z: number };
  trajectory: { x: number; y: number; z: number };
  directness: number;
  powerShot: boolean;
  counter: boolean;
  result: ImpactResult;
}

const PUNCH_SPECS: Partial<Record<FighterAction, PunchSpec>> = {
  jabHead: {
    target: "head",
    duration: 0.3,
    contactPhase: 0.46,
    reachFactor: 0.97,
    velocityFactor: 1.08,
    massFactor: 0.72,
    staminaCost: 1.5,
    rotationalFactor: 1,
    coverage: 0.3,
  },
  crossHead: {
    target: "head",
    duration: 0.4,
    contactPhase: 0.5,
    reachFactor: 1.02,
    velocityFactor: 1.14,
    massFactor: 1,
    staminaCost: 2.4,
    rotationalFactor: 1.08,
    coverage: 0.08,
  },
  hookHead: {
    target: "head",
    duration: 0.44,
    contactPhase: 0.48,
    reachFactor: 0.72,
    velocityFactor: 1.2,
    massFactor: 1.1,
    staminaCost: 2.8,
    rotationalFactor: 1.22,
    coverage: 0.17,
  },
  jabBody: {
    target: "body",
    duration: 0.34,
    contactPhase: 0.48,
    reachFactor: 0.92,
    velocityFactor: 1,
    massFactor: 0.74,
    staminaCost: 1.7,
    rotationalFactor: 0.8,
    coverage: 0.24,
  },
  crossBody: {
    target: "body",
    duration: 0.42,
    contactPhase: 0.5,
    reachFactor: 0.97,
    velocityFactor: 1.08,
    massFactor: 1.02,
    staminaCost: 2.6,
    rotationalFactor: 0.86,
    coverage: 0.07,
  },
  hookBody: {
    target: "body",
    duration: 0.46,
    contactPhase: 0.48,
    reachFactor: 0.68,
    velocityFactor: 1.12,
    massFactor: 1.12,
    staminaCost: 2.9,
    rotationalFactor: 0.9,
    coverage: 0.15,
  },
  // The uppercut: a short, rising power shot up the middle to the chin. It only
  // reaches inside the pocket (short reachFactor) but drives off the legs with a
  // heavy effective mass and strong rotational lift — the classic knockout blow.
  uppercut: {
    target: "head",
    duration: 0.44,
    contactPhase: 0.52,
    reachFactor: 0.6,
    velocityFactor: 1.18,
    massFactor: 1.16,
    staminaCost: 3.0,
    rotationalFactor: 1.18,
    coverage: 0.03,
  },
};

const IMPACT_ZONE_PROPERTIES: Record<
  ImpactZone,
  { vulnerability: number; momentArmMeters: number; bodyShock: number }
> = {
  guard: { vulnerability: 0.08, momentArmMeters: 0, bodyShock: 0.04 },
  jaw: { vulnerability: 1.32, momentArmMeters: 0.068, bodyShock: 0 },
  chin: { vulnerability: 1.38, momentArmMeters: 0.072, bodyShock: 0 },
  nose: { vulnerability: 0.76, momentArmMeters: 0.026, bodyShock: 0 },
  temple: { vulnerability: 1.20, momentArmMeters: 0.058, bodyShock: 0 },
  forehead: { vulnerability: 0.62, momentArmMeters: 0.022, bodyShock: 0 },
  cheek: { vulnerability: 0.90, momentArmMeters: 0.044, bodyShock: 0 },
  chest: { vulnerability: 0.18, momentArmMeters: 0, bodyShock: 0.55 },
  solarPlexus: { vulnerability: 0.22, momentArmMeters: 0, bodyShock: 1.18 },
  ribs: { vulnerability: 0.16, momentArmMeters: 0, bodyShock: 0.88 },
  liver: { vulnerability: 0.20, momentArmMeters: 0, bodyShock: 1.30 },
  abdomen: { vulnerability: 0.15, momentArmMeters: 0, bodyShock: 0.72 },
};

function intendedImpactZone(action: FighterAction): ImpactZone {
  if (action === "jabHead") return "nose";
  if (action === "crossHead") return "chin";
  if (action === "hookHead") return "jaw";
  if (action === "jabBody") return "chest";
  if (action === "crossBody") return "solarPlexus";
  if (action === "hookBody") return "liver";
  if (action === "uppercut") return "chin";
  return "guard";
}

function anatomicalAimOffset(zone: ImpactZone) {
  if (zone === "jaw") return { lateral: -0.055, vertical: -0.055 };
  if (zone === "chin") return { lateral: 0, vertical: -0.072 };
  if (zone === "temple") return { lateral: 0.072, vertical: 0.018 };
  if (zone === "forehead") return { lateral: 0, vertical: 0.07 };
  if (zone === "cheek") return { lateral: -0.045, vertical: 0 };
  if (zone === "chest") return { lateral: 0, vertical: 0.055 };
  if (zone === "solarPlexus") return { lateral: 0, vertical: -0.035 };
  if (zone === "ribs") return { lateral: 0.075, vertical: -0.025 };
  if (zone === "liver") return { lateral: -0.082, vertical: -0.045 };
  if (zone === "abdomen") return { lateral: 0, vertical: -0.065 };
  return { lateral: 0, vertical: 0 };
}

/** How far a punch has pulled its owner's defence apart at this beat, 0..1.
 *
 * Zero while the shot can still be cancelled into a cover — an opening that can
 * be taken back is not an opening, and the commit line here is the same one
 * `defensiveActionInterruptible` draws, so a man reads as exposed exactly when
 * he can no longer defend himself. It ramps to full as the glove commits
 * through contact, stays open across the recoil while the hand is away from
 * home and the shoulder is still turned over, and closes as the hand comes
 * back. The long recoil plateau is what gives a counter its window: at these
 * reaction lags nobody meets a punch at contact — they catch the hand on its
 * way home. */
function punchOpenness(spec: PunchSpec, progress: number) {
  const commitStart = spec.contactPhase - 0.08;
  if (progress <= commitStart || progress >= 1) return 0;
  if (progress < spec.contactPhase) return (progress - commitStart) / 0.08;
  if (progress <= 0.8) return 1;
  return (1 - progress) / 0.2;
}

/** The counter-puncher's read: how open this action leaves its owner right
 * now, 0..1. Nakedness of the shot times depth of the commitment — a committed
 * jab still carries most of a guard and is barely an invitation; a committed
 * uppercut has taken everything with it. Zero for anything that is not a
 * punch. */
export function punchExposure(action: FighterAction, progress: number) {
  const spec = PUNCH_SPECS[action];
  if (!spec) return 0;
  return round((1 - spec.coverage) * punchOpenness(spec, clamp(progress, 0, 1)), 4);
}

/** The same read taken off a live telegraph — a committed punch is gross body
 * position, visible on the early channel the threat read already rides. */
function punchExposureFromRead(read: LivePunchRead) {
  return punchExposure(
    read.action,
    read.actionElapsed / Math.max(0.01, read.actionDuration),
  );
}

const ATTACKS = new Set<FighterAction>(Object.keys(PUNCH_SPECS) as FighterAction[]);
/** The punches that answer a committed punch rather than defend it. */
const COUNTER_ANSWERS = new Set<FighterAction>([
  "crossHead",
  "hookHead",
  "uppercut",
]);
const EVASIONS = new Set<FighterAction>(["slip", "duck", "weave"]);
const DEFENSIVE_REACTIONS = new Set<FighterAction>([
  "guard",
  "retreat",
  "circleLeft",
  "circleRight",
  "slip",
  "duck",
  "weave",
]);
const FOOTWORK = new Set<FighterAction>([
  "advance",
  "retreat",
  "circleLeft",
  "circleRight",
  "pivotLeft",
  "pivotRight",
]);
const CIRCLES = new Set<FighterAction>(["circleLeft", "circleRight"]);
const PIVOTS = new Set<FighterAction>(["pivotLeft", "pivotRight"]);
const RING_MIN = 0.45;
const RING_MAX = BOXING_MODEL.ringLengthMeters - 0.4501;
const RING_DEPTH_MIN = 0.45;
const RING_DEPTH_MAX = BOXING_MODEL.ringDepthMeters - 0.4501;
// The two athletes hold a real boxing pocket rather than collapsing chest to
// chest. At ~0.48 m they sit inside their own straight-punch windows (a jab
// wants distance >= reach*0.62 ≈ 0.58 m), so the trained policies could only
// hook or cover and the hands never visibly extended. Holding ~0.7 m keeps
// them at clean jab/cross range — hips and shoulders rotate, the hand travels
// a readable distance — and a fighter has to step in to get his hooks and
// body work off, which is what gives the exchange its in-and-out rhythm.
//
// It has to stay BELOW the pocket threshold in tacticalPreference, though. Held
// at 0.7 m the two could never physically reach the range their own hooks,
// uppercuts and body shots require, so those six actions recorded literally zero
// uses across a full league season and every fight was jab/cross/guard.
const MIN_BODY_DISTANCE = 0.62;

const FEATURE = {
  distance: 0,
  jabWindow: 1,
  crossWindow: 2,
  hookWindow: 3,
  closing: 4,
  stamina: 5,
  fatigue: 6,
  opponentFatigue: 7,
  balance: 8,
  opponentOffBalance: 9,
  condition: 10,
  opponentHurt: 11,
  opponentPunch: 12,
  opponentGuard: 13,
  scoreBehind: 14,
  ownRope: 15,
  opponentRope: 16,
  targetOpen: 17,
  lateralOffset: 18,
  lateralClosing: 19,
  ownDepthRope: 20,
  opponentDepthRope: 21,
  opponentLowLevel: 22,
  opponentEvasive: 23,
  recentHeadImpact: 24,
  recentBodyImpact: 25,
  sustainedPressure: 26,
  opponentExposure: 27,
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  // The `+ 0` collapses negative zero. Numerically it changes nothing, but JSON
  // writes -0 out as 0, so without it a saved league never strictly matches the
  // one in memory and a policy could not be compared across a save.
  return Math.round(value * factor) / factor + 0;
};

const quantize = (value: number, step: number) =>
  round(Math.round(value / step) * step, 3);

function mutationSignal(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

/** How far a decision may be unsettled when two options score alike.
 *
 * Scores land a point or two apart between genuinely different plans, so this
 * shuffles the coin-flips without ever overruling a shot the boxing brain is
 * sure of. */
const DECISION_JITTER = 1.1;

/** How strongly a fighter tires of his own favourite shot. */
const REPETITION_FATIGUE = 0.9;

/** How far the head drifts off centre when no evasion is being thrown, in
 * metres. A committed slip travels 0.22 m, so this is a fifth of one. */
const RESTING_HEAD_MOVEMENT = 0.045;

/** How much of a full sidestep the feet make during an evasion. A slip moves a
 * man; it does not carry him across the ring the way circling does. */
const EVASION_STEP = 0.38;

/** The idle weight shift of a man standing in front of another man, in strides
 * per second and as a fraction of a travelling stride. Renderer state only — it
 * moves the feet under him, not him. */
const RESTING_GAIT_HZ = 0.85;
const RESTING_STRIDE = 0.22;

/** How hard a fighter steps off while resetting. Well short of a retreat — he is
 * buying air, not running, and he still has to be catchable. */
const RESET_STEP = 0.55;

/** A stable draw in [0, 1) from whatever the caller mixes in.
 *
 * Every bout has to replay identically from its seed on every viewer's machine,
 * so a fighter can never actually roll a die. This is a hash of the state that
 * produced the choice instead: the same man, in the same place, on the same
 * decision, always draws the same number. Feeding it the situation as well as
 * the counter is what stops a fighter cycling through his options in a fixed
 * order no matter what is in front of him. */
function decisionNoise(...parts: number[]) {
  let accumulated = 0.137;
  for (const part of parts) {
    const mixed = Math.sin((accumulated + part) * 12.9898 + 78.233) * 43758.5453;
    accumulated = mixed - Math.floor(mixed);
  }
  return accumulated;
}

function emptyRoundMetrics(): RoundMetrics {
  return {
    cleanBlows: 0,
    impactEnergy: 0,
    defense: 0,
    control: 0,
    knockdowns: 0,
  };
}

function emptyActionCounts(): Record<FighterAction, number> {
  return Object.fromEntries(ACTIONS.map((action) => [action, 0])) as Record<
    FighterAction,
    number
  >;
}

function initialConditioning(stats: FighterStats): ConditioningProfile {
  return {
    lowerBodyPower: round(clamp(stats.power * 0.58 + stats.speed * 0.42, 55, 98), 1),
    lowerBodyEndurance: round(clamp(stats.cardio * 0.82 + stats.defense * 0.18, 55, 98), 1),
    kineticChain: round(clamp(stats.ringIq * 0.5 + stats.speed * 0.3 + stats.power * 0.2, 55, 98), 1),
    shoulderEndurance: round(clamp(stats.cardio * 0.62 + stats.speed * 0.38, 55, 98), 1),
    workloadSteps: 0,
    adaptationCycles: 0,
  };
}

function initialArticulatedBody(weightPounds = 160): ArticulatedBodyState {
  const bodyWeightN = weightPounds * 0.453592 * 9.81;
  return {
    leadFootOffset: 0.18,
    rearFootOffset: -0.18,
    leadKneeFlexion: 18,
    rearKneeFlexion: 20,
    hipRotation: 0,
    shoulderRotation: 0,
    centerOfMassHeight: 0.94,
    leadGroundForceN: round(bodyWeightN * 0.52),
    rearGroundForceN: round(bodyWeightN * 0.48),
    resultantGroundForceN: round(bodyWeightN),
    forwardGroundForceN: 0,
    lateralGroundForceN: 0,
    previousGroundForceN: round(bodyWeightN),
    rateOfForceDevelopment: 0,
    kineticChainEfficiency: 0.72,
    gaitPhase: 0,
    plantedFoot: "both",
  };
}

function defaultStrategyDirective(
  issuedRound: number,
  source: StrategyDirective["source"] = "opening",
): StrategyDirective {
  return {
    focus: "outside",
    pace: 0,
    risk: 0,
    target: "mixed",
    ringMode: "center",
    confidence: 50,
    note: "Establish range and collect clean reads before increasing risk.",
    source,
    issuedRound,
  };
}

/** Learning rates, kept small on purpose.
 *
 * The bout update is applied unguarded — nothing re-runs the fight to check it
 * helped — so it has to be small enough that a single bad night cannot undo a
 * career. The sparring rate is larger because `trainAthlete` evaluates the
 * result and throws it away if it scored worse. */
const LEARNING = {
  boutRate: 0.012,
  sparringRate: 0.05,
  discount: 0.94,
  // Update size ceiling, applied to the whole gradient at once.
  maxUpdateNorm: 1.4,
  weightLimit: 4,
} as const;

function setPolicyWeight(
  policy: PolicyModel,
  action: FighterAction,
  feature: number,
  value: number,
) {
  policy.weights[ACTIONS.indexOf(action)][feature] = value;
}

function setIntentActionWeight(
  policy: PolicyModel,
  intent: TacticalIntent,
  action: FighterAction,
  value: number,
) {
  policy.intentActionWeights[ACTIONS.indexOf(action)][
    TACTICAL_INTENTS.indexOf(intent)
  ] = value;
}

function createInitialPolicy(fighter: {
  seed: number;
  archetype: string;
  stats: FighterStats;
}): PolicyModel {
  const policy: PolicyModel = {
    architecture: "recurrent-28x16x8x6x18",
    weights: ACTIONS.map(() => Array(BOXING_MODEL.observationFeatures).fill(0)),
    bias: ACTIONS.map(() => -0.2),
    hiddenWeights: Array.from(
      { length: BOXING_MODEL.neuralHiddenUnits },
      (_, hiddenIndex) =>
        Array.from(
          { length: BOXING_MODEL.observationFeatures },
          (_, featureIndex) =>
            round(
              mutationSignal(
                fighter.seed * 211 + hiddenIndex * 31 + featureIndex * 13,
              ) * 0.12,
              4,
            ),
        ),
    ),
    hiddenBias: Array.from(
      { length: BOXING_MODEL.neuralHiddenUnits },
      (_, hiddenIndex) =>
        round(mutationSignal(fighter.seed * 223 + hiddenIndex * 37) * 0.08, 4),
    ),
    recurrentHiddenWeights: Array.from(
      { length: BOXING_MODEL.neuralHiddenUnits },
      (_, hiddenIndex) =>
        Array.from(
          { length: BOXING_MODEL.recurrentUnits },
          (_, memoryIndex) =>
            round(
              mutationSignal(
                fighter.seed * 225 + hiddenIndex * 41 + memoryIndex * 19,
              ) * 0.08,
              4,
            ),
        ),
    ),
    memoryInputWeights: Array.from(
      { length: BOXING_MODEL.recurrentUnits },
      (_, memoryIndex) =>
        Array.from(
          { length: BOXING_MODEL.neuralHiddenUnits },
          (_, hiddenIndex) =>
            round(
              mutationSignal(
                fighter.seed * 226 + memoryIndex * 43 + hiddenIndex * 23,
              ) * 0.1,
              4,
            ),
        ),
    ),
    memoryWeights: Array.from(
      { length: BOXING_MODEL.recurrentUnits },
      (_, memoryIndex) =>
        Array.from(
          { length: BOXING_MODEL.recurrentUnits },
          (_, previousIndex) =>
            round(
              (memoryIndex === previousIndex ? 0.36 : 0) +
                mutationSignal(
                  fighter.seed * 228 + memoryIndex * 47 + previousIndex * 29,
                ) * 0.06,
              4,
            ),
        ),
    ),
    memoryBias: Array.from(
      { length: BOXING_MODEL.recurrentUnits },
      (_, memoryIndex) =>
        round(mutationSignal(fighter.seed * 224 + memoryIndex * 31) * 0.04, 4),
    ),
    intentWeights: TACTICAL_INTENTS.map((_, intentIndex) =>
      Array.from(
        { length: BOXING_MODEL.neuralHiddenUnits },
        (_, hiddenIndex) =>
          round(
            mutationSignal(
              fighter.seed * 227 + intentIndex * 41 + hiddenIndex * 17,
            ) * 0.12,
            4,
          ),
      ),
    ),
    intentMemoryWeights: TACTICAL_INTENTS.map((_, intentIndex) =>
      Array.from(
        { length: BOXING_MODEL.recurrentUnits },
        (_, memoryIndex) =>
          round(
            mutationSignal(
              fighter.seed * 231 + intentIndex * 47 + memoryIndex * 31,
            ) * 0.08,
            4,
          ),
      ),
    ),
    intentBias: TACTICAL_INTENTS.map(() => 0),
    outputWeights: ACTIONS.map((_, actionIndex) =>
      Array.from(
        { length: BOXING_MODEL.neuralHiddenUnits },
        (_, hiddenIndex) =>
          round(
            mutationSignal(
              fighter.seed * 229 + actionIndex * 43 + hiddenIndex * 19,
            ) * 0.08,
            4,
          ),
      ),
    ),
    outputMemoryWeights: ACTIONS.map((_, actionIndex) =>
      Array.from(
        { length: BOXING_MODEL.recurrentUnits },
        (_, memoryIndex) =>
          round(
            mutationSignal(
              fighter.seed * 233 + actionIndex * 53 + memoryIndex * 37,
            ) * 0.07,
            4,
          ),
      ),
    ),
    intentActionWeights: ACTIONS.map(() =>
      TACTICAL_INTENTS.map(() => 0),
    ),
    generation: 0,
    evaluatedBouts: 0,
    learnedDecisions: 0,
    fitness: 0,
  };
  policy.bias[ACTIONS.indexOf("guard")] = 0.55;
  policy.bias[ACTIONS.indexOf("slip")] = -0.05;
  policy.bias[ACTIONS.indexOf("duck")] = 0.04;
  policy.bias[ACTIONS.indexOf("weave")] = -0.04;
  policy.bias[ACTIONS.indexOf("circleLeft")] = 0.16;
  policy.bias[ACTIONS.indexOf("circleRight")] = 0.16;

  setIntentActionWeight(policy, "pressure", "advance", 0.75);
  setIntentActionWeight(policy, "pressure", "pivotLeft", 0.35);
  setIntentActionWeight(policy, "pressure", "pivotRight", 0.35);
  setIntentActionWeight(policy, "pressure", "crossHead", 0.35);
  setIntentActionWeight(policy, "pressure", "hookHead", 0.45);
  setIntentActionWeight(policy, "pressure", "hookBody", 0.5);
  setIntentActionWeight(policy, "counter", "retreat", 0.3);
  setIntentActionWeight(policy, "counter", "slip", 0.75);
  setIntentActionWeight(policy, "counter", "weave", 0.55);
  setIntentActionWeight(policy, "counter", "crossHead", 0.5);
  setIntentActionWeight(policy, "bodyWork", "jabBody", 0.45);
  setIntentActionWeight(policy, "bodyWork", "crossBody", 0.7);
  setIntentActionWeight(policy, "bodyWork", "hookBody", 0.75);
  setIntentActionWeight(policy, "outside", "jabHead", 0.65);
  setIntentActionWeight(policy, "outside", "retreat", 0.45);
  setIntentActionWeight(policy, "outside", "advance", 0.2);
  setIntentActionWeight(policy, "outside", "circleLeft", 1.05);
  setIntentActionWeight(policy, "outside", "circleRight", 1.05);
  setIntentActionWeight(policy, "recover", "guard", 0.8);
  setIntentActionWeight(policy, "recover", "recover", 0.85);
  setIntentActionWeight(policy, "recover", "retreat", 0.35);
  setIntentActionWeight(policy, "recover", "duck", 0.3);
  setIntentActionWeight(policy, "evasive", "slip", 0.75);
  setIntentActionWeight(policy, "evasive", "duck", 0.72);
  setIntentActionWeight(policy, "evasive", "weave", 0.82);
  setIntentActionWeight(policy, "evasive", "circleLeft", 0.6);
  setIntentActionWeight(policy, "evasive", "circleRight", 0.6);
  setIntentActionWeight(policy, "evasive", "pivotLeft", 0.55);
  setIntentActionWeight(policy, "evasive", "pivotRight", 0.55);

  setPolicyWeight(policy, "advance", FEATURE.distance, 2.8);
  setPolicyWeight(policy, "advance", FEATURE.opponentRope, 0.8);
  setPolicyWeight(policy, "advance", FEATURE.ownRope, 1.2);
  setPolicyWeight(policy, "retreat", FEATURE.opponentPunch, 2.2);
  setPolicyWeight(policy, "retreat", FEATURE.ownRope, -3.2);
  setPolicyWeight(policy, "retreat", FEATURE.closing, 0.9);
  setPolicyWeight(policy, "circleLeft", FEATURE.opponentPunch, 4.75);
  setPolicyWeight(policy, "circleLeft", FEATURE.distance, 1.15);
  setPolicyWeight(policy, "circleLeft", FEATURE.ownRope, 2.7);
  setPolicyWeight(policy, "circleLeft", FEATURE.ownDepthRope, -2.8);
  setPolicyWeight(policy, "circleRight", FEATURE.opponentPunch, 4.75);
  setPolicyWeight(policy, "circleRight", FEATURE.distance, 1.15);
  setPolicyWeight(policy, "circleRight", FEATURE.ownRope, 2.7);
  setPolicyWeight(policy, "circleRight", FEATURE.ownDepthRope, -2.8);
  setPolicyWeight(policy, "pivotLeft", FEATURE.hookWindow, 1.7);
  setPolicyWeight(policy, "pivotLeft", FEATURE.opponentPunch, 1.25);
  setPolicyWeight(policy, "pivotLeft", FEATURE.opponentOffBalance, 0.75);
  setPolicyWeight(policy, "pivotRight", FEATURE.hookWindow, 1.7);
  setPolicyWeight(policy, "pivotRight", FEATURE.opponentPunch, 1.25);
  setPolicyWeight(policy, "pivotRight", FEATURE.opponentOffBalance, 0.75);
  setPolicyWeight(policy, "jabHead", FEATURE.jabWindow, 3.4);
  setPolicyWeight(policy, "jabHead", FEATURE.targetOpen, 0.9);
  setPolicyWeight(policy, "jabHead", FEATURE.stamina, 0.5);
  setPolicyWeight(policy, "crossHead", FEATURE.crossWindow, 3.0);
  setPolicyWeight(policy, "crossHead", FEATURE.opponentHurt, 1.7);
  setPolicyWeight(policy, "crossHead", FEATURE.opponentOffBalance, 1.1);
  setPolicyWeight(policy, "hookHead", FEATURE.hookWindow, 2.55);
  setPolicyWeight(policy, "hookHead", FEATURE.opponentGuard, -0.8);
  setPolicyWeight(policy, "hookHead", FEATURE.opponentHurt, 1.2);
  setPolicyWeight(policy, "jabBody", FEATURE.jabWindow, 2.05);
  setPolicyWeight(policy, "jabBody", FEATURE.opponentGuard, 1.1);
  setPolicyWeight(policy, "crossBody", FEATURE.crossWindow, 2.15);
  setPolicyWeight(policy, "crossBody", FEATURE.opponentGuard, 1.3);
  setPolicyWeight(policy, "hookBody", FEATURE.hookWindow, 2.4);
  setPolicyWeight(policy, "hookBody", FEATURE.opponentGuard, 1.4);
  // The guard is a REACTION to an incoming punch, not a resting state. Its old
  // weights were four to five times any offensive pathway, and three of them
  // (recent impact, sustained pressure) climb as a fight gets busier — so the
  // more action there was, the more both men simply covered up, and the bout
  // stalled into a mutual staring contest. Keep it responsive to a live punch,
  // below the head-movement options, and stop accumulated pressure from pinning
  // a fighter behind his gloves for the rest of the round.
  setPolicyWeight(policy, "guard", FEATURE.opponentPunch, 2.8);
  setPolicyWeight(policy, "guard", FEATURE.fatigue, 0.7);
  setPolicyWeight(policy, "guard", FEATURE.recentHeadImpact, 2.0);
  setPolicyWeight(policy, "guard", FEATURE.recentBodyImpact, 1.5);
  setPolicyWeight(policy, "guard", FEATURE.sustainedPressure, 1.8);
  setPolicyWeight(policy, "slip", FEATURE.opponentPunch, 5.45);
  setPolicyWeight(policy, "slip", FEATURE.balance, 0.8);
  setPolicyWeight(policy, "duck", FEATURE.opponentPunch, 5.85);
  setPolicyWeight(policy, "duck", FEATURE.balance, 0.65);
  setPolicyWeight(policy, "weave", FEATURE.opponentPunch, 5.72);
  setPolicyWeight(policy, "weave", FEATURE.lateralOffset, 0.8);
  setPolicyWeight(policy, "weave", FEATURE.balance, 0.75);
  setPolicyWeight(policy, "recover", FEATURE.fatigue, 4.1);
  setPolicyWeight(policy, "recover", FEATURE.distance, 1.2);
  setPolicyWeight(policy, "recover", FEATURE.opponentPunch, -3.6);
  setPolicyWeight(policy, "recover", FEATURE.recentHeadImpact, 1.3);
  setPolicyWeight(policy, "recover", FEATURE.recentBodyImpact, 1.8);
  setPolicyWeight(policy, "recover", FEATURE.sustainedPressure, -3.2);
  setPolicyWeight(policy, "retreat", FEATURE.fatigue, 2.1);
  setPolicyWeight(policy, "retreat", FEATURE.recentHeadImpact, 5.2);
  setPolicyWeight(policy, "retreat", FEATURE.recentBodyImpact, 3.4);
  setPolicyWeight(policy, "retreat", FEATURE.sustainedPressure, 4.8);
  setPolicyWeight(policy, "circleLeft", FEATURE.sustainedPressure, 2.4);
  setPolicyWeight(policy, "circleRight", FEATURE.sustainedPressure, 2.4);
  setPolicyWeight(policy, "advance", FEATURE.recentHeadImpact, -3.8);
  setPolicyWeight(policy, "advance", FEATURE.recentBodyImpact, -2.6);
  setPolicyWeight(policy, "advance", FEATURE.sustainedPressure, -3.2);

  for (const action of Object.keys(PUNCH_SPECS) as FighterAction[]) {
    setPolicyWeight(policy, action, FEATURE.opponentPunch, -1.35);
    setPolicyWeight(policy, action, FEATURE.fatigue, -1.25);
    setPolicyWeight(policy, action, FEATURE.recentHeadImpact, -3.2);
    setPolicyWeight(policy, action, FEATURE.recentBodyImpact, -2.2);
    setPolicyWeight(policy, action, FEATURE.sustainedPressure, -3.6);
  }

  // The counter read arrives with a prior rather than at zero: a committed,
  // naked punch invites the power answer, and the blanket opponentPunch
  // caution above should lose that argument exactly when the opening is real.
  // The save path backfills these same values onto a veteran's matrix, so
  // nobody has to rediscover from a blank column that an extended hook is
  // there to be countered.
  setPolicyWeight(policy, "crossHead", FEATURE.opponentExposure, 1.7);
  setPolicyWeight(policy, "hookHead", FEATURE.opponentExposure, 1.1);
  setPolicyWeight(policy, "uppercut", FEATURE.opponentExposure, 1.3);

  const style = fighter.archetype.toLowerCase();
  if (style.includes("counter")) {
    policy.bias[ACTIONS.indexOf("slip")] += 0.55;
    policy.bias[ACTIONS.indexOf("jabHead")] += 0.25;
    policy.intentBias[TACTICAL_INTENTS.indexOf("counter")] += 0.65;
  }
  if (style.includes("pressure")) {
    policy.bias[ACTIONS.indexOf("advance")] += 0.7;
    policy.bias[ACTIONS.indexOf("hookBody")] += 0.4;
    policy.intentBias[TACTICAL_INTENTS.indexOf("pressure")] += 0.65;
  }
  if (style.includes("outfighter") || style.includes("volume")) {
    policy.bias[ACTIONS.indexOf("jabHead")] += 0.55;
    policy.bias[ACTIONS.indexOf("retreat")] += 0.2;
    policy.intentBias[TACTICAL_INTENTS.indexOf("outside")] += 0.55;
  }
  if (style.includes("body")) {
    policy.bias[ACTIONS.indexOf("crossBody")] += 0.55;
    policy.bias[ACTIONS.indexOf("hookBody")] += 0.55;
    policy.intentBias[TACTICAL_INTENTS.indexOf("bodyWork")] += 0.7;
  }
  if (style.includes("explosive")) {
    policy.bias[ACTIONS.indexOf("crossHead")] += 0.5;
    policy.bias[ACTIONS.indexOf("hookHead")] += 0.45;
    policy.intentBias[TACTICAL_INTENTS.indexOf("pressure")] += 0.35;
  }

  policy.weights.forEach((row, actionIndex) => {
    row.forEach((value, featureIndex) => {
      row[featureIndex] = round(
        value + mutationSignal(fighter.seed * 101 + actionIndex * 29 + featureIndex * 7) * 0.045,
        4,
      );
    });
  });

  return policy;
}

function createFighter(
  fighter: Omit<
    Fighter,
    | "rating"
    | "level"
    | "xp"
    | "confidence"
    | "trainingBouts"
    | "lastTrainingGain"
    | "record"
    | "policy"
    | "opponentDossiers"
    | "conditioning"
  > & {
    rating: number;
    record: Partial<FighterRecord>;
  },
): Fighter {
  const base = {
    ...fighter,
    // A debuting athlete's level is read off the career they arrive with, so the
    // seeded roster does not all start at 1 with a 9-4 record.
    level: 1 + Math.floor(((fighter.record.wins ?? 0) * 2 + (fighter.record.knockouts ?? 0)) / 4),
    xp: 0,
    confidence: 68,
    trainingBouts: 0,
    lastTrainingGain: 0,
    record: {
      wins: fighter.record.wins ?? 0,
      losses: fighter.record.losses ?? 0,
      draws: fighter.record.draws ?? 0,
      knockouts: fighter.record.knockouts ?? 0,
    },
  };

  return {
    ...base,
    policy: createInitialPolicy(base),
    opponentDossiers: {},
    conditioning: initialConditioning(base.stats),
  };
}

export function createInitialLeague(): LeagueState {
  return {
    version: 10,
    season: 1,
    week: 1,
    boutsCompleted: 0,
    roster: [
      // Featherweight — fast hands, high output, power that has to be earned.
      createFighter({
        id: "kaito-mori",
        seed: 101,
        firstName: "Kaito",
        lastName: "Mori",
        nickname: "Whisper",
        hometown: "Osaka, JP",
        stance: "Orthodox",
        archetype: "Reactive counter-puncher",
        weightClass: "featherweight",
        age: 22,
        height: 65,
        weight: 126,
        reach: 67,
        rating: 85,
        record: { wins: 9, losses: 1, knockouts: 3 },
        stats: { power: 66, speed: 96, cardio: 88, defense: 90, ringIq: 91, reaction: 95 },
      }),
      createFighter({
        id: "emilio-vargas",
        seed: 103,
        firstName: "Emilio",
        lastName: "Vargas",
        nickname: "Relámpago",
        hometown: "Guadalajara, MX",
        stance: "Orthodox",
        archetype: "Volume technician",
        weightClass: "featherweight",
        age: 25,
        height: 66,
        weight: 126,
        reach: 68,
        rating: 83,
        record: { wins: 11, losses: 2, knockouts: 4 },
        stats: { power: 70, speed: 93, cardio: 95, defense: 79, ringIq: 86, reaction: 88 },
      }),
      createFighter({
        id: "yusuf-adeyemi",
        seed: 107,
        firstName: "Yusuf",
        lastName: "Adeyemi",
        nickname: "The Metronome",
        hometown: "Lagos, NG",
        stance: "Orthodox",
        archetype: "Patient body hunter",
        weightClass: "featherweight",
        age: 24,
        height: 67,
        weight: 125,
        reach: 69,
        rating: 81,
        record: { wins: 8, losses: 2, draws: 1, knockouts: 2 },
        stats: { power: 74, speed: 84, cardio: 92, defense: 85, ringIq: 88, reaction: 80 },
      }),
      createFighter({
        id: "danny-boyle",
        seed: 109,
        firstName: "Danny",
        lastName: "Boyle",
        nickname: "Pocket Rocket",
        hometown: "Liverpool, UK",
        stance: "Southpaw",
        archetype: "Pressure infighter",
        weightClass: "featherweight",
        age: 27,
        height: 63,
        weight: 126,
        reach: 64,
        rating: 79,
        record: { wins: 12, losses: 4, knockouts: 8 },
        stats: { power: 83, speed: 86, cardio: 93, defense: 70, ringIq: 76, reaction: 78 },
      }),
      createFighter({
        id: "tae-hyun-park",
        seed: 113,
        firstName: "Tae-hyun",
        lastName: "Park",
        nickname: "Scalpel",
        hometown: "Busan, KR",
        stance: "Southpaw",
        archetype: "Angle-heavy outfighter",
        weightClass: "featherweight",
        age: 23,
        height: 66,
        weight: 124,
        reach: 68,
        rating: 82,
        record: { wins: 7, losses: 1, knockouts: 2 },
        stats: { power: 68, speed: 95, cardio: 86, defense: 86, ringIq: 90, reaction: 93 },
      }),
      createFighter({
        id: "marco-feliciano",
        seed: 127,
        firstName: "Marco",
        lastName: "Feliciano",
        nickname: "Sugarcane",
        hometown: "Havana, CU",
        stance: "Orthodox",
        archetype: "Volume technician",
        weightClass: "featherweight",
        age: 26,
        height: 65,
        weight: 126,
        reach: 67,
        rating: 78,
        record: { wins: 10, losses: 3, draws: 1, knockouts: 3 },
        stats: { power: 69, speed: 88, cardio: 90, defense: 78, ringIq: 84, reaction: 83 },
      }),
      createFighter({
        id: "oscar-nunez",
        seed: 131,
        firstName: "Oscar",
        lastName: "Nuñez",
        nickname: "El Gato",
        hometown: "Bogotá, CO",
        stance: "Southpaw",
        archetype: "Evasive stylist",
        weightClass: "featherweight",
        age: 21,
        height: 64,
        weight: 125,
        reach: 66,
        rating: 76,
        record: { wins: 5, losses: 1, knockouts: 1 },
        stats: { power: 62, speed: 92, cardio: 84, defense: 89, ringIq: 80, reaction: 91 },
      }),
      createFighter({
        id: "ibrahim-diallo",
        seed: 137,
        firstName: "Ibrahim",
        lastName: "Diallo",
        nickname: "Longshot",
        hometown: "Dakar, SN",
        stance: "Orthodox",
        archetype: "Angle-heavy outfighter",
        weightClass: "featherweight",
        age: 25,
        height: 68,
        weight: 126,
        reach: 70,
        rating: 80,
        record: { wins: 9, losses: 3, knockouts: 4 },
        stats: { power: 72, speed: 85, cardio: 87, defense: 83, ringIq: 87, reaction: 82 },
      }),
      createFighter({
        id: "rico-salvatore",
        seed: 139,
        firstName: "Rico",
        lastName: "Salvatore",
        nickname: "Tempo",
        hometown: "Naples, IT",
        stance: "Orthodox",
        archetype: "Patient body hunter",
        weightClass: "featherweight",
        age: 28,
        height: 65,
        weight: 126,
        reach: 66,
        rating: 74,
        record: { wins: 11, losses: 6, draws: 1, knockouts: 5 },
        stats: { power: 76, speed: 79, cardio: 85, defense: 81, ringIq: 83, reaction: 75 },
      }),
      createFighter({
        id: "jae-won-sohn",
        seed: 149,
        firstName: "Jae-won",
        lastName: "Sohn",
        nickname: "Nine Volt",
        hometown: "Incheon, KR",
        stance: "Orthodox",
        archetype: "Explosive puncher",
        weightClass: "featherweight",
        age: 24,
        height: 64,
        weight: 125,
        reach: 65,
        rating: 77,
        record: { wins: 8, losses: 4, knockouts: 7 },
        stats: { power: 90, speed: 83, cardio: 74, defense: 70, ringIq: 75, reaction: 84 },
      }),
      createFighter({
        id: "ruben-castellanos",
        seed: 229,
        firstName: "Rubén",
        lastName: "Castellanos",
        nickname: "Tin Roof",
        hometown: "Cienfuegos, CU",
        stance: "Southpaw",
        archetype: "Defensive technician",
        weightClass: "featherweight",
        age: 26,
        height: 66,
        weight: 125,
        reach: 68,
        rating: 79,
        record: { wins: 11, losses: 3, knockouts: 4 },
        stats: { power: 63, speed: 88, cardio: 90, defense: 91, ringIq: 86, reaction: 87 },
      }),
      createFighter({
        id: "otto-lindqvist",
        seed: 233,
        firstName: "Otto",
        lastName: "Lindqvist",
        nickname: "Cutaway",
        hometown: "Malmö, SE",
        stance: "Orthodox",
        archetype: "Evasive stylist",
        weightClass: "featherweight",
        age: 22,
        height: 67,
        weight: 126,
        reach: 69,
        rating: 75,
        record: { wins: 7, losses: 2, knockouts: 2 },
        stats: { power: 61, speed: 91, cardio: 83, defense: 87, ringIq: 78, reaction: 89 },
      }),

      // Middleweight — the division the league was founded on.
      createFighter({
        id: "malik-okoro",
        seed: 17,
        firstName: "Malik",
        lastName: "Okoro",
        nickname: "Static",
        hometown: "Oakland, CA",
        stance: "Southpaw",
        archetype: "Reactive counter-puncher",
        weightClass: "middleweight",
        age: 24,
        height: 71,
        weight: 160,
        reach: 74,
        rating: 86,
        record: { wins: 7, losses: 1, knockouts: 3 },
        stats: { power: 78, speed: 91, cardio: 84, defense: 88, ringIq: 92, reaction: 94 },
      }),
      createFighter({
        id: "jonah-vale",
        seed: 29,
        firstName: "Jonah",
        lastName: "Vale",
        nickname: "The Press",
        hometown: "Detroit, MI",
        stance: "Orthodox",
        archetype: "Pressure infighter",
        weightClass: "middleweight",
        age: 27,
        height: 69,
        weight: 159,
        reach: 71,
        rating: 84,
        record: { wins: 8, losses: 2, knockouts: 6 },
        stats: { power: 91, speed: 78, cardio: 90, defense: 72, ringIq: 81, reaction: 76 },
      }),
      createFighter({
        id: "mateo-silva",
        seed: 43,
        firstName: "Mateo",
        lastName: "Silva",
        nickname: "Switch",
        hometown: "San Juan, PR",
        stance: "Southpaw",
        archetype: "Angle-heavy outfighter",
        weightClass: "middleweight",
        age: 22,
        height: 72,
        weight: 158,
        reach: 76,
        rating: 82,
        record: { wins: 6, losses: 1, draws: 1, knockouts: 2 },
        stats: { power: 72, speed: 94, cardio: 86, defense: 83, ringIq: 87, reaction: 90 },
      }),
      createFighter({
        id: "darius-cole",
        seed: 61,
        firstName: "Darius",
        lastName: "Cole",
        nickname: "Anchor",
        hometown: "Baltimore, MD",
        stance: "Orthodox",
        archetype: "Patient body hunter",
        weightClass: "middleweight",
        age: 29,
        height: 70,
        weight: 160,
        reach: 72,
        rating: 80,
        record: { wins: 9, losses: 4, knockouts: 5 },
        stats: { power: 87, speed: 70, cardio: 82, defense: 86, ringIq: 88, reaction: 74 },
      }),
      createFighter({
        id: "ren-ito",
        seed: 73,
        firstName: "Ren",
        lastName: "Ito",
        nickname: "Needle",
        hometown: "Seattle, WA",
        stance: "Orthodox",
        archetype: "Volume technician",
        weightClass: "middleweight",
        age: 23,
        height: 70,
        weight: 157,
        reach: 73,
        rating: 79,
        record: { wins: 5, losses: 2, knockouts: 1 },
        stats: { power: 68, speed: 89, cardio: 93, defense: 80, ringIq: 90, reaction: 87 },
      }),
      createFighter({
        id: "andre-bishop",
        seed: 89,
        firstName: "Andre",
        lastName: "Bishop",
        nickname: "Heavy Weather",
        hometown: "Newark, NJ",
        stance: "Orthodox",
        archetype: "Explosive puncher",
        weightClass: "middleweight",
        age: 26,
        height: 68,
        weight: 160,
        reach: 70,
        rating: 77,
        record: { wins: 7, losses: 4, knockouts: 7 },
        stats: { power: 97, speed: 74, cardio: 69, defense: 67, ringIq: 73, reaction: 79 },
      }),
      createFighter({
        id: "viktor-zeman",
        seed: 151,
        firstName: "Viktor",
        lastName: "Zeman",
        nickname: "The Wall",
        hometown: "Ostrava, CZ",
        stance: "Orthodox",
        archetype: "Defensive technician",
        weightClass: "middleweight",
        age: 30,
        height: 71,
        weight: 160,
        reach: 73,
        rating: 78,
        record: { wins: 10, losses: 3, draws: 2, knockouts: 2 },
        stats: { power: 75, speed: 71, cardio: 84, defense: 93, ringIq: 86, reaction: 80 },
      }),
      createFighter({
        id: "tobias-kane",
        seed: 157,
        firstName: "Tobias",
        lastName: "Kane",
        nickname: "Ledger",
        hometown: "Toronto, CA",
        stance: "Southpaw",
        archetype: "Angle-heavy outfighter",
        weightClass: "middleweight",
        age: 25,
        height: 70,
        weight: 159,
        reach: 74,
        rating: 81,
        record: { wins: 7, losses: 2, knockouts: 3 },
        stats: { power: 76, speed: 87, cardio: 85, defense: 84, ringIq: 89, reaction: 86 },
      }),
      createFighter({
        id: "samir-haddad",
        seed: 163,
        firstName: "Samir",
        lastName: "Haddad",
        nickname: "Compass",
        hometown: "Beirut, LB",
        stance: "Orthodox",
        archetype: "Volume technician",
        weightClass: "middleweight",
        age: 26,
        height: 71,
        weight: 160,
        reach: 72,
        rating: 76,
        record: { wins: 8, losses: 4, draws: 1, knockouts: 2 },
        stats: { power: 71, speed: 83, cardio: 89, defense: 79, ringIq: 85, reaction: 81 },
      }),
      createFighter({
        id: "elias-thorne",
        seed: 167,
        firstName: "Elias",
        lastName: "Thorne",
        nickname: "Nightshift",
        hometown: "Glasgow, UK",
        stance: "Southpaw",
        archetype: "Explosive puncher",
        weightClass: "middleweight",
        age: 28,
        height: 72,
        weight: 160,
        reach: 75,
        rating: 79,
        record: { wins: 9, losses: 5, knockouts: 8 },
        stats: { power: 93, speed: 76, cardio: 72, defense: 74, ringIq: 78, reaction: 80 },
      }),
      createFighter({
        id: "dario-fontana",
        seed: 239,
        firstName: "Dario",
        lastName: "Fontana",
        nickname: "Brickwork",
        hometown: "Trieste, IT",
        stance: "Southpaw",
        archetype: "Pressure infighter",
        weightClass: "middleweight",
        age: 28,
        height: 69,
        weight: 160,
        reach: 71,
        rating: 80,
        record: { wins: 13, losses: 4, knockouts: 9 },
        stats: { power: 87, speed: 79, cardio: 88, defense: 72, ringIq: 80, reaction: 76 },
      }),
      createFighter({
        id: "solomon-bright",
        seed: 241,
        firstName: "Solomon",
        lastName: "Bright",
        nickname: "Quiet Hands",
        hometown: "Memphis, TN",
        stance: "Orthodox",
        archetype: "Reactive counter-puncher",
        weightClass: "middleweight",
        age: 24,
        height: 72,
        weight: 159,
        reach: 75,
        rating: 83,
        record: { wins: 10, losses: 1, knockouts: 5 },
        stats: { power: 71, speed: 89, cardio: 85, defense: 88, ringIq: 89, reaction: 91 },
      }),

      // Heavyweight — real mass behind every shot, and the physics feels it.
      createFighter({
        id: "ivan-brackett",
        seed: 173,
        firstName: "Ivan",
        lastName: "Brackett",
        nickname: "The Foundry",
        hometown: "Pittsburgh, PA",
        stance: "Orthodox",
        archetype: "Patient body hunter",
        weightClass: "heavyweight",
        age: 29,
        height: 77,
        weight: 245,
        reach: 81,
        rating: 86,
        record: { wins: 13, losses: 1, knockouts: 11 },
        stats: { power: 95, speed: 72, cardio: 80, defense: 87, ringIq: 89, reaction: 78 },
      }),
      createFighter({
        id: "nnamdi-obi",
        seed: 179,
        firstName: "Nnamdi",
        lastName: "Obi",
        nickname: "Thunderhead",
        hometown: "Port Harcourt, NG",
        stance: "Orthodox",
        archetype: "Explosive puncher",
        weightClass: "heavyweight",
        age: 27,
        height: 78,
        weight: 250,
        reach: 83,
        rating: 84,
        record: { wins: 12, losses: 2, knockouts: 12 },
        stats: { power: 99, speed: 70, cardio: 73, defense: 76, ringIq: 80, reaction: 77 },
      }),
      createFighter({
        id: "grigor-pavlenko",
        seed: 181,
        firstName: "Grigor",
        lastName: "Pavlenko",
        nickname: "Iron Sunday",
        hometown: "Kharkiv, UA",
        stance: "Southpaw",
        archetype: "Pressure infighter",
        weightClass: "heavyweight",
        age: 31,
        height: 76,
        weight: 238,
        reach: 79,
        rating: 82,
        record: { wins: 15, losses: 4, draws: 1, knockouts: 10 },
        stats: { power: 92, speed: 74, cardio: 85, defense: 75, ringIq: 83, reaction: 73 },
      }),
      createFighter({
        id: "wesley-duke",
        seed: 191,
        firstName: "Wesley",
        lastName: "Duke",
        nickname: "Coldwater",
        hometown: "Houston, TX",
        stance: "Orthodox",
        archetype: "Reactive counter-puncher",
        weightClass: "heavyweight",
        age: 26,
        height: 75,
        weight: 228,
        reach: 78,
        rating: 80,
        record: { wins: 9, losses: 2, knockouts: 5 },
        stats: { power: 84, speed: 81, cardio: 82, defense: 85, ringIq: 84, reaction: 86 },
      }),
      createFighter({
        id: "tomas-kovac",
        seed: 193,
        firstName: "Tomas",
        lastName: "Kovac",
        nickname: "The Anvil",
        hometown: "Bratislava, SK",
        stance: "Orthodox",
        archetype: "Defensive technician",
        weightClass: "heavyweight",
        age: 33,
        height: 74,
        weight: 250,
        reach: 76,
        rating: 77,
        record: { wins: 14, losses: 6, draws: 2, knockouts: 8 },
        stats: { power: 88, speed: 64, cardio: 76, defense: 90, ringIq: 85, reaction: 69 },
      }),
      createFighter({
        id: "julian-reyes",
        seed: 197,
        firstName: "Julian",
        lastName: "Reyes",
        nickname: "Skyline",
        hometown: "Miami, FL",
        stance: "Southpaw",
        archetype: "Angle-heavy outfighter",
        weightClass: "heavyweight",
        age: 24,
        height: 79,
        weight: 240,
        reach: 84,
        rating: 81,
        record: { wins: 7, losses: 1, knockouts: 4 },
        stats: { power: 86, speed: 79, cardio: 84, defense: 80, ringIq: 82, reaction: 84 },
      }),
      createFighter({
        id: "bo-whitaker",
        seed: 199,
        firstName: "Bo",
        lastName: "Whitaker",
        nickname: "Hammerlock",
        hometown: "Omaha, NE",
        stance: "Orthodox",
        archetype: "Pressure infighter",
        weightClass: "heavyweight",
        age: 30,
        height: 75,
        weight: 235,
        reach: 77,
        rating: 78,
        record: { wins: 11, losses: 5, knockouts: 7 },
        stats: { power: 90, speed: 73, cardio: 83, defense: 72, ringIq: 77, reaction: 74 },
      }),
      createFighter({
        id: "amadi-okonkwo",
        seed: 211,
        firstName: "Amadi",
        lastName: "Okonkwo",
        nickname: "Landslide",
        hometown: "Accra, GH",
        stance: "Orthodox",
        archetype: "Volume technician",
        weightClass: "heavyweight",
        age: 28,
        height: 77,
        weight: 248,
        reach: 82,
        rating: 79,
        record: { wins: 10, losses: 4, draws: 1, knockouts: 6 },
        stats: { power: 87, speed: 76, cardio: 86, defense: 77, ringIq: 81, reaction: 79 },
      }),
      createFighter({
        id: "frank-delgado",
        seed: 223,
        firstName: "Frank",
        lastName: "Delgado",
        nickname: "Overtime",
        hometown: "Fresno, CA",
        stance: "Southpaw",
        archetype: "Patient body hunter",
        weightClass: "heavyweight",
        age: 32,
        height: 74,
        weight: 230,
        reach: 76,
        rating: 75,
        record: { wins: 13, losses: 8, draws: 1, knockouts: 9 },
        stats: { power: 83, speed: 68, cardio: 79, defense: 84, ringIq: 86, reaction: 71 },
      }),
      createFighter({
        id: "kristian-vold",
        seed: 227,
        firstName: "Kristian",
        lastName: "Vold",
        nickname: "North Sea",
        hometown: "Bergen, NO",
        stance: "Orthodox",
        archetype: "Reactive counter-puncher",
        weightClass: "heavyweight",
        age: 25,
        height: 78,
        weight: 242,
        reach: 80,
        rating: 83,
        record: { wins: 8, losses: 1, knockouts: 6 },
        stats: { power: 89, speed: 77, cardio: 81, defense: 86, ringIq: 87, reaction: 85 },
      }),
      createFighter({
        id: "matias-ferreira",
        seed: 251,
        firstName: "Matías",
        lastName: "Ferreira",
        nickname: "Long Count",
        hometown: "Rosario, AR",
        stance: "Southpaw",
        archetype: "Volume technician",
        weightClass: "heavyweight",
        age: 27,
        height: 76,
        weight: 236,
        reach: 79,
        rating: 80,
        record: { wins: 12, losses: 3, knockouts: 6 },
        stats: { power: 76, speed: 84, cardio: 89, defense: 80, ringIq: 84, reaction: 81 },
      }),
      createFighter({
        id: "gunnar-hale",
        seed: 257,
        firstName: "Gunnar",
        lastName: "Hale",
        nickname: "Last Call",
        hometown: "Duluth, MN",
        stance: "Orthodox",
        archetype: "Explosive puncher",
        weightClass: "heavyweight",
        age: 31,
        height: 79,
        weight: 249,
        reach: 83,
        rating: 78,
        record: { wins: 14, losses: 6, knockouts: 12 },
        stats: { power: 93, speed: 74, cardio: 70, defense: 68, ringIq: 72, reaction: 77 },
      }),
    ],
  };
}

/** The parts of a policy that survive any change to the policy's shape.
 *
 * Not weights — these are the tallies: which generation a brain is on, how many
 * bouts it was evaluated over, how many decisions it has learned from, what it
 * scored. None of them depend on how the action space is numbered, so none of
 * them should ever be reset by a migration that renumbers it. */
function carriedCounters(
  saved: Record<string, unknown> | undefined,
  fresh: PolicyModel,
): Pick<PolicyModel, "generation" | "evaluatedBouts" | "learnedDecisions" | "fitness"> {
  const carried = <K extends "generation" | "evaluatedBouts" | "learnedDecisions" | "fitness">(
    key: K,
  ) => (typeof saved?.[key] === "number" ? (saved[key] as number) : fresh[key]);
  return {
    generation: carried("generation"),
    evaluatedBouts: carried("evaluatedBouts"),
    learnedDecisions: carried("learnedDecisions"),
    fitness: carried("fitness"),
  };
}

export function upgradeLeagueState(value: unknown): LeagueState | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as {
    version?: number;
    season?: number;
    week?: number;
    boutsCompleted?: number;
    roster?: unknown[];
  };
  if (
    (
      saved.version !== 4 &&
      saved.version !== 5 &&
      saved.version !== 6 &&
      saved.version !== 7 &&
      saved.version !== 8 &&
      saved.version !== 9 &&
      saved.version !== 10
    ) ||
    !Array.isArray(saved.roster)
  ) {
    return null;
  }
  // The action space changed in v8 (the uppercut was added), which shifts every
  // policy matrix index. Rather than mis-map old weights onto new slots, rebuild
  // the motor policy from scratch for any pre-v8 save — the deterministic tactical
  // brain drives behaviour now, so no learned nuance is meaningfully lost.
  //
  // v10 (the exposure feature) needs no such rebuild: the feature was APPENDED,
  // so every saved weight keeps its index and its meaning, and the merge below
  // fills the new final column from the fresh policy's seeded prior.
  const rebuildPolicy = (saved.version ?? 0) < 8;

  const seedRoster = createInitialLeague().roster;
  const defaults = new Map(seedRoster.map((fighter) => [fighter.id, fighter]));
  const roster = saved.roster.map((entry) => {
    const fighter = entry as Fighter;
    if (
      !fighter ||
      typeof fighter.seed !== "number" ||
      typeof fighter.archetype !== "string" ||
      !fighter.stats
    ) {
      return null;
    }
    const freshPolicy = createInitialPolicy(fighter);
    const savedPolicy = (fighter as unknown as { policy?: Record<string, unknown> })
      .policy;
    const matrix = (key: keyof PolicyModel, fallback: number[][]) => {
      const savedMatrix = savedPolicy?.[key];
      if (!Array.isArray(savedMatrix)) return fallback;
      return fallback.map((row, rowIndex) =>
        row.map((fallbackValue, columnIndex) => {
          const savedValue = (savedMatrix as unknown[][])[rowIndex]?.[columnIndex];
          return typeof savedValue === "number" ? savedValue : fallbackValue;
        }),
      );
    };
    const vector = (key: keyof PolicyModel, fallback: number[]) =>
      Array.isArray(savedPolicy?.[key])
        ? (savedPolicy?.[key] as number[])
        : fallback;

    const seeded = defaults.get(fighter.id);
    return {
      ...fighter,
      height:
        typeof fighter.height === "number"
          ? fighter.height
          : (seeded?.height ?? 70),
      // Saves written before the league split into divisions were all
      // middleweight, which is exactly what the founding six were.
      weightClass: fighter.weightClass ?? seeded?.weightClass ?? "middleweight",
      level: typeof fighter.level === "number" ? fighter.level : (seeded?.level ?? 1),
      xp: typeof fighter.xp === "number" ? fighter.xp : 0,
      opponentDossiers:
        fighter.opponentDossiers && typeof fighter.opponentDossiers === "object"
          ? fighter.opponentDossiers
          : {},
      conditioning:
        fighter.conditioning && typeof fighter.conditioning === "object"
          ? fighter.conditioning
          : initialConditioning(fighter.stats),
      // Rebuilding the motor policy throws away weight *matrices*, because
      // their indices no longer mean what they meant. It must not throw away
      // the counters beside them: how many fights a brain has learned from is
      // still true however the punches were renumbered, and those numbers are
      // the fighter's history rather than his wiring.
      policy: rebuildPolicy ? { ...freshPolicy, ...carriedCounters(savedPolicy, freshPolicy) } : {
        ...freshPolicy,
        weights: matrix("weights", freshPolicy.weights),
        bias: vector("bias", freshPolicy.bias),
        hiddenWeights: matrix("hiddenWeights", freshPolicy.hiddenWeights),
        hiddenBias: vector("hiddenBias", freshPolicy.hiddenBias),
        recurrentHiddenWeights: matrix(
          "recurrentHiddenWeights",
          freshPolicy.recurrentHiddenWeights,
        ),
        memoryInputWeights: matrix(
          "memoryInputWeights",
          freshPolicy.memoryInputWeights,
        ),
        memoryWeights: matrix("memoryWeights", freshPolicy.memoryWeights),
        memoryBias: vector("memoryBias", freshPolicy.memoryBias),
        intentWeights: matrix("intentWeights", freshPolicy.intentWeights),
        intentMemoryWeights: matrix(
          "intentMemoryWeights",
          freshPolicy.intentMemoryWeights,
        ),
        intentBias: vector("intentBias", freshPolicy.intentBias),
        outputWeights: matrix("outputWeights", freshPolicy.outputWeights),
        outputMemoryWeights: matrix(
          "outputMemoryWeights",
          freshPolicy.outputMemoryWeights,
        ),
        intentActionWeights: matrix(
          "intentActionWeights",
          freshPolicy.intentActionWeights,
        ),
        ...carriedCounters(savedPolicy, freshPolicy),
      },
    };
  });
  if (roster.some((fighter) => fighter === null)) return null;

  // Any athlete the league has since signed is merged into an older save rather
  // than dropped, so a career from the six-man middleweight days keeps its
  // records and simply gains the other two divisions.
  const carried = roster as Fighter[];
  const known = new Set(carried.map((fighter) => fighter.id));
  const signings = seedRoster.filter((fighter) => !known.has(fighter.id));

  return {
    version: 10,
    season: saved.season ?? 1,
    week: saved.week ?? 1,
    boutsCompleted: saved.boutsCompleted ?? 0,
    roster: [...carried, ...signings],
  };
}

export function formatFighterName(fighter: Fighter) {
  return `${fighter.firstName} “${fighter.nickname}” ${fighter.lastName}`;
}

/** A roster athlete rebuilt so the browser can actually fight him.
 *
 * The public roster arrives with its learned matrices stripped — that is the
 * whole point of `publicFighter`, and none of it is coming back over the wire
 * for an exhibition. What survives the trip is everything the physics reads:
 * build, reach, stance and the six stats. Those are re-fitted with the same
 * seeded opening policy a debutant gets, so the man in front of the player
 * moves, punches and tires exactly like his card says he should — he simply
 * has not learned this opponent, which is honest, because he has not.
 *
 * Nothing built here may ever reach a career save. It is a sparring partner
 * wearing a real name, not the fighter of record. */
export function exhibitionFighter(
  fighter: Fighter,
  handicap: {
    reactionSeconds?: number;
    movementScale?: number;
    exhaustion?: Fighter["exhaustionRules"];
  } = {},
): Fighter {
  return {
    ...fighter,
    policy: createInitialPolicy(fighter),
    opponentDossiers: {},
    conditioning: initialConditioning(fighter.stats),
    reactionOverrideSeconds: handicap.reactionSeconds,
    movementScale: handicap.movementScale,
    exhaustionRules: handicap.exhaustion,
  };
}

/** The player's own corner: a body with no brain behind it.
 *
 * Every action is forced from the controller, so the policy is never consulted
 * and only the stat block matters. Deliberately unremarkable — a debutant's
 * physical baseline, several rungs under anybody on the card. */
export function playerFighter(
  name: { firstName: string; lastName: string },
  weightClass: WeightClassId,
  handicap: {
    movementScale?: number;
    exhaustion?: Fighter["exhaustionRules"];
  } = {},
): Fighter {
  const build = PLAYER_BUILDS[weightClass];
  return {
    ...createFighter({
    id: PLAYER_FIGHTER_ID,
    seed: 4711,
    firstName: name.firstName,
    lastName: name.lastName,
    nickname: "The Challenger",
    hometown: "Debut",
    stance: "Orthodox",
    archetype: "Pressure",
    weightClass,
    age: 24,
    height: build.height,
    weight: build.weight,
    reach: build.reach,
    rating: 55,
    record: {},
    // A card nobody would book. Reach and build are division-average so the
    // range game is honest; everything learnable sits well under the roster,
    // because the man holding the controller is the one who has to make up
    // the difference.
    stats: { power: 62, speed: 66, cardio: 70, defense: 58, ringIq: 55, reaction: 60 },
    }),
    movementScale: handicap.movementScale,
    exhaustionRules: handicap.exhaustion,
  };
}

export const PLAYER_FIGHTER_ID = "player-challenger";

const PLAYER_BUILDS: Record<
  WeightClassId,
  { height: number; weight: number; reach: number }
> = {
  featherweight: { height: 65, weight: 126, reach: 67 },
  middleweight: { height: 70, weight: 160, reach: 72 },
  heavyweight: { height: 76, weight: 240, reach: 79 },
};

export function getRanking(roster: Fighter[]) {
  return [...roster].sort(
    (a, b) =>
      b.rating - a.rating ||
      b.record.wins - a.record.wins ||
      a.record.losses - b.record.losses,
  );
}

export function ringPositionPercent(positionMeters: number) {
  return clamp((positionMeters / BOXING_MODEL.ringLengthMeters) * 100, 0, 100);
}

export function ringDepthPercent(positionMeters: number) {
  return clamp((positionMeters / BOXING_MODEL.ringDepthMeters) * 100, 0, 100);
}

export function ringDistance(
  first: Pick<BoutFighter, "x" | "y">,
  second: Pick<BoutFighter, "x" | "y">,
) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function calculateImpact(input: ImpactInput): ImpactResult {
  const effectiveMassKg = Math.max(0, input.effectiveMassKg);
  const closingVelocityMps = Math.max(0, input.closingVelocityMps);
  const guardAbsorption = clamp(input.guardAbsorption ?? 0, 0, 0.95);
  const rotationalFactor = Math.max(0.5, input.rotationalFactor ?? 1);
  const directness = clamp(input.directness ?? 1, 0, 1);
  const momentArmMeters = Math.max(0, input.momentArmMeters ?? 0);
  const anatomicalVulnerability = Math.max(0, input.anatomicalVulnerability ?? 1);
  const impulseNs = effectiveMassKg * closingVelocityMps;
  const impactEnergyJ = 0.5 * effectiveMassKg * closingVelocityMps ** 2;
  const transmittedImpulseNs = impulseNs * (1 - guardAbsorption) * directness;
  const transmittedEnergyJ =
    impactEnergyJ * (1 - guardAbsorption) * rotationalFactor * directness;
  const rotationalImpulseNms =
    transmittedImpulseNs * momentArmMeters * rotationalFactor;
  const neurologicalLoad = anatomicalVulnerability * (
    transmittedImpulseNs / 26.5 * 0.32 +
    transmittedEnergyJ / 121 * 0.28 +
    rotationalImpulseNms / 1.72 * 0.40
  );
  const powerScore =
    closingVelocityMps / 9.14 * 0.34 +
    effectiveMassKg / 2.9 * 0.26 +
    transmittedEnergyJ / 121 * 0.30 +
    directness * 0.10;

  return {
    effectiveMassKg: round(effectiveMassKg, 3),
    closingVelocityMps: round(closingVelocityMps, 3),
    impulseNs: round(impulseNs, 3),
    transmittedImpulseNs: round(transmittedImpulseNs, 3),
    impactEnergyJ: round(impactEnergyJ, 2),
    transmittedEnergyJ: round(transmittedEnergyJ, 2),
    peakForceN: round(impulseNs / BOXING_MODEL.contactDurationSeconds),
    rotationalImpulseNms: round(rotationalImpulseNms, 4),
    neurologicalLoad: round(neurologicalLoad, 4),
    powerScore: round(powerScore, 4),
  };
}

function armLengthMeters(fighter: Fighter) {
  return fighter.reach * 0.0254 * 0.5;
}

// How well a man takes a shot. Derived from attributes we already persist rather
// than a new stored stat: conditioning and neck/shoulder work carry the head,
// ring IQ rolls with the punch instead of eating it square, and mass matters.
// ~0.74 for a fragile athlete, ~1.26 for a genuinely granite chin.
//
// The second weight term only bites above light-heavy, and exists because mass
// enters the punch on the attacker's side but never on the defender's: a
// heavyweight swings 32% more effective mass than a featherweight while the
// linear term below buys him only 12% more chin, so the same man is far easier
// to flatten than to hurt back. Head acceleration is impulse over the mass of
// the head and neck carrying it, and that unit grows with the body, so the
// extra chin restores the balance rather than inventing an advantage. Tuned to
// cancel the heavyweight's mass edge on defence while leaving his punches
// exactly as heavy — the division still finishes fights, it just stops
// finishing them in the first ninety seconds.
function chinRating(fighter: Fighter) {
  return clamp(
    0.62 +
      fighter.stats.cardio / 640 +
      fighter.stats.defense / 900 +
      fighter.stats.ringIq / 1100 +
      (fighter.weight - 155) / 900 +
      Math.max(0, fighter.weight - 175) / 900,
    0.74,
    1.26,
  );
}

function fatigueFactor(runtime: BoutFighter) {
  return 0.55 + runtime.stamina * 0.0045;
}

export function calibratedHandSpeed(
  fighter: Fighter,
  action: FighterAction,
  stamina = 100,
  balance = 1,
) {
  const spec = PUNCH_SPECS[action];
  if (!spec) return 0;
  const fatigue = 0.55 + clamp(stamina, 0, 100) * 0.0045;
  const technique = 0.72 + fighter.stats.speed / 360 + fighter.stats.power / 900;
  const stability = 0.62 + clamp(balance, 0, 1) * 0.38;
  const baseline = 6.5;
  return round(baseline * spec.velocityFactor * technique * fatigue * stability, 3);
}

function reactionSeconds(fighter: Fighter) {
  // Exhibitions only. The stat curve clamps at 290 ms, which is still three
  // times sharper than a person choosing between four defences, so no setting
  // of `reaction` can hand a human a fair fight. Nobody the league books
  // carries this field, so a real bout never reaches the branch.
  if (fighter.reactionOverrideSeconds !== undefined) {
    return fighter.reactionOverrideSeconds;
  }
  return clamp(0.4 - fighter.stats.reaction * 0.00235, 0.15, 0.29);
}

function actionDuration(action: FighterAction, fighter: Fighter, runtime: BoutFighter) {
  const punch = PUNCH_SPECS[action];
  if (punch) {
    const speedScale = 0.79 + fighter.stats.speed / 420;
    return round((punch.duration / speedScale) * (1.08 - fatigueFactor(runtime) * 0.08), 3);
  }
  if (action === "slip") return round(reactionSeconds(fighter) + 0.18, 3);
  if (action === "duck") return round(reactionSeconds(fighter) + 0.2, 3);
  if (action === "weave") return round(reactionSeconds(fighter) + 0.32, 3);
  if (action === "guard") return 0.55;
  if (action === "advance" || action === "retreat") return 0.5;
  if (action === "circleLeft" || action === "circleRight") return 0.55;
  if (action === "pivotLeft" || action === "pivotRight") return 0.42;
  if (action === "recover") return 0.65;
  return round(reactionSeconds(fighter) + 0.12, 3);
}

function initialSnapshot(x: number, y: number): SensorySnapshot {
  return {
    x,
    y,
    velocity: 0,
    velocityY: 0,
    stamina: 100,
    balance: 1,
    health: 100,
    hurt: 0,
    action: "guard",
    headOffset: 0,
    headLevel: 1,
    handExtension: 0,
    actionProgress: 0,
    punchSide: 0,
    heightM: 1.778,
  };
}

function createBoutFighter(
  fighterId: string,
  corner: Corner,
  seed = 0,
): BoutFighter {
  // Two men never walk to the centre from exactly the same spot twice. Without
  // this the whole sim is a pure function of the two profiles, so a rematch
  // replays the previous fight punch for punch. A seeded nudge of a few
  // centimetres is enough for the chaos in the contact model to take the bout
  // somewhere genuinely different, while staying perfectly reproducible for
  // every viewer who replays it from the same seed.
  //
  // The nudge is deliberately MIRRORED rather than drawn per corner: both men
  // move the same distance toward or away from the centre, on the same line.
  // A corner must never be a handicap, and seed 0 means "no nudge at all", so
  // an unseeded bout is bit-for-bit the fight it always was.
  const spread = seed === 0 ? 0 : mutationSignal(seed * 2.7) * 0.22;
  const drift = seed === 0 ? 0 : mutationSignal(seed * 3.9 + 11) * 0.34;
  const x =
    corner === "blue"
      ? 1.45 + spread
      : BOXING_MODEL.ringLengthMeters - 1.45 - spread;
  const y = BOXING_MODEL.ringDepthMeters / 2 + drift;
  return {
    fighterId,
    corner,
    x,
    y,
    facingDirection: corner === "blue" ? 1 : -1,
    velocity: 0,
    velocityY: 0,
    health: 100,
    stamina: 100,
    balance: 1,
    body: initialArticulatedBody(),
    headTrauma: 0,
    bodyTrauma: 0,
    neurologicalLoad: 0,
    bodyShock: 0,
    stunSeconds: 0,
    punchLockSeconds: 0,
    gassed: false,
    guardHeld: false,
    hurtSeconds: 0,
    chinIntegrity: 1,
    comboPlan: [],
    comboIndex: 0,
    guardStreak: 0,
    pocketSeconds: 0,
    downCountSeconds: 0,
    recoveryTargetSeconds: 0,
    knockout: false,
    knockoutCause: "none",
    score: 0,
    judgePoints: [0, 0, 0],
    action: "guard",
    lastAction: "guard",
    actionRecency: ACTIONS.map(() => 0),
    tacticalIntent: "outside",
    decisionConfidence: 0,
    decisionMargin: 0,
    decisionCount: 0,
    brainActivity: 0,
    workingMemory: Array(BOXING_MODEL.recurrentUnits).fill(0),
    memoryActivity: 0,
    memoryUpdates: 0,
    currentPlan: defaultStrategyDirective(1),
    planRevision: 0,
    attackSequence: 0,
    actionElapsed: 0,
    actionDuration: 0.35,
    previousHandExtension: 0,
    handExtension: 0,
    handVelocity: 0,
    headOffset: 0,
    headLevel: 1,
    punchAimOffset: 0,
    punchAimHeight: 1.67,
    punchAimZone: "guard",
    punchHand: "lead",
    punchSide: 0,
    punchDirectionX: corner === "blue" ? 1 : -1,
    punchDirectionY: 0,
    punchExtensionTarget: 0,
    punchResolved: false,
    evadeDirection: 1,
    landed: 0,
    thrown: 0,
    blocked: 0,
    knockdowns: 0,
    cleanImpactJ: 0,
    absorbedImpactJ: 0,
    lastImpactJ: 0,
    peakImpactJ: 0,
    peakHandSpeed: 0,
    peakForceN: 0,
    lastImpactZone: "guard",
    lastStrikeKind: "none",
    lastImpactSpeed: 0,
    lastRotationalImpulse: 0,
    lastPowerShot: false,
    lastImpactCounter: false,
    recentHeadImpact: 0,
    recentBodyImpact: 0,
    sustainedPressure: 0,
    heightM: 1.778,
    reachM: 1.829,
    massKg: 72.57,
    round: emptyRoundMetrics(),
    lastRound: emptyRoundMetrics(),
    actionCounts: emptyActionCounts(),
    rangeSampleTotal: 0,
    rangeSamples: 0,
    sensoryHistory: Array.from({ length: 8 }, () => initialSnapshot(x, y)),
  };
}

export function createBout(
  leftId: string,
  rightId: string,
  id = Date.now(),
  options: { roundSeconds?: number; totalRounds?: number; seed?: number } = {},
): BoutState {
  const roundLength = options.roundSeconds ?? BOXING_MODEL.roundSeconds;
  const seed = options.seed ?? 0;
  return {
    id,
    seed,
    tick: 0,
    round: 1,
    roundTime: roundLength,
    roundLength,
    totalRounds: options.totalRounds ?? BOXING_MODEL.totalRounds,
    breakTime: 0,
    introSeconds: BOXING_MODEL.roundIntroSeconds,
    running: true,
    speed: 1,
    left: createBoutFighter(leftId, "blue", seed),
    right: createBoutFighter(rightId, "red", seed),
    roundCards: [],
    events: [
      {
        id: 0,
        time: `R1 ${Math.floor(roundLength / 60)}:${String(roundLength % 60).padStart(2, "0")}`,
        tone: "neutral",
        text: "Opening bell — deterministic contact physics and delayed observation are active.",
      },
    ],
    winnerId: null,
    finish: null,
    careerCommitted: false,
  };
}

function getProfile(roster: Fighter[], fighterId: string) {
  return roster.find((fighter) => fighter.id === fighterId);
}

function openingPlan(fighter: Fighter, opponent: Fighter) {
  const dossier = fighter.opponentDossiers[opponent.id];
  let plan = defaultStrategyDirective(1, dossier ? "dossier" : "opening");
  const archetype = opponent.archetype.toLowerCase();

  if ((dossier?.pressureRate ?? 0) > 0.22 || archetype.includes("pressure")) {
    plan = {
      ...plan,
      focus: "counter",
      pace: -0.12,
      risk: -0.08,
      ringMode: "outside",
      confidence: dossier ? 78 : 58,
      note: dossier
        ? `Prior bouts show ${(dossier.pressureRate * 100).toFixed(0)}% pressure actions; draw entries and counter.`
        : "The opponent profiles as a pressure fighter; preserve exits and counter entries.",
    };
  } else if ((dossier?.guardRate ?? 0) > 0.18) {
    plan = {
      ...plan,
      focus: "bodyWork",
      pace: 0.1,
      target: "body",
      confidence: 74,
      note: `The dossier shows ${(dossier.guardRate * 100).toFixed(0)}% guard use; probe beneath the shell.`,
    };
  } else if (archetype.includes("outfighter") || archetype.includes("volume")) {
    plan = {
      ...plan,
      focus: "pressure",
      pace: 0.18,
      risk: 0.08,
      ringMode: "pressure",
      confidence: 57,
      note: "Close the outfighter's preferred range without abandoning balance.",
    };
  }

  return plan;
}

export function planBetweenRounds(
  fighter: Fighter,
  opponent: Fighter,
  runtime: BoutFighter,
  opponentRuntime: BoutFighter,
  nextRound: number,
): StrategyDirective {
  const dossier = fighter.opponentDossiers[opponent.id];
  const cleanDifference =
    runtime.round.cleanBlows - opponentRuntime.round.cleanBlows;
  const impactDifference =
    runtime.round.impactEnergy - opponentRuntime.round.impactEnergy;
  let candidate: Omit<StrategyDirective, "source" | "issuedRound"> = {
    ...runtime.currentPlan,
    confidence: 68,
    note: "Hold the current shape; the measured round does not justify a major change.",
  };

  if (runtime.stamina < 38 || runtime.health < 72) {
    candidate = {
      focus: "recover",
      pace: -0.55,
      risk: -0.5,
      target: "mixed",
      ringMode: "outside",
      confidence: 86,
      note: `Condition is ${runtime.health.toFixed(0)} health / ${runtime.stamina.toFixed(0)} stamina; recover behind exits.`,
    };
  } else if (cleanDifference <= -2 || impactDifference < -35) {
    candidate = {
      focus: "pressure",
      pace: 0.38,
      risk: 0.22,
      target: "mixed",
      ringMode: "pressure",
      confidence: 81,
      note: `Down ${Math.abs(cleanDifference)} clean blows and ${Math.abs(impactDifference).toFixed(0)} J this round; raise controlled pressure.`,
    };
  } else if (
    opponentRuntime.actionCounts.guard /
      Math.max(1, Object.values(opponentRuntime.actionCounts).reduce((sum, value) => sum + value, 0)) >
      0.18 ||
    (dossier?.guardRate ?? 0) > 0.18
  ) {
    candidate = {
      focus: "bodyWork",
      pace: 0.12,
      risk: -0.04,
      target: "body",
      ringMode: "center",
      confidence: 78,
      note: "Guard usage is elevated; shift the scoring threat toward the body.",
    };
  } else if (
    opponentRuntime.actionCounts.advance /
      Math.max(1, Object.values(opponentRuntime.actionCounts).reduce((sum, value) => sum + value, 0)) >
      0.16 ||
    (dossier?.pressureRate ?? 0) > 0.22
  ) {
    candidate = {
      focus: "counter",
      pace: -0.1,
      risk: -0.12,
      target: "head",
      ringMode: "outside",
      confidence: 76,
      note: "Entry pressure is elevated; protect the exit lane and counter the approach.",
    };
  }

  return normalizeStrategyDirective(
    candidate,
    nextRound,
    "between-round",
  ) ?? defaultStrategyDirective(nextRound, "between-round");
}

function strategyRoundStats(runtime: BoutFighter, useLastRound: boolean) {
  const metrics = useLastRound ? runtime.lastRound : runtime.round;
  return {
    ...metrics,
    stamina: round(runtime.stamina),
    health: round(runtime.health),
  };
}

export function buildStrategyContext(
  fighter: Fighter,
  opponent: Fighter,
  runtime: BoutFighter,
  opponentRuntime: BoutFighter,
  roundNumber: number,
): StrategyContext {
  const useLastRound = roundNumber > 1;
  return {
    fighter: {
      id: fighter.id,
      name: `${fighter.firstName} ${fighter.lastName}`,
      archetype: fighter.archetype,
      stance: fighter.stance,
      reachInches: fighter.reach,
    },
    opponent: {
      id: opponent.id,
      name: `${opponent.firstName} ${opponent.lastName}`,
      archetype: opponent.archetype,
      stance: opponent.stance,
      reachInches: opponent.reach,
    },
    round: roundNumber,
    scoreDifference: round(runtime.score - opponentRuntime.score),
    own: strategyRoundStats(runtime, useLastRound),
    opponentRound: strategyRoundStats(opponentRuntime, useLastRound),
    dossier: fighter.opponentDossiers[opponent.id] ?? null,
    currentDirective: { ...runtime.currentPlan },
  };
}

export function applyStrategyDirective(
  bout: BoutState,
  corner: Corner,
  directive: StrategyDirective,
) {
  const next = structuredClone(bout);
  const runtime = corner === "blue" ? next.left : next.right;
  const normalized = normalizeStrategyDirective(
    directive,
    next.round,
    directive.source,
  );
  if (!normalized || normalized.issuedRound !== next.round) return bout;
  runtime.currentPlan = normalized;
  runtime.planRevision += 1;
  return next;
}

function ringVector(
  self: Pick<BoutFighter, "x" | "y">,
  opponent: Pick<BoutFighter, "x" | "y">,
) {
  const deltaX = opponent.x - self.x;
  const deltaY = opponent.y - self.y;
  const distance = Math.max(0.0001, Math.hypot(deltaX, deltaY));
  const forwardX = deltaX / distance;
  const forwardY = deltaY / distance;
  return {
    deltaX,
    deltaY,
    distance,
    forwardX,
    forwardY,
    leftX: -forwardY,
    leftY: forwardX,
  };
}

function ropeDistance(position: Pick<BoutFighter, "x" | "y">) {
  return Math.min(
    position.x - RING_MIN,
    RING_MAX - position.x,
    position.y - RING_DEPTH_MIN,
    RING_DEPTH_MAX - position.y,
  );
}

function movementBlocked(
  runtime: Pick<BoutFighter, "x" | "y">,
  directionX: number,
  directionY: number,
) {
  const clearance = 0.1;
  return (
    runtime.x + directionX * clearance < RING_MIN ||
    runtime.x + directionX * clearance > RING_MAX ||
    runtime.y + directionY * clearance < RING_DEPTH_MIN ||
    runtime.y + directionY * clearance > RING_DEPTH_MAX
  );
}

function headHeight(headLevel: number, heightM: number) {
  return heightM - 0.13 - (1 - clamp(headLevel, 0.62, 1)) * 0.75;
}

function targetPosition(
  attacker: Pick<BoutFighter, "x" | "y">,
  defender: Pick<BoutFighter, "x" | "y" | "headOffset" | "headLevel" | "heightM">,
  target: PunchTarget,
) {
  const defenderFacing = ringVector(defender, attacker);
  // A slip or a weave is the whole upper body moving, hinged at the waist — the
  // head travels furthest but the ribs go with it. Pinning the torso to the spot
  // made body shots literally unmissable: crossBody and jabBody landed 99% of
  // everything thrown, because no action a defender could take ever moved the
  // target they were aimed at.
  const lateralOffset =
    target === "head" ? defender.headOffset : defender.headOffset * 0.85;
  const crouch = 1 - clamp(defender.headLevel, 0.62, 1);
  return {
    x: defender.x + defenderFacing.leftX * lateralOffset,
    y: defender.y + defenderFacing.leftY * lateralOffset,
    z: target === "head"
      ? headHeight(defender.headLevel, defender.heightM)
      // Dropping under a shot takes the ribs down with the head, so a body punch
      // aimed at a standing torso passes above a man who has ducked into it.
      : defender.heightM * (0.60 - crouch * 0.16),
  };
}

function perceivedSnapshot(opponent: BoutFighter, fighter: Fighter) {
  const history = opponent.sensoryHistory;
  const lagTicks = Math.max(
    1,
    Math.ceil(reactionSeconds(fighter) / BOXING_MODEL.physicsStepSeconds),
  );
  const index = Math.max(0, history.length - 1 - lagTicks);
  const snapshot = history[index] ?? history[0];
  // A punch is not read off the fist. It is read off the shoulder and the hip
  // loading before the hand has gone anywhere, and that gross telegraph resolves
  // a beat sooner than fine limb position — which is the only reason a boxer can
  // slip anything at all.
  //
  // Without this the timing was unsurvivable: contact lands 138 ms after a jab
  // starts and 200 ms after a cross, while a full sensory lag is 200 ms for the
  // sharpest man in the league and 300 ms for a typical heavyweight. Reading
  // only the fist, a fighter perceived every punch AFTER it had already landed —
  // so evasions fired into empty air a tick late, and heavyweights, who round up
  // to that third tick of lag, never slipped a shot all night.
  //
  // One tick earlier still leaves the jab genuinely unslippable for everyone and
  // keeps the cross and the hook readable only by the quicker men, which is how
  // it works in a real ring.
  const telegraph =
    history[Math.max(0, history.length - 1 - Math.max(1, lagTicks - 1))] ?? snapshot;
  return {
    ...snapshot,
    action: telegraph.action,
    actionProgress: telegraph.actionProgress,
    handExtension: telegraph.handExtension,
    // The loading shoulder reads on the same early beat as the punch itself —
    // it is the same gross tell, so it rides the telegraph rather than the
    // slower, finer channel.
    punchSide: telegraph.punchSide,
    x: quantize(snapshot.x, 0.05),
    y: quantize(snapshot.y, 0.05),
    velocity: quantize(snapshot.velocity, 0.1),
    velocityY: quantize(snapshot.velocityY, 0.1),
    stamina: quantize(snapshot.stamina, 5),
    balance: quantize(snapshot.balance, 0.05),
    health: quantize(snapshot.health, 5),
    hurt: quantize(snapshot.hurt, 0.1),
    headLevel: quantize(snapshot.headLevel, 0.05),
  };
}

/** What part of a perceived punch can still be defended.
 *
 * A punch animation includes wind-up, contact and a long recoil. Treating all
 * three as the same signal made fighters dodge after the glove had already
 * landed, then keep moving their heads while the hand was on its way home.
 * This read closes at contact: it is a warning about the shot that is coming,
 * not a report that one was thrown. */
type LivePunchRead = Pick<
  BoutFighter,
  "action" | "actionElapsed" | "actionDuration" | "punchResolved"
>;

function livePunchRead(runtime: BoutFighter): LivePunchRead {
  return {
    action: runtime.action,
    actionElapsed: runtime.actionElapsed,
    actionDuration: runtime.actionDuration,
    punchResolved: runtime.punchResolved,
  };
}

function incomingPunchRead(
  seen: SensorySnapshot,
  distance: number,
  opponentReach: number,
  actual?: LivePunchRead,
) {
  const seenSpec = PUNCH_SPECS[seen.action];
  const actualSpec = actual ? PUNCH_SPECS[actual.action] : undefined;
  const actualProgress = actual
    ? actual.actionElapsed / Math.max(0.01, actual.actionDuration)
    : 0;
  // Gross shoulder and hip loading are visible on the live beat, before the
  // delayed fine-position snapshot catches up. Prefer that telegraph while the
  // punch is still coming; otherwise a 200 ms sensory lag makes a 150–200 ms
  // contact window literally impossible to defend. Exact range, balance and
  // limb position remain delayed below, so this is a readable tell rather than
  // perfect knowledge of the opponent.
  const liveTelegraph = Boolean(
    actual &&
    actualSpec &&
    !actual.punchResolved &&
    actualProgress <= actualSpec.contactPhase + 0.035,
  );
  const action = liveTelegraph && actual ? actual.action : seen.action;
  const spec = liveTelegraph ? actualSpec : seenSpec;
  if (!spec) {
    return {
      action,
      target: null,
      threat: 0,
    } as const;
  }

  const targetRadius =
    spec.target === "head"
      ? BOXING_MODEL.headRadiusMeters
      : BOXING_MODEL.bodyRadiusMeters;
  const contactRange =
    opponentReach * spec.reachFactor +
    0.13 +
    targetRadius +
    BOXING_MODEL.gloveRadiusMeters;
  const progress = clamp(
    liveTelegraph ? actualProgress : seen.actionProgress,
    0,
    1,
  );
  // Reaction lag can leave the old wind-up in sensory memory after the glove
  // has already landed or sailed past. Contact itself is immediate information:
  // once this exact shot has resolved, the defender must recover or answer it,
  // never begin a dodge for it.
  const alreadyPassed =
    actual?.action === action &&
    (actual.punchResolved || actualProgress > spec.contactPhase + 0.09);
  const canReach = distance <= contactRange + 0.16;
  const contactStillAhead = progress <= spec.contactPhase + 0.035;
  if (!canReach || !contactStillAhead || alreadyPassed) {
    return {
      action,
      target: spec.target,
      threat: 0,
    } as const;
  }

  const windupStart = Math.max(0.04, spec.contactPhase - 0.3);
  const drive = clamp(
    (progress - windupStart) / Math.max(0.01, spec.contactPhase - windupStart),
    0,
    1,
  );
  return {
    action,
    target: spec.target,
    // The shoulder load is actionable before the glove starts travelling. It
    // begins as a read and rises as contact approaches, then disappears as soon
    // as the shot has passed its contact beat.
    threat: round(0.35 + drive * 0.65, 4),
  } as const;
}

/** Whether a live read may break the action already under way.
 *
 * Footwork and recovery are always cancellable. A punch is cancellable only
 * during its load, before the glove has committed to the target; after that the
 * fighter has to finish what he started and live with the exchange. */
function defensiveActionInterruptible(runtime: BoutFighter) {
  if (EVASIONS.has(runtime.action) || runtime.action === "retreat") return false;
  const punch = PUNCH_SPECS[runtime.action];
  if (!punch) return true;
  const progress = runtime.actionElapsed / Math.max(0.01, runtime.actionDuration);
  const committed =
    progress >= punch.contactPhase - 0.08 ||
    runtime.handExtension >= runtime.punchExtensionTarget * 0.72;
  return !runtime.punchResolved && !committed;
}

function buildObservation(
  self: BoutFighter,
  opponent: BoutFighter,
  fighter: Fighter,
  opponentTelegraph: LivePunchRead = opponent,
) {
  const seen = perceivedSnapshot(opponent, fighter);
  const vector = ringVector(self, seen);
  const distance = vector.distance;
  const reach = armLengthMeters(fighter);
  const closingVelocity =
    (self.velocity - seen.velocity) * vector.forwardX +
    (self.velocityY - seen.velocityY) * vector.forwardY;
  const lateralVelocity =
    (self.velocity - seen.velocity) * vector.leftX +
    (self.velocityY - seen.velocityY) * vector.leftY;
  const ownRopeDistance = Math.min(self.x - RING_MIN, RING_MAX - self.x);
  const opponentRopeDistance = Math.min(seen.x - RING_MIN, RING_MAX - seen.x);
  const ownDepthRopeDistance = Math.min(
    self.y - RING_DEPTH_MIN,
    RING_DEPTH_MAX - self.y,
  );
  const opponentDepthRopeDistance = Math.min(
    seen.y - RING_DEPTH_MIN,
    RING_DEPTH_MAX - seen.y,
  );
  const scoreDifference = opponent.score - self.score;
  const incoming = incomingPunchRead(
    seen,
    distance,
    opponent.reachM,
    opponentTelegraph,
  );
  const seenTarget = PUNCH_SPECS[seen.action]?.target;
  const ownHurt = clamp(self.hurtSeconds / 2.2, 0, 1);

  return [
    clamp(distance / 2.8, 0, 1),
    distance >= reach * 0.62 && distance <= reach + 0.28 ? 1 : 0,
    distance >= reach * 0.52 && distance <= reach + 0.2 ? 1 : 0,
    distance <= reach * 0.77 ? 1 : 0,
    clamp((closingVelocity + 2.2) / 4.4, 0, 1),
    self.stamina / 100,
    1 - self.stamina / 100,
    1 - seen.stamina / 100,
    self.balance,
    1 - seen.balance,
    // Own condition and the opponent's distress both fold in the visible hurt
    // state. Health alone barely moves inside a round, so without this a badly
    // buzzed man reads as perfectly healthy and nobody ever jumps on him.
    clamp(self.health / 100 - ownHurt * 0.55, 0, 1),
    Math.max(1 - seen.health / 100, seen.hurt),
    incoming.threat,
    seen.action === "guard" ? 1 : 0,
    clamp((scoreDifference + 18) / 36, 0, 1),
    clamp(1 - ownRopeDistance / 1.25, 0, 1),
    clamp(1 - opponentRopeDistance / 1.25, 0, 1),
    seen.action === "guard" && seenTarget !== "body" ? 0.2 : seen.action === "slip" ? 0.55 : 1,
    clamp(Math.abs(vector.deltaY) / 2.4, 0, 1),
    clamp((lateralVelocity + 2.2) / 4.4, 0, 1),
    clamp(1 - ownDepthRopeDistance / 1.25, 0, 1),
    clamp(1 - opponentDepthRopeDistance / 1.25, 0, 1),
    clamp(1 - seen.headLevel, 0, 1),
    seen.action === "slip" ||
    seen.action === "duck" ||
    seen.action === "weave" ||
    seen.action === "circleLeft" ||
    seen.action === "circleRight" ||
    seen.action === "pivotLeft" ||
    seen.action === "pivotRight"
      ? 1
      : 0,
    self.recentHeadImpact,
    self.recentBodyImpact,
    self.sustainedPressure,
    // How open the other man's current punch leaves him — the counter's read.
    // Taken off the live telegraph like the threat read above: a committed
    // punch is gross body position, visible on the early channel.
    punchExposureFromRead(opponentTelegraph),
  ];
}

function layerValue(weights: number[], inputs: number[], bias = 0) {
  return inputs.reduce(
    (value, input, inputIndex) =>
      value + input * (weights[inputIndex] ?? 0),
    bias,
  );
}

function runNeuralPolicy(
  policy: PolicyModel,
  features: number[],
  previousMemory = Array(BOXING_MODEL.recurrentUnits).fill(0),
) {
  const hiddenActivations = policy.hiddenWeights.map((weights, hiddenIndex) =>
    Math.tanh(
      layerValue(weights, features, policy.hiddenBias[hiddenIndex] ?? 0) +
        layerValue(
          policy.recurrentHiddenWeights[hiddenIndex] ?? [],
          previousMemory,
        ),
    ),
  );
  const nextMemory = policy.memoryInputWeights.map((weights, memoryIndex) =>
    Math.tanh(
      layerValue(weights, hiddenActivations, policy.memoryBias[memoryIndex] ?? 0) +
        layerValue(policy.memoryWeights[memoryIndex] ?? [], previousMemory),
    ),
  );
  const intentScores = policy.intentWeights.map((weights, intentIndex) =>
    layerValue(weights, hiddenActivations, policy.intentBias[intentIndex] ?? 0) +
      layerValue(
        policy.intentMemoryWeights[intentIndex] ?? [],
        nextMemory,
      ),
  );
  const intentIndex = intentScores.reduce(
    (best, score, index) => (score > intentScores[best] ? index : best),
    0,
  );
  const actionScores = ACTIONS.map((_, actionIndex) =>
    layerValue(
      policy.weights[actionIndex],
      features,
      policy.bias[actionIndex] ?? 0,
    ) +
    layerValue(policy.outputWeights[actionIndex], hiddenActivations) +
    layerValue(policy.outputMemoryWeights[actionIndex] ?? [], nextMemory) +
    (policy.intentActionWeights[actionIndex]?.[intentIndex] ?? 0),
  );

  return {
    hiddenActivations,
    nextMemory,
    intentScores,
    intentIndex,
    intent: TACTICAL_INTENTS[intentIndex],
    actionScores,
  };
}

function buildTrainingObservation(
  fighter: Fighter,
  self: BoutFighter,
  opponent: BoutFighter,
  opponentTelegraph: LivePunchRead = opponent,
): TrainingObservation {
  const features = buildObservation(
    self,
    opponent,
    fighter,
    opponentTelegraph,
  );
  const vector = ringVector(self, opponent);
  const distance = vector.distance;
  const seen = perceivedSnapshot(opponent, fighter);
  const incoming = incomingPunchRead(
    seen,
    ringVector(self, seen).distance,
    opponent.reachM,
    opponentTelegraph,
  );
  const defensiveWindow =
    self.actionElapsed < self.actionDuration &&
    incoming.threat > 0 &&
    defensiveActionInterruptible(self);
  const atRearRope = movementBlocked(self, -vector.forwardX, -vector.forwardY);
  const opponentExposure = punchExposureFromRead(opponentTelegraph);
  const actionMask = ACTIONS.map((action) => {
    // A defensive interrupt is deliberately narrow. The boxer may cover, move
    // his feet or move his head, but he cannot cancel ordinary footwork into a
    // fresh attack after the opponent has already committed a punch — with one
    // exception. A punch that has committed naked is the opening the counter
    // exists for, and a cross over a full-stretch hook is the one attack that
    // IS a defence. The bar sits above a committed jab's 0.70 on purpose: only
    // the power shots open this door, or every defensive window turns back
    // into a trade.
    if (defensiveWindow && !DEFENSIVE_REACTIONS.has(action)) {
      if (!(COUNTER_ANSWERS.has(action) && opponentExposure >= 0.78)) {
        return false;
      }
    }
    const spec = PUNCH_SPECS[action];
    // A tired fighter can always flick a jab; only the heavier, more
    // stamina-hungry power shots lock out when the tank is empty. This keeps
    // both fighters offensively alive instead of one covering up all round.
    if (spec && spec.staminaCost > 3.4 && self.stamina < spec.staminaCost + 1) return false;
    if (spec && self.balance < 0.2) return false;
    // Boxers do not throw punches they cannot possibly land. Mask any strike
    // whose target sits beyond its reach (a small buffer lets a fighter commit
    // as he steps into range). This alone kills most of the air-punching that
    // was inflating the "missed" count into the hundreds.
    if (spec) {
      const targetRadius =
        spec.target === "head"
          ? BOXING_MODEL.headRadiusMeters
          : BOXING_MODEL.bodyRadiusMeters;
      const maxReach =
        armLengthMeters(fighter) * spec.reachFactor +
        0.13 +
        targetRadius +
        BOXING_MODEL.gloveRadiusMeters;
      if (distance > maxReach + 0.14) return false;
    }
    if (action === "advance" && distance < MIN_BODY_DISTANCE + 0.06) return false;
    if (action === "retreat" && atRearRope) return false;
    // Head movement is either a read or a habit, never an idle animation. The
    // read: a straight can be slipped or rolled under, a looping head shot can
    // be ducked or rolled — but body shots and uppercuts are answered with the
    // feet or the guard, and ducking into either one is exactly the wrong
    // lesson to reinforce. The habit: inside punching range the head may move
    // before anything is thrown, because a jab crosses the gap faster than any
    // reaction — the only slip that beats one started early. Out of range, or
    // against a live body-shot read, the gate stays shut.
    const pocketAnticipation =
      distance <= opponent.reachM * 1.02 + 0.36 && self.downCountSeconds <= 0;
    if (action === "slip") {
      if (pocketAnticipation && incoming.threat <= 0) return true;
      return (
        incoming.threat > 0 &&
        (incoming.action === "jabHead" || incoming.action === "crossHead")
      );
    }
    if (action === "duck" || action === "weave") {
      if (pocketAnticipation && incoming.threat <= 0) return true;
      return (
        incoming.threat > 0 &&
        (incoming.action === "hookHead" || incoming.action === "crossHead")
      );
    }
    if (action === "circleLeft" && movementBlocked(self, vector.leftX, vector.leftY)) return false;
    if (action === "circleRight" && movementBlocked(self, -vector.leftX, -vector.leftY)) return false;
    if (action === "pivotLeft" && movementBlocked(self, vector.leftX, vector.leftY)) return false;
    if (action === "pivotRight" && movementBlocked(self, -vector.leftX, -vector.leftY)) return false;
    return true;
  });

  return {
    fighterId: fighter.id,
    opponentId: opponent.fighterId,
    corner: self.corner,
    tick: self.sensoryHistory.length,
    round: 0,
    roundTime: 0,
    actionReady: self.actionElapsed >= self.actionDuration || defensiveWindow,
    currentAction: self.action,
    lastAction: self.lastAction,
    actionRecency: self.actionRecency,
    attackSequence: self.attackSequence,
    distanceMeters: round(distance, 3),
    stamina: self.stamina,
    balance: self.balance,
    hurtSeconds: self.hurtSeconds,
    guardStreak: self.guardStreak,
    pocketSeconds: self.pocketSeconds,
    comboPlan: [...self.comboPlan],
    comboIndex: self.comboIndex,
    workingMemory: [...self.workingMemory],
    strategy: { ...self.currentPlan },
    opponentAction: incoming.action,
    opponentPunchTarget: incoming.target,
    incomingThreat: incoming.threat,
    features,
    actionMask,
  };
}

function strategyActionBias(
  action: FighterAction,
  strategy: StrategyDirective,
) {
  let bias = 0;
  const powerShot =
    action === "crossHead" ||
    action === "hookHead" ||
    action === "crossBody" ||
    action === "hookBody" ||
    action === "uppercut";
  const defensive =
    action === "guard" ||
    action === "slip" ||
    action === "duck" ||
    action === "weave" ||
    action === "retreat" ||
    action === "recover";

  if (strategy.focus === "pressure") {
    if (action === "advance") bias += 0.55;
    if (powerShot) bias += 0.28;
  }
  if (strategy.focus === "counter") {
    if (action === "slip" || action === "weave" || action === "retreat") bias += 0.42;
    if (action === "crossHead" || action === "crossBody") bias += 0.24;
  }
  if (strategy.focus === "bodyWork" && PUNCH_SPECS[action]?.target === "body") {
    bias += 0.58;
  }
  if (strategy.focus === "outside") {
    if (action === "jabHead" || action === "retreat" || CIRCLES.has(action)) bias += 0.42;
  }
  if (strategy.focus === "recover") {
    if (action === "recover" || action === "guard" || action === "retreat") bias += 0.5;
  }
  if (strategy.focus === "evasive") {
    if (EVASIONS.has(action) || CIRCLES.has(action) || PIVOTS.has(action)) bias += 0.46;
  }

  if (ATTACKS.has(action) || action === "advance") bias += strategy.pace * 0.22;
  if (action === "recover" || action === "guard") bias -= strategy.pace * 0.18;
  if (powerShot) bias += strategy.risk * 0.25;
  if (defensive) bias -= strategy.risk * 0.18;
  if (PUNCH_SPECS[action]?.target === strategy.target) bias += 0.24;
  if (strategy.ringMode === "pressure" && action === "advance") bias += 0.3;
  if (strategy.ringMode === "outside" && (action === "retreat" || CIRCLES.has(action))) bias += 0.28;
  if (strategy.ringMode === "center" && PIVOTS.has(action)) bias += 0.2;

  return clamp(bias, -1.2, 1.2);
}

interface FightStyle {
  pressure: boolean;
  counter: boolean;
  outside: boolean;
  body: boolean;
  volume: boolean;
  explosive: boolean;
}

function fightStyle(fighter: Fighter, strategy: StrategyDirective): FightStyle {
  const a = fighter.archetype.toLowerCase();
  return {
    pressure: a.includes("pressure") || a.includes("infighter") || strategy.focus === "pressure",
    counter: a.includes("counter") || strategy.focus === "counter",
    outside:
      a.includes("outfighter") ||
      a.includes("angle") ||
      a.includes("volume") ||
      a.includes("technician") ||
      strategy.focus === "outside",
    body: a.includes("body") || strategy.focus === "bodyWork",
    volume: a.includes("volume") || a.includes("technician"),
    explosive: a.includes("explosive") || a.includes("puncher"),
  };
}

// A deterministic boxing brain. It reads range, threat and health and returns a
// preference per action that encodes actual tactics — find range with the jab,
// step in behind it, work the body up close, slip and counter, reset the angle
// after a combo, cover and survive when hurt — shaded by the fighter's style.
// This drives the live bout; the trained neural net only nudges the choice, so
// behaviour is consistent and readable instead of swinging between 0% and 64%
// landing depending on how the recurrent weights happened to settle.
function tacticalPreference(
  action: FighterAction,
  observation: TrainingObservation,
  reach: number,
  style: FightStyle,
  // How much this man lives off head movement in the pocket, 0..1.2 off speed
  // and reaction. A slick featherweight moves on every beat; a slow heavyweight
  // trusts his guard and his chin, which is why the divisions separate.
  quickness = 1,
): number {
  const d = observation.distanceMeters;
  const f = observation.features;
  const spec = PUNCH_SPECS[action];
  const jabRange = reach + 0.16;
  // Four real ranges rather than one. Each punch owns a band, so the arsenal
  // actually gets used instead of every exchange collapsing into jab/cross.
  //   tight  — chest to chest, only short rising and looping shots fit
  //   pocket — hooks and body work
  //   mid    — the straight-punch range
  //   long   — jab and footwork
  const closeRange = reach * 0.92;
  const tightRange = reach * 0.74;
  const midRange = reach * 1.06;
  const inTight = d <= tightRange;
  const inPocket = d <= closeRange;
  const inMid = d > closeRange && d <= midRange;
  const inRange = d <= jabRange;
  const outOfRange = d > jabRange;
  const oppThrowing = observation.incomingThreat > 0;
  const straightToHead =
    observation.opponentAction === "jabHead" ||
    observation.opponentAction === "crossHead";
  const hookToHead = observation.opponentAction === "hookHead";
  const uppercutComing = observation.opponentAction === "uppercut";
  const bodyShotComing = observation.opponentPunchTarget === "body";
  const oppHurt = f[FEATURE.opponentHurt] > 0.25 || f[FEATURE.opponentOffBalance] > 0.55;
  const oppBadlyHurt = f[FEATURE.opponentHurt] > 0.55;
  const oppGuard = f[FEATURE.opponentGuard] > 0.5;
  const oppLow = f[FEATURE.opponentLowLevel] > 0.4;
  const oppOnRopes = f[FEATURE.opponentRope] > 0.55;
  const ownRopes = f[FEATURE.ownRope] > 0.6;
  const justThrew = ATTACKS.has(observation.lastAction);
  const seq = observation.attackSequence;
  // Genuinely in trouble — not merely "has been working". A flat stamina cliff
  // at 20 put both men permanently in survival mode and turned the fight into
  // nine minutes of covering up, so survival now keys off actually being under
  // fire: taking sustained clean punishment with nothing coming back. Those
  // signals decay once the assault stops, so a fighter covers through a bad
  // spell and then gets back to work instead of turtling for the rest of the round.
  const underFire =
    f[FEATURE.sustainedPressure] > 0.68 && f[FEATURE.recentHeadImpact] > 0.55;
  const hurt =
    observation.balance < 0.45 ||
    observation.stamina < 11 ||
    (underFire && observation.stamina < 42);
  const badlyHurt = observation.hurtSeconds > 1.2;
  // An infighter is happy in there; everyone else needs to get out and reset
  // before the exchange turns into a shoving match on the separation floor.
  const pocketPatience = style.pressure ? 3.4 : style.outside ? 1.1 : 2.0;
  const overstayed = observation.pocketSeconds > pocketPatience;

  let s = 0;

  // 1) Survival overrides everything — protect and reset, do not stand and trade.
  // A man whose legs are gone covers, holds and tries to get his head off the
  // centre-line; he does not calmly box. If he is against the ropes he has to
  // move first, because standing there is how a bad moment becomes a stoppage.
  if (hurt || badlyHurt) {
    if (action === "guard") s += badlyHurt ? 3.2 : 2.6;
    if (action === "retreat") s += ownRopes ? 1.0 : 2.2;
    if (action === "slip" || action === "weave") s += 1.5;
    if (CIRCLES.has(action)) s += ownRopes ? 2.6 : 1.3;
    if (PIVOTS.has(action)) s += ownRopes ? 2.2 : 0.6; // pivot off the ropes
    if (action === "recover" && d > closeRange) s += 1.8;
    if (spec) s -= 2.6;
    // Even hurt, a fighter throws something to buy space rather than eat shots.
    if (action === "jabHead" && d > closeRange) s += 1.4;
    return s;
  }

  // 2) In the pocket with nothing yet on the way: keep the head moving anyway.
  // A reaction is physically too slow for a jab — the only slip that beats one
  // was already happening when the jab left. This is the habit good trainers
  // drill ("move your head after you punch"), scored by quickness so the men
  // who actually have the reflexes are the ones who live off it.
  if (!oppThrowing && inRange && EVASIONS.has(action)) {
    s += 2.2 * quickness * (style.counter || style.outside ? 1.15 : 1);
  }

  // 2b) There is a punch coming and we are in its range: defend, and counter.
  // Defence is a MIX — a fighter who only ever raises a static guard gets
  // out-jabbed all night, so slips, rolls and counters carry real weight and the
  // guard is just one option, not the default.
  if (oppThrowing && inRange) {
    // Pick the defence that fits the line of the shot. Straights are slipped or
    // rolled under, or made short with a step-back; hooks are ducked or rolled;
    // uppercuts and body shots are never answered by dropping the head into
    // their path.
    if (straightToHead) {
      if (action === "slip") s += style.counter ? 5.0 : 4.5;
      if (observation.opponentAction === "crossHead") {
        if (action === "duck") s += 3.6;
        if (action === "weave") s += 3.3;
      }
      if (action === "retreat" && !ownRopes) s += style.outside ? 3.5 : 2.6;
      if (action === "guard") s += 1.0;
    } else if (hookToHead) {
      if (action === "duck") {
        s += oppLow ? 2.2 : style.pressure || style.explosive ? 5.5 : 5.2;
      }
      if (action === "weave") {
        s += style.counter || style.outside ? 5.25 : 4.5;
      }
      if (action === "retreat" && !ownRopes) s += 2.2;
      if (action === "guard") s += 1.1;
    } else if (uppercutComing || bodyShotComing) {
      if (action === "retreat" && !ownRopes) s += style.outside ? 4.0 : 3.2;
      if (action === "guard") s += bodyShotComing ? 1.8 : 1.3;
      if (CIRCLES.has(action)) s += 1.3;
    }
    if (CIRCLES.has(action)) s += 0.7;
    if ((style.pressure || style.explosive) && (action === "crossHead" || action === "hookHead")) {
      s += 1.0; // meet fire with fire
    }
  }

  // 2c) The counter read. A committed punch is an opening as well as a threat,
  // and the size of the opening is the size of the answer it invites: a
  // flicked jab leaves most of a guard in place and is barely worth trading
  // into, a full-stretch uppercut is begging for the cross over the top.
  // Everyone sees it; the counter-puncher is the one who lives off it.
  //
  // Deliberately NOT inside the oppThrowing block above: the threat read goes
  // quiet the moment contact passes, and the recoil after contact is exactly
  // when the man is most open and most counterable. Exposure gates itself —
  // it is zero until the shot has committed — so this fires on the commit and
  // the recoil, which is when a counter is actually thrown. It replaces the
  // old flat style.counter bonuses, which were backwards: they paid more for
  // countering a jab than a hook.
  const oppExposure = f[FEATURE.opponentExposure];
  if (oppExposure > 0.1 && inRange && !hurt && !badlyHurt) {
    if (action === "crossHead") s += oppExposure * (style.counter ? 3.1 : 1.7);
    if (action === "hookHead" && inPocket) s += oppExposure * (style.counter ? 1.8 : 1.0);
    if (action === "uppercut" && inTight) s += oppExposure * (style.counter ? 2.0 : 1.1);
  }

  // 3) Out of range: close it (or cut an angle), do not wing power shots at air.
  if (outOfRange) {
    if (action === "advance") s += style.outside ? 1.7 : 2.6;
    if (CIRCLES.has(action)) s += style.outside ? 1.9 : 0.9;
    if (action === "jabHead" && d < jabRange + 0.22) s += 1.5; // range-finding jab
    if (spec && action !== "jabHead") s -= 1.6;
    if (action === "guard") s -= 1.3;
    // Catching a breath out here is scored once, in section 5b.
  }

  // 4) In range and free to work. Each punch owns a range band and a reason, so
  // the selection reads like a boxer picking shots rather than one action always
  // winning the argmax and the rest of the arsenal never appearing.
  // Offence is NOT gated on the opponent being idle. Two boxers trade — gating
  // it meant any fighter who saw a punch coming could only cover, both men did
  // that at once, and the bout stalled into a mutual staring contest. Instead a
  // fighter in an exchange discounts his own offence by how willing he is to
  // stand in it: a pressure fighter or a banger trades, a technician gives ground.
  const tradeWillingness = !oppThrowing
    ? 1
    : (style.pressure || style.explosive ? 0.92 : style.counter ? 0.78 : 0.62) *
      (oppBadlyHurt ? 1.3 : 1);
  let atk = 0;
  if (inRange) {
    const comboOpen = seq < (style.volume ? 4 : style.pressure ? 3 : 2);
    if (comboOpen) {
      // -- long / mid: the straight punches own this range --
      if (action === "jabHead") {
        atk += style.outside || style.volume ? 2.3 : 1.7;
        if (inMid || !inPocket) atk += 0.8; // the jab is a range punch
        if (inTight) atk -= 1.4; // no room to extend it chest to chest
      }
      if (action === "crossHead") {
        atk += (justThrew ? 2.0 : 1.1) + (style.explosive ? 0.8 : 0) + (style.counter ? 0.6 : 0);
        if (inMid) atk += 0.7; // its natural range
        if (inTight) atk -= 1.6;
      }
      if (action === "crossBody") {
        // The straight to the midsection — a mid-range shot, and the reply to a
        // high guard from outside hooking range.
        atk += 0.9 + (style.body ? 1.1 : 0);
        if (inMid || (inPocket && !inTight)) atk += 1.0;
        if (oppGuard) atk += 0.9;
        if (inTight) atk -= 1.2;
      }
      if (action === "jabBody") {
        // A range-finder downstairs that drags the guard down with it.
        atk += 0.7 + (style.body ? 0.9 : 0);
        if (oppGuard) atk += 1.0;
        if (!justThrew) atk += 0.5; // often the shot that starts a sequence
        if (inTight) atk -= 0.8;
      }

      // -- pocket: hooks and body work --
      if (inPocket) {
        if (action === "hookHead") atk += 1.6 + (style.explosive ? 0.7 : 0);
        if (action === "hookBody") atk += 1.3 + (style.body ? 1.3 : 0);
      }

      // -- tight: only the short rising and looping shots fit --
      if (inTight) {
        // The uppercut lives in here — a rising shot up the middle, best when the
        // opponent ducks in or covers up, and a genuine fight-ender when hurt.
        if (action === "uppercut") {
          atk += 2.2 + (style.explosive ? 0.9 : 0) + (justThrew ? 0.6 : 0);
          if (oppLow) atk += 1.6; // he is ducking onto it
          if (oppGuard) atk += 1.2; // straight up the middle of a tight guard
        }
        if (action === "hookHead") atk += 0.8;
        if (action === "hookBody") atk += 0.9;
      }

      if (oppHurt && action === "uppercut") atk += 1.4; // load up the finisher
      if (oppGuard && spec?.target === "body") atk += 1.0; // dig downstairs
      if (oppGuard && action === "hookHead") atk += 0.5; // or bend one around it
      if (oppHurt && (action === "crossHead" || action === "hookHead")) atk += 1.8;
    } else {
      // Combo spent — get off the centre-line, reset the angle, re-enter. A pivot
      // is the move when he is on the ropes: it keeps him pinned and opens a new
      // angle, where circling would let him back to the middle of the ring.
      if (CIRCLES.has(action)) s += oppOnRopes ? 0.6 : 1.7;
      if (PIVOTS.has(action)) s += oppOnRopes ? 2.4 : 1.3;
      if (action === "retreat" && style.outside) s += 1.1;
      if (spec) s -= 1.6;
    }
    // A man in real trouble gets swarmed, and gets cut off rather than chased.
    // This sits outside the trade discount: nobody backs off a hurt opponent.
    if (oppBadlyHurt) {
      if (spec) s += 1.5;
      if (action === "advance") s += 1.2;
      if (CIRCLES.has(action) || action === "retreat") s -= 1.8;
      if (action === "guard") s -= 2.4;
    }
    // What each punch costs to throw into traffic. The trade discount below is
    // flat across the arsenal; this is the shaped half — a jab keeps most of a
    // guard while it travels and an uppercut keeps none, so the shot a man
    // picks with leather already coming back at him is a timing decision, not
    // a damage race.
    if (spec && oppThrowing) {
      atk -= observation.incomingThreat * (1 - spec.coverage) * 1.2;
    }
  }
  s += atk * tradeWillingness;

  // 5) Never freeze in a static guard when nothing is coming. Turtling is how a
  // fight stalls out, so the longer a fighter hides behind the gloves the worse
  // the option scores — a guard is a reaction to a punch, not a resting state.
  if (action === "guard") {
    if (!oppThrowing && observation.stamina > 45) s -= 1.5;
    if (!oppThrowing) s -= clamp(observation.guardStreak, 0, 6) * 0.55;
    if (outOfRange) s -= 1.2; // nothing can reach you out here
  }
  /* 5b) Running on empty.
   *
   * A gassed fighter does not just keep boxing at a lower rate — he buys
   * himself air. He backs out from under the other man, or he covers up and
   * breathes behind the gloves, and both `recover` and `guard` genuinely put
   * stamina back, so this is a real tactic rather than flavour. Previously the
   * only nod to it was a +1.4 on `recover`, which lost every argmax it entered:
   * fighters ran themselves to nothing and then kept trading on an empty tank.
   *
   * Scaled by how empty he actually is, and gone by the time he is back over a
   * third of a tank. That taper IS the anti-stall: `recover` refills roughly
   * seven stamina a second, so he gets about four seconds of air and then the
   * ordinary scoring — which pays well for closing the distance — takes back
   * over on its own. Two more guards against the corner-camping failure:
   *
   *  - Backing up only scores while the opponent is actually ON him. The moment
   *    there is space the reward moves to `recover`, which is stationary, so he
   *    cannot walk himself to the far side of the ring to rest. (Retreat is
   *    already illegal at the rear rope, so he cannot back into it either.)
   *  - On his own ropes the bonus moves to circling OFF them. Resting with your
   *    back on the ropes is how a tired fighter gets stopped.
   *
   * The guard-streak penalty in section 5 still applies throughout, so covering
   * up remains a breather he takes, not a shell he lives in. */
  /* Nothing at 40, full weight by 14 — and NOT a fraction of the tank, which is
   * the trap. Scaled as `(32 - stamina) / 32` this only reached full strength at
   * literally zero: a man on 20 got barely a third of the drive and kept losing
   * the argmax to a punch, so he stood there trading on an empty tank exactly as
   * before. It has to bite while he still has something left to protect. */
  const gassed = clamp((40 - observation.stamina) / 26, 0, 1);
  if (gassed > 0.05) {
    if (action === "recover" && !oppThrowing && d > closeRange) s += gassed * 3.4;
    if (action === "guard" && (oppThrowing || inRange)) s += gassed * 2.2;
    if (action === "retreat" && inRange && !ownRopes) s += gassed * 2.6;
    if (CIRCLES.has(action) && ownRopes) s += gassed * 2.0;
    if (PIVOTS.has(action) && ownRopes) s += gassed * 1.4;
    // Anything with a real price on it gets shelved until the air is back —
    // but never the jab, so a tired man can still hold someone off him.
    if (spec) s -= gassed * (spec.staminaCost > 2.4 ? 2.4 : 1.2);
    if (action === "jabHead" && d > closeRange) s += gassed * 0.9;
  } else if (action === "recover") {
    s -= 1.6;
  }

  /* 5c) HE is the one running on empty.
   *
   * The mirror of 5b, and the half that was missing. `FEATURE.opponentFatigue`
   * has sat in the observation vector all along with nothing reading it, so a
   * gassed fighter would back out to buy air and the fresh man would simply let
   * him have it — both resetting to range while one of them quietly got his legs
   * back. No boxer does that. You close him down, you make him work, and you
   * take what is left of the air out of him downstairs.
   *
   * Gated on actually BEING the fresher man rather than merely on him being
   * tired: scaled by the stamina gap, so two exhausted fighters still get the
   * ugly, honest last round they have earned instead of both charging. */
  const opponentStamina = (1 - f[FEATURE.opponentFatigue]) * 100;
  const press =
    clamp((40 - opponentStamina) / 26, 0, 1) *
    clamp((observation.stamina - opponentStamina) / 22, 0, 1);
  if (press > 0.05) {
    // Cut the ring off rather than chase him round it. A pivot keeps him pinned
    // where circling would hand him the middle of the ring and a place to breathe.
    if (action === "advance") s += press * (outOfRange ? 3.0 : 1.8);
    if (PIVOTS.has(action)) s += press * (oppOnRopes ? 2.2 : 1.0);
    // Downstairs is how a tired man is kept tired — body shots drain stamina
    // directly, so the investment compounds instead of merely scoring.
    if (spec?.target === "body") s += press * 1.9;
    // Raise the work rate generally: he cannot answer it, and every exchange
    // costs him more than it costs you.
    if (spec) s += press * 0.8;
    // And do not hand him the break he is trying to buy. Kept under the
    // pocket-break weights in section 7 on purpose — cutting a man off must not
    // turn into standing in front of him for the rest of the round.
    if (action === "retreat") s -= press * 2.0;
    if (action === "recover") s -= press * 3.0;
    if (action === "guard" && !oppThrowing) s -= press * 1.8;
  }

  // 6) Standing style flavour on the feet.
  if (style.outside && CIRCLES.has(action) && inRange) s += 0.5;
  if (style.pressure && action === "advance") s += 0.6;

  // 7) Break out of the pocket. Once he has been in tight long enough, stepping
  // back out and resetting the range beats standing there — this is what gives
  // the fight its in-and-out rhythm instead of one long clinch at arm's length.
  if (overstayed && inPocket) {
    const urgency = clamp((observation.pocketSeconds - pocketPatience) / 2, 0, 1.6);
    if (action === "retreat") s += (1.9 + urgency) * (ownRopes ? 0.3 : 1);
    if (PIVOTS.has(action)) s += 1.6 + urgency;
    if (CIRCLES.has(action)) s += 1.2 + urgency * 0.6;
    if (action === "advance") s -= 2.0;
    if (action === "guard") s -= 1.4;
    if (spec) s -= 0.9 + urgency * 0.5;
  }
  // Cut the ring off on a man who is backing into the ropes.
  if (oppOnRopes && (action === "advance" || PIVOTS.has(action))) s += 0.8;

  return s;
}

export function getPolicyDecision(
  fighter: Fighter,
  observation: TrainingObservation,
  nonce = 0,
): PolicyDecision {
  const reach = armLengthMeters(fighter);
  const style = fightStyle(fighter, observation.strategy);
  const neural = runNeuralPolicy(
    fighter.policy,
    observation.features,
    observation.workingMemory,
  );
  const adjustedScores = [...neural.actionScores];
  const influence = neuralInfluence(fighter.policy);
  let selected: FighterAction = "guard";
  let selectedScore = Number.NEGATIVE_INFINITY;

  ACTIONS.forEach((action, actionIndex) => {
    if (!observation.actionMask[actionIndex]) {
      adjustedScores[actionIndex] = Number.NEGATIVE_INFINITY;
      return;
    }
    const spec = PUNCH_SPECS[action];
    // The deterministic boxing brain leads and the trained net gets a say
    // proportional to what it has learned — a debutant is nudged, an athlete a
    // season deep is largely driving. See `neuralInfluence`.
    let score =
      adjustedScores[actionIndex] * influence +
      strategyActionBias(action, observation.strategy) +
      tacticalPreference(
        action,
        observation,
        reach,
        style,
        clamp(
          ((fighter.stats.speed + fighter.stats.reaction) / 2 - 50) / 45,
          0,
          1.2,
        ),
      ) * 2.2;
    // Hard constraints the tactics must not override.
    if (spec && observation.distanceMeters > reach * spec.reachFactor + 0.34) score -= 6;
    if (spec && observation.balance < 0.35) score -= 4;
    if (spec && observation.attackSequence >= 4) score -= 9; // no marathon combos
    // Light anti-repeat so identical actions do not lock in a loop.
    if (observation.lastAction === action && (EVASIONS.has(action) || PIVOTS.has(action))) {
      score -= 0.8;
    }
    // Going straight back to the punch he has just thrown is the single most
    // obvious tell that a man is running off a script rather than boxing.
    if (observation.lastAction === action && spec) score -= 1.1;
    // And the subtler tell: the same shot every other decision, with a step in
    // between, which `lastAction` cannot see at all. A fighter who has leaned on
    // one thing gets steadily more reluctant to go back to it, so the answer
    // changes even when the position does not. It decays quickly, so a genuinely
    // available shot is only ever deferred, never abandoned.
    score -= Math.min(observation.actionRecency[actionIndex] ?? 0, 2.4) * REPETITION_FATIGUE;
    // Choosing strictly by the best score makes the whole fight a fixed point:
    // put a fighter back in a position he has been in before and he produces the
    // identical answer, which is what set the ring cycling through the same
    // two-punch shape all night. This unsettles close calls only — anything the
    // boxing brain actually feels strongly about still wins comfortably — and it
    // is a hash rather than a die, so the bout still replays exactly.
    score += (decisionNoise(fighter.seed, nonce, actionIndex) - 0.5) * DECISION_JITTER;
    adjustedScores[actionIndex] = score;

    if (score > selectedScore) {
      selected = action;
      selectedScore = score;
    }
  });

  const finiteScores = adjustedScores.filter(Number.isFinite);
  const maximum = Math.max(...finiteScores);
  const exponentials = adjustedScores.map((score) =>
    Number.isFinite(score) ? Math.exp(score - maximum) : 0,
  );
  const exponentialTotal = exponentials.reduce((sum, value) => sum + value, 0);
  const selectedIndex = ACTIONS.indexOf(selected);
  const sortedScores = [...finiteScores].sort((a, b) => b - a);
  const activity =
    neural.hiddenActivations.reduce(
      (sum, activation) => sum + Math.abs(activation),
      0,
    ) / Math.max(1, neural.hiddenActivations.length);
  const memoryActivity =
    neural.nextMemory.reduce(
      (sum, activation) => sum + Math.abs(activation),
      0,
    ) / Math.max(1, neural.nextMemory.length);

  return {
    action: selected,
    intent: neural.intent,
    intentIndex: neural.intentIndex,
    confidence: round(
      exponentialTotal > 0
        ? (exponentials[selectedIndex] / exponentialTotal) * 100
        : 0,
      1,
    ),
    margin: round(sortedScores[0] - (sortedScores[1] ?? sortedScores[0]), 3),
    brainActivity: round(activity * 100, 1),
    memoryActivity: round(memoryActivity * 100, 1),
    nextMemory: neural.nextMemory.map((value) => round(value, 4)),
    hiddenActivations: neural.hiddenActivations.map((value) => round(value, 4)),
    actionScores: adjustedScores.map((value) =>
      Number.isFinite(value) ? round(value, 4) : value,
    ),
    neuralActionScores: neural.actionScores.map((value) => round(value, 4)),
    intentScores: neural.intentScores.map((value) => round(value, 4)),
  };
}

export function selectPolicyAction(
  fighter: Fighter,
  observation: TrainingObservation,
) {
  return getPolicyDecision(fighter, observation).action;
}

function chooseAction(
  fighter: Fighter,
  self: BoutFighter,
  opponent: BoutFighter,
  opponentTelegraph: LivePunchRead = opponent,
) {
  const observation = buildTrainingObservation(
    fighter,
    self,
    opponent,
    opponentTelegraph,
  );
  // The decision count is what makes each choice its own draw rather than one
  // fixed answer this fighter gives forever.
  return {
    observation,
    decision: getPolicyDecision(fighter, observation, self.decisionCount),
  };
}

/** What an exhausted fighter is still allowed to do.
 *
 * Exhibition only — `exhaustionRules` is absent on everybody the league books,
 * so a real bout returns on the first line and behaves exactly as before.
 *
 * Applied here rather than in the action mask because the mask is advisory: a
 * forced corner walks straight past it, so a mask-only rule would gas the AI
 * and leave the player throwing uppercuts on an empty tank. Every action,
 * chosen or forced, comes through `startAction`, which makes this the one place
 * the rule cannot be routed around.
 *
 * A gassed man is not helpless. He can cover, slip, duck, weave and move his
 * feet as much as he likes; what he loses is the ability to keep punching. */
function throttleWhenGassed(
  runtime: BoutFighter,
  fighter: Fighter,
  action: FighterAction,
): FighterAction {
  const rules = fighter.exhaustionRules;
  if (!rules) return action;

  // Latch, so the two thresholds actually mean something. He goes under at
  // `gassedAt` and stays under until he has climbed all the way to
  // `recoveredAt`; a single threshold with a guard regenerating 1.9 a second
  // put him back in business inside half a second, over and over.
  if (runtime.gassed) {
    if (runtime.stamina >= rules.recoveredAt) runtime.gassed = false;
  } else if (runtime.stamina <= rules.gassedAt) {
    runtime.gassed = true;
  }

  if (!runtime.gassed || !ATTACKS.has(action)) return action;
  // Power shots are simply gone until he gets his wind back.
  if (action !== "jabHead" && action !== "jabBody") return "guard";
  if (runtime.punchLockSeconds > 0) return "guard";
  runtime.punchLockSeconds = rules.jabCooldownSeconds;
  return action;
}

function startAction(
  runtime: BoutFighter,
  action: FighterAction,
  fighter: Fighter,
  opponent: BoutFighter,
) {
  runtime.lastAction = runtime.action;
  // Fade what he has been doing and mark what he has just done. The half-life is
  // a handful of decisions, so this is "what have I been showing him lately",
  // not a record of the round.
  const chosenIndex = ACTIONS.indexOf(action);
  runtime.actionRecency = runtime.actionRecency.map((value, index) =>
    round(value * 0.72 + (index === chosenIndex ? 1 : 0), 4),
  );
  runtime.attackSequence = ATTACKS.has(action)
    ? runtime.attackSequence + 1
    : 0;
  runtime.guardStreak = action === "guard" ? runtime.guardStreak + 1 : 0;
  runtime.action = action;
  runtime.actionCounts[action] += 1;
  runtime.actionElapsed = 0;
  runtime.actionDuration = actionDuration(action, fighter, runtime);
  runtime.punchResolved = false;
  runtime.previousHandExtension = 0;
  runtime.handExtension = 0;
  runtime.handVelocity = 0;

  const spec = PUNCH_SPECS[action];
  if (spec) {
    runtime.punchHand =
      action === "jabHead" || action === "jabBody"
        ? "lead"
        : action === "crossHead" || action === "crossBody"
          ? "rear"
          : runtime.punchHand === "lead"
            ? "rear"
            : "lead";
    // Stance finally decides something physical. An orthodox lead hand is the
    // left, a southpaw lead is the right, so the same jab arrives at the other
    // man's head from opposite sides depending on who is throwing it.
    const leadIsLeft = fighter.stance === "Orthodox";
    runtime.punchSide =
      (runtime.punchHand === "lead") === leadIsLeft ? 1 : -1;
    const seen = perceivedSnapshot(opponent, fighter);
    const aimZone = intendedImpactZone(action);
    const anatomy = anatomicalAimOffset(aimZone);
    const defenderFacing = ringVector(seen, runtime);
    runtime.punchAimZone = aimZone;
    runtime.punchAimOffset =
      (spec.target === "head" ? seen.headOffset : 0) + anatomy.lateral;
    const perceivedTarget = targetPosition(runtime, seen, spec.target);
    perceivedTarget.x += defenderFacing.leftX * anatomy.lateral;
    perceivedTarget.y += defenderFacing.leftY * anatomy.lateral;
    perceivedTarget.z += anatomy.vertical;
    const aimX = perceivedTarget.x - runtime.x;
    const aimY = perceivedTarget.y - runtime.y;
    const planarDistance = Math.max(0.0001, Math.hypot(aimX, aimY));
    runtime.punchDirectionX = aimX / planarDistance;
    runtime.punchDirectionY = aimY / planarDistance;
    runtime.punchAimHeight = perceivedTarget.z;
    const targetRadius =
      spec.target === "head"
        ? BOXING_MODEL.headRadiusMeters
        : BOXING_MODEL.bodyRadiusMeters;
    const maximumExtension = armLengthMeters(fighter) * spec.reachFactor;
    const perceivedExtension = clamp(
      planarDistance -
        0.13 -
        targetRadius -
        BOXING_MODEL.gloveRadiusMeters,
      0.1,
      maximumExtension,
    );
    runtime.punchExtensionTarget =
      perceivedExtension + (maximumExtension - perceivedExtension) * 0.15;
    runtime.thrown += 1;
    runtime.stamina = round(
      clamp(
        runtime.stamina - spec.staminaCost * (1.0 - fighter.stats.cardio / 500),
        0,
        100,
      ),
    );
  } else {
    runtime.punchSide = 0;
  }

  if (EVASIONS.has(action)) {
    runtime.evadeDirection = committedEvadeSide(runtime, fighter, opponent);
  }
}

/** Which way a fighter takes his head as he starts an evasion.
 *
 * This used to alternate on the decision counter, so the head went left, right,
 * left regardless of what was being thrown at it — half of all slips moved into
 * the punch, and none of them were a response to anything.
 *
 * A boxer slips OUTSIDE the hand that is coming: away from the shoulder it is
 * loading off, which takes the head off the punch's line and leaves it away from
 * the follow-up. He is doing that off a read, not off the punch itself, so the
 * side is committed here from the same lagged perception that chose the
 * evasion — a fighter who reads late slips into the shot, exactly as he should.
 *
 * Only straight punches are answered this way. A hook arrives on an arc that
 * lateral movement cannot beat, and stepping either way into one is worse than
 * standing still; that is what ducking and weaving are for, and the policy
 * already picks those. With nothing readable coming, the side falls back to a
 * hash of the situation rather than a visible left-right-left tick. */
function committedEvadeSide(
  runtime: BoutFighter,
  fighter: Fighter,
  opponent: BoutFighter,
) {
  const seen = perceivedSnapshot(opponent, fighter);
  const straight =
    seen.action === "jabHead" ||
    seen.action === "crossHead" ||
    seen.action === "jabBody" ||
    seen.action === "crossBody";
  if (straight && seen.punchSide !== 0) {
    // The two men face each other, so the hand on his left comes at this man's
    // right. Going the other way is what takes the head off the line.
    return seen.punchSide;
  }
  return decisionNoise(
    fighter.seed,
    runtime.decisionCount,
    Math.round(runtime.x * 10),
  ) < 0.5
    ? 1
    : -1;
}

// Real combinations. A boxer does not pick each punch from scratch — he commits
// to a sequence and lets it go, and the follow-up is thrown with the OTHER hand
// while the first is still coming back. The renderer maps jab/hook to the lead
// hand and cross/uppercut to the rear, so these templates also make the hands
// visibly alternate instead of the same arm pumping over and over.
//
// Keyed by the punch the policy chose to open with; the rest of the sequence
// follows from it. Ordered from most to least ambitious — the first entry whose
// range still fits gets thrown.
/** What a fighter throws behind each opening punch.
 *
 * Every opener needs enough templates that two men in the same spot are not
 * reaching for the same three shapes all night — `hookHead` and `uppercut` used
 * to hold two options each, which is why the ring kept showing the same
 * alternating pair. The longer templates only come out when the man has the
 * legs for them (see the budget in `planCombination`), so the short, honest
 * combinations still dominate a late round. */
const COMBINATIONS: Partial<Record<FighterAction, FighterAction[][]>> = {
  jabHead: [
    ["crossHead", "hookHead"], // 1-2-3
    ["crossHead", "hookBody"], // 1-2 to the body
    ["jabHead", "crossHead"], // double jab, straight right
    ["jabHead", "jabHead"], // triple jab, walking him onto it
    ["crossBody"], // up top, then downstairs
    ["crossHead"], // the plain 1-2
    ["crossHead", "hookHead", "crossHead"], // 1-2-3-2
    ["crossHead", "uppercut", "hookHead"], // 1-2-6-3
    ["uppercut", "hookHead"], // splitting a tight guard
    ["hookBody", "hookHead"], // downstairs, then back up top
    ["jabBody", "crossHead"], // jab up, jab down, right hand
    ["hookHead", "crossHead"], // 1-3-2
  ],
  jabBody: [
    ["crossHead", "hookHead"], // down-up-around
    ["crossHead"],
    ["jabHead", "crossHead"], // down to bring the guard, then up
    ["hookHead"],
    ["crossBody", "hookHead"],
    ["uppercut", "hookHead"],
  ],
  crossHead: [
    ["hookHead"], // 2-3
    ["hookBody", "hookHead"],
    ["uppercut"],
    ["hookHead", "crossHead"], // 2-3-2
    ["jabHead", "crossHead"], // step off behind the jab, right hand again
    ["hookBody", "crossHead"],
    ["uppercut", "hookHead", "crossHead"],
    ["crossBody"], // same hand, downstairs
  ],
  crossBody: [
    ["hookHead"],
    ["jabHead"],
    ["hookHead", "crossHead"],
    ["uppercut"],
    ["jabHead", "crossHead"],
  ],
  hookHead: [
    ["crossHead"],
    ["uppercut"],
    ["hookBody"], // same hand, head then ribs
    ["crossHead", "hookHead"], // 3-2-3
    ["uppercut", "crossHead"],
    ["jabHead", "crossHead"],
  ],
  hookBody: [
    ["hookHead"], // 3b-3, the classic up-down
    ["crossHead"],
    ["hookHead", "crossHead"],
    ["uppercut"],
    ["crossHead", "hookHead"],
  ],
  uppercut: [
    ["hookHead"], // 6-3
    ["crossHead"],
    ["hookHead", "crossHead"], // 6-3-2
    ["hookBody"],
    ["crossHead", "hookHead"],
    ["jabHead", "crossHead"],
  ],
};

// Can this punch physically be thrown from where the fighter is standing?
function punchFitsRange(
  action: FighterAction,
  distance: number,
  reach: number,
) {
  const spec = PUNCH_SPECS[action];
  if (!spec) return false;
  const targetRadius =
    spec.target === "head"
      ? BOXING_MODEL.headRadiusMeters
      : BOXING_MODEL.bodyRadiusMeters;
  const maxReach =
    reach * spec.reachFactor + 0.13 + targetRadius + BOXING_MODEL.gloveRadiusMeters;
  return distance <= maxReach + 0.1;
}

function planCombination(
  runtime: BoutFighter,
  fighter: Fighter,
  opener: FighterAction,
  distance: number,
) {
  const options = COMBINATIONS[opener];
  if (!options) return;
  const reach = armLengthMeters(fighter);
  // A tired or rocked fighter shortens up; a volume puncher lets more go.
  //
  // Deliberately left where it was. Letting the better-conditioned men throw
  // four and five punch strings made the whole league a volume-punching one:
  // land rate went up seven points and knockdowns fell to an identical 0.58 a
  // bout in every division, which wipes out the heavyweight's whole identity.
  // The variety belongs in how many templates exist, not in how long they run.
  const budget =
    runtime.stamina < 30 || runtime.hurtSeconds > 0.6
      ? 1
      : fighter.stats.cardio >= 88
        ? 3
        : 2;
  // Rotating strictly on the decision count made the choice a fixed cycle: the
  // same fighter reached for the same template every nth time he opened up,
  // whatever was in front of him. Mixing the range and how much is left in the
  // tank means a man picks differently at long range than on the inside, and
  // differently again in the last round than in the first.
  const offset = Math.floor(
    decisionNoise(
      fighter.seed,
      runtime.decisionCount,
      Math.round(distance * 20),
      Math.round(runtime.stamina / 10),
    ) * options.length,
  );
  // Only a few templates get considered, not the whole book. Scanning every
  // option meant that simply writing more combinations down made a fighter far
  // likelier to find one that fit and open up at all — the library grew and the
  // league gained seven points of land rate without anybody deciding it should.
  // A boxer sees two or three things he can throw from here, not twelve.
  const considered = Math.min(options.length, 3);
  for (let i = 0; i < considered; i += 1) {
    const candidate = options[(offset + i) % options.length];
    if (candidate.length > budget) continue;
    if (candidate.every((punch) => punchFitsRange(punch, distance, reach))) {
      runtime.comboPlan = [...candidate];
      runtime.comboIndex = 0;
      return;
    }
  }
}

function updateDecision(
  runtime: BoutFighter,
  opponent: BoutFighter,
  fighter: Fighter,
  forcedAction?: FighterAction,
  ledger?: DecisionLedger,
  opponentTelegraph: LivePunchRead = opponent,
) {
  let earlyChoice: ReturnType<typeof chooseAction> | null = null;
  if (runtime.actionElapsed < runtime.actionDuration) {
    if (!defensiveActionInterruptible(runtime)) return;

    const read = chooseAction(fighter, runtime, opponent, opponentTelegraph);
    const reaction = forcedAction ?? read.decision.action;
    const reactionIndex = ACTIONS.indexOf(reaction);
    const defensiveInterrupt =
      read.observation.incomingThreat > 0 &&
      DEFENSIVE_REACTIONS.has(reaction) &&
      read.observation.actionMask[reactionIndex] &&
      reaction !== runtime.action;
    // A driven corner punches on the press, not on the next tick boundary. A
    // human tapping "jab" from a resting `recover` was waiting out up to 650 ms
    // of idle animation before his hand moved, which read as input lag rather
    // than boxing. Footwork, guard and recovery cancel into the strike the way
    // a real boxer throws off a step; a punch already in the air stays
    // committed (so combinations still land), and evasions and retreats stay
    // uncancellable exactly as `defensiveActionInterruptible` says. The AI
    // never takes this door — an undriven corner has no forced action.
    const drivenStrike =
      forcedAction !== undefined &&
      ATTACKS.has(forcedAction) &&
      !ATTACKS.has(runtime.action);
    if (!defensiveInterrupt && !drivenStrike) return;
    earlyChoice = read;
  }
  if (!earlyChoice && ATTACKS.has(runtime.action) && !runtime.punchResolved) {
    if (
      opponent.action === "slip" ||
      opponent.action === "duck" ||
      opponent.action === "weave" ||
      opponent.action === "retreat" ||
      opponent.action === "circleLeft" ||
      opponent.action === "circleRight" ||
      opponent.action === "pivotLeft" ||
      opponent.action === "pivotRight"
    ) {
      opponent.round.defense += 1;
    }
  }
  const distance = ringDistance(runtime, opponent);
  const reach = armLengthMeters(fighter);

  // Mid-combination: let the sequence go rather than re-deciding every punch.
  // It is abandoned the moment it stops making sense — he gets rocked, the range
  // breaks, or the man in front of him goes down.
  if (!earlyChoice && !forcedAction && runtime.comboIndex < runtime.comboPlan.length) {
    const next = runtime.comboPlan[runtime.comboIndex];
    const stillOn =
      runtime.hurtSeconds < 0.6 &&
      runtime.balance >= 0.4 &&
      runtime.stamina > 8 &&
      opponent.downCountSeconds <= 0 &&
      punchFitsRange(next, distance, reach);
    if (stillOn) {
      runtime.comboIndex += 1;
      runtime.decisionCount += 1;
      startAction(runtime, throttleWhenGassed(runtime, fighter, next), fighter, opponent);
      return;
    }
    runtime.comboPlan = [];
    runtime.comboIndex = 0;
  }

  const { observation, decision } =
    earlyChoice ?? chooseAction(fighter, runtime, opponent, opponentTelegraph);
  runtime.tacticalIntent = decision.intent;
  runtime.decisionConfidence = decision.confidence;
  runtime.decisionMargin = decision.margin;
  runtime.brainActivity = decision.brainActivity;
  runtime.workingMemory = decision.nextMemory;
  runtime.memoryActivity = decision.memoryActivity;
  runtime.memoryUpdates += 1;
  runtime.decisionCount += 1;
  const action = forcedAction ?? decision.action;

  // A punch abandoned during its loading beat was never actually thrown. Keep
  // the public totals and the combo state honest before starting the defensive
  // reaction that replaced it.
  if (earlyChoice && ATTACKS.has(runtime.action)) {
    runtime.thrown = Math.max(0, runtime.thrown - 1);
    runtime.actionCounts[runtime.action] = Math.max(
      0,
      runtime.actionCounts[runtime.action] - 1,
    );
    runtime.attackSequence = Math.max(0, runtime.attackSequence - 1);
    runtime.comboPlan = [];
    runtime.comboIndex = 0;
  }

  // Write the choice down while the state that produced it is still to hand.
  // Only a real decision is recorded — the punches that come out of an already
  // committed combination were never chosen, and crediting them would reward
  // the brain for something it did not do.
  if (ledger) {
    const actionIndex = ACTIONS.indexOf(action);
    if (observation.actionMask[actionIndex]) {
      recordDecision(ledger, fighter.id, {
        features: observation.features,
        hidden: decision.hiddenActivations,
        previousMemory: observation.workingMemory,
        memory: decision.nextMemory,
        mask: observation.actionMask,
        actionIndex,
        actionScores: decision.neuralActionScores,
        intentIndex: decision.intentIndex,
        intentScores: decision.intentScores,
        value: rewardPotential(runtime, opponent),
      });
    }
  }

  // Opening a new attack: commit to a combination behind it.
  runtime.comboPlan = [];
  runtime.comboIndex = 0;
  if (!forcedAction && ATTACKS.has(action) && runtime.attackSequence === 0) {
    planCombination(runtime, fighter, action, distance);
  }

  startAction(runtime, throttleWhenGassed(runtime, fighter, action), fighter, opponent);
}

function updateMotion(
  runtime: BoutFighter,
  opponent: Pick<BoutFighter, "x" | "y">,
  fighter: Fighter,
) {
  const dt = BOXING_MODEL.physicsStepSeconds;
  const vector = ringVector(runtime, opponent);
  const fatigue = fatigueFactor(runtime);
  // Buzzed legs do not carry a man around the ring. Hurt costs more mobility
  // than a plain stun, which is what makes a hurt fighter visibly stagger and
  // get cut off against the ropes instead of calmly circling out.
  const neurologicalControl = clamp(
    1 - runtime.stunSeconds / 3 - clamp(runtime.hurtSeconds / 3.4, 0, 1) * 0.34,
    0.38,
    1,
  );
  const legDrive = 0.9 + fighter.conditioning.lowerBodyPower / 1000;
  // Footwork only, and only in an exhibition. Absent on every booked athlete,
  // so a real bout multiplies by nothing.
  const stride = fighter.movementScale ?? 1;
  const maxForward =
    (0.82 + fighter.stats.speed / 105) * fatigue * legDrive * neurologicalControl * stride;
  const maxBackward = maxForward * 0.82;
  const maxLateral = maxForward * 0.74;
  let desiredVelocityX = 0;
  let desiredVelocityY = 0;

  if (runtime.action === "advance") {
    desiredVelocityX = vector.forwardX * maxForward;
    desiredVelocityY = vector.forwardY * maxForward;
  }
  if (runtime.action === "retreat") {
    desiredVelocityX = -vector.forwardX * maxBackward;
    desiredVelocityY = -vector.forwardY * maxBackward;
  }
  if (runtime.action === "circleLeft" || runtime.action === "circleRight") {
    const side = runtime.action === "circleLeft" ? 1 : -1;
    desiredVelocityX = vector.leftX * maxLateral * side;
    desiredVelocityY = vector.leftY * maxLateral * side;
  }
  if (runtime.action === "pivotLeft" || runtime.action === "pivotRight") {
    const side = runtime.action === "pivotLeft" ? 1 : -1;
    desiredVelocityX =
      (vector.leftX * side + vector.forwardX * 0.16) * maxLateral * 0.74;
    desiredVelocityY =
      (vector.leftY * side + vector.forwardY * 0.16) * maxLateral * 0.74;
  }
  // Resetting is not standing still. A tired boxer buys his air by stepping off
  // and circling out of range, not by planting in front of the other man and
  // breathing — and since this is nearly a fifth of every fight, doing it on the
  // spot was a large part of why both men looked rooted. He drifts back and to
  // the side, which is what the action already claims to be.
  if (runtime.action === "recover") {
    const away = decisionNoise(fighter.seed, runtime.decisionCount) < 0.5 ? 1 : -1;
    desiredVelocityX =
      (-vector.forwardX * 0.62 + vector.leftX * away * 0.5) * maxBackward * RESET_STEP;
    desiredVelocityY =
      (-vector.forwardY * 0.62 + vector.leftY * away * 0.5) * maxBackward * RESET_STEP;
  }
  // A slip is a movement of the feet as much as the head — the weight shifts
  // onto the outside foot and the man ends up standing somewhere slightly
  // different, which is what leaves him on an angle instead of back where he
  // started. Pinning the feet through every evasion is why the ring showed two
  // men rooted to the spot taking turns: a fifth of the league's decisions were
  // slips and ducks, and not one of them moved anybody.
  if (EVASIONS.has(runtime.action)) {
    // Ducking takes him down and slightly in, under the shot. Slipping and
    // weaving take him off to the side he committed his head to.
    const lateral = runtime.action === "duck" ? 0 : runtime.evadeDirection;
    const closing = runtime.action === "duck" ? 0.3 : 0.1;
    desiredVelocityX =
      (vector.leftX * lateral + vector.forwardX * closing) * maxLateral * EVASION_STEP;
    desiredVelocityY =
      (vector.leftY * lateral + vector.forwardY * closing) * maxLateral * EVASION_STEP;
  }

  // A punch is thrown while stepping in behind it, not from a dead stand. During
  // the drive to contact the fighter carries his weight forward into the shot,
  // which keeps the feet alive through an exchange and adds closing energy to
  // the blow instead of both fighters freezing the instant one throws.
  const punchSpec = PUNCH_SPECS[runtime.action];
  const punchProgress = punchSpec
    ? clamp(runtime.actionElapsed / Math.max(0.01, runtime.actionDuration), 0, 1)
    : 0;
  const steppingIn = Boolean(punchSpec) && punchProgress < (punchSpec?.contactPhase ?? 0);
  if (steppingIn) {
    const stepGain = punchSpec?.target === "body" ? 0.42 : 0.3;
    desiredVelocityX = vector.forwardX * maxForward * stepGain;
    desiredVelocityY = vector.forwardY * maxForward * stepGain;
  }

  const massKg = fighter.weight * 0.453592;
  // The stride multiplier has to reach the drive off the floor, not just the
  // ceiling above. `desiredVelocity` is only a cap, and a fighter never gets
  // near it — his real top speed is wherever this acceleration balances the
  // per-tick damping below. Scaling the cap alone moved a doubled-stride
  // fighter 1.050 m/s against a normal one's 1.049.
  const groundAccelerationX =
    ((vector.forwardX * runtime.body.forwardGroundForceN +
      vector.leftX * runtime.body.lateralGroundForceN) /
    massKg) * stride;
  const groundAccelerationY =
    ((vector.forwardY * runtime.body.forwardGroundForceN +
      vector.leftY * runtime.body.lateralGroundForceN) /
    massKg) * stride;
  const isFootwork = FOOTWORK.has(runtime.action);
  // Footwork, the step-in behind a punch and the weight shift under an evasion
  // all drive off the floor; a static guard glides to a stop.
  const drives =
    isFootwork ||
    steppingIn ||
    EVASIONS.has(runtime.action) ||
    runtime.action === "recover";
  const nextVelocityX =
    runtime.velocity + (drives ? groundAccelerationX * dt : 0);
  const nextVelocityY =
    runtime.velocityY + (drives ? groundAccelerationY * dt : 0);
  runtime.velocity = round(
    (Math.abs(nextVelocityX) > Math.abs(desiredVelocityX)
      ? desiredVelocityX
      : nextVelocityX) * (drives ? 0.96 : 0.72),
    4,
  );
  runtime.velocityY = round(
    (Math.abs(nextVelocityY) > Math.abs(desiredVelocityY)
      ? desiredVelocityY
      : nextVelocityY) * (drives ? 0.96 : 0.72),
    4,
  );
  const nextX = runtime.x + runtime.velocity * dt;
  const nextY = runtime.y + runtime.velocityY * dt;
  runtime.x = round(clamp(nextX, RING_MIN, RING_MAX), 4);
  runtime.y = round(clamp(nextY, RING_DEPTH_MIN, RING_DEPTH_MAX), 4);
  if (runtime.x !== round(nextX, 4)) runtime.velocity = 0;
  if (runtime.y !== round(nextY, 4)) runtime.velocityY = 0;

  const movementLoad =
    Math.hypot(runtime.velocity, runtime.velocityY) / Math.max(0.5, maxForward);
  const footworkAction =
    runtime.action === "advance" ||
    runtime.action === "retreat" ||
    runtime.action === "circleLeft" ||
    runtime.action === "circleRight" ||
    runtime.action === "pivotLeft" ||
    runtime.action === "pivotRight";
  // Standing behind a high guard or resetting lets a fighter catch their
  // breath — both restore stamina so a defender is not locked into a
  // one-way death spiral where they can only cover and never work back.
  const continuousCost =
    footworkAction
      ? 0.42 * movementLoad
      : runtime.action === "guard"
        ? -0.36
        : runtime.action === "slip"
          ? 0.48
          : runtime.action === "duck"
            ? 0.44
            : runtime.action === "weave"
              ? 0.62
          : runtime.action === "recover"
            ? -1.7
            : -0.12;
  const cardioScale =
    1.25 -
    fighter.stats.cardio / 560 -
    fighter.conditioning.lowerBodyEndurance / 850;
  runtime.stamina = round(
    clamp(runtime.stamina - continuousCost * cardioScale * dt * 5, 0, 100),
  );

  const balanceRecovery =
    (0.18 + fighter.stats.defense / 420) *
    (runtime.action === "recover" || runtime.action === "guard" ? 1.5 : 1);
  // Flat per-tick penalties, scaled to the step: balance recovery below is
  // dt-scaled, and if the drains are not, a finer tick grinds everyone's legs
  // down faster than they can come back and the fight fills with flash
  // knockdowns nobody earned.
  const movementPenalty =
    Math.max(0, movementLoad - 0.72) * 0.08 * (dt / 0.1);
  const levelPenalty =
    runtime.action === "weave" ||
    runtime.action === "pivotLeft" ||
    runtime.action === "pivotRight"
      ? 0.018 * (dt / 0.1)
      : 0;
  runtime.balance = round(
    clamp(
      runtime.balance + balanceRecovery * dt - movementPenalty - levelPenalty,
      0,
      1,
    ),
    3,
  );

  const evadeSide = runtime.evadeDirection;
  const actionProgress = clamp(
    runtime.actionElapsed / Math.max(0.01, runtime.actionDuration),
    0,
    1,
  );
  // Nobody stands with his head on a post. Even between shots a boxer keeps it
  // drifting off the centre-line, and that idle movement is most of what makes a
  // man look like he is boxing rather than waiting his turn. It is small — a few
  // centimetres against a slip's twenty — so it changes how the ring reads
  // without quietly turning every fighter into a hard target.
  const alive = clamp(
    1 - runtime.stunSeconds - clamp(runtime.hurtSeconds, 0, 1),
    0,
    1,
  );
  const idleSway =
    RESTING_HEAD_MOVEMENT *
    alive *
    (0.5 + fighter.stats.defense / 200) *
    Math.sin((runtime.decisionCount + actionProgress) * 0.9 + fighter.seed);
  const slipTarget =
    runtime.action === "slip"
      ? evadeSide * (0.14 + fighter.stats.defense / 800)
      : runtime.action === "weave"
        ? Math.cos(actionProgress * Math.PI) *
          evadeSide *
          (0.16 + fighter.stats.defense / 760)
      : idleSway;
  // Onset speed is where the reaction stat pays continuously. Perception lag is
  // quantized to whole ticks and deliberately stays that way — see
  // `perceivedSnapshot` — so this is the channel that separates a 70-reaction
  // man from a 90 without shifting the range judgement everything else is tuned
  // around. A cross gives one tick of warning; whether twenty centimetres of
  // slip arrive inside that tick or the one after is the difference between a
  // punch slipped and a punch worn on the ear.
  // The onset eases were authored per 10 Hz tick; converted to a real-time
  // rate so a slip crosses the same centimetres per second at any tick rate.
  // Left per-tick, a finer tick turned every slip into a ~30 ms teleport no
  // punch could ever catch.
  const evadeTempo = DIVISION_EVADE_TEMPO[fighter.weightClass];
  const evadeRate = EVASIONS.has(runtime.action)
    ? 1 -
      Math.pow(
        1 - clamp(0.58 + fighter.stats.reaction * 0.0035, 0.1, 0.98),
        (dt / 0.1) * evadeTempo,
      )
    : 0.55;
  runtime.headOffset = round(runtime.headOffset + (slipTarget - runtime.headOffset) * evadeRate, 4);
  const levelTarget =
    runtime.action === "duck" ? 0.66 : runtime.action === "weave" ? 0.73 : 1;
  runtime.headLevel = round(
    runtime.headLevel +
      (levelTarget - runtime.headLevel) *
        (EVASIONS.has(runtime.action)
          ? 1 -
            Math.pow(
              1 - clamp(0.55 + fighter.stats.reaction * 0.005, 0.1, 0.98),
              (dt / 0.1) * evadeTempo,
            )
          : 0.72),
    4,
  );
}

function updateArticulatedMechanics(
  runtime: BoutFighter,
  fighter: Fighter,
) {
  const body = runtime.body;
  const dt = BOXING_MODEL.physicsStepSeconds;
  const massKg = fighter.weight * 0.453592;
  const bodyWeightN = massKg * 9.81;
  const progress = clamp(
    runtime.actionElapsed / Math.max(0.01, runtime.actionDuration),
    0,
    1,
  );
  const movementSpeed = Math.hypot(runtime.velocity, runtime.velocityY);
  // A slip is a weight transfer onto the outside foot, so the legs work through
  // one exactly as they do through a step.
  const moving = FOOTWORK.has(runtime.action) || EVASIONS.has(runtime.action);
  // The gait never stops. A boxer at rest is still shifting his weight foot to
  // foot — that idle bounce is most of what separates a man boxing from a
  // mannequin, and parking the phase at zero the instant he stopped travelling
  // is why fighters looked planted for two thirds of every round. It stays a
  // fifth of a real stride, so a resting stance still reads as a stance.
  body.gaitPhase = moving
    ? (body.gaitPhase + dt * (2.1 + movementSpeed * 1.35)) % 1
    : (body.gaitPhase + dt * RESTING_GAIT_HZ) % 1;
  const strideWave =
    Math.sin(body.gaitPhase * Math.PI * 2) * (moving ? 1 : RESTING_STRIDE);
  const lateralStep = CIRCLES.has(runtime.action) || PIVOTS.has(runtime.action);
  const strideLength = (lateralStep ? 0.12 : 0.17) * strideWave;
  body.leadFootOffset = round(0.18 + strideLength, 3);
  body.rearFootOffset = round(-0.18 - strideLength, 3);

  const leadStepFlex = Math.max(0, -strideWave) * 24;
  const rearStepFlex = Math.max(0, strideWave) * 24;
  const levelFlex = runtime.action === "duck" ? 34 : runtime.action === "weave" ? 27 : 0;
  const pivotFlex = PIVOTS.has(runtime.action) ? 8 : 0;
  body.leadKneeFlexion = round(
    clamp(17 + leadStepFlex + levelFlex + pivotFlex, 8, 62),
    1,
  );
  body.rearKneeFlexion = round(
    clamp(20 + rearStepFlex + levelFlex * 0.9 + pivotFlex, 8, 62),
    1,
  );

  const punch = PUNCH_SPECS[runtime.action];
  const isCross = runtime.action === "crossHead" || runtime.action === "crossBody";
  const isHook = runtime.action === "hookHead" || runtime.action === "hookBody";
  const isJab = runtime.action === "jabHead" || runtime.action === "jabBody";
  const rotationWave = punch ? Math.sin(progress * Math.PI) : 0;
  const hipPeak = isHook ? 42 : isCross ? 34 : isJab ? 9 : 0;
  const shoulderPeak = isHook ? 55 : isCross ? 48 : isJab ? 16 : 0;
  const bodyTarget = PUNCH_SPECS[runtime.action]?.target === "body" ? 1.08 : 1;
  const hipTarget = hipPeak * rotationWave * bodyTarget;
  // Hips fire clearly before the shoulders. The lag is a fraction of the punch,
  // so it holds as a visible kinetic sequence even for the faster snap-punches
  // the 10 Hz decision tick would otherwise blur past.
  const shoulderProgress = clamp((progress - 0.16) / 0.84, 0, 1);
  const shoulderTarget =
    shoulderPeak * Math.sin(shoulderProgress * Math.PI) * bodyTarget;
  body.hipRotation = round(
    body.hipRotation + (hipTarget - body.hipRotation) * 0.62,
    2,
  );
  body.shoulderRotation = round(
    body.shoulderRotation + (shoulderTarget - body.shoulderRotation) * 0.58,
    2,
  );

  let leadForce = bodyWeightN * 0.52;
  let rearForce = bodyWeightN * 0.48;
  let forwardForce = 0;
  let lateralForce = 0;
  const driveEnd = punch ? Math.max(0.32, punch.contactPhase) : 0.5;
  const driveWave = punch
    ? Math.sin(Math.PI * clamp(progress / driveEnd, 0, 1))
    : 0;
  const powerScale =
    (0.82 + fighter.conditioning.lowerBodyPower / 500) *
    (0.7 + runtime.stamina / 330) *
    (0.72 + runtime.balance * 0.28);
  if (punch) {
    const rearDrive = isCross ? 1.08 : isHook ? 0.96 : 0.68;
    const leadBrace = isCross ? 0.28 : isHook ? 0.34 : 0.46;
    rearForce += bodyWeightN * rearDrive * driveWave * powerScale;
    leadForce += bodyWeightN * leadBrace * driveWave * powerScale;
    forwardForce = bodyWeightN * rearDrive * driveWave * powerScale * 0.13;
  } else if (moving) {
    const transfer = strideWave * bodyWeightN * 0.2;
    leadForce = bodyWeightN * 0.53 - transfer;
    rearForce = bodyWeightN * 0.47 + transfer;
    const propulsion = bodyWeightN * movementSpeed * 0.08;
    if (strideWave >= 0) rearForce += propulsion;
    else leadForce += propulsion;
    const gaitDrive =
      bodyWeightN *
      (0.24 + fighter.conditioning.lowerBodyPower / 900) *
      (0.82 + runtime.stamina / 560) *
      (0.84 + Math.abs(strideWave) * 0.16);
    if (runtime.action === "advance") forwardForce = gaitDrive;
    if (runtime.action === "retreat") forwardForce = -gaitDrive * 0.82;
    if (runtime.action === "circleLeft") lateralForce = gaitDrive * 0.76;
    if (runtime.action === "circleRight") lateralForce = -gaitDrive * 0.76;
    if (runtime.action === "pivotLeft" || runtime.action === "pivotRight") {
      const side = runtime.action === "pivotLeft" ? 1 : -1;
      forwardForce = gaitDrive * 0.12;
      lateralForce = gaitDrive * 0.62 * side;
    }
  } else if (runtime.action === "duck" || runtime.action === "weave") {
    leadForce += bodyWeightN * 0.12;
    rearForce += bodyWeightN * 0.12;
  }

  body.previousGroundForceN = body.resultantGroundForceN;
  body.leadGroundForceN = round(Math.max(0, leadForce), 1);
  body.rearGroundForceN = round(Math.max(0, rearForce), 1);
  body.resultantGroundForceN = round(
    body.leadGroundForceN + body.rearGroundForceN,
    1,
  );
  body.forwardGroundForceN = round(forwardForce, 1);
  body.lateralGroundForceN = round(lateralForce, 1);
  const rawRfd =
    (body.resultantGroundForceN - body.previousGroundForceN) / dt;
  body.rateOfForceDevelopment = round(
    clamp(body.rateOfForceDevelopment * 0.32 + rawRfd * 0.68, -4500, 4500),
    1,
  );
  const forceDifference = body.leadGroundForceN - body.rearGroundForceN;
  body.plantedFoot =
    Math.abs(forceDifference) < bodyWeightN * 0.16
      ? "both"
      : forceDifference > 0
        ? "lead"
        : "rear";
  const sequenceQuality = clamp(
    1 - Math.abs(body.shoulderRotation - body.hipRotation * 1.28) / 58,
    0.5,
    1,
  );
  body.kineticChainEfficiency = round(
    clamp(
      (0.42 + fighter.conditioning.kineticChain / 175) *
        sequenceQuality *
        (0.76 + runtime.balance * 0.24) *
        (0.82 + runtime.stamina / 560),
      0.45,
      1,
    ),
    3,
  );
  body.centerOfMassHeight = round(
    clamp(
      1.02 -
        (body.leadKneeFlexion + body.rearKneeFlexion) * 0.0019 -
        (1 - runtime.headLevel) * 0.08,
      0.74,
      1,
    ),
    3,
  );
}

function separateBodies(left: BoutFighter, right: BoutFighter) {
  const vector = ringVector(left, right);
  if (vector.distance >= MIN_BODY_DISTANCE) return;
  const correction = (MIN_BODY_DISTANCE - vector.distance) / 2;
  left.x = clamp(left.x - vector.forwardX * correction, RING_MIN, RING_MAX);
  left.y = clamp(left.y - vector.forwardY * correction, RING_DEPTH_MIN, RING_DEPTH_MAX);
  right.x = clamp(right.x + vector.forwardX * correction, RING_MIN, RING_MAX);
  right.y = clamp(right.y + vector.forwardY * correction, RING_DEPTH_MIN, RING_DEPTH_MAX);
  const leftClosing = left.velocity * vector.forwardX + left.velocityY * vector.forwardY;
  const rightClosing = right.velocity * vector.forwardX + right.velocityY * vector.forwardY;
  if (leftClosing > 0) {
    left.velocity -= vector.forwardX * leftClosing * 0.6;
    left.velocityY -= vector.forwardY * leftClosing * 0.6;
  }
  if (rightClosing < 0) {
    right.velocity -= vector.forwardX * rightClosing * 0.6;
    right.velocityY -= vector.forwardY * rightClosing * 0.6;
  }
  const clinchScale = BOXING_MODEL.physicsStepSeconds / 0.1;
  left.balance = clamp(left.balance - 0.018 * clinchScale, 0, 1);
  right.balance = clamp(right.balance - 0.018 * clinchScale, 0, 1);
}

function updateFacing(runtime: BoutFighter, opponent: BoutFighter) {
  const horizontalOffset = opponent.x - runtime.x;
  if (Math.abs(horizontalOffset) < 0.04) return;
  runtime.facingDirection = horizontalOffset > 0 ? 1 : -1;
}

function extensionCurve(progress: number, contactPhase: number) {
  const windupEnd = Math.max(0.12, contactPhase - 0.26);
  if (progress <= windupEnd) return 0;
  if (progress <= contactPhase) {
    return (progress - windupEnd) / (contactPhase - windupEnd);
  }
  return clamp(1 - (progress - contactPhase) / (1 - contactPhase), 0, 1);
}

function updateHandKinematics(runtime: BoutFighter, fighter: Fighter) {
  const spec = PUNCH_SPECS[runtime.action];
  const previous = runtime.handExtension;
  runtime.previousHandExtension = previous;
  if (!spec) {
    runtime.handExtension = 0;
    runtime.handVelocity = 0;
    return;
  }

  const progress = clamp(runtime.actionElapsed / runtime.actionDuration, 0, 1);
  const extensionTarget = Math.min(
    armLengthMeters(fighter) * spec.reachFactor,
    Math.max(0.1, runtime.punchExtensionTarget),
  );
  const extension =
    extensionCurve(progress, spec.contactPhase) * extensionTarget;
  const rawVelocity = Math.max(
    0,
    (extension - previous) / BOXING_MODEL.physicsStepSeconds,
  );
  const calibratedPeak = calibratedHandSpeed(
    fighter,
    runtime.action,
    runtime.stamina,
    runtime.balance,
  );
  const bodyWeightN = fighter.weight * 0.453592 * 9.81;
  const groundDrive = clamp(
    runtime.body.resultantGroundForceN / Math.max(1, bodyWeightN),
    0.72,
    2.2,
  );
  const shoulderDurability =
    0.91 + fighter.conditioning.shoulderEndurance / 1100;
  const kineticScale =
    (0.82 + runtime.body.kineticChainEfficiency * 0.2) *
    (0.96 + (groundDrive - 1) * 0.075) *
    shoulderDurability;
  const trajectoryPeak =
    extensionTarget /
    Math.max(0.08, (spec.contactPhase - Math.max(0.12, spec.contactPhase - 0.26)) * runtime.actionDuration);
  const calibrationScale = calibratedPeak / Math.max(0.1, trajectoryPeak);
  runtime.handExtension = round(extension, 4);
  const neurologicalControl = clamp(
    1 - runtime.stunSeconds / 2.5 - clamp(runtime.hurtSeconds / 3.4, 0, 1) * 0.3,
    0.34,
    1,
  );
  runtime.handVelocity = round(
    rawVelocity * calibrationScale * kineticScale * neurologicalControl,
    3,
  );
  runtime.peakHandSpeed = Math.max(runtime.peakHandSpeed, runtime.handVelocity);
}

// A thrown punch is not fired blind on a fixed bearing — as it drives out, the
// hand corrects toward where the opponent's TORSO now is, so a fighter who is
// simply stepping or circling gets hit. It deliberately does NOT chase the
// opponent's head slip, duck or weave (those live in headOffset / headLevel and
// still shift the true target off this line), so defensive head movement keeps
// its value while ordinary repositioning no longer makes every punch whiff.
function updatePunchTracking(
  attacker: BoutFighter,
  defender: BoutFighter,
  attackerProfile: Fighter,
) {
  const spec = PUNCH_SPECS[attacker.action];
  if (!spec || attacker.punchResolved || attacker.downCountSeconds > 0) return;
  const progress = attacker.actionElapsed / Math.max(0.01, attacker.actionDuration);
  // Only home through the drive to contact; windup and recoil are committed.
  if (progress < 0.12 || progress > spec.contactPhase + 0.04) return;

  const aimX = defender.x - attacker.x;
  const aimY = defender.y - attacker.y;
  const distance = Math.max(0.0001, Math.hypot(aimX, aimY));
  const wantX = aimX / distance;
  const wantY = aimY / distance;
  // Neither head nor body shot is a perfect lock, so a fast lateral break still
  // slides part of the punch past the target. Keep this low. At 0.4-0.5 the
  // glove homed so hard that footwork and angles could not beat a punch at all
  // and fighters landed ~70% of everything thrown; real boxers connect on
  // roughly a third. A committed punch mostly goes where it was aimed, and
  // moving off the line is what makes it miss.
  //
  // Body shots used to track harder at 0.28, which compounded the torso being a
  // wider and slower-moving target — between them a body punch could not be
  // made to miss. A cross to the ribs is not better guided than a cross to the
  // chin; it just has more to hit.
  const trackRate = 0.2;
  const dirX = attacker.punchDirectionX + (wantX - attacker.punchDirectionX) * trackRate;
  const dirY = attacker.punchDirectionY + (wantY - attacker.punchDirectionY) * trackRate;
  const norm = Math.max(0.0001, Math.hypot(dirX, dirY));
  attacker.punchDirectionX = dirX / norm;
  attacker.punchDirectionY = dirY / norm;

  const targetRadius =
    spec.target === "head"
      ? BOXING_MODEL.headRadiusMeters
      : BOXING_MODEL.bodyRadiusMeters;
  const maximumExtension = armLengthMeters(attackerProfile) * spec.reachFactor;
  // Drive THROUGH the target rather than stopping the glove on its surface — the
  // same margin startAction uses, so a tracked punch actually plants instead of
  // grazing the knife-edge of the contact radius and whiffing on any wobble.
  const perceivedExtension = clamp(
    distance - 0.13 - targetRadius - BOXING_MODEL.gloveRadiusMeters,
    0.1,
    maximumExtension,
  );
  attacker.punchExtensionTarget =
    perceivedExtension + (maximumExtension - perceivedExtension) * 0.15;
}

function guardAbsorption(
  defender: Fighter,
  runtime: BoutFighter,
  target: PunchTarget,
  strike: FighterAction,
) {
  const technical = defender.stats.defense / 100;
  const fatigue = fatigueFactor(runtime);
  // A hurt man's guard is full of holes — the elbows drop and the hands drift.
  const composure = 1 - clamp(runtime.hurtSeconds / 3.4, 0, 1) * 0.42;
  if (runtime.action === "guard" || (runtime.guardHeld && !ATTACKS.has(runtime.action))) {
    // A high guard blunts shots but is not an impenetrable shell. Straight head
    // punches are largely picked off and hooks beat it around the sides. The head
    // base sits just under the block threshold for a fresh, high-defence fighter,
    // so a sharp jab still chips through the gloves as a light scoring shot
    // rather than a volume puncher never landing at all.
    //
    // The body base used to sit at 0.3, which is below the 0.6 threshold that
    // counts a shot as blocked no matter how good the defender — so body punches
    // were never once blocked in a whole league season. A high guard tucks the
    // elbows against the ribs; that is most of what a guard is FOR downstairs.
    const isHook = strike === "hookHead" || strike === "hookBody";
    const base = target === "body" ? 0.46 : isHook ? 0.42 : 0.52;
    return clamp((base + technical * 0.16 + fatigue * 0.05) * composure, 0, 0.88);
  }

  // A punch is not a defensive void. The specs say what each shot leaves in
  // place — a jab keeps most of the shell home, an uppercut keeps nothing —
  // and the openness curve scales it down as the shot commits, so being caught
  // at full extension is the worst moment there is. This is what turns a trade
  // into a timing decision: two jabs crossing is a nothing exchange, a cross
  // thrown into a committed hook lands at close to full value while giving up
  // a flick. Capped well under the 0.6 block line, because a thrown jab must
  // never count as a clean block — the argmax would discover jab-as-defence
  // and spam it all night.
  const ownPunch = PUNCH_SPECS[runtime.action];
  if (ownPunch) {
    const progress =
      runtime.actionElapsed / Math.max(0.01, runtime.actionDuration);
    const openness = punchOpenness(ownPunch, clamp(progress, 0, 1));
    return clamp(
      ownPunch.coverage *
        (1 - 0.55 * openness) *
        (0.8 + technical * 0.45) *
        composure,
      0,
      0.4,
    );
  }

  const maintainsDefensivePosture =
    runtime.action === "advance" ||
    runtime.action === "retreat" ||
    runtime.action === "recover";
  if (!maintainsDefensivePosture) return 0;

  // Boxers do not drop both hands between explicit guard actions. Footwork and
  // recovery retain partial coverage, while punching and slipping open lanes.
  const base = target === "head" ? 0.28 : 0.12;
  return clamp((base + technical * 0.15 + fatigue * 0.04) * composure, 0, 0.58);
}

function closestPointOnSegment3D(
  point: { x: number; y: number; z: number },
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentZ = end.z - start.z;
  const segmentLengthSquared =
    segmentX ** 2 + segmentY ** 2 + segmentZ ** 2;
  if (segmentLengthSquared <= 0.000001) {
    return { ...start };
  }
  const projection = clamp(
    ((point.x - start.x) * segmentX +
      (point.y - start.y) * segmentY +
      (point.z - start.z) * segmentZ) /
      segmentLengthSquared,
    0,
    1,
  );
  return {
    x: start.x + segmentX * projection,
    y: start.y + segmentY * projection,
    z: start.z + segmentZ * projection,
  };
}

function distancePointToSegment3D(
  point: { x: number; y: number; z: number },
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
) {
  const closest = closestPointOnSegment3D(point, start, end);
  return Math.hypot(
    point.x - closest.x,
    point.y - closest.y,
    point.z - closest.z,
  );
}

export function classifyImpactZone(
  target: PunchTarget,
  lateralOffsetMeters: number,
  verticalOffsetMeters: number,
): ImpactZone {
  if (target === "head") {
    if (verticalOffsetMeters < -0.042) {
      return Math.abs(lateralOffsetMeters) >= 0.025 ? "jaw" : "chin";
    }
    if (Math.abs(lateralOffsetMeters) > 0.055) return "temple";
    if (verticalOffsetMeters > 0.045) return "forehead";
    if (
      Math.abs(lateralOffsetMeters) <= 0.034 &&
      Math.abs(verticalOffsetMeters) <= 0.04
    ) {
      return "nose";
    }
    return "cheek";
  }
  if (lateralOffsetMeters < -0.045 && verticalOffsetMeters < 0.025) {
    return "liver";
  }
  if (Math.abs(lateralOffsetMeters) > 0.045) return "ribs";
  if (verticalOffsetMeters > 0.025) return "chest";
  if (verticalOffsetMeters < -0.055) return "abdomen";
  return "solarPlexus";
}

function detectImpact(
  attacker: BoutFighter,
  defender: BoutFighter,
  attackerProfile: Fighter,
  defenderProfile: Fighter,
): ImpactCandidate | null {
  const spec = PUNCH_SPECS[attacker.action];
  if (
    !spec ||
    attacker.punchResolved ||
    attacker.handVelocity <= 0.2 ||
    attacker.downCountSeconds > 0 ||
    defender.downCountSeconds > 0 ||
    attacker.knockout ||
    defender.knockout
  ) return null;

  const progress = attacker.actionElapsed / attacker.actionDuration;
  if (progress < spec.contactPhase - 0.2 || progress > spec.contactPhase + 0.09) return null;

  const vector = ringVector(attacker, defender);
  const absorption = guardAbsorption(
    defenderProfile,
    defender,
    spec.target,
    attacker.action,
  );
  // Only a genuinely smothering guard counts as a clean block. Partial coverage —
  // a jab picking through the gloves, a body shot slipping under a high guard, a
  // hook curling around it — still lands, carrying reduced energy rather than
  // being wiped off the board.
  const blocked = absorption >= 0.6;
  const targetRadius =
    spec.target === "head"
      ? BOXING_MODEL.headRadiusMeters
      : BOXING_MODEL.bodyRadiusMeters;
  const contactRadius = targetRadius + BOXING_MODEL.gloveRadiusMeters;
  const maximumContactRange =
    armLengthMeters(attackerProfile) * spec.reachFactor +
    0.13 +
    contactRadius;
  if (vector.distance > maximumContactRange) return null;
  const anatomicalTarget = targetPosition(attacker, defender, spec.target);
  const target = { ...anatomicalTarget };
  const guardPlane = blocked ? (spec.target === "head" ? 0.18 : 0.1) : 0;
  target.x -= vector.forwardX * guardPlane;
  target.y -= vector.forwardY * guardPlane;
  // The 10 Hz decision tick can straddle a fast punch's peak: a quick jab is
  // fully extended for only a sliver of real time that falls between two ticks,
  // so sampling the hand position at tick boundaries catches it perpetually
  // short and every fast punch "misses" in open space. Sweep the contact test
  // all the way out to the extension the punch actually drives to, so a jab is
  // measured at its true reach regardless of how few ticks land inside the
  // contact window. This is what lets a fast, jab-heavy fighter land at all.
  const peakExtension = Math.min(
    armLengthMeters(attackerProfile) * spec.reachFactor,
    Math.max(0.1, attacker.punchExtensionTarget),
  );
  const reachExtension = Math.max(attacker.handExtension, peakExtension);
  const previousFist = {
    x: attacker.x + attacker.punchDirectionX * (0.13 + attacker.previousHandExtension),
    y: attacker.y + attacker.punchDirectionY * (0.13 + attacker.previousHandExtension),
    z: attacker.punchAimHeight,
  };
  const fist = {
    x: attacker.x + attacker.punchDirectionX * (0.13 + reachExtension),
    y: attacker.y + attacker.punchDirectionY * (0.13 + reachExtension),
    z: attacker.punchAimHeight,
  };

  // Contact is a true swept glove test against the defender's current
  // three-dimensional target. Footwork, slips, ducks, and weaves move that
  // target; there is no hit or dodge probability roll.
  if (distancePointToSegment3D(target, previousFist, fist) > contactRadius) {
    return null;
  }

  const impactPoint = closestPointOnSegment3D(anatomicalTarget, previousFist, fist);
  const defenderFacing = ringVector(defender, attacker);
  const impactOffsetX = impactPoint.x - anatomicalTarget.x;
  const impactOffsetY = impactPoint.y - anatomicalTarget.y;
  const lateralOffset =
    impactOffsetX * defenderFacing.leftX + impactOffsetY * defenderFacing.leftY;
  const verticalOffset = impactPoint.z - anatomicalTarget.z;
  const zone = blocked
    ? "guard"
    : classifyImpactZone(spec.target, lateralOffset, verticalOffset);
  const trajectoryDelta = {
    x: fist.x - previousFist.x,
    y: fist.y - previousFist.y,
    z: fist.z - previousFist.z,
  };
  const trajectoryMagnitude = Math.max(
    0.0001,
    Math.hypot(trajectoryDelta.x, trajectoryDelta.y, trajectoryDelta.z),
  );
  const trajectory = {
    x: trajectoryDelta.x / trajectoryMagnitude,
    y: trajectoryDelta.y / trajectoryMagnitude,
    z: trajectoryDelta.z / trajectoryMagnitude,
  };
  const directness = clamp(
    Math.abs(trajectory.x * vector.forwardX + trajectory.y * vector.forwardY),
    0,
    1,
  );

  const closingBodyVelocity = Math.max(
    0,
    (attacker.velocity - defender.velocity) * vector.forwardX +
      (attacker.velocityY - defender.velocityY) * vector.forwardY,
  );
  const closingVelocity = attacker.handVelocity + closingBodyVelocity;
  const massKg = attackerProfile.weight * 0.453592;
  const effectiveMass =
    (2.18 + massKg * 0.01) *
    spec.massFactor *
    (0.68 + attackerProfile.stats.power / 310) *
    (0.65 + attacker.balance * 0.35) *
    (0.84 + attacker.body.kineticChainEfficiency * 0.2) *
    (0.94 +
      clamp(
        attacker.body.resultantGroundForceN /
          Math.max(1, massKg * 9.81) -
          1,
        0,
        1.2,
      ) *
        0.06);
  const result = calculateImpact({
    effectiveMassKg: effectiveMass,
    closingVelocityMps: closingVelocity,
    guardAbsorption: absorption,
    rotationalFactor: spec.rotationalFactor,
    directness,
    momentArmMeters: IMPACT_ZONE_PROPERTIES[zone].momentArmMeters,
    anatomicalVulnerability: IMPACT_ZONE_PROPERTIES[zone].vulnerability,
  });
  const powerShot =
    !blocked &&
    directness >= 0.72 &&
    closingVelocity >= 7.4 &&
    result.transmittedEnergyJ >= 58 &&
    result.powerScore >= 0.78;
  const counter =
    ATTACKS.has(defender.action) &&
    defender.actionElapsed / Math.max(0.001, defender.actionDuration) < 0.66;

  return {
    attacker: attacker.corner,
    defender: defender.corner,
    blocked,
    target: spec.target,
    zone,
    strike: attacker.action,
    impactPoint,
    trajectory,
    directness,
    powerShot,
    counter,
    result,
  };
}

function clockLabel(roundNumber: number, roundTime: number) {
  const seconds = Math.max(0, Math.ceil(roundTime));
  return `R${roundNumber} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const NEUROLOGICAL_ZONES = new Set<ImpactZone>([
  "jaw",
  "chin",
  "nose",
  "temple",
  "forehead",
  "cheek",
]);

const HIGH_ROTATION_ZONES = new Set<ImpactZone>(["jaw", "chin", "temple"]);

// A clean knockout — not a knockdown he beats the count on. This needs either a
// blow that clears the defender's own flash-knockdown bar with power to spare, or
// a chin that has already been broken down over the course of the fight.
export function evaluateNeurologicalKnockout(input: {
  zone: ImpactZone;
  blocked: boolean;
  singleImpactLoad: number;
  accumulatedLoad: number;
  balance: number;
  powerScore: number;
  flashBar?: number;
  chinIntegrity?: number;
}) {
  if (input.blocked || !HIGH_ROTATION_ZONES.has(input.zone)) return false;
  const flashBar = input.flashBar ?? 1.5;
  const chinIntegrity = input.chinIntegrity ?? 1;
  const cleanRotationalKnockout =
    input.singleImpactLoad >= flashBar * 1.28 && input.powerScore >= 0.92;
  const brokenChinKnockout =
    chinIntegrity <= 0.42 &&
    input.singleImpactLoad >= flashBar &&
    input.balance <= 0.55;
  const accumulatedKnockout =
    input.accumulatedLoad >= 2.65 && input.balance <= 0.30;
  return cleanRotationalKnockout || brokenChinKnockout || accumulatedKnockout;
}

function applyImpact(
  bout: BoutState,
  candidate: ImpactCandidate,
  attackerProfile: Fighter,
  defenderProfile: Fighter,
  captureEvents: boolean,
) {
  const attacker = candidate.attacker === "blue" ? bout.left : bout.right;
  const defender = candidate.defender === "blue" ? bout.left : bout.right;
  const { result } = candidate;
  attacker.punchResolved = true;
  attacker.lastImpactJ = result.transmittedEnergyJ;
  attacker.peakImpactJ = Math.max(attacker.peakImpactJ, result.transmittedEnergyJ);
  attacker.peakForceN = Math.max(
    attacker.peakForceN,
    round(result.transmittedImpulseNs / BOXING_MODEL.contactDurationSeconds),
  );
  attacker.lastImpactZone = candidate.zone;
  attacker.lastStrikeKind = candidate.strike;
  attacker.lastImpactSpeed = result.closingVelocityMps;
  attacker.lastRotationalImpulse = result.rotationalImpulseNms;
  attacker.lastPowerShot = candidate.powerShot;
  attacker.lastImpactCounter = candidate.counter;

  if (candidate.blocked) {
    attacker.absorbedImpactJ += result.impactEnergyJ - result.transmittedEnergyJ;
    attacker.blocked += 1;
    defender.round.defense += 0.65;
  } else {
    attacker.landed += 1;
    attacker.cleanImpactJ += result.transmittedEnergyJ;
    attacker.round.cleanBlows += 1;
    attacker.round.impactEnergy += result.transmittedEnergyJ;
    attacker.score = round(attacker.score + 1 + result.transmittedEnergyJ / 40);
  }

  const vulnerability = 1 + (1 - defender.balance) * 0.32;
  // The counter multiplier predates the coverage model and stays at 1.16: a
  // timed counter already collects extra transmitted energy through the
  // target's stripped mid-punch guard, and raising this dial to 1.3 measurably
  // changed nothing at league level — counters are too rare to move a
  // division's stoppage rate — while reshuffling fight outcomes for free.
  const neurologicalImpact = NEUROLOGICAL_ZONES.has(candidate.zone)
    ? result.neurologicalLoad * (candidate.counter ? 1.16 : 1)
    : 0;
  const bodyImpactShock = candidate.target === "body"
    ? result.transmittedEnergyJ / 70 * IMPACT_ZONE_PROPERTIES[candidate.zone].bodyShock
    : 0;
  if (candidate.target === "head") {
    // Punishment has to actually show on a man over three rounds. At the old
    // rate it took ~50 clean power shots to move the health bar, so fights were
    // decided entirely by knockdown thresholds and a stoppage could happen with
    // the loser still at 93 health.
    defender.headTrauma = round(
      defender.headTrauma +
        (result.transmittedEnergyJ / 46) *
          vulnerability *
          IMPACT_ZONE_PROPERTIES[candidate.zone].vulnerability,
    );
    defender.neurologicalLoad = round(
      clamp(defender.neurologicalLoad + neurologicalImpact, 0, 5),
      4,
    );
    defender.stunSeconds = round(
      Math.max(
        defender.stunSeconds,
        clamp(neurologicalImpact * 0.72 - defenderProfile.stats.defense / 500, 0, 2.4),
      ),
      3,
    );
  } else {
    defender.bodyTrauma = round(
      defender.bodyTrauma +
        (result.transmittedEnergyJ / 52) *
          vulnerability *
          IMPACT_ZONE_PROPERTIES[candidate.zone].bodyShock,
    );
    defender.bodyShock = round(clamp(defender.bodyShock + bodyImpactShock, 0, 5), 4);
    defender.stamina = round(
      clamp(
        defender.stamina - result.transmittedEnergyJ / 18 - bodyImpactShock * 2.4,
        0,
        100,
      ),
    );
  }

  const impactDose = clamp(result.transmittedEnergyJ / 85, 0, 1);
  if (candidate.target === "head") {
    defender.recentHeadImpact = round(
      clamp(defender.recentHeadImpact + impactDose, 0, 1),
      4,
    );
  } else {
    defender.recentBodyImpact = round(
      clamp(defender.recentBodyImpact + impactDose, 0, 1),
      4,
    );
  }
  defender.sustainedPressure = round(
    clamp(
      defender.sustainedPressure +
        (candidate.blocked ? 0.12 : 0.24) +
        result.impulseNs / 90,
      0,
      1,
    ),
    4,
  );

  defender.health = round(
    clamp(100 - defender.headTrauma * 0.72 - defender.bodyTrauma * 0.45, 0, 100),
  );
  // Wearing a punch costs wind, and a body shot costs more of it than a head
  // shot does — taking one downstairs is most of why a fighter fades late.
  // Exhibition only; absent on everybody the league books.
  const windRules = defenderProfile.exhaustionRules;
  if (windRules) {
    const wind =
      windRules.hitStaminaCost *
      clamp(result.transmittedImpulseNs / 26, 0.25, 2.4) *
      (candidate.target === "body" ? 1.55 : 1) *
      (candidate.blocked ? 0.35 : 1);
    defender.stamina = round(clamp(defender.stamina - wind, 0, 100), 2);
  }
  const massKg = defenderProfile.weight * 0.453592;
  const balanceLoss =
    (result.transmittedImpulseNs / Math.max(70, massKg * 2.25)) *
    (candidate.target === "head" ? 1.2 : 0.82) *
    (1.12 - defenderProfile.stats.defense / 850) *
    (1 + neurologicalImpact * 0.22 + bodyImpactShock * 0.08);
  defender.balance = round(clamp(defender.balance - balanceLoss, 0, 1), 3);
  const impactDirection = ringVector(attacker, defender);
  const displacement =
    (result.transmittedImpulseNs / Math.max(55, massKg)) * 0.32;
  defender.velocity = round(
    defender.velocity + impactDirection.forwardX * displacement,
    3,
  );
  defender.velocityY = round(
    defender.velocityY + impactDirection.forwardY * displacement,
    3,
  );

  // How much punishment this particular chin absorbs, and how much of it is
  // left. Every clean head shot cracks it a little further, so a fight is won by
  // accumulating damage across rounds rather than by landing one magic punch.
  const durability = chinRating(defenderProfile);

  // The bar a single blow has to clear to actually put a man down. A fresh chin
  // needs a genuinely huge, clean, well-placed shot; a chin that has been under
  // fire all night folds to far less. Being off balance or gassed lowers it too,
  // which is why finishes cluster in the late rounds instead of the first minute.
  // Calibrated against measured impact: a clean cross to the chin lands around
  // 1.0-1.3 neurological load, so a fresh chin (bar ~1.75) rides it out while a
  // chin broken down late in the fight (bar ~0.9) does not.
  const flashBar =
    2.25 *
    // Chins were calibrated against the flush, unreactable connections of the
    // 10 Hz tick. Finer ticks let defense react, which compresses the top of
    // the punch-quality distribution; the bar follows so a flash knockdown
    // stays the same percentile of punch, not the same joules. Fitted together
    // with the real-time evade onset in updateMotion — measured 30/62/74%
    // stoppage by division at 50 Hz against the 37/64/70% the 10 Hz league
    // airs. Retune the pair together or not at all.
    (DIVISION_FLASH_FLOOR[defenderProfile.weightClass] +
      (1 - DIVISION_FLASH_FLOOR[defenderProfile.weightClass]) *
        Math.min(1, BOXING_MODEL.physicsStepSeconds / 0.1)) *
    durability *
    (0.44 + 0.56 * defender.chinIntegrity) *
    (0.70 + 0.30 * defender.balance) *
    (0.87 + 0.13 * clamp(defender.stamina / 100, 0, 1)) *
    // An unmarked fighter should not fold to an ordinary punch. A man still near
    // full condition needs a genuinely perfect, heavy shot to be dropped; the
    // same punch folds him once he has been beaten down. This is the difference
    // between a knockdown that looks earned and one that looks rigged.
    (0.58 + 0.42 * clamp(defender.health / 100, 0, 1) ** 0.7);
  // Well under the knockdown bar sits the HURT bar. Clearing it does not end the
  // fight — it takes the man's legs for a few seconds and invites the other one
  // to jump on him. That window is where a fight becomes worth watching.
  const hurtBar = flashBar * 0.36;

  // Every clean head shot cracks the chin a little, weighted by how big it was
  // relative to what this man can take. A flicked jab is nothing; a flush cross
  // is real. Roughly twenty-five heavy connects break a chin down, which is what
  // moves a stoppage into the later rounds instead of the first exchange.
  if (candidate.target === "head" && !candidate.blocked) {
    const severity = clamp(neurologicalImpact / Math.max(0.3, flashBar), 0, 1);
    defender.chinIntegrity = round(
      clamp(defender.chinIntegrity - severity ** 1.6 * 0.055, 0.15, 1),
      4,
    );
  }

  const knockout = evaluateNeurologicalKnockout({
    zone: candidate.zone,
    blocked: candidate.blocked,
    singleImpactLoad: neurologicalImpact,
    accumulatedLoad: defender.neurologicalLoad,
    balance: defender.balance,
    powerScore: result.powerScore,
    flashBar,
    chinIntegrity: defender.chinIntegrity,
  });
  const knockdownThreshold =
    0.13 + defenderProfile.stats.defense / 2200 + defender.stamina / 2200;

  // Whether he was ALREADY out on his feet when this punch arrived. Read before
  // the shot's own hurt is applied, otherwise a single clean blow counts as its
  // own follow-up and every buzz chains straight into a knockdown.
  const priorHurtSeconds = defender.hurtSeconds;

  if (!candidate.blocked && neurologicalImpact >= hurtBar) {
    // Buzzed. Scale the wobble by how far past the hurt bar the shot landed, so
    // a glancing buzz clears in a second and a genuine bomb has him out on his
    // feet for the best part of a round.
    const severity = clamp((neurologicalImpact - hurtBar) / Math.max(0.2, flashBar - hurtBar), 0, 1);
    defender.hurtSeconds = round(
      Math.max(defender.hurtSeconds, 1.1 + severity * 3.4),
      2,
    );
  }
  if (!candidate.blocked && candidate.target === "body" && bodyImpactShock >= 0.62) {
    // A dug-in body shot folds a man for a moment even when his head is clear.
    defender.hurtSeconds = round(
      Math.max(defender.hurtSeconds, 0.8 + clamp(bodyImpactShock - 0.62, 0, 1) * 2.2),
      2,
    );
  }
  // A sustained clean body assault should drop a fighter even when no single shot
  // is a one-hitter: once accumulated body shock is high and the tank is empty,
  // the next clean body shot folds them. Head trauma does the same neurologically.
  // Once body shots were actually being thrown this became the source of nearly
  // every knockdown in the league — fighters folded at 85 health because shock
  // accumulated faster than it bled off. It should be the finish to a sustained
  // body assault on a spent man, not the routine outcome of a good hook.
  const bodyCollapse =
    candidate.target === "body" &&
    defender.bodyShock >= 4.4 &&
    defender.stamina <= 16;
  const accumulatedHeadCollapse =
    candidate.target === "head" &&
    defender.headTrauma >= 46 &&
    defender.balance <= 0.42;
  // A spent fighter who is being teed off on with no answer folds — this is what
  // stops a defenceless, gassed opponent from absorbing a fifty-punch unanswered
  // flurry. Once down he either beats the count and resets or the three-knockdown
  // rule ends it, so the assault resolves instead of running forever.
  const pressureCollapse =
    !candidate.blocked &&
    defender.stamina <= 14 &&
    defender.sustainedPressure >= 0.82 &&
    defender.balance <= 0.55;
  // A man already out on his feet goes down to a shot that would not otherwise
  // have dropped him — the follow-up in a finishing sequence, not the first bomb.
  // It still has to be a real punch, not the next flick — otherwise every buzz
  // chains straight into a knockdown and no fighter ever survives a bad moment.
  const alreadyHurt = priorHurtSeconds > 0.35;
  const followUpDrop =
    alreadyHurt &&
    neurologicalImpact >=
      flashBar * (0.90 - 0.18 * clamp(priorHurtSeconds / 3.4, 0, 1));
  const knockdown =
    !candidate.blocked &&
    (knockout ||
      defender.balance < knockdownThreshold ||
      neurologicalImpact >= flashBar ||
      followUpDrop ||
      bodyImpactShock >= 1.35 ||
      bodyCollapse ||
      accumulatedHeadCollapse ||
      pressureCollapse);

  if (knockdown) {
    defender.knockdowns += 1;
    defender.round.knockdowns += 1;
    defender.downCountSeconds = BOXING_MODEL.physicsStepSeconds;
    defender.recoveryTargetSeconds = knockout
      ? 10
      : round(clamp(
        2.6 +
          defender.neurologicalLoad * 1.45 +
          defender.bodyShock * 0.65 +
          (100 - defender.stamina) * 0.018 -
          defenderProfile.stats.cardio * 0.012,
        3,
        10.4,
      ), 2);
    defender.knockout = knockout;
    defender.knockoutCause = knockout
      ? `${formatImpactZone(candidate.zone)} ${candidate.strike}`
      : "none";
    defender.balance = knockout ? 0.02 : Math.min(defender.balance, 0.18);
    defender.velocity = 0;
    defender.velocityY = 0;
    // Bleed off the accumulated shock so standing back up gives a clean slate and
    // the fighter isn't instantly re-dropped by the first shot of the next flurry.
    defender.bodyShock = round(clamp(defender.bodyShock * 0.35, 0, 5), 4);
    defender.neurologicalLoad = round(clamp(defender.neurologicalLoad * 0.45, 0, 5), 4);
    defender.health = clamp(defender.health - 3.5, 0, 100);
    defender.action = "recover";
    defender.actionElapsed = 0;
    defender.actionDuration = defender.recoveryTargetSeconds;
  }

  if (!captureEvents) return;
  const target = formatImpactZone(candidate.zone);
  const strikeLabel = candidate.strike.replace(/(Head|Body)$/, "").replace(/([A-Z])/g, " $1").toLowerCase();
  const quality = `${candidate.powerShot ? "power " : ""}${candidate.counter ? "counter " : ""}${strikeLabel}`;
  const eventText = candidate.blocked
    ? `${defenderProfile.lastName} absorbs the ${strikeLabel} on the guard — ${result.transmittedEnergyJ.toFixed(0)} J transferred.`
    : `${attackerProfile.lastName} lands a ${quality} on the ${target} at ${result.closingVelocityMps.toFixed(1)} m/s — ${result.transmittedEnergyJ.toFixed(0)} J, ${result.rotationalImpulseNms.toFixed(2)} N·m·s rotational impulse${knockout ? ", knockout" : knockdown ? ", knockdown" : ""}.`;
  bout.events.unshift({
    id: bout.tick * 10 + (candidate.attacker === "blue" ? 1 : 2),
    time: clockLabel(bout.round, bout.roundTime),
    tone: knockdown ? "warning" : candidate.attacker,
    text: eventText,
  });
  bout.events = bout.events.slice(0, 8);
}

function updateRingControl(
  runtime: BoutFighter,
  opponent: BoutFighter,
) {
  const vector = ringVector(runtime, opponent);
  const advancing =
    runtime.velocity * vector.forwardX + runtime.velocityY * vector.forwardY >
    0.12;
  const opponentRopeDistance = ropeDistance(opponent);
  if (advancing) runtime.round.control += BOXING_MODEL.physicsStepSeconds;
  if (advancing && opponentRopeDistance < 0.72) {
    runtime.round.control += BOXING_MODEL.physicsStepSeconds * 0.65;
  }
}

function pushSnapshot(runtime: BoutFighter) {
  runtime.sensoryHistory.push({
    x: runtime.x,
    y: runtime.y,
    velocity: runtime.velocity,
    velocityY: runtime.velocityY,
    stamina: runtime.stamina,
    balance: runtime.balance,
    health: runtime.health,
    hurt: clamp(
      runtime.hurtSeconds / 2.2 + (runtime.downCountSeconds > 0 ? 1 : 0),
      0,
      1,
    ),
    action: runtime.action,
    headOffset: runtime.headOffset,
    headLevel: runtime.headLevel,
    handExtension: runtime.handExtension,
    actionProgress: clamp(runtime.actionElapsed / runtime.actionDuration, 0, 1),
    punchSide: runtime.punchSide,
    heightM: runtime.heightM,
  });
  runtime.sensoryHistory = runtime.sensoryHistory.slice(-12);
}

function judgeMerit(metrics: RoundMetrics, judge: number) {
  const cleanWeight = [1, 0.94, 1.06][judge];
  const qualityWeight = [0.011, 0.014, 0.009][judge];
  const tacticalWeight = [0.22, 0.18, 0.28][judge];
  return (
    metrics.cleanBlows * cleanWeight +
    metrics.impactEnergy * qualityWeight +
    (metrics.defense + metrics.control * 0.3) * tacticalWeight
  );
}

function scoreRound(bout: BoutState): RoundCard {
  const judges: JudgeRoundScore[] = [0, 1, 2].map((judge) => {
    const leftMerit = judgeMerit(bout.left.round, judge);
    const rightMerit = judgeMerit(bout.right.round, judge);
    if (Math.abs(leftMerit - rightMerit) < 0.0001) {
      return { judge: judge + 1, left: 10, right: 10 };
    }
    const leftWon = leftMerit > rightMerit;
    const winner = leftWon ? bout.left.round : bout.right.round;
    const loser = leftWon ? bout.right.round : bout.left.round;
    const decisive =
      winner.knockdowns > loser.knockdowns ||
      Math.abs(leftMerit - rightMerit) > 24;
    const losingScore = decisive ? 8 : 9;
    return {
      judge: judge + 1,
      left: leftWon ? 10 : losingScore,
      right: leftWon ? losingScore : 10,
    };
  });

  judges.forEach((card, index) => {
    bout.left.judgePoints[index] += card.left;
    bout.right.judgePoints[index] += card.right;
  });

  return {
    round: bout.round,
    judges,
    leftCleanBlows: bout.left.round.cleanBlows,
    rightCleanBlows: bout.right.round.cleanBlows,
    leftImpactJ: round(bout.left.round.impactEnergy),
    rightImpactJ: round(bout.right.round.impactEnergy),
  };
}

function decisionWinner(bout: BoutState) {
  let leftJudges = 0;
  let rightJudges = 0;
  for (let judge = 0; judge < 3; judge += 1) {
    if (bout.left.judgePoints[judge] > bout.right.judgePoints[judge]) leftJudges += 1;
    if (bout.right.judgePoints[judge] > bout.left.judgePoints[judge]) rightJudges += 1;
  }
  if (leftJudges > rightJudges) return bout.left.fighterId;
  if (rightJudges > leftJudges) return bout.right.fighterId;
  if (bout.left.cleanImpactJ !== bout.right.cleanImpactJ) {
    return bout.left.cleanImpactJ > bout.right.cleanImpactJ
      ? bout.left.fighterId
      : bout.right.fighterId;
  }
  return null;
}

function finishBout(
  bout: BoutState,
  winnerId: string | null,
  finish: BoutState["finish"],
) {
  bout.running = false;
  bout.winnerId = winnerId;
  bout.finish = finish;
}

function resetForNextRound(
  runtime: BoutFighter,
  fighter: Fighter,
  x: number,
  plan: StrategyDirective,
) {
  runtime.x = x;
  runtime.y = BOXING_MODEL.ringDepthMeters / 2;
  runtime.facingDirection = runtime.corner === "blue" ? 1 : -1;
  runtime.velocity = 0;
  runtime.velocityY = 0;
  runtime.body = initialArticulatedBody(fighter.weight);
  runtime.balance = clamp(runtime.balance + 0.32, 0, 1);
  // A minute on the stool clears the legs and lets the corner work on him, but a
  // chin that has been cracked only comes back a little.
  runtime.hurtSeconds = 0;
  runtime.chinIntegrity = round(clamp(runtime.chinIntegrity + 0.07, 0.15, 1), 4);
  runtime.comboPlan = [];
  runtime.comboIndex = 0;
  runtime.guardStreak = 0;
  runtime.pocketSeconds = 0;
  runtime.stamina = round(
    clamp(runtime.stamina + 13 + fighter.stats.cardio / 8, 0, 100),
  );
  runtime.action = "guard";
  runtime.lastAction = "guard";
  runtime.tacticalIntent = "outside";
  runtime.decisionConfidence = 0;
  runtime.decisionMargin = 0;
  runtime.brainActivity = 0;
  runtime.workingMemory = runtime.workingMemory.map((value) => round(value * 0.62, 4));
  runtime.memoryActivity = round(runtime.memoryActivity * 0.62, 1);
  runtime.recentHeadImpact = round(runtime.recentHeadImpact * 0.18, 4);
  runtime.recentBodyImpact = round(runtime.recentBodyImpact * 0.24, 4);
  runtime.sustainedPressure = 0;
  runtime.neurologicalLoad = round(runtime.neurologicalLoad * 0.72, 4);
  runtime.bodyShock = round(runtime.bodyShock * 0.58, 4);
  runtime.stunSeconds = 0;
  runtime.downCountSeconds = 0;
  runtime.recoveryTargetSeconds = 0;
  runtime.knockout = false;
  runtime.knockoutCause = "none";
  runtime.currentPlan = plan;
  runtime.planRevision += 1;
  runtime.attackSequence = 0;
  runtime.actionElapsed = 0;
  runtime.actionDuration = 0.35;
  runtime.previousHandExtension = 0;
  runtime.handExtension = 0;
  runtime.handVelocity = 0;
  runtime.headOffset = 0;
  runtime.headLevel = 1;
  runtime.punchAimOffset = 0;
  runtime.punchAimHeight = 1.67;
  runtime.punchAimZone = "guard";
  runtime.punchDirectionX = runtime.corner === "blue" ? 1 : -1;
  runtime.punchDirectionY = 0;
  runtime.punchExtensionTarget = 0;
  runtime.punchResolved = false;
  runtime.punchSide = 0;
  runtime.lastRound = { ...runtime.round };
  runtime.round = emptyRoundMetrics();
  runtime.sensoryHistory = Array.from(
    { length: 8 },
    () => initialSnapshot(runtime.x, runtime.y),
  );
}

/** How far the standing man is waved back before he is left to watch. */
const NEUTRAL_CORNER_DISTANCE = 1.9;

/** The other man is on the floor: back off and wait out the count.
 *
 * A knockdown stops the action — the referee waves the standing fighter away
 * and nothing else happens until the count is beaten. Without this he simply
 * kept deciding as though the fight were live, so he stood over the body
 * throwing punches that could never land (impacts are already blocked while
 * either man is down) and burned his own tank doing it. The man on the floor
 * got up into an opponent who had gifted him back a stamina edge, which is a
 * disadvantage the puncher invented for himself.
 */
function holdForCount(runtime: BoutFighter, opponent: BoutFighter) {
  // A punch still loading when the other man hit the floor was never thrown —
  // the same accounting the abandoned-for-a-defensive-reaction path uses. The
  // shot that scored the knockdown has already resolved, so it still counts.
  if (ATTACKS.has(runtime.action) && !runtime.punchResolved) {
    runtime.thrown = Math.max(0, runtime.thrown - 1);
    runtime.actionCounts[runtime.action] = Math.max(
      0,
      runtime.actionCounts[runtime.action] - 1,
    );
  }
  runtime.comboPlan = [];
  runtime.comboIndex = 0;
  runtime.attackSequence = 0;
  runtime.punchResolved = true;
  runtime.handExtension = 0;
  runtime.previousHandExtension = 0;
  runtime.handVelocity = 0;
  runtime.punchExtensionTarget = 0;
  // Step off first, then stand and watch. Retreating rather than teleporting
  // keeps the walk to a neutral distance on the same footwork everything else
  // in the ring uses.
  const holding =
    ringDistance(runtime, opponent) < NEUTRAL_CORNER_DISTANCE ? "retreat" : "guard";
  if (runtime.action !== holding) {
    runtime.lastAction = runtime.action;
    runtime.action = holding;
    runtime.actionElapsed = 0;
    runtime.actionDuration = 0.5;
  }
}

function advanceKnockdown(
  bout: BoutState,
  runtime: BoutFighter,
  profile: Fighter,
  captureEvents: boolean,
) {
  if (runtime.downCountSeconds <= 0) return false;
  runtime.velocity = 0;
  runtime.velocityY = 0;
  runtime.action = "recover";
  runtime.downCountSeconds = round(
    runtime.downCountSeconds + BOXING_MODEL.physicsStepSeconds,
    2,
  );
  if (runtime.downCountSeconds >= 10) {
    runtime.knockout = true;
    if (runtime.knockoutCause === "none") runtime.knockoutCause = "ten count";
    return true;
  }
  // A neurological knockout means the fighter cannot recover, but the referee
  // still completes the visible count before the result is declared.
  if (runtime.knockout) return true;
  if (runtime.downCountSeconds < runtime.recoveryTargetSeconds) return true;

  const count = Math.min(9, Math.ceil(runtime.downCountSeconds));
  runtime.downCountSeconds = 0;
  runtime.recoveryTargetSeconds = 0;
  // He has to come back up genuinely steadier than the bar that put him down,
  // otherwise the next clean shot re-drops him and every knockdown cascades
  // straight into a three-knockdown stoppage.
  runtime.balance = round(clamp(
    0.68 + profile.stats.defense / 500 - runtime.neurologicalLoad * 0.045,
    0.55,
    0.9,
  ), 3);
  runtime.action = "guard";
  runtime.actionElapsed = 0;
  runtime.actionDuration = 0.5;
  runtime.stunSeconds = Math.max(runtime.stunSeconds, 0.35);
  if (captureEvents) {
    bout.events.unshift({
      id: bout.tick * 10 + (runtime.corner === "blue" ? 3 : 4),
      time: clockLabel(bout.round, bout.roundTime),
      tone: runtime.corner,
      text: `${profile.lastName} regains a guarded stance at the referee's count of ${count}.`,
    });
    bout.events = bout.events.slice(0, 8);
  }
  return false;
}

function resolveEndState(
  bout: BoutState,
  leftProfile: Fighter,
  rightProfile: Fighter,
  captureEvents: boolean,
) {
  const leftKnockedOut = bout.left.knockout && bout.left.downCountSeconds >= 10;
  const rightKnockedOut = bout.right.knockout && bout.right.downCountSeconds >= 10;
  if (leftKnockedOut || rightKnockedOut) {
    const winnerId = leftKnockedOut && rightKnockedOut
      ? null
      : leftKnockedOut
        ? bout.right.fighterId
        : bout.left.fighterId;
    finishBout(bout, winnerId, winnerId ? "KO" : "Draw");
    if (captureEvents) {
      const stopped = leftKnockedOut ? bout.left : bout.right;
      bout.events.unshift({
        id: bout.tick * 10 + 9,
        time: clockLabel(bout.round, bout.roundTime),
        tone: "warning",
        text: winnerId
          ? `Knockout — ${stopped.knockoutCause}; the result follows from the measured contact and recovery state.`
          : "Both athletes are knocked out by the same exchange.",
      });
    }
    return true;
  }

  const leftStopped = bout.left.health <= 4 || bout.left.knockdowns >= 3;
  const rightStopped = bout.right.health <= 4 || bout.right.knockdowns >= 3;

  if (leftStopped || rightStopped) {
    const winnerId = leftStopped && rightStopped
      ? null
      : leftStopped
        ? bout.right.fighterId
        : bout.left.fighterId;
    const finish = winnerId ? "TKO" : "Draw";
    finishBout(bout, winnerId, finish);
    if (captureEvents) {
      bout.events.unshift({
        id: bout.tick * 10 + 9,
        time: clockLabel(bout.round, bout.roundTime),
        tone: "warning",
        text: winnerId
          ? "The referee stops the contest after measurable accumulated trauma."
          : "Both athletes are ruled unable to continue.",
      });
    }
    return true;
  }

  if (bout.roundTime > 0) return false;

  bout.roundCards.push(scoreRound(bout));
  if (bout.round < bout.totalRounds) {
    const nextRound = bout.round + 1;
    const leftPlan = planBetweenRounds(
      leftProfile,
      rightProfile,
      bout.left,
      bout.right,
      nextRound,
    );
    const rightPlan = planBetweenRounds(
      rightProfile,
      leftProfile,
      bout.right,
      bout.left,
      nextRound,
    );
    bout.round += 1;
    bout.roundTime = bout.roundLength;
    bout.breakTime = BOXING_MODEL.cornerBreakSeconds;
    bout.introSeconds = BOXING_MODEL.roundIntroSeconds;
    resetForNextRound(bout.left, leftProfile, 1.45, leftPlan);
    resetForNextRound(
      bout.right,
      rightProfile,
      BOXING_MODEL.ringLengthMeters - 1.45,
      rightPlan,
    );
    if (captureEvents) {
      bout.events.unshift({
        id: bout.tick * 10 + 8,
        time: `R${bout.round} ${Math.floor(bout.roundLength / 60)}:${String(bout.roundLength % 60).padStart(2, "0")}`,
        tone: "neutral",
        text: `Corner break — both athletes received a measured round plan; motor control remains neural.`,
      });
    }
    return false;
  }

  const winnerId = decisionWinner(bout);
  finishBout(bout, winnerId, winnerId ? "Decision" : "Draw");
  if (captureEvents) {
    bout.events.unshift({
      id: bout.tick * 10 + 8,
      time: "FINAL",
      tone: "warning",
      text: winnerId
        ? "The three deterministic judge cards return a decision."
        : "Every physical and judging tiebreak remains level; the bout is a draw.",
    });
  }
  return true;
}

function simulateStepMutable(
  bout: BoutState,
  roster: Fighter[],
  captureEvents: boolean,
  actionOverrides: Partial<Record<Corner, FighterAction>> = {},
  ledger?: DecisionLedger,
) {
  if (!bout.running || bout.finish) return;
  const leftProfile = getProfile(roster, bout.left.fighterId);
  const rightProfile = getProfile(roster, bout.right.fighterId);
  if (!leftProfile || !rightProfile) return;

  for (const [runtime, profile] of [
    [bout.left, leftProfile],
    [bout.right, rightProfile],
  ] as const) {
    runtime.heightM = profile.height * 0.0254;
    runtime.reachM = profile.reach * 0.0254;
    runtime.massKg = profile.weight * 0.453592;
    // These decay rates were authored per 10 Hz tick. Scaled to the actual
    // step so damage bleeds off at the same real-time rate at any tick rate —
    // unscaled, a finer tick evaporated accumulated damage before it could
    // ever stack into a stoppage.
    const tickScale = BOXING_MODEL.physicsStepSeconds / 0.1;
    runtime.recentHeadImpact = round(
      runtime.recentHeadImpact * Math.pow(0.91, tickScale),
      4,
    );
    runtime.recentBodyImpact = round(
      runtime.recentBodyImpact * Math.pow(0.93, tickScale),
      4,
    );
    runtime.sustainedPressure = round(
      runtime.sustainedPressure * Math.pow(0.92, tickScale),
      4,
    );
    runtime.neurologicalLoad = round(
      Math.max(0, runtime.neurologicalLoad - 0.0015 * tickScale),
      4,
    );
    runtime.bodyShock = round(
      Math.max(0, runtime.bodyShock - 0.011 * tickScale),
      4,
    );
    runtime.stunSeconds = round(
      Math.max(0, runtime.stunSeconds - BOXING_MODEL.physicsStepSeconds),
      3,
    );
    runtime.punchLockSeconds = round(
      Math.max(0, (runtime.punchLockSeconds ?? 0) - BOXING_MODEL.physicsStepSeconds),
      3,
    );
    // Legs come back faster for a well-conditioned fighter, but never instantly —
    // the window has to stay open long enough for the other man to use it.
    runtime.hurtSeconds = round(
      Math.max(
        0,
        runtime.hurtSeconds -
          BOXING_MODEL.physicsStepSeconds * (0.72 + profile.stats.cardio / 320),
      ),
      3,
    );
  }

  if (bout.tick === 0) {
    bout.left.currentPlan = openingPlan(leftProfile, rightProfile);
    bout.right.currentPlan = openingPlan(rightProfile, leftProfile);
  }

  bout.tick += 1;
  if (bout.breakTime > 0) {
    bout.breakTime = round(
      Math.max(0, bout.breakTime - BOXING_MODEL.physicsStepSeconds),
      2,
    );
    if (captureEvents && bout.breakTime === 0) {
      bout.events.unshift({
        id: bout.tick * 10 + 7,
        time: `R${bout.round}`,
        tone: "neutral",
        text: `Round ${bout.round} begins. The recurrent motor policies resume control.`,
      });
      bout.events = bout.events.slice(0, 8);
    }
    return;
  }
  // Held at the bell. The clock does not run, nobody decides, nobody moves and
  // no contact resolves until the round call has finished — a fighter must not
  // be throwing while "FIGHT!" is still flashing.
  // Only autonomous bouts are held. When a caller is driving the action — the
  // training environment, or a test staging a specific exchange — it owns the
  // timeline and the round call must not swallow its first commands.
  if (bout.introSeconds > 0 && Object.keys(actionOverrides).length === 0) {
    bout.introSeconds = round(
      Math.max(0, bout.introSeconds - BOXING_MODEL.physicsStepSeconds),
      2,
    );
    for (const runtime of [bout.left, bout.right]) {
      runtime.action = "guard";
      runtime.lastAction = "guard";
      runtime.actionElapsed = 0;
      runtime.actionDuration = 0.5;
      runtime.velocity = 0;
      runtime.velocityY = 0;
      runtime.handExtension = 0;
      runtime.previousHandExtension = 0;
      runtime.handVelocity = 0;
      runtime.punchResolved = true;
      runtime.attackSequence = 0;
      runtime.comboPlan = [];
      runtime.comboIndex = 0;
    }
    updateFacing(bout.left, bout.right);
    updateFacing(bout.right, bout.left);
    pushSnapshot(bout.left);
    pushSnapshot(bout.right);
    if (captureEvents && bout.introSeconds === 0) {
      bout.events.unshift({
        id: bout.tick * 10 + 8,
        time: clockLabel(bout.round, bout.roundTime),
        tone: "neutral",
        text: `Fight! Round ${bout.round} is under way.`,
      });
      bout.events = bout.events.slice(0, 8);
    }
    return;
  }

  const leftDown = advanceKnockdown(
    bout,
    bout.left,
    leftProfile,
    captureEvents,
  );
  const rightDown = advanceKnockdown(
    bout,
    bout.right,
    rightProfile,
    captureEvents,
  );
  // Both corners read the same pre-decision beat. If the left side changes its
  // action before the right side decides, the right side must not receive a
  // newer telegraph merely because it is updated second in this function.
  const leftTelegraph = livePunchRead(bout.left);
  const rightTelegraph = livePunchRead(bout.right);
  if (!leftDown) {
    if (rightDown) holdForCount(bout.left, bout.right);
    else updateDecision(
      bout.left,
      bout.right,
      leftProfile,
      actionOverrides.blue,
      ledger,
      rightTelegraph,
    );
  }
  if (!rightDown) {
    if (leftDown) holdForCount(bout.right, bout.left);
    else updateDecision(
      bout.right,
      bout.left,
      rightProfile,
      actionOverrides.red,
      ledger,
      leftTelegraph,
    );
  }
  const leftPosition = { x: bout.left.x, y: bout.left.y };
  const rightPosition = { x: bout.right.x, y: bout.right.y };
  if (!leftDown) updateMotion(bout.left, rightPosition, leftProfile);
  if (!rightDown) updateMotion(bout.right, leftPosition, rightProfile);
  if (!leftDown && !rightDown) separateBodies(bout.left, bout.right);
  updateFacing(bout.left, bout.right);
  updateFacing(bout.right, bout.left);
  updateArticulatedMechanics(bout.left, leftProfile);
  updateArticulatedMechanics(bout.right, rightProfile);
  const sampledRange = ringVector(bout.left, bout.right).distance;
  bout.left.rangeSampleTotal = round(bout.left.rangeSampleTotal + sampledRange, 3);
  bout.right.rangeSampleTotal = round(bout.right.rangeSampleTotal + sampledRange, 3);
  bout.left.rangeSamples += 1;
  bout.right.rangeSamples += 1;

  bout.left.actionElapsed = round(
    bout.left.actionElapsed + BOXING_MODEL.physicsStepSeconds,
    3,
  );
  bout.right.actionElapsed = round(
    bout.right.actionElapsed + BOXING_MODEL.physicsStepSeconds,
    3,
  );
  updatePunchTracking(bout.left, bout.right, leftProfile);
  updatePunchTracking(bout.right, bout.left, rightProfile);
  updateHandKinematics(bout.left, leftProfile);
  updateHandKinematics(bout.right, rightProfile);

  const leftImpact = detectImpact(
    bout.left,
    bout.right,
    leftProfile,
    rightProfile,
  );
  const rightImpact = detectImpact(
    bout.right,
    bout.left,
    rightProfile,
    leftProfile,
  );
  if (leftImpact) {
    applyImpact(
      bout,
      leftImpact,
      leftProfile,
      rightProfile,
      captureEvents,
    );
  }
  if (rightImpact) {
    applyImpact(
      bout,
      rightImpact,
      rightProfile,
      leftProfile,
      captureEvents,
    );
  }

  // How long each man has been stuck in tight. Boxing has an in-and-out rhythm:
  // they close, exchange, and reset. Without this the two simply collapse onto
  // the body-separation floor and stay welded there for the whole round.
  const separation = ringDistance(bout.left, bout.right);
  for (const runtime of [bout.left, bout.right]) {
    runtime.pocketSeconds =
      separation <= MIN_BODY_DISTANCE + 0.18
        ? round(runtime.pocketSeconds + BOXING_MODEL.physicsStepSeconds, 2)
        : round(Math.max(0, runtime.pocketSeconds - BOXING_MODEL.physicsStepSeconds * 1.6), 2);
  }
  updateRingControl(bout.left, bout.right);
  updateRingControl(bout.right, bout.left);
  pushSnapshot(bout.left);
  pushSnapshot(bout.right);
  bout.roundTime = round(
    bout.roundTime - BOXING_MODEL.physicsStepSeconds,
    2,
  );
  resolveEndState(
    bout,
    leftProfile,
    rightProfile,
    captureEvents,
  );
}

export function stepBout(
  bout: BoutState,
  roster: Fighter[],
  ledger?: DecisionLedger,
): BoutState {
  if (!bout.running || bout.finish) return bout;
  const next = structuredClone(bout);
  if (typeof next.introSeconds !== "number") next.introSeconds = 0;
  simulateStepMutable(next, roster, true, {}, ledger);
  return next;
}

export function stepBoutWithActions(
  bout: BoutState,
  roster: Fighter[],
  actions: Partial<Record<Corner, FighterAction>>,
): BoutState {
  if (!bout.running || bout.finish) return bout;
  const next = structuredClone(bout);
  simulateStepMutable(next, roster, true, actions);
  return next;
}

/** The same step, in place.
 *
 * `stepBoutWithActions` deep-clones the whole bout so a caller can hold every
 * frame it produced; a live renderer holds exactly one and throws the rest
 * away, and fifty structured clones a second is a measurable share of a phone's
 * frame budget. The worker's own loop has always stepped mutably for the same
 * reason — this is that, exported, for a caller driving a bout in real time. */
export function advanceBout(
  bout: BoutState,
  roster: Fighter[],
  actions: Partial<Record<Corner, FighterAction>> = {},
  guardHeld: Partial<Record<Corner, boolean>> = {},
) {
  bout.left.guardHeld = guardHeld.blue ?? false;
  bout.right.guardHeld = guardHeld.red ?? false;
  simulateStepMutable(bout, roster, true, actions);
}

/** How well a fighter is doing right now, as one number.
 *
 * This is a potential rather than a reward. What a single decision earned is
 * how far this moved between that decision and the next one, which is what lets
 * credit land on the choice that actually produced it instead of being smeared
 * evenly over a whole round. */
function rewardPotential(own: BoutFighter, opponent: BoutFighter) {
  return (
    (own.landed - opponent.landed) * 3.5 +
    (own.cleanImpactJ - opponent.cleanImpactJ) * 0.045 +
    (own.health - opponent.health) * 0.22 +
    (opponent.blocked - own.blocked) * 0.35 +
    (opponent.neurologicalLoad - own.neurologicalLoad) * 1.8 +
    (opponent.bodyShock - own.bodyShock) * 1.1 +
    (own.knockdowns - opponent.knockdowns) * 8
  );
}

function trainingRewardValue(bout: BoutState, traineeId: string) {
  const own = bout.left.fighterId === traineeId ? bout.left : bout.right;
  const opponent = bout.left.fighterId === traineeId ? bout.right : bout.left;
  return rewardPotential(own, opponent);
}

/** Opens a trace for a bout.
 *
 * Pass the athletes worth recording — usually the two men in the ring, or just
 * the one being trained — and everyone else's decisions are dropped instead of
 * accumulated and thrown away later. */
export function createDecisionLedger(fighterIds?: string[]): DecisionLedger {
  return { tracked: fighterIds ? [...fighterIds] : null, records: new Map() };
}

function recordDecision(
  ledger: DecisionLedger,
  fighterId: string,
  record: DecisionRecord,
) {
  if (ledger.tracked && !ledger.tracked.includes(fighterId)) return;
  const existing = ledger.records.get(fighterId);
  if (existing) {
    existing.push(record);
    return;
  }
  ledger.records.set(fighterId, [record]);
}

/** Closes a trace against the bout it came from.
 *
 * The last decision of a fight has no next decision to be measured against, so
 * it is settled on the final state of the bout plus what the verdict was worth. */
export function sealDecisionLedger(
  ledger: DecisionLedger,
  bout: BoutState,
): DecisionEpisode[] {
  const episodes: DecisionEpisode[] = [];
  for (const [fighterId, records] of ledger.records) {
    if (records.length < 2) continue;
    episodes.push({
      fighterId,
      records,
      finalValue: trainingRewardValue(bout, fighterId),
      terminalBonus: !bout.finish
        ? 0
        : bout.winnerId === fighterId
          ? 25
          : bout.winnerId === null
            ? 0
            : -25,
    });
  }
  return episodes;
}

export function createTrainingEnvironment(
  traineeId: string,
  opponentId: string,
  options: {
    traineeCorner?: Corner;
    roundSeconds?: number;
    totalRounds?: number;
  } = {},
): TrainingEnvironment {
  const traineeCorner = options.traineeCorner ?? "blue";
  const leftId = traineeCorner === "blue" ? traineeId : opponentId;
  const rightId = traineeCorner === "red" ? traineeId : opponentId;
  return {
    traineeId,
    opponentId,
    traineeCorner,
    // A training episode is not a broadcast — no round call, no held bell.
    bout: { ...createBout(leftId, rightId, 1, options), introSeconds: 0 },
    cumulativeReward: 0,
  };
}

export function observeTrainingEnvironment(
  environment: TrainingEnvironment,
  roster: Fighter[],
): TrainingObservation {
  const runtime =
    environment.traineeCorner === "blue"
      ? environment.bout.left
      : environment.bout.right;
  const opponent =
    environment.traineeCorner === "blue"
      ? environment.bout.right
      : environment.bout.left;
  const fighter = getProfile(roster, environment.traineeId);
  if (!fighter) {
    throw new Error(`Training athlete ${environment.traineeId} is not in the roster.`);
  }
  return {
    ...buildTrainingObservation(fighter, runtime, opponent),
    tick: environment.bout.tick,
    round: environment.bout.round,
    roundTime: environment.bout.roundTime,
  };
}

export function stepTrainingEnvironment(
  environment: TrainingEnvironment,
  roster: Fighter[],
  action?: FighterAction,
  ledger?: DecisionLedger,
): TrainingTransition {
  if (!environment.bout.running || environment.bout.finish) {
    return {
      environment,
      observation: observeTrainingEnvironment(environment, roster),
      reward: 0,
      done: true,
    };
  }

  const beforeObservation = observeTrainingEnvironment(environment, roster);
  const actionIndex = action ? ACTIONS.indexOf(action) : -1;
  const validAction =
    actionIndex >= 0 && beforeObservation.actionMask[actionIndex];
  const actionOverride = beforeObservation.actionReady
    ? validAction
      ? action
      : "guard"
    : undefined;
  const invalidActionPenalty =
    beforeObservation.actionReady && action && !validAction ? -2 : 0;
  const beforeValue = trainingRewardValue(
    environment.bout,
    environment.traineeId,
  );
  const next = structuredClone(environment);
  simulateStepMutable(
    next.bout,
    roster,
    false,
    { [environment.traineeCorner]: actionOverride },
    ledger,
  );
  let reward =
    trainingRewardValue(next.bout, next.traineeId) - beforeValue +
    invalidActionPenalty;
  if (next.bout.finish && !environment.bout.finish) {
    reward +=
      next.bout.winnerId === next.traineeId
        ? 25
        : next.bout.winnerId === null
          ? 0
          : -25;
  }
  reward = round(reward, 4);
  next.cumulativeReward = round(next.cumulativeReward + reward, 4);

  return {
    environment: next,
    observation: observeTrainingEnvironment(next, roster),
    reward,
    done: !next.bout.running || Boolean(next.bout.finish),
  };
}

export function simulateBoutToCompletion(
  roster: Fighter[],
  leftId: string,
  rightId: string,
  options: { roundSeconds?: number; totalRounds?: number } = {},
  ledger?: DecisionLedger,
) {
  const bout = createBout(leftId, rightId, 1, options);
  const maxTicks =
    Math.ceil(
      (((options.roundSeconds ?? BOXING_MODEL.roundSeconds) *
        (options.totalRounds ?? BOXING_MODEL.totalRounds)) +
        Math.max(0, (options.totalRounds ?? BOXING_MODEL.totalRounds) - 1) * 6 +
        (options.totalRounds ?? BOXING_MODEL.totalRounds) *
          BOXING_MODEL.roundIntroSeconds) /
        BOXING_MODEL.physicsStepSeconds,
    ) + 20;
  for (let tick = 0; tick < maxTicks && bout.running; tick += 1) {
    simulateStepMutable(bout, roster, false, {}, ledger);
  }
  return bout;
}

function updateOpponentDossier(
  fighter: Fighter,
  opponent: Fighter,
  opponentRuntime: BoutFighter,
  roundsObserved: number,
  updatedWeek: number,
  outcome: OpponentDossier["lastOutcome"],
) {
  const previous = fighter.opponentDossiers[opponent.id];
  const totalActions = Math.max(
    1,
    Object.values(opponentRuntime.actionCounts).reduce(
      (sum, value) => sum + value,
      0,
    ),
  );
  const actionRate = (...actions: FighterAction[]) =>
    actions.reduce(
      (sum, action) => sum + opponentRuntime.actionCounts[action],
      0,
    ) / totalActions;
  const sample = {
    headAttackRate: actionRate("jabHead", "crossHead", "hookHead"),
    bodyAttackRate: actionRate("jabBody", "crossBody", "hookBody"),
    pressureRate: actionRate(
      "advance",
      "crossHead",
      "hookHead",
      "crossBody",
      "hookBody",
    ),
    evasionRate: actionRate(
      "slip",
      "duck",
      "weave",
      "circleLeft",
      "circleRight",
      "pivotLeft",
      "pivotRight",
    ),
    guardRate: actionRate("guard"),
    averageRangeMeters:
      opponentRuntime.rangeSampleTotal / Math.max(1, opponentRuntime.rangeSamples),
    dangerScore: clamp(
      opponentRuntime.cleanImpactJ / Math.max(1, roundsObserved * 2.2) +
        opponentRuntime.knockdowns * 12,
      0,
      100,
    ),
  };
  const previousBouts = previous?.boutsObserved ?? 0;
  const blend = (key: keyof typeof sample) =>
    round(
      (((previous?.[key] as number | undefined) ?? sample[key]) * previousBouts +
        sample[key]) /
        (previousBouts + 1),
      3,
    );

  const dossier: OpponentDossier = {
    opponentId: opponent.id,
    boutsObserved: previousBouts + 1,
    roundsObserved: (previous?.roundsObserved ?? 0) + roundsObserved,
    headAttackRate: blend("headAttackRate"),
    bodyAttackRate: blend("bodyAttackRate"),
    pressureRate: blend("pressureRate"),
    evasionRate: blend("evasionRate"),
    guardRate: blend("guardRate"),
    averageRangeMeters: blend("averageRangeMeters"),
    dangerScore: blend("dangerScore"),
    lastOutcome: outcome,
    updatedWeek,
  };

  return {
    ...fighter.opponentDossiers,
    [opponent.id]: dossier,
  };
}

/** What a night's work was worth.
 *
 * Experience is paid for the fight itself, not just the verdict — rounds
 * survived and clean work landed both count, so a fighter who loses a war still
 * develops faster than one who wins a walkover. */
function awardBoutExperience(
  fighter: Fighter,
  bout: BoutState,
  own: BoutFighter,
  opponent: BoutFighter,
  won: boolean,
  drew: boolean,
) {
  const stoppage = bout.finish === "KO" || bout.finish === "TKO";
  const earned =
    20 +
    (won ? 45 : drew ? 25 : 12) +
    (won && stoppage ? 25 : 0) +
    Math.min(40, own.landed * 0.6) +
    Math.min(30, Math.max(1, bout.round) * 4) +
    Math.min(15, own.knockdowns * 7) -
    Math.min(12, opponent.knockdowns * 4);

  let level = fighter.level;
  let xp = fighter.xp + Math.max(8, Math.round(earned));
  while (xp >= xpForNextLevel(level) && level < 50) {
    xp -= xpForNextLevel(level);
    level += 1;
  }
  return { level, xp };
}

/** Levels sharpen what an athlete already is: their best attribute grows
 * fastest, and the rest come along behind it. */
function levelUpStats(fighter: Fighter, level: number): FighterStats {
  const gained = level - fighter.level;
  if (gained <= 0) return fighter.stats;
  const entries = Object.entries(fighter.stats) as [keyof FighterStats, number][];
  const signature = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const grown = { ...fighter.stats };
  for (const [stat, value] of entries) {
    grown[stat] = clamp(value + gained * (stat === signature ? 0.5 : 0.3), 40, 99);
  }
  return grown;
}

export function commitBout(league: LeagueState, bout: BoutState): LeagueState {
  if (!bout.finish || bout.careerCommitted) return league;
  const roster = league.roster.map((fighter) => {
    if (fighter.id !== bout.left.fighterId && fighter.id !== bout.right.fighterId) return fighter;
    const won = fighter.id === bout.winnerId;
    const drew = bout.winnerId === null;
    const own = fighter.id === bout.left.fighterId ? bout.left : bout.right;
    const opponent = fighter.id === bout.left.fighterId ? bout.right : bout.left;
    const opponentProfile = league.roster.find(
      (candidate) => candidate.id === opponent.fighterId,
    );
    const ratingChange = drew ? 0 : won ? 3 : -3;
    const { level, xp } = awardBoutExperience(fighter, bout, own, opponent, won, drew);
    return {
      ...fighter,
      rating: clamp(fighter.rating + ratingChange, 55, 99),
      level,
      xp,
      stats: levelUpStats(fighter, level),
      record: {
        wins: fighter.record.wins + (won ? 1 : 0),
        losses: fighter.record.losses + (!won && !drew ? 1 : 0),
        draws: fighter.record.draws + (drew ? 1 : 0),
        knockouts:
          fighter.record.knockouts +
          (won && (bout.finish === "KO" || bout.finish === "TKO") ? 1 : 0),
      },
      lastTrainingGain: fighter.lastTrainingGain,
      confidence: clamp(
        fighter.confidence +
          (won ? Math.min(3, own.cleanImpactJ / Math.max(60, opponent.cleanImpactJ + 20)) : -1.5),
        35,
        96,
      ),
      opponentDossiers: opponentProfile
        ? updateOpponentDossier(
            fighter,
            opponentProfile,
            opponent,
            Math.max(1, bout.round),
            league.week,
            drew ? "draw" : won ? "win" : "loss",
          )
        : fighter.opponentDossiers,
    };
  });

  // The season calendar belongs to the broadcast now — it decides when a week
  // is over and a title is on the line — so committing a result no longer
  // silently rolls the week forward under it.
  return {
    ...league,
    boutsCompleted: league.boutsCompleted + 1,
    roster,
  };
}

const GRADIENT_MATRICES = [
  "weights",
  "hiddenWeights",
  "recurrentHiddenWeights",
  "memoryInputWeights",
  "memoryWeights",
  "intentWeights",
  "intentMemoryWeights",
  "outputWeights",
  "outputMemoryWeights",
  "intentActionWeights",
] as const;

const GRADIENT_VECTORS = [
  "bias",
  "hiddenBias",
  "memoryBias",
  "intentBias",
] as const;

type PolicyGradient = Pick<
  PolicyModel,
  (typeof GRADIENT_MATRICES)[number] | (typeof GRADIENT_VECTORS)[number]
>;

/** Softmax across the actions the fighter was actually allowed to throw. */
function maskedSoftmax(scores: number[], mask: boolean[]) {
  let maximum = Number.NEGATIVE_INFINITY;
  scores.forEach((score, index) => {
    if (mask[index] && score > maximum) maximum = score;
  });
  if (!Number.isFinite(maximum)) return scores.map(() => 0);
  const exponentials = scores.map((score, index) =>
    mask[index] ? Math.exp(score - maximum) : 0,
  );
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => (total > 0 ? value / total : 0));
}

/** What each decision in an episode was ultimately worth.
 *
 * A decision earns however far the fighter's position moved before his next
 * one, so consecutive values telescope and no exchange is counted twice. The
 * last decision has no successor and is settled against the final bell plus
 * what the verdict was worth. */
function episodeReturns(episode: DecisionEpisode) {
  const returns = episode.records.map(() => 0);
  let running = 0;
  for (let index = episode.records.length - 1; index >= 0; index -= 1) {
    const reward =
      index === episode.records.length - 1
        ? episode.finalValue - episode.records[index].value + episode.terminalBonus
        : episode.records[index + 1].value - episode.records[index].value;
    running = reward + LEARNING.discount * running;
    returns[index] = running;
  }
  return returns;
}

/** One learning step over decisions that have already been made.
 *
 * The action a fighter threw came from the blended controller rather than from
 * a sample of this net, so this is not textbook REINFORCE. Read it instead as:
 * endorse more strongly the choices that turned out well, and back away from
 * the ones that did not. That is precisely the signal the influence dial needs
 * — the net learns to agree with the boxing brain where the boxing brain was
 * right, and to differ from it where it was not, so handing it more of the
 * decision is an improvement rather than added noise.
 *
 * Backpropagation through the recurrent memory is truncated at a single step:
 * the gradient reaches the weights that produced this decision's memory, but is
 * not unrolled back through the round. */
function policyGradientUpdate(
  policy: PolicyModel,
  episodes: DecisionEpisode[],
  learningRate: number,
): { policy: PolicyModel; decisions: number } {
  const samples: { record: DecisionRecord; expectedReturn: number }[] = [];
  for (const episode of episodes) {
    const returns = episodeReturns(episode);
    episode.records.forEach((record, index) => {
      samples.push({ record, expectedReturn: returns[index] });
    });
  }
  if (samples.length < 2) return { policy, decisions: 0 };

  // Centre and scale the returns. Without this the size of an update would be
  // set by how violent the fight happened to be rather than by which decisions
  // in it were better than this athlete's own average.
  const mean =
    samples.reduce((sum, sample) => sum + sample.expectedReturn, 0) /
    samples.length;
  const variance =
    samples.reduce(
      (sum, sample) => sum + (sample.expectedReturn - mean) ** 2,
      0,
    ) / samples.length;
  const deviation = Math.max(Math.sqrt(variance), 1e-3);

  const gradient = {
    weights: policy.weights.map((row) => row.map(() => 0)),
    bias: policy.bias.map(() => 0),
    hiddenWeights: policy.hiddenWeights.map((row) => row.map(() => 0)),
    hiddenBias: policy.hiddenBias.map(() => 0),
    recurrentHiddenWeights: policy.recurrentHiddenWeights.map((row) =>
      row.map(() => 0),
    ),
    memoryInputWeights: policy.memoryInputWeights.map((row) => row.map(() => 0)),
    memoryWeights: policy.memoryWeights.map((row) => row.map(() => 0)),
    memoryBias: policy.memoryBias.map(() => 0),
    intentWeights: policy.intentWeights.map((row) => row.map(() => 0)),
    intentMemoryWeights: policy.intentMemoryWeights.map((row) =>
      row.map(() => 0),
    ),
    intentBias: policy.intentBias.map(() => 0),
    outputWeights: policy.outputWeights.map((row) => row.map(() => 0)),
    outputMemoryWeights: policy.outputMemoryWeights.map((row) =>
      row.map(() => 0),
    ),
    intentActionWeights: policy.intentActionWeights.map((row) =>
      row.map(() => 0),
    ),
  } satisfies PolicyGradient;

  for (const { record, expectedReturn } of samples) {
    const advantage = (expectedReturn - mean) / deviation;
    const { features, hidden, memory, previousMemory } = record;
    const hiddenError = hidden.map(() => 0);
    const memoryError = memory.map(() => 0);

    maskedSoftmax(record.actionScores, record.mask).forEach(
      (probability, actionIndex) => {
        if (!record.mask[actionIndex]) return;
        const delta =
          ((actionIndex === record.actionIndex ? 1 : 0) - probability) *
          advantage;
        if (delta === 0) return;
        gradient.bias[actionIndex] += delta;
        features.forEach((feature, featureIndex) => {
          gradient.weights[actionIndex][featureIndex] += delta * feature;
        });
        hidden.forEach((activation, hiddenIndex) => {
          gradient.outputWeights[actionIndex][hiddenIndex] += delta * activation;
          hiddenError[hiddenIndex] +=
            delta * (policy.outputWeights[actionIndex]?.[hiddenIndex] ?? 0);
        });
        memory.forEach((activation, memoryIndex) => {
          gradient.outputMemoryWeights[actionIndex][memoryIndex] +=
            delta * activation;
          memoryError[memoryIndex] +=
            delta * (policy.outputMemoryWeights[actionIndex]?.[memoryIndex] ?? 0);
        });
        gradient.intentActionWeights[actionIndex][record.intentIndex] += delta;
      },
    );

    // The intent head picks by argmax, which has no gradient of its own, so it
    // is trained as a classifier on the intent the fighter actually carried
    // into the exchange and credited with the same advantage.
    maskedSoftmax(
      record.intentScores,
      record.intentScores.map(() => true),
    ).forEach((probability, intentIndex) => {
      const delta =
        ((intentIndex === record.intentIndex ? 1 : 0) - probability) * advantage;
      if (delta === 0) return;
      gradient.intentBias[intentIndex] += delta;
      hidden.forEach((activation, hiddenIndex) => {
        gradient.intentWeights[intentIndex][hiddenIndex] += delta * activation;
        hiddenError[hiddenIndex] +=
          delta * (policy.intentWeights[intentIndex]?.[hiddenIndex] ?? 0);
      });
      memory.forEach((activation, memoryIndex) => {
        gradient.intentMemoryWeights[intentIndex][memoryIndex] +=
          delta * activation;
        memoryError[memoryIndex] +=
          delta * (policy.intentMemoryWeights[intentIndex]?.[memoryIndex] ?? 0);
      });
    });

    memory.forEach((activation, memoryIndex) => {
      const preActivation = memoryError[memoryIndex] * (1 - activation * activation);
      if (preActivation === 0) return;
      gradient.memoryBias[memoryIndex] += preActivation;
      hidden.forEach((hiddenActivation, hiddenIndex) => {
        gradient.memoryInputWeights[memoryIndex][hiddenIndex] +=
          preActivation * hiddenActivation;
        hiddenError[hiddenIndex] +=
          preActivation *
          (policy.memoryInputWeights[memoryIndex]?.[hiddenIndex] ?? 0);
      });
      previousMemory.forEach((previous, previousIndex) => {
        gradient.memoryWeights[memoryIndex][previousIndex] +=
          preActivation * previous;
      });
    });

    hidden.forEach((activation, hiddenIndex) => {
      const preActivation = hiddenError[hiddenIndex] * (1 - activation * activation);
      if (preActivation === 0) return;
      gradient.hiddenBias[hiddenIndex] += preActivation;
      features.forEach((feature, featureIndex) => {
        gradient.hiddenWeights[hiddenIndex][featureIndex] +=
          preActivation * feature;
      });
      previousMemory.forEach((previous, previousIndex) => {
        gradient.recurrentHiddenWeights[hiddenIndex][previousIndex] +=
          preActivation * previous;
      });
    });
  }

  // Average the batch, then cap how far one update may move the brain. A single
  // wild night should nudge an athlete, never rewrite him.
  const average = 1 / samples.length;
  let squared = 0;
  for (const key of GRADIENT_MATRICES) {
    for (const row of gradient[key]) {
      for (const value of row) squared += value * value;
    }
  }
  for (const key of GRADIENT_VECTORS) {
    for (const value of gradient[key]) squared += value * value;
  }
  const norm = Math.sqrt(squared) * average;
  const step =
    learningRate *
    average *
    (norm > LEARNING.maxUpdateNorm ? LEARNING.maxUpdateNorm / norm : 1);

  // Every weight stays rounded to four places. The whole roster is persisted as
  // JSON on every league write, and unrounded floats would quietly triple the
  // size of that payload.
  const applyMatrix = (base: number[][], delta: number[][]) =>
    base.map((row, rowIndex) =>
      row.map((weight, columnIndex) =>
        round(
          clamp(
            weight + (delta[rowIndex]?.[columnIndex] ?? 0) * step,
            -LEARNING.weightLimit,
            LEARNING.weightLimit,
          ),
          4,
        ),
      ),
    );
  const applyVector = (base: number[], delta: number[]) =>
    base.map((weight, index) =>
      round(
        clamp(
          weight + (delta[index] ?? 0) * step,
          -LEARNING.weightLimit,
          LEARNING.weightLimit,
        ),
        4,
      ),
    );

  return {
    policy: {
      ...policy,
      weights: applyMatrix(policy.weights, gradient.weights),
      bias: applyVector(policy.bias, gradient.bias),
      hiddenWeights: applyMatrix(policy.hiddenWeights, gradient.hiddenWeights),
      hiddenBias: applyVector(policy.hiddenBias, gradient.hiddenBias),
      recurrentHiddenWeights: applyMatrix(
        policy.recurrentHiddenWeights,
        gradient.recurrentHiddenWeights,
      ),
      memoryInputWeights: applyMatrix(
        policy.memoryInputWeights,
        gradient.memoryInputWeights,
      ),
      memoryWeights: applyMatrix(policy.memoryWeights, gradient.memoryWeights),
      memoryBias: applyVector(policy.memoryBias, gradient.memoryBias),
      intentWeights: applyMatrix(policy.intentWeights, gradient.intentWeights),
      intentMemoryWeights: applyMatrix(
        policy.intentMemoryWeights,
        gradient.intentMemoryWeights,
      ),
      intentBias: applyVector(policy.intentBias, gradient.intentBias),
      outputWeights: applyMatrix(policy.outputWeights, gradient.outputWeights),
      outputMemoryWeights: applyMatrix(
        policy.outputMemoryWeights,
        gradient.outputMemoryWeights,
      ),
      intentActionWeights: applyMatrix(
        policy.intentActionWeights,
        gradient.intentActionWeights,
      ),
    },
    decisions: samples.length,
  };
}

/** Folds a finished fight back into the two brains that fought it.
 *
 * This is what the trace is for: the bout already happened, so the training
 * data costs nothing to produce and nothing to keep — the decisions are read
 * once, turned into one small step per athlete, and dropped. Every fight on the
 * card makes both men fractionally better at the thing they just did.
 *
 * The step is unguarded — no re-run checks that it helped — which is why
 * `LEARNING.boutRate` is a fraction of the rate guarded sparring uses. */
export function learnFromBout(
  league: LeagueState,
  episodes: DecisionEpisode[],
): LeagueState {
  if (episodes.length === 0) return league;
  const byFighter = new Map(
    episodes.map((episode) => [episode.fighterId, episode]),
  );
  let changed = false;
  const roster = league.roster.map((fighter) => {
    const episode = byFighter.get(fighter.id);
    if (!episode) return fighter;
    const learned = policyGradientUpdate(
      fighter.policy,
      [episode],
      LEARNING.boutRate,
    );
    if (learned.decisions === 0) return fighter;
    changed = true;
    return {
      ...fighter,
      policy: {
        ...learned.policy,
        learnedDecisions:
          fighter.policy.learnedDecisions + learned.decisions,
      },
    };
  });
  return changed ? { ...league, roster } : league;
}

function mutatePolicy(
  source: PolicyModel,
  seed: number,
  scale: number,
): PolicyModel {
  const mutateMatrix = (
    matrix: number[][],
    seedOffset: number,
    mutationScale = scale,
  ) =>
    matrix.map((row, rowIndex) =>
      row.map((weight, columnIndex) =>
        round(
          weight +
            mutationSignal(
              seed + seedOffset + rowIndex * 97 + columnIndex * 17,
            ) * mutationScale,
          4,
        ),
      ),
    );
  const mutateVector = (
    vector: number[],
    seedOffset: number,
    mutationScale = scale,
  ) =>
    vector.map((value, index) =>
      round(
        value +
          mutationSignal(seed + seedOffset + index * 41) * mutationScale,
        4,
      ),
    );

  return {
    ...source,
    weights: mutateMatrix(source.weights, 0),
    bias: mutateVector(source.bias, 701, scale * 0.65),
    hiddenWeights: mutateMatrix(source.hiddenWeights, 1301, scale * 0.72),
    hiddenBias: mutateVector(source.hiddenBias, 1901, scale * 0.5),
    recurrentHiddenWeights: mutateMatrix(
      source.recurrentHiddenWeights,
      2101,
      scale * 0.62,
    ),
    memoryInputWeights: mutateMatrix(
      source.memoryInputWeights,
      2201,
      scale * 0.65,
    ),
    memoryWeights: mutateMatrix(source.memoryWeights, 2251, scale * 0.48),
    memoryBias: mutateVector(source.memoryBias, 2271, scale * 0.42),
    intentWeights: mutateMatrix(source.intentWeights, 2301, scale * 0.7),
    intentMemoryWeights: mutateMatrix(
      source.intentMemoryWeights,
      2601,
      scale * 0.58,
    ),
    intentBias: mutateVector(source.intentBias, 2901, scale * 0.48),
    outputWeights: mutateMatrix(source.outputWeights, 3301, scale * 0.72),
    outputMemoryWeights: mutateMatrix(
      source.outputMemoryWeights,
      3601,
      scale * 0.58,
    ),
    intentActionWeights: mutateMatrix(
      source.intentActionWeights,
      3901,
      scale * 0.58,
    ),
  };
}

function runPolicyTrainingEpisode(
  roster: Fighter[],
  fighterId: string,
  opponentId: string,
  traineeCorner: Corner,
  evaluationSeconds: number,
  episodes?: DecisionEpisode[],
) {
  const fighter = getProfile(roster, fighterId);
  if (!fighter) {
    throw new Error(`Training athlete ${fighterId} is not in the roster.`);
  }
  let environment = createTrainingEnvironment(fighterId, opponentId, {
    traineeCorner,
    roundSeconds: evaluationSeconds,
    totalRounds: 1,
  });
  const maxTicks =
    Math.ceil(evaluationSeconds / BOXING_MODEL.physicsStepSeconds) + 10;
  // Sparring is already being simulated to score the candidate, so the trace
  // rides along on it for free rather than costing a second run.
  const ledger = episodes ? createDecisionLedger([fighterId]) : undefined;

  for (
    let tick = 0;
    tick < maxTicks && environment.bout.running;
    tick += 1
  ) {
    const observation = observeTrainingEnvironment(environment, roster);
    const action = observation.actionReady
      ? selectPolicyAction(fighter, observation)
      : undefined;
    environment = stepTrainingEnvironment(
      environment,
      roster,
      action,
      ledger,
    ).environment;
  }

  if (ledger && episodes) {
    episodes.push(...sealDecisionLedger(ledger, environment.bout));
  }
  return environment;
}

function evaluatePolicy(
  roster: Fighter[],
  fighterId: string,
  policy: PolicyModel,
  opponentCount: number,
  evaluationSeconds: number,
  episodes?: DecisionEpisode[],
) {
  // Sparring only teaches something useful against bodies the athlete will
  // actually meet. Now that the league spans three divisions, evaluating a
  // middleweight against whoever happens to sit first in the roster could pit
  // him against a featherweight 34 lb lighter — a walkover that no mutation can
  // improve on. Stay in the division whenever it is deep enough to.
  const pool = roster.filter((fighter) => fighter.id !== fighterId);
  const division = roster.find((fighter) => fighter.id === fighterId)?.weightClass;
  const inDivision = pool.filter((fighter) => fighter.weightClass === division);
  const opponents = (inDivision.length >= opponentCount ? inDivision : pool)
    .slice(0, opponentCount);
  const evaluationRoster = roster.map((fighter) =>
    fighter.id === fighterId ? { ...fighter, policy } : fighter,
  );
  let fitness = 0;
  let bouts = 0;
  let physicsSteps = 0;

  opponents.forEach((opponent) => {
    const asBlue = runPolicyTrainingEpisode(
      evaluationRoster,
      fighterId,
      opponent.id,
      "blue",
      evaluationSeconds,
      episodes,
    );
    const asRed = runPolicyTrainingEpisode(
      evaluationRoster,
      fighterId,
      opponent.id,
      "red",
      evaluationSeconds,
      episodes,
    );
    fitness += asBlue.cumulativeReward + asRed.cumulativeReward;
    physicsSteps += asBlue.bout.tick + asRed.bout.tick;
    bouts += 2;
  });

  return {
    fitness: round(fitness / Math.max(1, bouts), 3),
    bouts,
    physicsSteps,
  };
}

export function adaptConditioning(
  conditioning: ConditioningProfile,
  bouts: number,
  physicsSteps: number,
  gain: number,
  cycles: number,
) {
  const enduranceRate = clamp(
    physicsSteps / 420000 + bouts / 9000,
    0.001,
    0.035,
  );
  const powerRate = clamp(
    bouts / 14000 + Math.max(0, gain) / 5000,
    0.0008,
    0.018,
  );
  const chainRate = clamp(
    physicsSteps / 900000 + Math.max(0, gain) / 3500,
    0.0008,
    0.022,
  );
  const shoulderRate = clamp(
    bouts / 10000 + physicsSteps / 1100000,
    0.0008,
    0.025,
  );
  const adapt = (value: number, rate: number) =>
    round(clamp(value + (100 - value) * rate, 45, 100), 2);

  return {
    lowerBodyPower: adapt(conditioning.lowerBodyPower, powerRate),
    lowerBodyEndurance: adapt(conditioning.lowerBodyEndurance, enduranceRate),
    kineticChain: adapt(conditioning.kineticChain, chainRate),
    shoulderEndurance: adapt(conditioning.shoulderEndurance, shoulderRate),
    workloadSteps: conditioning.workloadSteps + physicsSteps,
    adaptationCycles: conditioning.adaptationCycles + cycles,
  } satisfies ConditioningProfile;
}

export function trainAthlete(
  league: LeagueState,
  fighterId: string,
  config: TrainingConfig = {},
): TrainingResult {
  const generations = config.generations ?? 4;
  const population = config.population ?? 5;
  const opponents = config.opponents ?? 3;
  const evaluationSeconds = config.evaluationSeconds ?? 45;
  const fighter = league.roster.find((entry) => entry.id === fighterId);
  if (!fighter) {
    return {
      league,
      bouts: 0,
      physicsSteps: 0,
      generations: 0,
      candidates: 0,
      fitnessBefore: 0,
      fitnessAfter: 0,
      gain: 0,
    };
  }

  // The baseline sparring is run anyway to find out where the athlete stands,
  // so its decisions are traced on the way past and become the material for the
  // credited-learning candidate below.
  const episodes: DecisionEpisode[] = [];
  const baseline = evaluatePolicy(
    league.roster,
    fighterId,
    fighter.policy,
    opponents,
    evaluationSeconds,
    episodes,
  );
  let bestPolicy = structuredClone(fighter.policy);
  let bestFitness = baseline.fitness;
  let bouts = baseline.bouts;
  let physicsSteps = baseline.physicsSteps;
  let creditedDecisions = 0;

  for (let generation = 0; generation < generations; generation += 1) {
    const scale = Math.max(0.035, 0.16 - generation * 0.027);
    let generationPolicy = bestPolicy;
    let generationFitness = bestFitness;
    let generationCredited = 0;
    // Candidate zero used to be the incumbent, re-run to a fitness that was
    // already known — a wasted evaluation every generation. It is now the
    // incumbent with one credited-decision step applied, so the search gets a
    // candidate that changed for a reason at no extra cost. Blind mutation
    // still fills the rest of the population, and the accept gate below is
    // unchanged: nothing is kept unless it actually sparred better.
    const learned = policyGradientUpdate(
      bestPolicy,
      episodes,
      LEARNING.sparringRate,
    );

    for (let candidate = 0; candidate < population; candidate += 1) {
      const candidatePolicy =
        candidate === 0
          ? learned.policy
          : mutatePolicy(
              bestPolicy,
              fighter.seed * 1009 +
                (fighter.policy.generation + generation + 1) * 131 +
                candidate * 43,
              scale,
            );
      const evaluation = evaluatePolicy(
        league.roster,
        fighterId,
        candidatePolicy,
        opponents,
        evaluationSeconds,
      );
      bouts += evaluation.bouts;
      physicsSteps += evaluation.physicsSteps;
      if (evaluation.fitness > generationFitness) {
        generationFitness = evaluation.fitness;
        generationPolicy = candidatePolicy;
        generationCredited = candidate === 0 ? learned.decisions : 0;
      }
    }

    bestPolicy = generationPolicy;
    bestFitness = generationFitness;
    creditedDecisions += generationCredited;
  }

  const gain = round(Math.max(0, bestFitness - baseline.fitness), 2);
  const roster = league.roster.map((entry) => {
    if (entry.id !== fighterId) return entry;
    return {
      ...entry,
      policy: {
        ...bestPolicy,
        generation: entry.policy.generation + generations,
        evaluatedBouts: entry.policy.evaluatedBouts + bouts,
        // Only decisions behind a candidate the search actually kept count, so
        // the influence dial tracks learning that survived rather than every
        // step that was tried.
        learnedDecisions: entry.policy.learnedDecisions + creditedDecisions,
        fitness: bestFitness,
      },
      trainingBouts: entry.trainingBouts + bouts,
      lastTrainingGain: gain,
      confidence: round(clamp(entry.confidence + Math.min(2, gain * 0.08), 35, 98)),
      rating: round(clamp(entry.rating + Math.min(0.7, gain * 0.015), 55, 99)),
      conditioning: adaptConditioning(
        entry.conditioning,
        bouts,
        physicsSteps,
        gain,
        generations,
      ),
    };
  });

  return {
    league: { ...league, roster },
    bouts,
    physicsSteps,
    generations,
    candidates: generations * population,
    fitnessBefore: baseline.fitness,
    fitnessAfter: bestFitness,
    gain,
  };
}

/** A clean opening exchange, as the observation vector sees it.
 *
 * Keyed by feature name rather than written out as a bare list. The list had
 * fallen three short of the 27 features the net reads, and because `layerValue`
 * folds over the inputs rather than the weights, the missing three were read as
 * zeros instead of raising anything — a silent mismatch waiting for the next
 * feature to be added. Typing it against FEATURE means a new feature cannot be
 * introduced without a neutral value for it. */
const NEUTRAL_OBSERVATION: Record<keyof typeof FEATURE, number> = {
  distance: 0.38,
  jabWindow: 1,
  crossWindow: 1,
  hookWindow: 0.4,
  closing: 0.5,
  stamina: 0.72,
  fatigue: 0.28,
  opponentFatigue: 0.3,
  balance: 0.82,
  opponentOffBalance: 0.2,
  condition: 0.8,
  opponentHurt: 0.2,
  opponentPunch: 0.25,
  opponentGuard: 0.35,
  scoreBehind: 0.5,
  ownRope: 0.15,
  opponentRope: 0.15,
  targetOpen: 0.8,
  lateralOffset: 0.18,
  lateralClosing: 0.5,
  ownDepthRope: 0.15,
  opponentDepthRope: 0.15,
  opponentLowLevel: 0,
  opponentEvasive: 0.2,
  recentHeadImpact: 0,
  recentBodyImpact: 0,
  sustainedPressure: 0,
  // The scouting pose has nobody mid-punch, so nobody reads as open.
  opponentExposure: 0,
};

/** The scouting snapshot as a vector, in the order the net reads it. */
export function neutralObservation() {
  const features = Array<number>(BOXING_MODEL.observationFeatures).fill(0);
  for (const [feature, index] of Object.entries(FEATURE)) {
    features[index] = NEUTRAL_OBSERVATION[feature as keyof typeof FEATURE];
  }
  return features;
}

export function getActionPreferences(fighter: Fighter) {
  if (fighter.publicActionPreferences?.length) {
    return fighter.publicActionPreferences;
  }
  const neural = runNeuralPolicy(fighter.policy, neutralObservation());
  const raw = ACTIONS.map((action, index) => ({
    action,
    score: neural.actionScores[index],
  }));
  const maxScore = Math.max(...raw.map((entry) => entry.score));
  const exponentials = raw.map((entry) => Math.exp(entry.score - maxScore));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return raw
    .map((entry, index) => ({
      action: entry.action,
      value: Math.round((exponentials[index] / total) * 100),
    }))
    .sort((a, b) => b.value - a.value);
}
