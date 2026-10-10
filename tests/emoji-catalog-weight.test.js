// Mobile page-weight budget for src/emoji-catalog.js.
//
// The catalog ships in the critical first-paint module graph (src/emoji.js is
// statically imported by src/app.js, src/conversation.js and src/events.js),
// so every byte here is paid on every page view — phones on slow networks pay
// it hardest. The catalog is stored in a compact pipe-delimited encoding (see
// the header of src/emoji-catalog.js); this test fails if the source file
// regresses past the budget, forcing future growth to justify itself or pack
// tighter. Byte budget: 130_000 (~34% under the 2026-10-07 pre-compact size).
import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

const CATALOG_URL = new URL("../src/emoji-catalog.js", import.meta.url);
const BUDGET_BYTES = 130_000;

test("emoji catalog source stays within the mobile page-weight budget", () => {
  const { size } = statSync(CATALOG_URL);
  assert.ok(
    size <= BUDGET_BYTES,
    `src/emoji-catalog.js is ${size} bytes, over the ${BUDGET_BYTES}-byte mobile budget`
  );
});
