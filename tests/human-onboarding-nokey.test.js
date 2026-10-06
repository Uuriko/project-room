// Human-UX wave 2 (#1596 + #1600): the human connection guide contract.
//
// The graded B+ human guide (docs/HUMAN-ONBOARDING.md) was the right
// document but told a human with an AI to "start at docs/JOINING.md" —
// an agent-addressed vocabulary doc — while the genuinely no-key human
// path ("Use my AI → Paste AI draft", a work-item flow that needs no key,
// no install, no new account) stayed buried in a dev doc's decision
// record. Contract:
//
// 1. HUMAN-ONBOARDING.md carries a plain-language "Connect your AI"
//    section that documents the no-key paste flow as the primary human
//    path: open the work item's Details → Use my AI → copy → ask your
//    own AI → Paste AI draft → review → Post draft. No key, no install.
// 2. The human guide contains no agent jargon on the human path: no
//    "for agent tooling", no "under a minute with just a name", no CLI
//    versions, MCP JSON, SHA-256 proof-of-work, identity-mint, bearer
//    tokens, or MCP tool names.
// 3. The operator-forwardable blurb in docs/SWARM-PLUG-IN.md no longer
//    promises "under a minute with just a name" (friction inventory row
//    14) — it names the honest setup: a live agent seat needs an owner
//    invite plus one-time agent-side setup (Node 24.19+ runtime, or an
//    MCP host); the no-key paste path needs none of that.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const onboarding = readFileSync(join(root, "docs", "HUMAN-ONBOARDING.md"), "utf8");
const swarmPlugin = readFileSync(join(root, "docs", "SWARM-PLUG-IN.md"), "utf8");

// Phrases that may live in agent-addressed docs, but never on the human
// connection path. (friction inventory rows 2, 14)
const HUMAN_JARGON = [
  "for agent tooling",
  "under a minute with just a name",
  "Node 24.19",
  "MCP JSON",
  "SHA-256",
  "proof-of-work",
  "proof of work",
  "identity mint",
  "Authorization: Bearer",
  "room_check_access",
  "Ed25519",
];

function section(md, headingRe) {
  const match = md.match(new RegExp(`^## ${headingRe.source}[\\s\\S]*?(?=^## |\\z)`, "m"));
  assert.ok(match, `section ## ${headingRe.source} present`);
  return match[0];
}

test("human guide documents the no-key 'Use my AI → Paste AI draft' path first", () => {
  const connect = section(onboarding, /Connect your AI/i);
  for (const step of ["Use my AI", "Paste AI draft", "Post draft", "Details"]) {
    assert.ok(connect.includes(step), `no-key section names the ${step} control`);
  }
  assert.ok(/no key/i.test(connect), "no-key section says no key is needed");
  assert.ok(/no (install|setup)/i.test(connect), "no-key section says no install/setup is needed");
});

test("human guide keeps a live agent seat honest and one line", () => {
  const connect = section(onboarding, /Connect your AI/i);
  assert.ok(/invite/i.test(connect), "says a live seat needs an invite from the owner");
  assert.ok(connect.includes("CONNECT-AGENT-QUICKSTART.md"),
    "points the technical setup at the quickstart doc, not at JOINING.md");
});

test("human guide has no agent jargon on the human path", () => {
  for (const phrase of HUMAN_JARGON) {
    assert.ok(!onboarding.includes(phrase),
      `human guide must not say "${phrase}" — that is agent-addressed copy`);
  }
});

test("'After you're in' routes humans to the no-key path, not JOINING.md", () => {
  const after = section(onboarding, /After you're in/i);
  assert.ok(/Connect your AI/i.test(after),
    "'After you're in' points at the 'Connect your AI' section first");
  assert.ok(!after.includes("start at [docs/JOINING.md](JOINING.md)"),
    "'After you're in' no longer sends humans to the agent vocabulary doc");
});

test("operator blurb in SWARM-PLUG-IN.md stops promising 'under a minute with just a name'", () => {
  assert.ok(!swarmPlugin.includes("under a minute with just a name"),
    "blurb must not promise 'under a minute with just a name' (friction row 14)");
  const blurbIdx = swarmPlugin.indexOf("## Operator-forwardable blurb");
  assert.ok(blurbIdx > -1, "operator blurb section still exists");
  const blurb = swarmPlugin.slice(blurbIdx, swarmPlugin.indexOf("```", swarmPlugin.indexOf("```", blurbIdx) + 3) + 3);
  assert.ok(/Node 24\.19|one-time|MCP/i.test(blurb),
    "blurb names the honest setup (one-time identity setup; Node 24.19+ runtime or MCP host)");
});

test("SWARM-PLUG-IN.md human join paragraph drops 'for agent tooling'", () => {
  assert.ok(!swarmPlugin.includes("for agent tooling"),
    "jargon phrase 'for agent tooling' gone from the human-facing join paragraph");
});
