// Lane 5 — audit item 6 (2026-10-06): /api/guest-invites/* is agent-API-only.
//
// The GX guest-invite flow's credential primitive is an Ed25519-signed agent
// card (+ an ai_… identity secret for redemption). A browser cannot produce
// that credential, and no bundled client (src/, cloudflare/public/src/,
// client/) calls these endpoints — the join page runs on /api/agent-invites/*
// + /api/join, a different flow. Resolution of the audit item: formally mark
// the family agent-API-only in docs/openapi.yaml (this test pins the marking)
// instead of wiring UI for a flow no browser user can complete.
//
// Two gates, each with a distinct owner:
//   1. Every guest-invites operation documented in docs/openapi.yaml carries
//      `x-consumer: agent-api` and a description that names the
//      agent-API-only status. No existing gate checks the consumer marking
//      (openapi-served-coverage checks served-vs-spec identity, not labels),
//      so this is the primary owner of this contract.
//   2. docs/GUEST-AGENT-LINKS.md states the agent-API-only status, so agents
//      reading the recipe know the endpoints have no browser UI and are
//      consumed over plain HTTPS by programmatic clients.
//
// Docs-vs-served-routes identity for this family is already owned by the
// openapi-gen gate (every documented op must be a route-table row or legacy
// allowlist row), so it is not re-checked here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Top-level GX flow + room-scoped owner administration.
const FAMILIES = [/^\/api\/guest-invites($|\/)/, /^\/api\/rooms\/\{roomId\}\/guest-invites($|-)/];

function guestInviteOperations(doc) {
  const paths = doc.get("paths");
  assert.ok(paths && Array.isArray(paths.items), "openapi.yaml has a paths map");
  const ops = [];
  for (const pathPair of paths.items) {
    const path = String(pathPair.key);
    if (!FAMILIES.some((re) => re.test(path))) continue;
    for (const methodPair of pathPair.value.items) {
      ops.push({ method: String(methodPair.key).toUpperCase(), path, op: methodPair.value });
    }
  }
  return ops;
}

function loadOperations() {
  const text = readFileSync(join(ROOT, "docs/openapi.yaml"), "utf8");
  const doc = parseDocument(text, { uniqueKeys: true, strict: true });
  assert.deepEqual(doc.errors.map((e) => e.message), [], "openapi.yaml parses cleanly");
  return guestInviteOperations(doc);
}

test("every guest-invites operation is marked agent-API-only", () => {
  const ops = loadOperations();
  // 6 top-level (GET, HEAD, preview, redeem, request, rotate) + 6 room-scoped
  // owner operations.
  assert.ok(ops.length >= 12, `expected the full guest-invites family documented, found ${ops.length}`);
  for (const { method, path, op } of ops) {
    assert.equal(
      String(op.get("x-consumer")),
      "agent-api",
      `${method} ${path} carries x-consumer: agent-api`,
    );
    const description = String(op.get("description") ?? "");
    assert.match(
      description,
      /agent[\s-]*api/i,
      `${method} ${path} description names the agent-API-only status`,
    );
  }
});

test("docs/GUEST-AGENT-LINKS.md states the agent-API-only status", () => {
  const text = readFileSync(join(ROOT, "docs/GUEST-AGENT-LINKS.md"), "utf8");
  assert.match(text, /agent-API-only/i, "GUEST-AGENT-LINKS.md marks the endpoints agent-API-only");
});
