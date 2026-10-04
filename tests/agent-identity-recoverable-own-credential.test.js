// QA2-CONTRACT fuzz regression (2026-10-04, schemathesis BUG-1).
//
// Contract: POST /api/agent-identities is retryable ("recoverable"). Re-
// registering with your own live credential must be idempotent (200,
// duplicate:true, the same identity) - never an unhandled 500. Schemathesis
// found the handler colliding on the UNIQUE secret_hash when the credential
// belonged to a normally-minted identity (random identity_id, not the
// derived recoverable id): ERR_SQLITE_ERROR -> HTTP 500.
//
// A revoked credential cannot mint again: 409 identity_credential_changed
// (matching the derived-id path), not a 500 either.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "qa2-contract-identity-retry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function mint(origin, displayName, { secret } = {}) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers, body: JSON.stringify({ displayName }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function reRegister(origin, secret, displayName) {
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ displayName, recoverable: true }),
  });
  return { status: res.status, json: await res.json() };
}

test("re-registering your own live credential is idempotent, not a 500", async t => {
  const origin = await serve(t);
  const first = await mint(origin, "Retry Agent");
  const again = await reRegister(origin, first.secret, "Retry Agent Renamed");
  // The idempotent duplicate answers through the same 201 mint response as
  // the derived-id path (existing client-visible behavior); the contract is
  // the body: same identity, duplicate:true, never a 500.
  assert.equal(again.status, 201, `expected 201, got ${again.status}: ${JSON.stringify(again.json).slice(0, 200)}`);
  assert.equal(again.json.identityId, first.identityId, "same identity is returned");
  assert.equal(again.json.duplicate, true, "marked as a duplicate registration");
  assert.equal(again.json.displayName, first.displayName, "existing display name wins, like the derived-id path");
  // Idempotent twice over: nothing was half-written by the first retry.
  const third = await reRegister(origin, first.secret, "Retry Agent Renamed");
  assert.equal(third.status, 201);
  assert.equal(third.json.identityId, first.identityId);
  assert.equal(third.json.duplicate, true);
});

test("re-registering a revoked credential is a 409, not a 500", async t => {
  const origin = await serve(t);
  const first = await mint(origin, "Revoked Agent");
  const revoke = await fetch(`${origin}/api/agent-identities/${first.identityId}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${first.secret}` },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(revoke.status, 200, "revocation succeeds");
  const again = await reRegister(origin, first.secret, "Revoked Agent");
  assert.equal(again.status, 409, `expected 409, got ${again.status}: ${JSON.stringify(again.json)}`);
  assert.equal(again.json.error?.code, "identity_credential_changed");
});
