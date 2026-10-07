// enrollment-docs-accuracy.test.js — hardwork-docs-1 (2026-10-07).
//
// The enrollment docs (docs/SWARM-PLUG-IN.md, docs/IDENTITY-LIFECYCLE.md)
// state concrete request shapes for the agent front door. Two of them
// drifted from the server and were repaired in the same change:
//   1. access-request requestId is OPTIONAL (server mints `ar_…` when
//      omitted) — the doc claimed omission is rejected with 422.
//   2. identity rotate/revoke REQUIRE {"confirm":true} (422
//      confirm_required without) — the lifecycle doc showed bare POSTs.
//
// This file pins both contracts at the HTTP boundary AND checks the docs
// state them, so a future server-side flip re-drifts loudly instead of
// silently lying to a cold agent.
//
// Authoring gate:
// 1. Contract: documented request shapes == served request shapes for the
//    two enrollment mutations above.
// 2. Regression: both drifted once already (server changed, docs did not);
//    a server flip of either would re-drift the docs silently.
// 3. Existing coverage does not catch it: tests/agent-identity-secrets.test.js
//    always sends {confirm:true} (pins the server, not the doc's claim);
//    tests/access-requests.test.js always passes an explicit requestId and
//    never asserts the optionality; nothing reads the docs. The doc-text
//    half is the retention-bar's "source inspection as cheapest independent
//    guard": it fails when the user-facing contract wording changes and
//    survives an identifier-only refactor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const startServer = async (t, f) => {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body ?? {}),
});
const errorCode = async res => (await res.json()).error?.code;

test("access-request: omitted requestId is accepted and server-minted (doc: optional)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Docs drift requester");
  const res = await post(origin, "/api/access-requests", {
    roomId: "commons",
    identityId: agent.identityId,
    displayName: "Docs drift requester",
    requestedPermissions: [],
  });
  assert.equal(res.status, 201, "omitted requestId must not 422");
  const body = await res.json();
  assert.equal(body.status, "pending");
  assert.match(body.requestId, /^ar_[A-Za-z0-9]{16}$/, "server mints an ar_ requestId when the client omits one");
});

test("access-request: client requestId still works as the idempotency key (doc: retry-safe)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Docs drift idempotent");
  const payload = {
    requestId: "docs-drift-req-1",
    roomId: "commons",
    identityId: agent.identityId,
    displayName: "Docs drift idempotent",
    requestedPermissions: [],
  };
  const first = await post(origin, "/api/access-requests", payload);
  assert.equal(first.status, 201);
  const second = await post(origin, "/api/access-requests", payload);
  assert.equal(second.status, 201, "same requestId retries return the original request");
  assert.equal((await second.json()).requestId, "docs-drift-req-1");
});

test("identity rotate: bare POST is rejected, {confirm:true} rotates (doc: confirm-gated)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Docs drift rotator");
  const path = `/api/agent-identities/${agent.identityId}/rotate`;
  assert.equal(await errorCode(await post(origin, path, {}, agent.secret)), "confirm_required");
  const res = await post(origin, path, { confirm: true }, agent.secret);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).secret, "rotation returns the new secret once");
});

test("identity revoke: bare POST is rejected, {confirm:true} revokes (doc: confirm-gated)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Docs drift revokee");
  const path = `/api/agent-identities/${agent.identityId}/revoke`;
  assert.equal(await errorCode(await post(origin, path, {}, agent.secret)), "confirm_required");
  const res = await post(origin, path, { confirm: true }, agent.secret);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revoked, true);
});

test("docs state the confirmed contracts (doc-text guard)", () => {
  const plugIn = readFileSync(join(ROOT, "docs", "SWARM-PLUG-IN.md"), "utf8");
  assert.ok(!/omitting `requestId` is rejected with 422/.test(plugIn),
    "SWARM-PLUG-IN.md must not claim an omitted requestId 422s");
  assert.ok(/requestId.*optional/i.test(plugIn),
    "SWARM-PLUG-IN.md must say the access-request requestId is optional");

  const lifecycle = readFileSync(join(ROOT, "docs", "IDENTITY-LIFECYCLE.md"), "utf8");
  const near = (text, word, term) => {
    const idx = text.indexOf(term);
    assert.ok(idx >= 0, `IDENTITY-LIFECYCLE.md mentions ${term}`);
    const window = text.slice(Math.max(0, idx - 400), idx + 400);
    assert.ok(window.includes(word), `IDENTITY-LIFECYCLE.md mentions "${word}" near "${term}"`);
  };
  near(lifecycle, "confirm", "rotate");
  near(lifecycle, "confirm", "revoke");
  assert.ok(/confirm_required/.test(lifecycle),
    "IDENTITY-LIFECYCLE.md must name the 422 confirm_required rejection");
});
