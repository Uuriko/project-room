// Review 17231 on #4388: an unauthenticated dynamic client could register as
// "ChatGPT" with its own callback, and registration had no per-address limit.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  return "http://127.0.0.1:" + server.address().port;
}

const register = (origin, client_name, redirect_uris) => fetch(origin + "/oauth/register", {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ client_name, redirect_uris }),
});

test("a dynamic client cannot register as ChatGPT with a foreign callback", async t => {
  const origin = await serve(t);
  const spoof = await register(origin, "ChatGPT", ["https://evil.example/cb"]);
  assert.equal(spoof.status, 400);
  assert.equal((await spoof.json()).error, "invalid_client_metadata");
  const real = await register(origin, "ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  assert.equal(real.status, 201);
});

test("registration is rate limited per address", async t => {
  const origin = await serve(t);
  let created = 0;
  for (let i = 0; i < 30; i++) if ((await register(origin, "Notes app " + i, ["https://notes.example/cb"])).status === 201) created++;
  assert.ok(created > 0 && created < 30, `created ${created} of 30`);
});
