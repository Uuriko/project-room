// Demigod / DIE Wave 3 progress docs lock. Research notes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const progress = join(root, "research", "DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md");
const matchStates = join(root, "research", "MATCH-STATE-PROPOSALS-2026-09-18.md");
const stripe = join(root, "research", "STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md");
const watchlist = join(root, "research", "WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md");
const optIn = join(root, "research", "OPT-IN-FORM-SHIP-PLAN-2026-09-18.md");
const plan = join(root, "research", "DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md");
const wave2 = join(root, "research", "DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md");
const researchReadme = join(root, "research", "README.md");
const docsReadme = join(root, "docs", "README.md");

test("Wave 3 progress note exists and stays honest", () => {
  assert.ok(existsSync(progress), "research/DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md");
  assert.ok(existsSync(plan), "parent optimize plan");
  assert.ok(existsSync(wave2), "Wave 2 progress companion");
  const text = readFileSync(progress, "utf8");
  for (const needle of [
    "DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md",
    "DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md",
    "MATCH-STATE-PROPOSALS-2026-09-18.md",
    "STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md",
    "OPT-IN-FORM-SHIP-PLAN-2026-09-18.md",
    "WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md",
    "~55/100",
    "draft factory",
    "dieSoRMutation",
    "false",
    "proposed",
    "finalized_local",
    "send_invoice",
    "blocked",
    "FIRST_PARTY",
    "empty",
    "ticket_sent",
    "pending",
    "never-run",
    "9:25 PT",
    "people-data",
    "not production E2E",
    "Compute ≠ Room",
    "Shipped ≠ Measured",
    "one Lightfield hire",
  ]) {
    assert.ok(text.includes(needle), `Wave 3 progress should include ${needle}`);
  }
  assert.ok(
    !/fully automated matching/i.test(text),
    "must not claim fully automated matching"
  );
  assert.ok(!/\/workspace\//.test(text), "must not hard-code /workspace box paths");
});

test("MATCH_STATES companion is proposed-only", () => {
  assert.ok(existsSync(matchStates));
  const text = readFileSync(matchStates, "utf8");
  for (const needle of [
    "dieSoRMutation",
    "false",
    "proposed",
    "submitted",
    "reviewed",
    "matched",
    "people-data",
    "Compute ≠ Room",
  ]) {
    assert.ok(text.includes(needle), `MATCH_STATES note should include ${needle}`);
  }
  assert.ok(/never.*mutat/i.test(text), "must refuse silent SoR mutation");
});

test("Stripe companion keeps send_invoice blocked", () => {
  assert.ok(existsSync(stripe));
  const text = readFileSync(stripe, "utf8");
  for (const needle of [
    "finalized_local",
    "send_invoice",
    "blocked",
    "auto_advance",
    "STRIPE_SECRET",
    "people-data",
    "Compute ≠ Room",
  ]) {
    assert.ok(text.includes(needle), `Stripe note should include ${needle}`);
  }
  assert.ok(/never unblock `send_invoice`/i.test(text));
});

test("Opt-in plan and watchlist stay unshipped / never-run", () => {
  assert.ok(existsSync(optIn));
  assert.ok(existsSync(watchlist));
  const opt = readFileSync(optIn, "utf8");
  const cron = readFileSync(watchlist, "utf8");
  assert.ok(opt.includes("FIRST_PARTY.empty.json"));
  assert.ok(opt.includes("live: false"));
  assert.ok(opt.includes("worker-route.stub.mjs"));
  assert.ok(/not.*deploy/i.test(opt));
  assert.ok(opt.includes("Compute ≠ Room"));
  assert.ok(cron.includes("never-run"));
  assert.ok(cron.includes("9:25 PT"));
  assert.ok(cron.includes("Compute ≠ Room"));
});

test("index rows sit in Demigod / DIE matching sections", () => {
  const research = readFileSync(researchReadme, "utf8");
  const docs = readFileSync(docsReadme, "utf8");
  for (const file of [
    "DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md",
    "MATCH-STATE-PROPOSALS-2026-09-18.md",
    "STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md",
    "WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md",
  ]) {
    assert.ok(research.includes(file), `research/README indexes ${file}`);
    assert.ok(docs.includes(file), `docs/README indexes ${file}`);
  }
  assert.match(research, /Demigod\s*\/\s*DIE matching/i);
  assert.match(docs, /Demigod\s*\/\s*DIE matching/i);
  const researchDie = research.search(/Demigod\s*\/\s*DIE matching/i);
  const researchNote = research.indexOf("DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md");
  assert.ok(researchDie !== -1 && researchNote !== -1);
  assert.ok(
    researchNote > researchDie && researchNote - researchDie < 4000,
    "research Wave 3 row sits in the Demigod / DIE section"
  );
  const docsDie = docs.search(/Demigod\s*\/\s*DIE matching/i);
  const docsNote = docs.indexOf("DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md");
  assert.ok(docsDie !== -1 && docsNote !== -1);
  assert.ok(
    docsNote > docsDie && docsNote - docsDie < 4000,
    "docs Wave 3 row sits in the Demigod / DIE section"
  );
});
