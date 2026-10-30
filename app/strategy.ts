export const STRATEGY_FOCI = [
  "pressure",
  "counter",
  "bodyWork",
  "outside",
  "recover",
  "evasive",
] as const;

export type StrategyFocus = (typeof STRATEGY_FOCI)[number];
export type StrategyTarget = "head" | "body" | "mixed";
export type RingMode = "center" | "pressure" | "outside";
export type StrategySource =
  | "opening"
  | "dossier"
  | "between-round"
  | "language";

export interface OpponentDossier {
  opponentId: string;
  boutsObserved: number;
  roundsObserved: number;
  headAttackRate: number;
  bodyAttackRate: number;
  pressureRate: number;
  evasionRate: number;
  guardRate: number;
  averageRangeMeters: number;
  dangerScore: number;
  lastOutcome: "win" | "loss" | "draw";
  updatedWeek: number;
}

export interface StrategyRoundStats {
  cleanBlows: number;
  impactEnergy: number;
  defense: number;
  control: number;
  knockdowns: number;
  stamina: number;
  health: number;
}

export interface StrategyContext {
  fighter: {
    id: string;
    name: string;
    archetype: string;
    stance: string;
    reachInches: number;
  };
  opponent: {
    id: string;
    name: string;
    archetype: string;
    stance: string;
    reachInches: number;
  };
  round: number;
  scoreDifference: number;
  own: StrategyRoundStats;
  opponentRound: StrategyRoundStats;
  dossier: OpponentDossier | null;
  currentDirective: StrategyDirective;
}

export interface StrategyDirective {
  focus: StrategyFocus;
  pace: number;
  risk: number;
  target: StrategyTarget;
  ringMode: RingMode;
  confidence: number;
  note: string;
  source: StrategySource;
  issuedRound: number;
}

export const STRATEGY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    focus: { type: "string", enum: STRATEGY_FOCI },
    pace: {
      type: "number",
      minimum: -1,
      maximum: 1,
      description: "Negative slows the pace; positive increases it.",
    },
    risk: {
      type: "number",
      minimum: -1,
      maximum: 1,
      description: "Negative prioritizes safety; positive accepts exchanges.",
    },
    target: { type: "string", enum: ["head", "body", "mixed"] },
    ringMode: { type: "string", enum: ["center", "pressure", "outside"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    note: {
      type: "string",
      description: "One short, evidence-based corner instruction.",
    },
  },
  required: [
    "focus",
    "pace",
    "risk",
    "target",
    "ringMode",
    "confidence",
    "note",
  ],
  additionalProperties: false,
} as const;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

export function normalizeStrategyDirective(
  value: unknown,
  issuedRound: number,
  source: StrategySource = "language",
): StrategyDirective | null {
  if (!value || typeof value !== "object") return null;
  const directive = value as Record<string, unknown>;
  if (!includesValue(STRATEGY_FOCI, directive.focus)) return null;
  if (!includesValue(["head", "body", "mixed"] as const, directive.target)) return null;
  if (!includesValue(["center", "pressure", "outside"] as const, directive.ringMode)) return null;
  if (
    typeof directive.pace !== "number" ||
    typeof directive.risk !== "number" ||
    typeof directive.confidence !== "number" ||
    typeof directive.note !== "string"
  ) {
    return null;
  }

  return {
    focus: directive.focus,
    pace: clamp(directive.pace, -1, 1),
    risk: clamp(directive.risk, -1, 1),
    target: directive.target,
    ringMode: directive.ringMode,
    confidence: clamp(directive.confidence, 0, 100),
    note: directive.note.trim().slice(0, 180),
    source,
    issuedRound: Math.max(1, Math.round(issuedRound)),
  };
}

export function buildStrategyInstructions() {
  return [
    "You are the slow strategy layer above an autonomous boxer's recurrent motor policy.",
    "Analyze only the supplied measurements and opponent dossier.",
    "Issue one bounded round directive. Never choose individual punches, combos, movement frames, damage, scores, or a winner.",
    "The fast neural policy remains responsible for every motor action and may reject the strategic bias when physics or legality requires it.",
    "Keep the note under 140 characters and cite the most important observed tendency in plain boxing language.",
  ].join(" ");
}

export function extractStrategyOutput(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}
