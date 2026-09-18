// T075 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T075 Ask Advanced ladder UX brief exists", () => {
  assert.ok(existsSync(note), "research/ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T075",
    "Speed",
    "Mid",
    "Quality",
    "Advanced",
    "picker placement",
    "empty canvas",
    "model essay",
    "ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md",
    "dasha-compute-ask-quiet-chrome-canary.test.mjs",
    "dasha-compute-ask-empty-canvas-canary.test.mjs",
    "ASK-MODEL-CMDK-SPEC-2026-09-17.md",
    "ASK-QUIET-SHELL-V3.md",
  ]) {
    assert.ok(text.includes(needle), `UX brief should include ${needle}`);
  }
  assert.ok(text.includes("#518"), "cross-link project-room #518 T071/T072 research");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(/hands-off|Hands-off/i.test(text), "must stay hands-off Quill #260");
  assert.ok(text.includes("#275"), "cite dasha-lobby #275 T073 canary");
  assert.ok(/hands-off/i.test(text), "must stay hands-off #275");
  assert.ok(text.includes("T030"), "name T030 whisper-pill canary");
  assert.ok(text.includes("T047"), "name T047 empty-canvas canary");
  assert.ok(text.includes("#270"), "cite dasha-lobby #270 T030");
  assert.ok(text.includes("#268"), "cite dasha-lobby #268 T047");
  assert.ok(/never dump|Never dump|never a model essay/i.test(text), "never dump model essay");
  assert.ok(/#ask-model/.test(text), "picker lives on #ask-model");
  assert.ok(/#ask-cmdk/.test(text), "later picker is #ask-cmdk");
  assert.ok(/Advanced stays empty|empty Advanced|empty until #258/i.test(text), "Advanced stays empty");
  assert.ok(/no wrangler|No wrangler|not.*wrangler/i.test(text), "no wrangler");
});

test("index rows point at T075", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md"));
  assert.ok(docs.includes("ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md"));
});
