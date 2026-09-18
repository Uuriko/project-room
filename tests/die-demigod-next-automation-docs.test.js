// Demigod / DIE next-automation docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DIE-DEMIGOD-NEXT-AUTOMATION-2026-09-18.md");
const wave3 = join(root, "research", "DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md");
const plan = join(root, "research", "DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("next-automation note exists and stays honest", () => {
  assert.ok(existsSync(note), "research/DIE-DEMIGOD-NEXT-AUTOMATION-2026-09-18.md");
  assert.ok(existsSync(plan), "parent optimize plan");
  assert.ok(existsSync(wave3), "Wave 3 progress companion");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md",
    "DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md",
    "DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md",
    "OPT-IN-FORM-SHIP-PLAN-2026-09-18.md",
    "WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md",
    "~55/100",
    "draft factory",
    "not production E2E",
    "people-data",
    "Compute ≠ Room",
    "FIRST_PARTY",
    "empty",
    "never-run",
    "9:25 PT",
    "send_*",
    "one Lightfield hire",
    "Shipped ≠ Measured",
  ]) {
    assert.ok(text.includes(needle), `next-automation note should include ${needle}`);
  }
  assert.ok(
    !/fully automated matching/i.test(text),
    "must not claim fully automated matching"
  );
  assert.ok(!/\/workspace\//.test(text), "must not hard-code /workspace box paths");
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  const file = "DIE-DEMIGOD-NEXT-AUTOMATION-2026-09-18.md";
  assert.ok(research.includes(file), "research/README indexes next-automation");
  assert.ok(docs.includes(file), "docs/README indexes next-automation");
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNext = research.indexOf("## Research index");
  const researchNote = research.indexOf(file);
  assert.ok(researchDie !== -1 && researchNote !== -1 && researchNext !== -1);
  assert.ok(
    researchNote > researchDie && researchNote < researchNext,
    "research next-automation row sits in the Demigod / DIE section"
  );
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNext = docs.indexOf("## Steal contracts");
  const docsNote = docs.indexOf(file);
  assert.ok(docsDie !== -1 && docsNote !== -1 && docsNext !== -1);
  assert.ok(
    docsNote > docsDie && docsNote < docsNext,
    "docs next-automation row sits in the Demigod / DIE section"
  );
});
