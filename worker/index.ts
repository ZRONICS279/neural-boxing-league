/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleArchiveRequest } from "./archive";
import {
  handleLeagueRequest,
  handleTimelineRequest,
  handleVoiceRequest,
  processLeagueTick,
} from "./league";
import { handleMarketRequest } from "./market";
import { handleMigrationRequest } from "./migration";
import { handleSim3dRequest } from "./sim3d";
import { handleStrategyRequest } from "./strategy";
import {
  handleTrainingRequest,
  handleTrainingStatusRequest,
  processTrainingQueue,
} from "./training";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  FORGE_ADMIN_TOKEN?: string;
  FORGE_MIGRATION_IMPORT?: string;
  OPENAI_API_KEY?: string;
  OPENAI_STRATEGY_MODEL?: string;
  /** The ringside voice's speech model and voice. Optional; see worker/voice.ts. */
  OPENAI_VOICE_MODEL?: string;
  OPENAI_VOICE?: string;
  SIM3D_SERVICE_URL?: string;
  SIM3D_SERVICE_TOKEN?: string;
  /** The fight book on Robinhood Chain. All optional: unset means the league
   *  runs with no market against it, which is the default. */
  FIGHT_RPC_URL?: string;
  FIGHT_CHAIN_ID?: string;
  FIGHT_CLOB_ADDRESS?: string;
  FIGHT_READER_ADDRESS?: string;
  FIGHT_COLLATERAL_ADDRESS?: string;
  FIGHT_COLLATERAL_DECIMALS?: string;
  FIGHT_COLLATERAL_SYMBOL?: string;
  FIGHT_TAKER_FEE_BPS?: string;
  FIGHT_START_BLOCK?: string;
  FIGHT_EXPLORER_URL?: string;
  /** The one key the league holds. Books, closes and scores bouts; cannot move
   *  a unit of anyone's collateral. Its absence makes booking a no-op. */
  FIGHT_OPERATOR_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/** The provider hostname is a deployment address, not a public identity. */
function redirectProviderHostname(request: Request) {
  const url = new URL(request.url);
  if (!url.hostname.endsWith(".chatgpt.site")) return null;

  url.hostname = "forgeleague.space";
  url.protocol = "https:";
  url.port = "";
  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": "public, max-age=3600",
      Location: url.toString(),
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const providerRedirect = redirectProviderHostname(request);
    if (providerRedirect) return providerRedirect;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/strategy") {
      return handleStrategyRequest(request, env);
    }

    if (url.pathname === "/api/training/status") {
      return handleTrainingStatusRequest(request, env, ctx);
    }

    if (url.pathname === "/api/training") {
      return handleTrainingRequest(request, env, ctx);
    }

    if (url.pathname === "/api/league" || url.pathname === "/api/league/roster") {
      return handleLeagueRequest(request, env, ctx);
    }

    if (url.pathname === "/api/archive") {
      return handleArchiveRequest(request, env);
    }

    if (url.pathname === "/api/timeline") {
      return handleTimelineRequest(request, env);
    }

    if (url.pathname === "/api/voice") {
      return handleVoiceRequest(request, env);
    }

    if (url.pathname === "/api/sim3d" || url.pathname === "/api/sim3d/replay") {
      return handleSim3dRequest(request, env);
    }

    if (url.pathname === "/api/market") {
      return handleMarketRequest(request, env);
    }

    if (url.pathname.startsWith("/api/migration/")) {
      return handleMigrationRequest(request, env);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    // The card runs whether or not anybody is watching, so a viewer who comes
    // back after an hour finds the league where it should be, not where they
    // left it.
    ctx.waitUntil((async () => {
      // The card has first call on every minute. Training waits for that pass,
      // then shares its simulation lease and skips both men currently on air.
      await processLeagueTick(env);
      await processTrainingQueue(env);
    })());
  },
};

export default worker;
