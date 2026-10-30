import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the homepage: the slogan, the numbers and the belts", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Forge League · AI Athletes, Unscripted<\/title>/i);
  assert.match(html, /INDEPENDENT NEURAL BRAINS · BUILT TO THINK · FORGED TO FIGHT/);
  assert.match(html, /Autonomous boxing/);
  assert.doesNotMatch(html, /Autonomous boxing · three divisions/i);

  // What somebody who has never been here needs: the size of the thing, who
  // holds the belts, and a compact introduction to the league and its market.
  assert.match(html, /Independent brains/);
  assert.match(html, /Your champions/);
  assert.match(html, /Forging a new league of athletes/);
  assert.match(html, /A mind of its own/);
  assert.match(html, /Bet who wins/);
  assert.match(html, /Bet before or during the fight/);

  // The ring is a tab of its own now, and the brand is the way back to here.
  assert.match(html, /href="\/ring"/);
  assert.match(html, /aria-label="Forge League home"/);
  assert.doesNotMatch(html, /Every boxer in the league/);

  // The long read hangs off the hero and off nothing in the nav.
  assert.match(html, /href="\/how-it-works"/);
  assert.match(html, />Learn more<\/a>/);
  assert.doesNotMatch(html, /Learn more \/ How it works/);
});

test("server-renders the long read: the brain, the corner and the learning", async () => {
  const response = await render("/how-it-works");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>How it works · Forge League<\/title>/i);

  // The page explains the whole career loop without exposing implementation
  // details as marketing copy: an independent brain observes, chooses, receives
  // bounded corner advice, and learns from the result.
  // The title and the sign-off each break once, by hand, in the markup.
  assert.match(html, /How Forge<br\/>League works/);
  assert.match(html, /Every fighter has his own brain/);
  assert.match(html, /Seeing the punch coming/);
  assert.match(html, /EARLY TELL/);
  assert.match(html, /FAST JAB/);
  assert.match(html, /QUICK REACTION/);
  assert.match(html, /What you see and what is underneath it/);
  assert.match(html, /How a brain takes over/);
  assert.match(html, /Furthest along right now|Loading the roster/);
  assert.match(html, /Between rounds/);
  assert.match(html, /What he keeps after a fight/);
  assert.match(html, /Between fight nights/);
  assert.match(html, /That is the<br\/>whole thing\./);

  // Plain prose in boxed panels. The career-loop diagram, the claim chips and
  // the closing manifesto are gone, and nothing on the page is a slogan.
  assert.doesNotMatch(html, /how-head__cycle|how-head__chips|how-manifesto/);
  assert.doesNotMatch(html, /Fully unscripted|They take over/);

  // A page you read once, reachable from the homepage and not from the nav.
  // The back arrow itself is a ::before in the stylesheet, so the markup only
  // carries the word.
  assert.match(html, /how-head__back">Home</);
  assert.doesNotMatch(html, /topnav__tab topnav__tab--active/);
});

test("server-renders the ring page: the live bout and the whole division", async () => {
  const response = await render("/ring");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>The ring · Forge League<\/title>/i);
  assert.match(html, /Live bout/);
  assert.match(html, /AI athletes · Real skill · Unscripted fights/);
  assert.doesNotMatch(html, /Neural boxers who learned to fight, fighting each other/);

  // The ring is a broadcast the server owns, so a cold page renders the stage
  // and waits to be told what is on air rather than starting its own fight.
  assert.match(html, /Joining the broadcast|Between fights/);
  assert.match(html, /Compact|Full size/);

  // The league is organised into divisions with a champion and a ladder.
  assert.match(html, /Champions and contender ladders/);
  assert.match(html, /Featherweight/);
  assert.match(html, /Middleweight/);
  assert.match(html, /Heavyweight/);

  // Every athlete is listed with the stats behind them.
  assert.match(html, /Every boxer in the league/);
  assert.match(html, /Okoro/);
  assert.match(html, /Vale/);
  assert.match(html, /The Tank/);
  assert.match(html, /Mori/);
  assert.match(html, /Conditioning/);
  assert.match(html, /Favourite punches/);
  assert.match(html, /force-integrated steps/);

  // Training lives on its own page and is linked, not embedded.
  assert.match(html, /href="\/training"/);
  assert.doesNotMatch(html, /How fights are decided/);
  assert.doesNotMatch(html, /Native physics lab/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("server-renders the public training lab and keeps native 3D hidden", async () => {
  const response = await render("/training");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Training lab · Forge League<\/title>/i);
  assert.match(html, /League sparring/);
  assert.match(html, /Current rotation/);
  assert.match(html, /The whole roster keeps learning/);
  assert.match(html, /10 turns per athlete daily/);
  assert.match(html, /Next drill/);
  assert.match(html, /drills shown here are illustrative/);
  assert.match(html, /Up next/);
  assert.match(html, /How fights are decided/);
  assert.match(html, /Who decides/);
  assert.match(html, /Between rounds only/);
  assert.match(html, /Randomness in results/);
  assert.doesNotMatch(html, /Native physics lab|3D training|39-DOF|MuJoCo|Native service/i);

  // The whole rotation remains visible beneath the feed, but it is a readout:
  // the page offers no buttons that hold the feed or select a drill.
  assert.match(html, /training-gym__controls/);
  assert.match(html, /Sparring.*Reflex balls.*Heavy bag.*Push-ups.*Footwork/s);
  assert.doesNotMatch(html, /<button[^>]+training-gym__(?:scene|auto)/i);
  assert.doesNotMatch(html, /Auto rotation off|Camera held|Choose a gym camera drill/i);
  assert.doesNotMatch(html, /Pause training|Start training|Pinned drill/);

  // The ring is its own page and this one links back to it.
  assert.match(html, /href="\/ring"/);
});

test("ships the simulation engine and removes disposable starter assets", async () => {
  const [page, ring, layout, simulation, packageJson, fightCanvas] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ring/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/simulation.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/fight-canvas.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<HomePage \/>/);
  assert.match(ring, /<ForgeLeague \/>/);
  assert.match(layout, /Forge League/);
  assert.match(simulation, /export function stepBout/);
  assert.match(simulation, /export function trainAthlete/);
  assert.match(simulation, /export function adaptConditioning/);
  assert.match(simulation, /export function createTrainingEnvironment/);
  assert.match(simulation, /export function observeTrainingEnvironment/);
  assert.match(simulation, /export function stepTrainingEnvironment/);
  assert.match(simulation, /export function stepBoutWithActions/);
  assert.match(simulation, /export function getPolicyDecision/);
  assert.match(simulation, /recurrent-28x16x8x6x18/);
  assert.match(simulation, /export function planBetweenRounds/);
  assert.match(simulation, /export function buildStrategyContext/);
  assert.match(simulation, /export function calculateImpact/);
  assert.match(simulation, /export function simulateBoutToCompletion/);
  assert.match(simulation, /function perceivedSnapshot/);
  assert.match(simulation, /function distancePointToSegment3D/);
  assert.match(simulation, /function updateArticulatedMechanics/);
  assert.match(simulation, /function updateFacing/);
  assert.doesNotMatch(simulation, /Math\.random/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(fightCanvas, /Victory pose: both fists above the crown/);
  assert.match(fightCanvas, /lapProgress \* Math\.PI \* 2/);
  assert.match(fightCanvas, /v\.victory/);

  await assert.rejects(access(new URL("app\/_sites-preview", projectRoot)));
});
