import {
  STRATEGY_OUTPUT_SCHEMA,
  buildStrategyInstructions,
  extractStrategyOutput,
  normalizeStrategyDirective,
  type StrategyContext,
} from "../app/strategy.ts";
import { adminAuthorized } from "./admin.ts";

interface StrategyEnv {
  FORGE_ADMIN_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_STRATEGY_MODEL?: string;
}

/** How long a corner call may take before the fight goes on without it.
 *
 * A bout is simulated inside the broadcast tick, so a request that never comes
 * back does not merely lose one instruction — it holds the whole card up behind
 * it, and every viewer sits on "between fights" until the isolate is replaced.
 * The simulation's own corner logic is a perfectly good fallback, and it is what
 * a timeout falls through to. */
const STRATEGY_TIMEOUT_MS = 15_000;

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Asks the language strategist for one corner's next-round instructions.
 *
 * Split out of the HTTP handler because the broadcast needs the same thing from
 * inside the worker: a bout is simulated to its final bell on the server before
 * it airs, and the corner instructions have to be generated and written down at
 * that point so every viewer replays the identical fight. Returns null whenever
 * the strategist is unconfigured or unhappy, and the deterministic corner logic
 * in the simulation takes over. */
export async function generateStrategyDirective(
  context: StrategyContext,
  env: StrategyEnv,
) {
  if (!env.OPENAI_API_KEY) return null;
  if (!context?.fighter?.id || !context?.opponent?.id || !context.round) return null;

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_STRATEGY_MODEL ?? "gpt-5.6-terra",
        instructions: buildStrategyInstructions(),
        input: JSON.stringify(context),
        max_output_tokens: 400,
        text: {
          format: {
            type: "json_schema",
            name: "boxing_round_strategy",
            strict: true,
            schema: STRATEGY_OUTPUT_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(STRATEGY_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload: unknown;
  try {
    // The deadline covers the body too, so a response that stops arriving
    // half-read lands here rather than hanging the bout.
    payload = await response.json();
  } catch {
    return null;
  }
  const output = extractStrategyOutput(payload);
  let parsed: unknown;
  try {
    parsed = output ? JSON.parse(output) : null;
  } catch {
    parsed = null;
  }
  return normalizeStrategyDirective(parsed, context.round, "language");
}

export async function handleStrategyRequest(request: Request, env: StrategyEnv) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(
      {
        available: false,
        error: "The optional language strategist is not configured.",
      },
      503,
    );
  }
  if (!await adminAuthorized(request, env)) {
    return jsonResponse({ available: false, error: "Not authorised." }, 401);
  }

  let context: StrategyContext;
  try {
    context = await request.json() as StrategyContext;
  } catch {
    return jsonResponse({ error: "Invalid strategy context." }, 400);
  }
  if (!context?.fighter?.id || !context?.opponent?.id || !context.round) {
    return jsonResponse({ error: "Incomplete strategy context." }, 400);
  }

  const directive = await generateStrategyDirective(context, env);
  if (!directive) {
    return jsonResponse(
      { available: false, error: "The language strategist is unavailable." },
      502,
    );
  }
  return jsonResponse({ available: true, directive }, 200);
}
