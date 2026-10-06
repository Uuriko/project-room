// O014: the troubleshooting playbook must not drift from the product.
// Every error code it cites has to appear in server/, src/, or tests/.
// Gate answers (see .agents/skills/test-audit/SKILL.md):
// 1. Contract: the playbook's cited error codes/shapes exist in the product.
// 2. Regression: an edit renames a code in server/ (or the doc invents one)
//    and the playbook goes stale, misdiagnosing agents' errors.
// 3. No existing test reads the playbook; nothing else catches docs drift.
// 4. No production seam: the test reads files and greps the tree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOK = path.join(ROOT, "docs", "TROUBLESHOOTING.md");

function groundedCodes() {
  const text = readFileSync(PLAYBOOK, "utf8");
  const block = text.match(/<!--\s*#?\s*TROUBLESHOOT-GROUNDED-CODES[^\n]*\n([\s\S]*?)-->/);
  assert.ok(block, "playbook must carry the TROUBLESHOOT-GROUNDED-CODES comment block");
  return block[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function mentionedAnywhere(codes) {
  const alternation = codes.map((c) => `\\b${c}\\b`).join("|");
  const out = execFileSync(
    "grep",
    ["-rhoE", "--include=*.mjs", "--include=*.js", `(${alternation})`, "server", "src", "tests"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

test("every error code cited in the playbook exists in code or tests", () => {
  const codes = groundedCodes();
  assert.ok(codes.length >= 20, `playbook cites a real body of codes (got ${codes.length})`);
  for (const code of codes) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, `grounded token is a code, not prose: ${code}`);
  }
  const found = mentionedAnywhere(codes);
  for (const code of codes) {
    assert.ok(found.has(code), `playbook cites "${code}" but nothing in server/, src/, or tests/ mentions it`);
  }
});

test("playbook is organized by symptom and cross-references the taxonomy", () => {
  const text = readFileSync(PLAYBOOK, "utf8");
  for (const section of [
    "auth",
    "409",
    "422",
    "500",
    "webhook",
    "proof",
    "guest",
  ]) {
    assert.ok(text.toLowerCase().includes(section), `playbook covers "${section}"`);
  }
  assert.ok(text.includes("ERROR-TAXONOMY.md"), "playbook cross-references docs/ERROR-TAXONOMY.md");
});

test("playbook states the real status/code pairings, not pinned singles", () => {
  const text = readFileSync(PLAYBOOK, "utf8");
  const linesWith = (pat) =>
    execFileSync("grep", ["-rn", "--include=*.mjs", pat, "server"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean);
  // account_session_required: 401 on account-flow routes, 403 on agent mint routes.
  const asr = linesWith("account_session_required");
  assert.ok(asr.some((l) => l.includes("(401")), "server/ emits 401 account_session_required");
  assert.ok(asr.some((l) => l.includes("(403")), "server/ emits 403 account_session_required");
  assert.ok(
    text.includes("`account_session_required` (401 or 403)"),
    "playbook states both statuses for account_session_required",
  );
  // identity_revoked: 403 on identity-gated paths, 409 on the secret-rotation path.
  const ir = linesWith("identity_revoked");
  assert.ok(ir.some((l) => l.includes("(403")), "server/ emits 403 identity_revoked");
  assert.ok(ir.some((l) => l.includes("(409")), "server/ emits 409 identity_revoked");
  assert.ok(
    text.includes("`identity_revoked` (403 or 409)"),
    "playbook states both statuses for identity_revoked",
  );
  // Expired v0 credential on ordinary endpoints: 401 unauthenticated via store.authenticate.
  const store = readFileSync(path.join(ROOT, "server", "store.mjs"), "utf8");
  assert.ok(
    store.includes('fail(401, "unauthenticated", "Session or key expired or revoked")'),
    "expired credential resolves to 401 unauthenticated in server/store.mjs",
  );
  assert.ok(
    text.includes("401 unauthenticated") && text.includes("Session or key expired or revoked"),
    "playbook documents the 401 for expired ordinary credential use",
  );
});

test("playbook's load-bearing facts match the product", () => {
  const text = readFileSync(PLAYBOOK, "utf8");
  // The 428 recipe field names the playbook relies on.
  const identities = readFileSync(path.join(ROOT, "server", "agent-identities.mjs"), "utf8");
  for (const field of ["acceptBuckets", "prefix", "nonce", "challenge", "windowMs"]) {
    assert.ok(identities.includes(field), `server/agent-identities.mjs defines proof field "${field}"`);
    assert.ok(text.includes(field), `playbook documents proof field "${field}"`);
  }
  assert.ok(identities.includes("IDENTITY_POW_BITS = 12"), "identity mint proof is 12 bits in code");
  assert.ok(text.includes('"bits": 12'), "playbook states the real 12-bit difficulty");
  assert.ok(identities.includes("^[A-Za-z0-9_-]{1,43}$"), "nonce shape is pinned in code");
  assert.ok(text.includes("^[A-Za-z0-9_-]{1,43}$"), "playbook states the real nonce shape");
  // The v0 refresh endpoint the playbook documents.
  const http = readFileSync(path.join(ROOT, "server", "http.mjs"), "utf8");
  assert.ok(http.includes("/api/guest-agent-links/refresh"), "refresh endpoint exists in server/http.mjs");
  assert.ok(text.includes("/api/guest-agent-links/refresh"), "playbook documents the refresh endpoint path");
  // TTL and grace window numbers the playbook states.
  const links = readFileSync(path.join(ROOT, "server", "guest-agent-links.mjs"), "utf8");
  assert.ok(links.includes("2 * 60 * 60 * 1000"), "v0 credential TTL is 2h in code");
  assert.ok(links.includes("7 * 24 * 60 * 60 * 1000"), "refresh grace window is 7d in code");
  // The errorId format the playbook promises.
  const traceTest = readFileSync(path.join(ROOT, "tests", "mcp-500-error-trace.test.js"), "utf8");
  assert.ok(traceTest.includes("eid_"), "the eid_ errorId format is pinned by tests/mcp-500-error-trace.test.js");
  assert.ok(text.includes("eid_"), "playbook states the eid_ errorId format");
});
