// Demigod / DIE Optimize companion docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const note = join(root, "research", "DEMIGOD-E2E-OPTIMIZE-2026-09-18.md");
const parent = join(root, "research", "DEMIGOD-E2E-AUTOMATION-2026-09-18.md");
const sliceCli = join(root, "research", "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md");
const killSwitches = join(root, "research", "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md");
const nextOperator = join(root, "research", "DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Demigod E2E Optimize companion note exists", () => {
  assert.ok(existsSync(note), "research/DEMIGOD-E2E-OPTIMIZE-2026-09-18.md");
  assert.ok(existsSync(parent), "parent DEMIGOD-E2E-AUTOMATION note");
  assert.ok(existsSync(sliceCli), "slice CLI companion note");
  assert.ok(existsSync(killSwitches), "kill-switches companion note");
  assert.ok(existsSync(nextOperator), "next-operator companion note");
  const text = readFileSync(note, "utf8");
  for (const needle of [
    "DEMIGOD-E2E-AUTOMATION-2026-09-18.md",
    "DEMIGOD-E2E-SLICE-CLI-2026-09-18.md",
    "DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md",
    "DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md",
    "HumanLayer",
    "requireApproval",
    "Factory",
    "blocklist",
    "Horton",
    "recommend-into-queue",
    "company waterfall",
    "Parallel",
    "Exa",
    "Clay",
    "Stripe",
    "auto_advance=false",
    "Allow",
    "Ask",
    "Block",
    "send_ticket",
    "send_consent_request",
    "send_intro",
    "send_trial_invite",
    "send_invoice",
    "Auto-DM",
    "hire_confirmed",
    "ticket_sent",
    "company_packet_ready",
    "brief_locked",
    "ticket_drafted",
    "queue_recommended",
    "one Lightfield hire",
    "Shipped ≠ Measured",
    "~34/100",
    "draft factory",
    "not production E2E",
    "people-data",
    "Quill",
    "dasha-lobby",
    "wrangler",
    "Ask T0xx",
    "Phase 0",
    "https://www.npmjs.com/package/@humanlayer/sdk",
    "https://docs.factory.ai/enterprise/llm-safety-and-agent-controls",
    "http://john-joseph-horton.com/papers/employer_search.pdf",
    "https://www.clay.com/guides/waterfall-enrichment",
    "https://docs.stripe.com/invoicing/integration"
  ]) {
    assert.ok(text.includes(needle), `Optimize note should include ${needle}`);
  }
  assert.ok(
    !/\/workspace\//.test(text),
    "must not hard-code /workspace box paths as required runtime"
  );
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  const file = "DEMIGOD-E2E-OPTIMIZE-2026-09-18.md";
  assert.ok(research.includes(file));
  assert.ok(docs.includes(file));
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNote = research.indexOf(file);
  assert.ok(researchDie !== -1 && researchNote !== -1);
  assert.ok(
    Math.abs(researchNote - researchDie) < 1600,
    "research index row sits next to the Demigod / DIE heading"
  );
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNote = docs.indexOf(file);
  assert.ok(docsDie !== -1 && docsNote !== -1);
  assert.ok(
    Math.abs(docsNote - docsDie) < 1600,
    "docs index row sits next to the Demigod / DIE heading"
  );
});
