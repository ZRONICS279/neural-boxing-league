import assert from "node:assert/strict";
import test from "node:test";
import {
  STRATEGY_OUTPUT_SCHEMA,
  extractStrategyOutput,
  normalizeStrategyDirective,
} from "../app/strategy.ts";
import { handleStrategyRequest } from "../worker/strategy.ts";

test("language strategy output is normalized into a bounded round directive", () => {
  const directive = normalizeStrategyDirective(
    {
      focus: "counter",
      pace: 2,
      risk: -2,
      target: "head",
      ringMode: "outside",
      confidence: 140,
      note: "  Draw the entry and make the pressure fighter reset.  ",
    },
    2,
  );

  assert.deepEqual(directive, {
    focus: "counter",
    pace: 1,
    risk: -1,
    target: "head",
    ringMode: "outside",
    confidence: 100,
    note: "Draw the entry and make the pressure fighter reset.",
    source: "language",
    issuedRound: 2,
  });
  assert.equal(STRATEGY_OUTPUT_SCHEMA.additionalProperties, false);
});

test("response text extraction supports the Responses API output envelope", () => {
  const output = extractStrategyOutput({
    output: [
      {
        content: [
          {
            type: "output_text",
            text: "{\"focus\":\"outside\"}",
          },
        ],
      },
    ],
  });

  assert.equal(output, "{\"focus\":\"outside\"}");
});

test("the strategy route fails closed when no server secret is configured", async () => {
  const response = await handleStrategyRequest(
    new Request("http://localhost/api/strategy", { method: "POST" }),
    {},
  );
  const payload = await response.json() as { available: boolean };

  assert.equal(response.status, 503);
  assert.equal(payload.available, false);
});

test("the public strategy route cannot spend the server key", async () => {
  const response = await handleStrategyRequest(
    new Request("http://localhost/api/strategy", { method: "POST" }),
    { OPENAI_API_KEY: "server-secret", FORGE_ADMIN_TOKEN: "admin-secret" },
  );

  assert.equal(response.status, 401);
});
