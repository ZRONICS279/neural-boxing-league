import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

/** Operational settings that are configuration, not credentials.
 *
 * The Sites plane owns these on the hosted deployment. A personal Wrangler
 * deploy has no such environment, so its public settings have to travel in the
 * generated config. Keeping the names explicit is the guard against an API key
 * or operator key ever being copied out of `.env.local`. */
const SELF_HOSTED_VARS = [
  "OPENAI_STRATEGY_MODEL",
  "OPENAI_VOICE_MODEL",
  "OPENAI_VOICE",
  "SIM3D_SERVICE_URL",
  "FIGHT_PUBLIC_RPC_URL",
  "FIGHT_CHAIN_ID",
  "FIGHT_CLOB_ADDRESS",
  "FIGHT_READER_ADDRESS",
  "FIGHT_COLLATERAL_ADDRESS",
  "FIGHT_COLLATERAL_DECIMALS",
  "FIGHT_COLLATERAL_SYMBOL",
  "FIGHT_TAKER_FEE_BPS",
  "FIGHT_START_BLOCK",
  "FIGHT_EXPLORER_URL",
  "FIGHT_SEED_SHARES",
  "FIGHT_SEED_SPREAD",
  "FIGHT_MM_STEP",
  "FIGHT_MM_LEVELS",
  "FIGHT_MM_SIZE_GROWTH",
  "FIGHT_MM_SKEW_SHARES",
  "FIGHT_MM_MAX_SKEW",
  "FIGHT_MM_MAX_NET",
  "FIGHT_MM_STOCK",
  "FIGHT_MM_BUDGET",
  "FORGE_MIGRATION_IMPORT",
] as const;

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

/** The D1 the worker is bound to.
 *
 * The site-creator plane provisions its own database and injects the real
 * values, so the placeholder is what this file has always carried and has to
 * keep carrying — it is the id that says "somebody else is filling this in".
 *
 * Self-hosting on a personal Cloudflare account is the other case: `wrangler d1
 * create` hands back a real id, and it arrives through `.env.local` rather than
 * being written in here. One config serves both, and neither deployment needs
 * to know about the other. */
function databaseBinding(env: Record<string, string>) {
  if (!d1) return [];
  return [
    {
      binding: d1,
      database_name: env.FORGE_D1_DATABASE_NAME || "site-creator-d1",
      database_id: env.FORGE_D1_DATABASE_ID || SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
    },
  ];
}

function workerVariables(env: Record<string, string>) {
  if (env.FORGE_SELF_HOSTED !== "1") return {};
  const vars = Object.fromEntries(
    SELF_HOSTED_VARS.flatMap((name) => env[name] ? [[name, env[name]]] : []),
  );
  return Object.keys(vars).length > 0 ? { vars } : {};
}

function cronTriggers(env: Record<string, string>) {
  if (env.FORGE_SELF_HOSTED === "1" && env.FORGE_CRON_ENABLED === "0") return {};
  return { triggers: { crons: ["* * * * *"] } };
}

export default defineConfig(async ({ mode }) => {
  // Read with an empty prefix so unprefixed operational settings are visible.
  // Only the two D1 fields below are ever read out of it — nothing here is
  // handed to the client or written into `vars`, and the application's own
  // secrets continue to reach the worker through Wrangler rather than Vite.
  const env = {
    ...loadEnv(mode, process.cwd(), ""),
    ...process.env,
  } as Record<string, string>;

  // A hostname the worker answers on directly, for a self-hosted deploy that
  // wants to be somewhere other than workers.dev. Empty is the ordinary case:
  // the site-creator plane routes its own traffic and must not be given a route
  // it did not ask for. Comma-separated, so apex and www can both land here.
  const customDomains = (env.FORGE_CUSTOM_DOMAIN ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    ...cronTriggers(env),
    d1_databases: databaseBinding(env),
    ...workerVariables(env),
    ...(customDomains.length > 0
      ? {
          routes: customDomains.map((pattern) => ({
            pattern,
            custom_domain: true,
          })),
        }
      : {}),
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
