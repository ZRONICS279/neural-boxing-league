import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LINE,
  MIN_LINE,
  formScore,
  openingLine,
  openingLineFor,
  openingOdds,
} from "../app/opening-line.ts";
import { createInitialLeague, type Fighter } from "../app/simulation.ts";

/** The opening line is the price every fight starts at, and nobody sees it
 *  being wrong until money is already on it — so the properties that keep it
 *  honest are worth pinning: it is symmetric, it is bounded, and it moves in
 *  the direction the evidence moves. */

const roster = createInitialLeague().roster;

function fighterNamed(lastName: string): Fighter {
  const found = roster.find((entry) => entry.lastName === lastName);
  assert.ok(found, `no ${lastName} on the roster`);
  return found;
}

/** A fighter with one thing changed, for the "does this term move the price"
 *  tests. Cloned deeply enough that the nested record is not shared. */
function variant(fighter: Fighter, changes: Partial<Fighter>): Fighter {
  return { ...fighter, record: { ...fighter.record }, ...changes };
}

test("a fighter against himself is a coin flip", () => {
  for (const fighter of roster) {
    assert.equal(openingLine(fighter, fighter), 50);
  }
});

test("the line is the same fight read from either corner", () => {
  for (const blue of roster.slice(0, 12)) {
    for (const red of roster.slice(12, 24)) {
      assert.equal(openingLine(blue, red), 100 - openingLine(red, blue));
    }
  }
});

test("no fight on the roster opens outside the band", () => {
  for (const blue of roster) {
    for (const red of roster) {
      const line = openingLine(blue, red);
      assert.ok(line >= MIN_LINE && line <= MAX_LINE, `${line} out of band`);
    }
  }
});

test("the better stat line is the favourite", () => {
  const mori = fighterNamed("Mori");
  const weaker = variant(mori, {
    id: "weaker",
    stats: { ...mori.stats, reaction: mori.stats.reaction - 20, defense: mori.stats.defense - 20 },
  });
  assert.ok(openingLine(mori, weaker) > 55);
  assert.ok(formScore(mori) > formScore(weaker));
});

test("a longer reach is worth something and not everything", () => {
  const mori = fighterNamed("Mori");
  const short = variant(mori, { id: "short", reach: mori.reach - 6 });
  const line = openingLine(mori, short);
  assert.ok(line > 50, "six inches of reach should favour somebody");
  assert.ok(line < 60, "and should not on its own make it a rout");
});

test("a record is shrunk toward even, so a debut is not unbeaten", () => {
  const mori = fighterNamed("Mori");
  const debutant = variant(mori, {
    id: "debutant",
    record: { wins: 1, losses: 0, draws: 0, knockouts: 1 },
  });
  const veteran = variant(mori, {
    id: "veteran",
    record: { wins: 14, losses: 0, draws: 0, knockouts: 9 },
  });
  // Both are unbeaten. The one who has proved it fourteen times is favoured,
  // and the 1-0 man is not quoted as if he had.
  assert.ok(openingLine(veteran, debutant) > 52);
});

test("the two sides of the odds always fund one collateral unit", () => {
  for (const blue of roster.slice(0, 20)) {
    for (const red of roster.slice(20, 40)) {
      const odds = openingOdds(blue, red);
      assert.equal(odds.blue + odds.red, 100);
    }
  }
});

test("a fight nobody on the roster is in has no line", () => {
  const [first, second] = roster;
  assert.equal(openingLineFor(roster, first.id, second.id), openingLine(first, second));
  assert.equal(openingLineFor(roster, first.id, "nobody-at-all"), null);
});

test("real matchmaking lands in the range a book would quote", () => {
  // Cards are made out of ladder neighbours, so those are the fights that
  // actually get priced. If this drifts into 80/20 territory the scale is
  // wrong, and every market on the card opens somewhere nobody wants to trade.
  const divisions = new Map<string, Fighter[]>();
  for (const fighter of roster) {
    divisions.set(fighter.weightClass, [...(divisions.get(fighter.weightClass) ?? []), fighter]);
  }

  const lines: number[] = [];
  for (const list of divisions.values()) {
    for (let index = 0; index + 1 < list.length; index += 1) {
      lines.push(openingLine(list[index], list[index + 1]));
    }
  }

  assert.ok(lines.length >= 20);
  for (const line of lines) {
    const favourite = Math.max(line, 100 - line);
    assert.ok(favourite <= 75, `neighbours priced ${line}/${100 - line}`);
  }
});
