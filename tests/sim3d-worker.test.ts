import assert from "node:assert/strict";
import test from "node:test";

import { handleSim3dRequest } from "../worker/sim3d.ts";

test("the 3D bridge reports its honest disconnected baseline", async () => {
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d"),
    {},
  );
  const payload = await response.json() as {
    available: boolean;
    status: string;
    physics: { physicsHz: number; degreesOfFreedomPerAthlete: number };
  };

  assert.equal(response.status, 200);
  assert.equal(payload.available, false);
  assert.equal(payload.status, "not-connected");
  assert.equal(payload.physics.physicsHz, 500);
  assert.equal(payload.physics.degreesOfFreedomPerAthlete, 39);
});

test("the 3D bridge authenticates and forwards native target changes", async () => {
  let forwarded: Request | null = null;
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-admin": "admin-secret",
      },
      body: JSON.stringify({ action: "target", targetId: "jonah-vale" }),
    }),
    {
      SIM3D_SERVICE_URL: "https://physics.example/",
      SIM3D_SERVICE_TOKEN: "secret-token",
      FORGE_ADMIN_TOKEN: "admin-secret",
    },
    async (request) => {
      forwarded = request;
      return Response.json({
        available: true,
        status: "running",
        targetId: "jonah-vale",
      });
    },
  );
  const payload = await response.json() as { targetId: string };

  assert.equal(response.status, 200);
  assert.ok(forwarded);
  assert.equal(forwarded.url, "https://physics.example/v1/control");
  assert.equal(forwarded.headers.get("authorization"), "Bearer secret-token");
  assert.deepEqual(await forwarded.json(), {
    action: "target",
    targetId: "jonah-vale",
  });
  assert.equal(payload.targetId, "jonah-vale");
});

test("the 3D bridge forwards a pinned test scenario", async () => {
  let forwarded: Request | null = null;
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-admin": "admin-secret",
      },
      body: JSON.stringify({ action: "scenario", scenarioName: "projectile_evasion" }),
    }),
    {
      SIM3D_SERVICE_URL: "https://physics.example",
      FORGE_ADMIN_TOKEN: "admin-secret",
    },
    async (request) => {
      forwarded = request;
      return Response.json({
        available: true,
        status: "running",
        pinnedScenario: "projectile_evasion",
      });
    },
  );
  const payload = await response.json() as { pinnedScenario: string };

  assert.equal(response.status, 200);
  assert.ok(forwarded);
  assert.deepEqual(await forwarded.json(), {
    action: "scenario",
    scenarioName: "projectile_evasion",
  });
  assert.equal(payload.pinnedScenario, "projectile_evasion");
});

test("the 3D bridge rejects malformed control commands", async () => {
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forge-admin": "admin-secret",
      },
      body: JSON.stringify({ action: "target" }),
    }),
    {
      SIM3D_SERVICE_URL: "https://physics.example",
      FORGE_ADMIN_TOKEN: "admin-secret",
    },
  );

  assert.equal(response.status, 400);
});

test("the public 3D bridge cannot control the native service", async () => {
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    }),
    {
      SIM3D_SERVICE_URL: "https://physics.example",
      FORGE_ADMIN_TOKEN: "admin-secret",
    },
  );

  assert.equal(response.status, 401);
});

test("the 3D bridge exposes bounded pose replay frames", async () => {
  let forwardedUrl = "";
  const response = await handleSim3dRequest(
    new Request("http://localhost/api/sim3d/replay?frames=900"),
    { SIM3D_SERVICE_URL: "https://physics.example" },
    async (request) => {
      forwardedUrl = request.url;
      return Response.json({ available: true, frames: [] });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://physics.example/v1/replay?frames=600");
});
