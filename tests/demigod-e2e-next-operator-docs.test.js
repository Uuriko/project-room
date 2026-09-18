// Demigod / DIE Next-operator companion docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md");
const parent = join(root, "research", "DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
const sliceCli = join(root, "research", "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md");
const killSwitches = join(root, "research", "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Demigod E2E Next-operator companion note exists", () => {
  assert.ok(existsSync(note), "research/DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md");
  assert.ok(existsSync(parent), "parent DEMIGOD-E2E-AUTOMATION note");
  assert.ok(existsSync(sliceCli), "slice CLI companion note");
  assert.ok(existsSync(killSwitches), "kill-switches companion note");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "DEMIGOD-E2E-AUTOMATION-2026-09-18.md",
    "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md",
    "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md",
    "NEXT-OPERATOR-DESK.md",
    "ticket-draft",
    "ticket-draft.json",
    "ticket-draft.schema.json",
    "draft-ticket.mjs",
    "companySlug",
    "briefPath",
    "roleTitle",
    "cheapTalk",
    "scorecardSummary",
    "DRAFT",
    "KILL_SWITCH",
    "send_ticket",
    "freeze-band ack",
    "freeze-band-ack.mjs",
    "freeze-band.json",
    "ackRequired",
    "consent-draft.md",
    "intro-draft.md",
    "invoice-draft.json",
    "send_consent_request",
    "send_intro",
    "send_invoice",
    "send_trial_invite",
    "approve_trial_start",
    "Now → Next → Later",
    "one Lightfield hire",
    "Shipped ≠ Measured",
    "people-data",
    "Quill",
    "dasha-lobby",
    "wrangler",
    "Ask T0xx",
    "Phase 0",
  ]) {
    assert.ok(text.includes(needle), `Next-operator note should include ${needle}`);
  }
  assert.ok(
    /no people fields|No people fields/i.test(text),
    "must forbid people fields on the ticket draft"
  );
  assert.ok(
    !/\/workspace\//.test(text),
    "must not hard-code /workspace box paths as required runtime"
  );
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  const file = "DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md";
  assert.ok(research.includes(file));
  assert.ok(docs.includes(file));
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNote = research.indexOf(file);
  assert.ok(researchDie !== -1 && researchNote !== -1);
  assert.ok(
    Math.abs(researchNote - researchDie) < 1200,
    "research index row sits next to the Demigod / DIE heading"
  );
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNote = docs.indexOf(file);
  assert.ok(docsDie !== -1 && docsNote !== -1);
  assert.ok(
    Math.abs(docsNote - docsDie) < 1200,
    "docs index row sits next to the Demigod / DIE heading"
  );
});
