// Guard: the production deploy pipeline must stay fail-closed on agent-card
// signing. History: the 2026-09-28 deploy failed closed at sign-agent-card
// ("signing failed; release stopped"); the unsigned escape hatch
// (--allow-unsigned) exists only for local dev and CI dry-runs
// (scripts/worker-ci-build.mjs injects it into a throwaway config for
// --dry-run only, and refuses to run if it is already present). If
// --allow-unsigned ever lands in a production workflow or the production
// wrangler build command, unsigned cards could ship without anyone noticing.
// These checks run on every PR via the unit suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- pure checkers (unit-testable against poisoned fixtures) ----------------

// True when a production workflow text never carries the unsigned escape hatch.
export function productionWorkflowForbidsUnsigned(workflowText) {
  return !workflowText.includes("--allow-unsigned");
}

// True when the deploy-prod workflow's secret gate refuses the deploy if the
// agent-card signing key is missing. Scoped to the "Require deploy secrets"
// step so a stray match elsewhere cannot satisfy it.
export function deployJobRequiresSigningKey(workflowText) {
  const i = workflowText.indexOf("Require deploy secrets");
  if (i === -1) return false;
  const step = workflowText.slice(i, i + 2000);
  return step.includes("missing ROOM_AGENT_CARD_SIGNING_KEY") &&
    /exit\s+["']?\$missing["']?/.test(step);
}

// True when at least one wrangler build command signs the agent card without
// the unsigned escape hatch. (tests/asset-packaging.test.js pins the exact
// full command; this guards the signing half against silent edits.)
export function buildCommandSignsCard(jsoncText) {
  const commands = [...jsoncText.matchAll(/"command"\s*:\s*"([^"]*)"/g)].map(m => m[1]);
  if (commands.length === 0) return false;
  return commands.some(cmd =>
    cmd.includes("node ../scripts/sign-agent-card.mjs") && !cmd.includes("--allow-unsigned"));
}

// --- checker unit tests: poisoned fixtures must be caught -------------------

test("productionWorkflowForbidsUnsigned catches an injected escape hatch", () => {
  assert.equal(productionWorkflowForbidsUnsigned("run: wrangler deploy"), true);
  assert.equal(productionWorkflowForbidsUnsigned("run: node sign-agent-card.mjs --allow-unsigned"), false);
});

test("deployJobRequiresSigningKey rejects a gate that lost its key check", () => {
  const good = "name: Require deploy secrets\nrun: |\n  if [ -z \"$KEY\" ]; then\n    echo \"::error title=missing ROOM_AGENT_CARD_SIGNING_KEY::missing\"\n    missing=1\n  fi\n  exit \"$missing\"";
  const noKeyCheck = "name: Require deploy secrets\nrun: |\n  echo deploying\n  exit 0";
  const noStep = "name: something else\nrun: |\n  exit 0";
  assert.equal(deployJobRequiresSigningKey(good), true);
  assert.equal(deployJobRequiresSigningKey(noKeyCheck), false);
  assert.equal(deployJobRequiresSigningKey(noStep), false);
});

test("buildCommandSignsCard catches a signer removed or neutered", () => {
  const signed = '{ "build": { "command": "node ../scripts/stamp-version.mjs && node ../scripts/sign-agent-card.mjs" } }';
  const removed = '{ "build": { "command": "node ../scripts/stamp-version.mjs" } }';
  const neutered = '{ "build": { "command": "node ../scripts/sign-agent-card.mjs --allow-unsigned" } }';
  assert.equal(buildCommandSignsCard(signed), true);
  assert.equal(buildCommandSignsCard(removed), false);
  assert.equal(buildCommandSignsCard(neutered), false);
  assert.equal(buildCommandSignsCard("{}"), false);
});

// --- live-repo guards ---------------------------------------------------------

const PRODUCTION_WORKFLOWS = [
  ".github/workflows/deploy-prod.yml",
  ".github/workflows/rollback-prod.yml",
  ".github/workflows/staging.yml",
];

test("no production workflow carries --allow-unsigned", () => {
  for (const rel of PRODUCTION_WORKFLOWS) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.ok(productionWorkflowForbidsUnsigned(text),
      `${rel} must never carry --allow-unsigned; the unsigned escape hatch is dev/CI-dry-run only`);
  }
});

test("deploy-prod refuses without ROOM_AGENT_CARD_SIGNING_KEY", () => {
  const text = readFileSync(join(root, ".github/workflows/deploy-prod.yml"), "utf8");
  assert.ok(deployJobRequiresSigningKey(text),
    "deploy-prod must fail closed when the signing key secret is missing");
});

test("wrangler production build command signs the agent card", () => {
  const jsonc = readFileSync(join(root, "cloudflare/wrangler.jsonc"), "utf8");
  assert.ok(buildCommandSignsCard(jsonc),
    "cloudflare/wrangler.jsonc build command must run scripts/sign-agent-card.mjs without --allow-unsigned");
});
