// WAVE-2000 GUILD-02 (API fuzzing, server/http.mjs).
// Fail-first regression tests for FUZZ-001: POST /oauth/revoke 500s when the
// `token` field is missing or not a non-empty string (server/http.mjs ~L1591
// calls oauthProvider.revoke(data.token) unwrapped; the provider's check()
// throws OAuthProviderError, which the http error boundary maps to 500
// `invalid_request`/`internal` instead of a 400).
// Boots a real server against the acceptance fixture over loopback.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t) {
  const f = await createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, body, contentType = "application/json") =>
  fetch(origin + "/oauth/revoke", {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body,
  });

// FUZZ-001: missing token must be a 400, never a 500.
test("POST /oauth/revoke with missing token returns 400, not 500", async t => {
  const origin = await startServer(t);
  const r = await post(origin, "{}");
  assert.equal(r.status, 400, `expected 400 for missing token, got ${r.status}`);
});

// FUZZ-001: wrong-typed token must be a 400, never a 500.
test("POST /oauth/revoke with non-string token returns 400, not 500", async t => {
  const origin = await startServer(t);
  for (const body of ['{"token":42}', '{"token":null}', '{"token":""}', '{"token":["x"]}', '{"token":{"t":"x"}}']) {
    const r = await post(origin, body);
    assert.equal(r.status, 400, `expected 400 for body ${body}, got ${r.status}`);
  }
});

// Already-correct behavior, locked in: RFC 7009 leniency — an unknown but
// well-formed token still answers 200.
test("POST /oauth/revoke with unknown string token returns 200", async t => {
  const origin = await startServer(t);
  const r = await post(origin, JSON.stringify({ token: "nope-not-a-real-token" }));
  assert.equal(r.status, 200);
});

// Already-correct behavior, locked in: non-JSON content type is refused.
test("POST /oauth/revoke without JSON content type returns 415", async t => {
  const origin = await startServer(t);
  const r = await post(origin, '{"token":"x"}', "text/plain");
  assert.equal(r.status, 415);
});
