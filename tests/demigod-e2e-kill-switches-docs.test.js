// Demigod / DIE kill-switches companion docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md");
const parent = join(root, "research", "DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
const sliceCli = join(root, "research", "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Demigod E2E kill-switches companion note exists", () => {
  assert.ok(existsSync(note), "research/DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md");
  assert.ok(existsSync(parent), "parent DEMIGOD-E2E-AUTOMATION note");
  assert.ok(existsSync(sliceCli), "slice CLI companion note");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "DEMIGOD-E2E-AUTOMATION-2026-09-18.md",
    "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md",
    "send_ticket",
    "send_consent_request",
    "send_intro",
    "send_trial_invite",
    "approve_trial_start",
    "send_invoice",
    "freeze-band ack",
    "state-machine.json",
    "kill-switch-ledger.mjs",
    "one Lightfield hire",
    "Shipped ≠ Measured",
    "people-data",
    "auto-DM",
    "salary history",
    "1099",
    "EOR",
    "W-2",
    "Quill",
    "dasha-lobby",
    "wrangler",
    "Ask T0xx",
    "Phase 0",
  ]) {
    assert.ok(text.includes(needle), `kill-switches note should include ${needle}`);
  }
  assert.ok(
    /six human kill-switches|The six human kill-switches/i.test(text),
    "must name the six human kill-switches"
  );
  assert.ok(
    !/\/workspace\//.test(text),
    "must not hard-code /workspace box paths as required runtime"
  );
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  const file = "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md";
  assert.ok(research.includes(file));
  assert.ok(docs.includes(file));
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNote = research.indexOf(file);
  assert.ok(researchDie !== -1 && researchNote !== -1);
  assert.ok(
    Math.abs(researchNote - researchDie) < 800,
    "research index row sits next to the Demigod / DIE heading"
  );
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNote = docs.indexOf(file);
  assert.ok(docsDie !== -1 && docsNote !== -1);
  assert.ok(
    Math.abs(docsNote - docsDie) < 800,
    "docs index row sits next to the Demigod / DIE heading"
  );
});
