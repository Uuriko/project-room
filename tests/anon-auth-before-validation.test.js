// SEC-03 ratchet: anonymous callers on authenticated routes must not get
// 405/422/400/415 (validation or method checks) before the 401 auth check.
// The KNOWN map pins today's exceptions (all routes are already public in
// docs/openapi.yaml, so each one reveals only route existence, P4).
// The test fails when a NEW route or method leaks, and when a KNOWN entry
// stops leaking, so the list only shrinks.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const KNOWN = JSON.parse(readFileSync(new URL("./fixtures/anon-auth-before-validation.json", import.meta.url), "utf8"));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const PRE_AUTH = new Set([400, 405, 415, 422]);

test("anonymous callers get 401 before method or validation errors on authenticated routes", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-anon-order-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  const spec = YAML.parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
  const found = {};
  for (const template of Object.keys(spec.paths)) {
    const path = template.replace("{roomId}", "commons").replace(/\{[^}]+\}/g, "x1");
    const status = {};
    for (const method of METHODS) {
      const hasBody = method !== "GET" && method !== "DELETE";
      const response = await fetch(origin + path, {
        method,
        headers: hasBody ? { "Content-Type": "application/json" } : {},
        body: hasBody ? "{}" : undefined,
        signal: AbortSignal.timeout(5000)
      });
      await response.arrayBuffer();
      status[method] = response.status;
    }
    if (!Object.values(status).includes(401)) continue;
    const leaking = METHODS.filter(method => PRE_AUTH.has(status[method]));
    if (leaking.length) found[template] = leaking;
  }

  const added = [];
  const fixed = [];
  for (const [path, methods] of Object.entries(found)) {
    for (const method of methods) if (!(KNOWN[path] || []).includes(method)) added.push(`${method} ${path}`);
  }
  for (const [path, methods] of Object.entries(KNOWN)) {
    for (const method of methods) if (!(found[path] || []).includes(method)) fixed.push(`${method} ${path}`);
  }
  assert.deepEqual(added, [], `new pre-auth 4xx for anonymous callers; run auth first:\n${added.join("\n")}`);
  assert.deepEqual(fixed, [], `these no longer leak; remove them from tests/fixtures/anon-auth-before-validation.json:\n${fixed.join("\n")}`);
});
