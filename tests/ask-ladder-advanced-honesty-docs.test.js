// T071/T072 no-collide docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("T071/T072 ladder Advanced + network honesty note exists", () => {
  assert.ok(existsSync(note), "research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "T071",
    "T072",
    "Speed",
    "Mid",
    "Quality",
    "Advanced",
    "empty",
    "N Macs · models",
    "ternary-bonsai-2-27b",
    "dasha-compute-ask-quiet-chrome-canary.test.mjs",
    "dasha-compute-ask-community-chip-canary.test.mjs",
    "ASK-MODEL-CMDK-SPEC-2026-09-17.md",
  ]) {
    assert.ok(text.includes(needle), `ladder note should include ${needle}`);
  }
  assert.ok(text.includes("#258"), "cite dasha-lobby #258");
  assert.ok(/do not edit|not edited|not undrafted/i.test(text), "must not undraft #258");
  assert.ok(text.includes("#260"), "cite Quill #260 HTML gate");
  assert.ok(text.includes("#270"), "cite T030 ask-model pill canary");
  assert.ok(text.includes("#269"), "cite T050 community chip canary");
  assert.ok(text.includes("T030"), "name T030 whisper-pill canary");
  assert.ok(text.includes("T050"), "name T050 community-chip canary");
  assert.ok(/Advanced stays empty|Advanced empty|empty in this ship/i.test(text), "Advanced stays empty");
  assert.ok(text.includes("expandable"), "T072 is expandable");
  assert.ok(text.includes("UNKNOWN") || text.includes("…"), "pending/unmeasured stays honest");
});

test("index rows point at T071/T072", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  assert.ok(research.includes("ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md"));
  assert.ok(docs.includes("ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md"));
});
