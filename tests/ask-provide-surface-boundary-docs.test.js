// T074 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T074 Ask vs Provide surface boundary note exists", () => {
  assert.ok(existsSync(note), "research/ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T074",
    "T073",
    "Ask",
    "Provide",
    "Host",
    "Marketplace",
    "capacity dashboard",
    "providers table",
    "empty Ask canvas",
    "dasha-compute-ask-empty-canvas-canary.test.mjs",
    "dasha-compute-ask-quiet-chrome-canary.test.mjs",
    "dasha-compute-ask-quiet-shell.test.mjs",
    "dasha-compute-ask-community-chip-canary.test.mjs",
    "ASK-QUIET-SHELL-V3.md",
  ]) {
    assert.ok(text.includes(needle), `boundary note should include ${needle}`);
  }
  assert.ok(text.includes("#268"), "cite dasha-lobby #268 T047 empty-canvas canary");
  assert.ok(text.includes("#270"), "cite dasha-lobby #270 quiet-shell canaries");
  assert.ok(text.includes("#255"), "cite dasha-lobby #255 quiet-shell polish");
  assert.ok(text.includes("#269"), "cite dasha-lobby #269 T050 community chip canary");
  assert.ok(text.includes("T047"), "name T047 empty-canvas canary");
  assert.ok(text.includes("T027"), "name T027 quiet-shell starters canary");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(/spinning/i.test(text), "T073 named as spinning dasha-lobby canary");
  assert.ok(/do not collide|Hands-off/i.test(text), "must not collide with T073");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
  assert.ok(!/wrangler deploy/i.test(text) || /No wrangler|no wrangler/.test(text), "does not instruct wrangler deploy");
});

test("index rows point at T074", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md"));
  assert.ok(docs.includes("ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md"));
});
