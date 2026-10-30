import assert from "node:assert/strict";
import test from "node:test";
import { createAnnouncer } from "../app/announcer.ts";
import { createBout, createInitialLeague } from "../app/simulation.ts";

/** The ringside voice is a pure function of the frames it is shown, so every
 * test here is the same shape: build a bout, mutate it the way the sim would,
 * show it to the engine, and read what got said. */

function freshBout() {
  const league = createInitialLeague();
  const roster = league.roster;
  const bout = createBout(roster[0].id, roster[1].id, 1, {
    roundSeconds: 180,
    totalRounds: 5,
  });
  return { bout, blue: roster[0], red: roster[1] };
}

/** Past the walk-out and into a live round, so calls are not read as a join. */
function liveBout() {
  const { bout, blue, red } = freshBout();
  bout.introSeconds = 0;
  bout.tick = 3000;
  bout.roundTime = 120;
  return { bout, blue, red };
}

test("joining mid-fight baselines the counters instead of narrating the backlog", () => {
  const { bout, blue, red } = liveBout();
  bout.left.landed = 30;
  bout.left.thrown = 70;
  bout.left.knockdowns = 1;

  const announcer = createAnnouncer();
  assert.equal(announcer.observe(bout, blue, red), null);

  // The very next landing is a fresh moment and may be called.
  bout.tick += 5;
  bout.left.landed = 31;
  bout.left.lastStrikeKind = "crossHead";
  bout.left.lastImpactJ = 60;
  const line = announcer.observe(bout, blue, red);
  assert.ok(line);
  assert.equal(line.corner, "blue");
  // The voice varies both which man a sentence centres on and how it says
  // him — surname, full name, or nickname — so the invariant is only that
  // somebody in this fight is named.
  assert.ok(
    [blue.lastName, blue.nickname, red.lastName, red.nickname].some(
      (name) => name && line.text.includes(name),
    ),
    line.text,
  );
});

test("a knockdown is called over everything and names both men correctly", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  bout.tick += 5;
  bout.right.knockdowns = 1;
  bout.right.downCountSeconds = 0.2;
  bout.left.lastStrikeKind = "hookHead";
  const down = announcer.observe(bout, blue, red);
  assert.ok(down);
  assert.equal(down.register, "alarm");
  assert.equal(down.corner, "blue");

  // He beats the count at eight: the sim's count reads floor(seconds) + 1.
  bout.tick += 350;
  bout.right.downCountSeconds = 7.3;
  assert.equal(announcer.observe(bout, blue, red), null);
  bout.tick += 50;
  bout.right.downCountSeconds = 0;
  const rise = announcer.observe(bout, blue, red);
  assert.ok(rise);
  assert.ok(rise.text.includes("8"));
  assert.ok(rise.text.includes(red.lastName));
});

test("two viewers of the same fight hear the same broadcast", () => {
  const play = (announcer: ReturnType<typeof createAnnouncer>) => {
    const { bout, blue, red } = liveBout();
    const spoken: string[] = [];
    announcer.observe(bout, blue, red);
    for (let step = 0; step < 40; step += 1) {
      bout.tick += 40;
      if (step % 3 === 0) {
        bout.left.landed += 1;
        bout.left.lastStrikeKind = step % 6 === 0 ? "jabHead" : "crossHead";
        bout.left.lastImpactJ = step % 9 === 0 ? 62 : 30;
      }
      if (step % 4 === 1) {
        bout.right.landed += 1;
        bout.right.lastStrikeKind = "hookBody";
        bout.right.lastImpactJ = 44;
      }
      const line = announcer.observe(bout, blue, red);
      if (line) spoken.push(line.text);
    }
    return spoken;
  };

  const first = play(createAnnouncer());
  const second = play(createAnnouncer());
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test("routine landings wait out the cooldown; a haymaker does not", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  bout.tick += 5;
  bout.left.landed = 1;
  bout.left.lastStrikeKind = "jabHead";
  bout.left.lastImpactJ = 25;
  assert.ok(announcer.observe(bout, blue, red));

  // A second ordinary jab inside the gap stays uncalled. Past the combo
  // window, so it does not read as a combination either.
  bout.tick += 110;
  bout.left.landed = 2;
  assert.equal(announcer.observe(bout, blue, red), null);

  // A shot at haymaker weight interrupts regardless.
  bout.tick += 10;
  bout.left.landed = 3;
  bout.left.lastImpactJ = 70;
  const big = announcer.observe(bout, blue, red);
  assert.ok(big);
  assert.equal(big.register, "call");
});

test("the finish is called once, and never to a viewer arriving on the aftermath", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  bout.tick += 5;
  bout.finish = "KO";
  bout.winnerId = bout.left.fighterId;
  bout.running = false;
  const call = announcer.observe(bout, blue, red);
  assert.ok(call);
  assert.equal(call.register, "alarm");
  assert.ok(call.text.includes(blue.lastName));
  assert.equal(announcer.observe(bout, blue, red), null);

  // A fresh viewer whose first frame is the result card hears nothing.
  const late = createAnnouncer();
  assert.equal(late.observe(bout, blue, red), null);
  bout.tick += 5;
  assert.equal(late.observe(bout, blue, red), null);
});

test("a viewer at the opening bell gets the introductions, once", () => {
  const { bout, blue, red } = freshBout();
  const announcer = createAnnouncer();
  assert.equal(announcer.observe(bout, blue, red), null);
  bout.tick += 5;
  const intro = announcer.observe(bout, blue, red);
  assert.ok(intro);
  assert.ok(intro.text.includes(blue.lastName));
  assert.ok(intro.text.includes(red.lastName));
  bout.tick += 5;
  assert.equal(announcer.observe(bout, blue, red), null);
});

test("a punch made to miss credits the man who moved", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  // Blue throws, red is mid-slip, and the punch never becomes a landing or a
  // block. The call waits for the contact window to settle.
  bout.tick += 5;
  bout.left.thrown = 1;
  bout.left.action = "crossHead";
  bout.right.action = "slip";
  assert.equal(announcer.observe(bout, blue, red), null);
  bout.tick += 40;
  bout.right.action = "guard";
  const dodge = announcer.observe(bout, blue, red);
  assert.ok(dodge);
  assert.equal(dodge.corner, "red");
  assert.ok(dodge.text.includes(red.lastName));

  // A throw that connects is never a dodge, whatever the defender was doing.
  bout.tick += 400;
  bout.left.thrown = 2;
  bout.left.action = "jabHead";
  bout.right.action = "weave";
  announcer.observe(bout, blue, red);
  bout.tick += 5;
  bout.left.landed = 1;
  bout.left.lastStrikeKind = "jabHead";
  bout.left.lastImpactJ = 20;
  announcer.observe(bout, blue, red);
  bout.tick += 40;
  const settled = announcer.observe(bout, blue, red);
  assert.ok(!settled || !settled.text.includes("miss"));
});

test("a quick pair of landings is called as the named combination", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  bout.tick += 5;
  bout.left.landed = 1;
  bout.left.lastStrikeKind = "hookHead";
  bout.left.lastImpactJ = 20;
  announcer.observe(bout, blue, red);

  // The second landing arrives inside the combo window.
  bout.tick += 60;
  bout.left.landed = 2;
  bout.left.lastStrikeKind = "jabHead";
  const combo = announcer.observe(bout, blue, red);
  assert.ok(combo);
  assert.ok(combo.text.includes("hook-jab to the face"), combo.text);
});

test("a flash wobble on a fresh man never reads as an alarm; real damage does", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  // Six short hurt spells with the condition bar still in the 90s: the voice
  // may drop a small aside or say nothing, but never sound the alarm.
  for (let episode = 0; episode < 6; episode += 1) {
    bout.tick += 200;
    bout.roundTime -= 4;
    bout.right.health = 96;
    bout.right.hurtSeconds = 0.6;
    const line = announcer.observe(bout, blue, red);
    if (line) assert.notEqual(line.register, "alarm", line.text);
    bout.tick += 5;
    bout.right.hurtSeconds = 0;
    announcer.observe(bout, blue, red);
  }

  // The same flag with the scoreboard agreeing he is hurt: alarm register.
  bout.tick += 900;
  bout.right.health = 60;
  bout.right.hurtSeconds = 2;
  const alarm = announcer.observe(bout, blue, red);
  assert.ok(alarm);
  assert.equal(alarm.register, "alarm");
});

test("the voice does not lean on the same sentences", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  const texts: string[] = [];
  for (let landing = 0; landing < 24; landing += 1) {
    bout.tick += 400;
    bout.left.landed += 1;
    bout.left.lastStrikeKind = "jabHead";
    bout.left.lastImpactJ = 20;
    const line = announcer.observe(bout, blue, red);
    if (line) texts.push(line.text);
  }

  assert.ok(texts.length >= 20, `only ${texts.length} lines spoken`);
  for (let i = 1; i < texts.length; i += 1) {
    assert.notEqual(texts[i], texts[i - 1], `back-to-back repeat: ${texts[i]}`);
  }
  assert.ok(
    new Set(texts).size >= texts.length * 0.6,
    `too few distinct lines: ${new Set(texts).size} of ${texts.length}`,
  );
});

test("the break scores the round that just ended", () => {
  const { bout, blue, red } = liveBout();
  const announcer = createAnnouncer();
  announcer.observe(bout, blue, red);

  bout.tick += 5;
  bout.left.landed = 12;
  bout.right.landed = 4;
  bout.left.lastImpactJ = 20;
  bout.left.lastStrikeKind = "jabHead";
  announcer.observe(bout, blue, red);

  // The bell: the sim turns the round number over as the break starts.
  bout.tick += 100;
  bout.round = 2;
  bout.breakTime = 60;
  const summary = announcer.observe(bout, blue, red);
  assert.ok(summary);
  assert.equal(summary.register, "color");
  assert.ok(/round/i.test(summary.text), summary.text);
  assert.ok(summary.text.includes(blue.lastName), summary.text);
});
