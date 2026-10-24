// Failing-first evidence for the three #4445 lookalike residuals recorded at
// muse-room 17149/17165: Cherokee U+13DF, Latin small-cap U+0262 and a
// combining acute (U+0301) on a provisioned connector name all still register
// (201). Each case below is expected to refuse with invalid_client_metadata
// once the confusable fold is extended. Accented fresh names must keep
// registering (guarded in agent-door-auth-scope-cure.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const PROVISIONED = Object.freeze({
  clientId: "chatgpt", name: "ChatGPT", redirectUris: ["https://chatgpt.com/oauth/callback"],
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-lookalike-residuals-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store, connectorClients: [PROVISIONED] });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const register = async (origin, name) => {
  const response = await fetch(origin + "/oauth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: ["https://evil.example/cb"] }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

for (const [label, name] of [
  ["Cherokee letter TLI U+13DF for C", "\u13DFhatGPT"],
  ["Latin small capital G U+0262", "Chat\u0262PT"],
  ["combining acute U+0301 on a", "Cha\u0301tGPT"],
]) {
  test(`registration door refuses residual lookalike: ${label}`, async t => {
    const origin = await serve(t);
    const res = await register(origin, name);
    assert.equal(res.status, 400, `${label} must be refused, got ${res.status}`);
    assert.equal(res.body?.error, "invalid_client_metadata", label);
  });
}
