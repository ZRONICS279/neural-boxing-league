import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** Compact is a choice you only have room to make on a wide screen.
 *
 * Below 1181px the stage is one column at either setting, so the league page
 * hides the control and assumes compact — and every rule that dresses the
 * compact stage lives inside a `min-width: 1181px` block for that reason. The
 * rules for its opposite have to live there too. Three of them did not, which
 * nobody saw on the league page because it carries the class on a phone
 * anyway; a single fight's page never carries it at all, so a 375px screen was
 * still being handed the wide deck and folding both corner cards into two
 * columns of it.
 *
 * Read off the source rather than a browser: the failure is a rule sitting in
 * the wrong place in the file, which is exactly what this can see and a
 * screenshot at one width cannot. */
test("the full-size stage rules are inside the compact breakpoint", () => {
  const marker = "@media (min-width: 1181px) {";
  const opensAt = CSS.indexOf(marker);
  assert.ok(opensAt >= 0, "the 1181px stage block has been renamed or removed");

  // Walk the braces from the block's own opening one to find where it closes.
  let depth = 0;
  let closesAt = -1;
  for (let i = opensAt + marker.length - 1; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) {
      closesAt = i;
      break;
    }
  }
  assert.ok(closesAt > opensAt, "the 1181px stage block is not closed");

  const selector = ".broadcast:not(.broadcast--compact)";
  const outside: number[] = [];
  for (let at = CSS.indexOf(selector); at >= 0; at = CSS.indexOf(selector, at + 1)) {
    if (at < opensAt || at > closesAt) outside.push(at);
  }
  assert.deepEqual(
    outside.map((at) => CSS.slice(at, CSS.indexOf("{", at)).trim()),
    [],
    "a full-size stage rule is outside the 1181px block — it will reach a phone",
  );
});
