// COLD-AGENT-WALKTHROUGH accuracy pins: doc statements in
// docs/COLD-AGENT-WALKTHROUGH.md must match server code and live behavior.
// Fail-first: each test failed on the pre-fix doc (2026-10-08) and passes
// with the drift closed. Regression history: the stranger table listed
// /mcp.json and /governance.json at the root, both 404 live (the routes are
// /.well-known/mcp.json and /.well-known/governance.json); agent-invite
// code TTL was undocumented (QA-200); rotate/revoke endpoints were
// invisible; the finish example showed a hardcoded generation value without
// saying where it comes from (literal copy answers 409).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("walkthrough discovery row points at the live .well-known paths", () => {
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  const discovery = read("server/discoverability.mjs");
  // Independent guard: the user-facing paths must exist in the server's
  // route table and be the ones the doc advertises.
  for (const path of ["/.well-known/mcp.json", "/.well-known/governance.json"]) {
    assert.ok(
      discovery.includes(`"${path}"`),
      `server must serve ${path}`,
    );
    assert.ok(
      cold.includes(path),
      `COLD-AGENT-WALKTHROUGH.md must advertise ${path}`,
    );
  }
  // The doc previously listed the two JSON cards at the root, where both
  // are 404 live. (/agent-card.json really is a root path, so only the
  // mcp.json/governance.json root forms are rejected.)
  for (const rootPath of ["/mcp.json", "/governance.json"]) {
    const row = cold.split("\n").filter((line) => line.includes("Machine-readable discovery"));
    assert.ok(row.length > 0, "doc must keep a machine-readable discovery row");
    assert.ok(
      !row.some((line) => line.includes(`\`${rootPath}\``) || line.includes(`"${rootPath}"`)),
      `COLD-AGENT-WALKTHROUGH.md must not list ${rootPath} at the root (404 live)`,
    );
  }
});

test("walkthrough documents the agent-invite code TTL from server constants", () => {
  const invites = read("server/agent-invites.mjs");
  const def = invites.match(/DEFAULT_TTL_MINUTES\s*=\s*(\d+)/);
  const min = invites.match(/MIN_TTL_MINUTES\s*=\s*(\d+)/);
  const max = invites.match(/MAX_TTL_MINUTES\s*=\s*(\d+)/);
  assert.ok(def && min && max, "server must export invite TTL minutes constants");
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  const defaultHours = Number(def[1]) / 60;
  const maxDays = Number(max[1]) / (24 * 60);
  assert.ok(
    cold.includes(`${defaultHours} hour`),
    `walkthrough must state the invite-code default TTL (${defaultHours}h)`,
  );
  assert.ok(
    cold.includes(`${min[1]} minutes`) && cold.includes(`${maxDays} days`),
    `walkthrough must state the issuer-settable TTL range (${min[1]}m-${maxDays}d)`,
  );
});

test("walkthrough surfaces identity-secret rotate and revoke", () => {
  const discovery = read("server/discoverability.mjs");
  const routes = [
    "/api/agent-identities/{identityId}/rotate",
    "/api/agent-identities/{identityId}/revoke",
  ];
  for (const route of routes) {
    assert.ok(
      discovery.includes(`"${route}"`),
      `server must register ${route}`,
    );
  }
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  assert.ok(
    cold.includes("/api/agent-identities/{identityId}/rotate"),
    "walkthrough must document the secret-rotate endpoint",
  );
  assert.ok(
    cold.includes("/api/agent-identities/{identityId}/revoke"),
    "walkthrough must document the secret-revoke endpoint",
  );
});

test("walkthrough tells the reader where generation and expectedTermsVersion come from", () => {
  const claims = read("server/public-work-claims.mjs");
  // The finish call rejects a guessed generation: it must equal the claim's
  // current generation (stale_public_claim), and the terms version must match
  // the task's (stale_public_work). A doc example with bare literals teaches
  // the reader to copy them instead.
  assert.ok(
    /(row\.generation !== input\.generation|input\.generation !== row\.generation)/.test(claims),
    "server must reject a generation that does not match the claim",
  );
  assert.ok(
    /(row\.terms_version !== input\.expectedTermsVersion|input\.expectedTermsVersion !== row\.terms_version)/.test(claims),
    "server must reject a terms version that does not match the task",
  );
  const cold = read("docs/COLD-AGENT-WALKTHROUGH.md");
  const step3 = cold.slice(cold.indexOf("## 3."));
  assert.ok(
    /generation.*claim response|claim response.*generation/s.test(step3),
    "walkthrough must say generation comes from the claim response",
  );
  assert.ok(
    /expectedTermsVersion.*termsVersion|termsVersion.*expectedTermsVersion/s.test(step3),
    "walkthrough must say expectedTermsVersion comes from the task read",
  );
});
