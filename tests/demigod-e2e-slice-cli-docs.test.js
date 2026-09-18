// Demigod / DIE Now-slice CLI companion docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md");
const parent = join(root, "research", "DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Demigod E2E slice CLI companion note exists", () => {
  assert.ok(existsSync(note), "research/DEMIGOD-E2E-SLICE-CLI-2026-09-18.md");
  assert.ok(existsSync(parent), "parent DEMIGOD-E2E-AUTOMATION note");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "die-packet-brief-status",
    "DEMIGOD-E2E-AUTOMATION-2026-09-18.md",
    "SLICE-CLI.md",
    "run-slice.mjs",
    "run-pipeline.mjs",
    "validate-state-machine.mjs",
    "assert-no-people-domains.mjs",
    "fetch-company-packet.mjs",
    "draft-brief-from-packet.mjs",
    "status-on-stage-change.mjs",
    "rank-queue-dry-run.mjs",
    "draft-consent-request.mjs",
    "draft-intro.mjs",
    "draft-trial-eor.mjs",
    "draft-invoice.mjs",
    "packet.md",
    "brief.md",
    "status.json",
    "queue-rank.json",
    "consent-draft.md",
    "intro-draft.md",
    "trial-eor-checklist.md",
    "invoice-draft.json",
    "send_ticket",
    "send_queue_digest",
    "send_consent_request",
    "send_intro",
    "send_trial_invite",
    "approve_trial_start",
    "send_invoice",
    "stripeCall:false",
    "SYNTHETIC",
    "Lightfield",
    "people-data",
    "wrangler",
    "Quill",
    "dasha-lobby",
    "Ask T0xx",
  ]) {
    assert.ok(text.includes(needle), `slice CLI note should include ${needle}`);
  }
  assert.ok(
    /local prototype|prototype dirname/i.test(text),
    "must describe local prototype without requiring box paths"
  );
  assert.ok(
    !/\/workspace\//.test(text),
    "must not hard-code /workspace box paths as required runtime"
  );
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  const file = "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md";
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
