import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { validRoomDigest } from "../client/room-digest.mjs";

test("Workers SQLite serves the same bounded, authenticated digest contract", async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("./http-worker.test-fixture.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });
  const origin = "https://room.example.test";
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "HttpTestRoom", useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, token) => mf.dispatchFetch(origin + path, {
    headers: { Host: "room.example.test", "CF-Connecting-IP": "192.0.2.1", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  try {
    const provision = await call("/__test-provision");
    assert.equal(provision.status, 200);
    const { ownerKey } = await provision.json();
    assert.equal((await call("/api/rooms/commons/digest")).status, 401);
    const response = await call("/api/rooms/commons/digest?since=0", ownerKey);
    assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= 4096);
    const digest = JSON.parse(raw);
    assert.ok(validRoomDigest(digest, { roomId: "commons", memberId: "owner", since: 0 }));
    const quiet = await call(`/api/rooms/commons/digest?since=${digest.next}`, ownerKey);
    assert.equal(quiet.status, 200);
    assert.equal((await quiet.json()).coverage.eventsInWindow, 0);
  } finally { await mf.dispose(); }
});
