// After a room is archived, no write route may record anything new. This
// walks every room-scoped write operation in docs/openapi.yaml against an
// archived room as its owner and fails on any 2xx outside the allowlist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Allowed on an archived room, with the reason:
const ALLOWED = new Map([
  ["post /api/rooms/{roomId}/guest-invites-list", "a read sent as POST"],
  ["post /api/rooms/{roomId}/guest-invites-revoke-all", "removing access stays possible after archive"],
  ["post /api/rooms/{roomId}/collab/envelopes/sweep", "idempotent expiry maintenance; records no new content"],
]);

const yaml = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
const operations = [...yaml.matchAll(/^  (\/api\/rooms\/\{[^}]+\}[^:]*):\n((?:    .*\n|\n)*)/gm)]
  .flatMap(m => [...m[2].matchAll(/^    (post|put|patch|delete):/gm)].map(x => [x[1], m[1]]));

async function archivedRoom() {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const call = (method, path, payload) => fetch(origin + path, { method,
    headers: { Authorization: "Bearer " + f.keys.owner, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload) });
  await call("POST", "/api/rooms/commons/work-claims", { id: "walk-claim", title: "before archive", files: ["a.js"] });
  const archived = await call("POST", "/api/rooms/commons/commands", { id: randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
  assert.equal(archived.status, 201);
  const close = async () => { server.closeStreams?.(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); };
  return { call, close };
}

test("every room write route refuses an archived room", { timeout: 120000 }, async () => {
  assert.ok(operations.length > 100, `found ${operations.length} write operations`);
  const accepted = [];
  // The shared write bucket allows 60 a minute per credential, so each batch
  // gets a fresh fixture.
  for (let i = 0; i < operations.length; i += 40) {
    const room = await archivedRoom();
    try {
      for (const [method, template] of operations.slice(i, i + 40)) {
        const key = `${method} ${template}`;
        if (ALLOWED.has(key)) continue;
        const path = template.replace(/\{[^}]+\}/, "commons").replace(/\{[^}]+\}/g, "walk-claim");
        const res = await room.call(method.toUpperCase(), path, { id: "w" + randomUUID().slice(0, 8), title: "late", body: "late",
          requestId: randomUUID(), state: "released", files: ["b.js"], suppressions: [], actionId: "a1" });
        await res.arrayBuffer();
        assert.notEqual(res.status, 429, `${key} hit the rate limit; shrink the batch`);
        if (res.status < 300) accepted.push(`${key} -> ${res.status}`);
      }
    } finally { await room.close(); }
  }
  assert.deepEqual(accepted, []);
});
