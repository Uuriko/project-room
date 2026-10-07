// Lane 2 doc-drift grounding: agent-facing onboarding docs must match server code.
// Contract: factual claims in AGENT-QUICKSTART.md and COLD-AGENT-WALKTHROUGH.md
// (guest-invite TTL, proof-of-work numbers, issue references) stay pinned to
// the checked-in server constants. Regression history: PR #857 changed the
// guest-invite default TTL to 72h while the doc still said 2h; issue #1548 was
// closed as a duplicate of #1547 while the doc still cited it as the tracker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { llmsTxt } from "../deploy/agent-discovery.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("AGENT-QUICKSTART guest-invite TTL matches the server default", () => {
  const doc = read("docs/AGENT-QUICKSTART.md");
  const serverSrc = read("server/guest-invites.mjs");
  const m = serverSrc.match(
    /GUEST_CREDENTIAL_TTL_DEFAULT_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
  );
  assert.ok(m, "server must export GUEST_CREDENTIAL_TTL_DEFAULT_MS as H * 60 * 60 * 1000");
  const hours = Number(m[1]);
  assert.ok(
    !doc.includes("(read/chat, 2h)"),
    "stale 2h guest-invite TTL must not appear in AGENT-QUICKSTART.md",
  );
  assert.ok(
    doc.includes(`default ${hours}h`),
    `AGENT-QUICKSTART.md must state the server guest-invite default (${hours}h)`,
  );
});

test("COLD-AGENT-WALKTHROUGH does not cite a closed issue as the live tracker", () => {
  const doc = read("docs/COLD-AGENT-WALKTHROUGH.md");
  assert.ok(
    !doc.includes("tracked in issue #1548"),
    "issue #1548 was closed as a duplicate of #1547 — the doc must not present it as the live tracker",
  );
});

test("proof-of-work numbers in the cold docs match server/agent-identities.mjs", () => {
  const ids = read("server/agent-identities.mjs");
  assert.ok(/ANONYMOUS_PROOF_FREE_PER_ADDRESS\s*=\s*8/.test(ids), "free-per-address quota");
  assert.ok(/IDENTITY_POW_BITS\s*=\s*12/.test(ids), "PoW bits");
  assert.ok(/IDENTITY_POW_WINDOW_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/.test(ids), "PoW window");
  assert.ok(
    /PROOF_NONCE\s*=\s*\/\^\[A-Za-z0-9_-\]\{1,43\}\$\//.test(ids),
    "PoW nonce pattern",
  );
  assert.ok(ids.includes('"proof_required"'), "428 proof_required code");
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  for (const phrase of [
    "first 8 identities per source address",
    "12 zero bits",
    "10-minute",
    "[A-Za-z0-9_-]",
    "428",
  ]) {
    assert.ok(
      cold.includes(phrase),
      `COLD-AGENT-WALKTHROUGH.md must document the PoW gate (${phrase})`,
    );
  }
  const start = read("docs/AGENT-START-HERE.md");
  assert.ok(
    start.includes("{bucket}:{trimmedDisplayName}:{nonce}"),
    "AGENT-START-HERE.md must spell the PoW input format",
  );
});

test("anonymous MCP catalog is seven tools in the packet, API reference, and cold doc", () => {
  // Regression history: lane1/funnel added room_identity_mint to the anonymous
  // catalog (now 7 tools: four join + two public-work + identity mint).
  // PR #1492 fixed the count in seven copy spots but missed the generated
  // /llms.txt packet, docs/openapi.yaml, and COLD-AGENT-WALKTHROUGH.md —
  // all three still said "six" on 2026-10-07 (live tools/list probe).
  const packet = llmsTxt();
  assert.ok(!packet.includes("six public tools"), "packet must not say 'six public tools'");
  assert.ok(!packet.includes("six-tool"), "packet must not say 'six-tool'");
  assert.ok(packet.includes("seven"), "packet must state the seven-tool count");
  const apiRef = read("docs/openapi.yaml");
  assert.ok(
    !apiRef.includes("six public tools"),
    "docs/openapi.yaml must not say 'six public tools'",
  );
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  assert.ok(
    /seven public tools/i.test(cold),
    "COLD-AGENT-WALKTHROUGH.md stranger table must say seven public tools",
  );
});

test("deployed revision is documented at /api/version, not /api/health", () => {
  // Live evidence 2026-10-07: GET /api/health answers
  // {status, mode, deployment} with no revision; GET /api/version answers
  // {status, mode, sourceRevision, buildId, deployment}. The cold doc's
  // stranger table must not point revision-seekers at /api/health.
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  assert.ok(
    !/GET \/api\/health[^\n]*deployed revision/i.test(cold),
    "COLD-AGENT-WALKTHROUGH.md must not claim /api/health carries the deployed revision",
  );
  assert.ok(
    /\/api\/version/.test(cold),
    "COLD-AGENT-WALKTHROUGH.md must point deployed-revision seekers at /api/version",
  );
  const httpSrc = read("server/http.mjs");
  assert.ok(
    /sourceRevision: SOURCE_REVISION/.test(httpSrc),
    "server must serve sourceRevision on /api/version",
  );
});
