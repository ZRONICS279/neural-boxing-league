import { adminAuthorized } from "./admin.ts";

export interface Sim3dEnv {
  FORGE_ADMIN_TOKEN?: string;
  SIM3D_SERVICE_URL?: string;
  SIM3D_SERVICE_TOKEN?: string;
}

type Sim3dControlAction = "start" | "pause" | "target" | "reset" | "scenario";

interface Sim3dControlPayload {
  action: Sim3dControlAction;
  targetId?: string;
  scenarioName?: string | null;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function unavailable() {
  return jsonResponse({
    available: false,
    status: "not-connected",
    targetId: null,
    lastError: null,
    training: null,
    curriculum: null,
    physics: {
      physicsHz: 500,
      motorHz: 50,
      degreesOfFreedomPerAthlete: 39,
      motorsPerAthlete: 33,
      athletes: 2,
      contactDerivedGroundForce: true,
    },
  });
}

function serviceRequest(
  env: Sim3dEnv,
  path: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (env.SIM3D_SERVICE_TOKEN) {
    headers.set("authorization", `Bearer ${env.SIM3D_SERVICE_TOKEN}`);
  }
  const base = env.SIM3D_SERVICE_URL!.replace(/\/$/, "");
  return new Request(`${base}${path}`, {
    ...init,
    headers,
  });
}

export async function handleSim3dRequest(
  request: Request,
  env: Sim3dEnv,
  fetcher: typeof fetch = fetch,
) {
  if (!env.SIM3D_SERVICE_URL) return unavailable();
  if (request.method === "GET") {
    try {
      const url = new URL(request.url);
      const replay = url.pathname.endsWith("/replay");
      const frames = Math.max(1, Math.min(600, Number(url.searchParams.get("frames")) || 300));
      const path = replay ? `/v1/replay?frames=${frames}` : "/v1/status";
      const response = await fetcher(serviceRequest(env, path));
      if (!response.ok) {
        return jsonResponse({
          available: false,
          status: "unreachable",
          error: `Native service returned ${response.status}.`,
        }, 502);
      }
      return jsonResponse(await response.json());
    } catch {
      return jsonResponse({
        available: false,
        status: "unreachable",
        error: "Native 3D physics service could not be reached.",
      }, 502);
    }
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (!await adminAuthorized(request, env)) {
    return jsonResponse({ error: "Not authorised." }, 401);
  }

  let payload: Sim3dControlPayload;
  try {
    payload = await request.json() as Sim3dControlPayload;
  } catch {
    return jsonResponse({ error: "Invalid native training command." }, 400);
  }
  if (!["start", "pause", "target", "reset", "scenario"].includes(payload.action)) {
    return jsonResponse({ error: "Unsupported native training command." }, 400);
  }
  if (payload.action === "target" && !payload.targetId) {
    return jsonResponse({ error: "A target athlete is required." }, 400);
  }

  try {
    const response = await fetcher(serviceRequest(env, "/v1/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    const body = await response.json();
    return jsonResponse(body, response.ok ? 200 : response.status);
  } catch {
    return jsonResponse({
      available: false,
      status: "unreachable",
      error: "Native 3D physics service could not be reached.",
    }, 502);
  }
}
