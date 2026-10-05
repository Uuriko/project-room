import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// #1529 LOW batch: wrong-method liveness is 405 (not 404), llms.txt names the
// work-claims REST contract, headless agents (no Origin, no Sec-Fetch-Site,
// no cookie) are not refused for a missing Origin, and MCP initialize says
// when it substitutes the protocol version.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-low-batch-1529-"));
  const clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Unlike most suites, Origin is OMITTED by default: these tests prove
  // bearer agent clients are not browsers. Pass origin: true to model a
  // browser request.
  const request = (path, { method = "GET", data, token, origin: withOrigin = false, headers = {} } = {}) => fetch(origin + path, {
    method, headers: {
      // true = the server's own origin (browser on the app); a string =
      // a literal Origin header (browser on another allowed host).
      ...(withOrigin === true ? { Origin: origin } : typeof withOrigin === "string" ? { Origin: withOrigin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey };
}

test("#1529 POST /api/health and /api/version are 405 with Allow, GET still 200", async t => {
  const { request } = await serve(t);
  for (const path of ["/api/health", "/api/version"]) {
    const wrong = await request(path, { method: "POST", data: {} });
    assert.equal(wrong.status, 405, path);
    assert.equal(wrong.headers.get("allow"), "GET, HEAD", path);
    assert.equal((await wrong.json()).error.code, "method_not_allowed");
    assert.equal((await request(path)).status, 200, path);
  }
});

test("#1529 share-link preview: a bearer agent with no Origin passes the gate; no credential or a foreign Origin does not", async t => {
  const { request, store } = await serve(t);
  const identity = store.identities.create("Preview agent");
  const headless = await request("/api/share-links/preview", { method: "POST", data: { linkToken: "not-a-real-link" }, token: identity.secret });
  assert.notEqual(headless.status, 403, "bearer agent without Origin is not origin_denied");
  const anonymous = await request("/api/share-links/preview", { method: "POST", data: { linkToken: "not-a-real-link" } });
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).error.code, "origin_denied");
  const foreign = await request("/api/share-links/preview", { method: "POST", data: { linkToken: "not-a-real-link" }, token: identity.secret, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
});

async function initialize(request, protocolVersion, token) {
  const response = await request("/mcp", { method: "POST", token, headers: { Accept: "application/json, text/event-stream" }, data: {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } } } });
  const text = await response.text();
  const line = text.startsWith("{") ? text : text.split("\n").filter(l => l.startsWith("data:")).pop().slice(5);
  return JSON.parse(line).result;
}

test("#1529 MCP initialize states a protocol-version substitution in _meta, and is quiet when it matches", async t => {
  const { request, store } = await serve(t);
  const identity = store.identities.create("Init agent");
  for (const token of [undefined, identity.secret]) {
    const swapped = await initialize(request, "1999-01-01", token);
    assert.notEqual(swapped.protocolVersion, "1999-01-01");
    const note = swapped._meta?.protocolVersionSubstituted;
    assert.ok(note, `substitution note (token: ${Boolean(token)})`);
    assert.equal(note.requested, "1999-01-01");
    assert.equal(note.negotiated, swapped.protocolVersion);
    assert.ok(note.supported.includes(swapped.protocolVersion));
    const exact = await initialize(request, swapped.protocolVersion, token);
    assert.equal(exact.protocolVersion, swapped.protocolVersion);
    assert.equal(exact._meta?.protocolVersionSubstituted, undefined);
  }
});
