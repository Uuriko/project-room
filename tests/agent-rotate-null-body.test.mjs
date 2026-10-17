// R316: Fo v4 (R305-1/R306) reads data.requestId before ownerAuth. Prove a
// null / array / scalar JSON body never reaches that read (body() rejects
// non-objects with 400 invalid_json), so the route answers 4xx, never 500,
// for the owner, and that an unauthenticated caller still gets 401 first
// (the v4 comment: "an unauthenticated caller still sees 401").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-rotate-null-body-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, text, token) => fetch(origin + path, { method: "POST", body: text,
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { raw };
}

for (const text of ["null", "[]", "\"x\"", "7", "true"]) {
  test(`rotate with JSON body ${text} answers 400 invalid_json, never 500; no credential -> 401`, async t => {
    const { raw } = await serve(t);
    const minted = await raw("/api/agent-identities", JSON.stringify({ displayName: "Null Body Probe" }));
    assert.equal(minted.status, 201);
    const { identityId, secret } = await minted.json();
    for (const token of [secret, undefined, "pri_not_a_real_secret"]) {
      const res = await raw(`/api/agent-identities/${identityId}/rotate`, text, token);
      const out = await res.json().catch(() => ({}));
      assert.notEqual(res.status, 500, `500 for body ${text}`);
      // owner: shape refusal; no/bogus credential: 401 before any body guidance (v4 comment's own contract)
      assert.equal(res.status, token === secret ? 400 : 401, `body ${text} token ${token === secret ? "owner" : token ? "bogus" : "none"}`);
      if (token === secret) assert.equal(out.code ?? out.error?.code ?? out.error, "invalid_json");
      t.diagnostic(`body=${text} token=${token === secret ? "owner" : token ? "bogus" : "none"} -> ${res.status} ${JSON.stringify(out).slice(0, 120)}`);
    }
    // the identity is unchanged: the owner secret still rotates
    const ok = await raw(`/api/agent-identities/${identityId}/rotate`, JSON.stringify({ confirm: true }), secret);
    assert.equal(ok.status, 200);
  });
}
