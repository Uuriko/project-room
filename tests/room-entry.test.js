import test from "node:test";
import assert from "node:assert/strict";
import { roomEntry } from "../deploy/room-entry.mjs";

test("unlisted entry opens the isolated Room without forwarding input or embedding credentials", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/room?return=untrusted"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /href="https:\/\/project-room-staging.getdasha.workers.dev"/);
  assert.ok(!html.includes("untrusted"));
  assert.ok(!html.includes("<script"));
});

test("entry handler leaves other Demigod pages and hosts to existing routing", () => {
  for (const path of ["/", "/hardware", "/weekly", "/ticket", "/room/api"]) assert.equal(roomEntry(new Request(`https://www.trydemigod.com${path}`)), null);
  assert.equal(roomEntry(new Request("https://example.com/room")), null);
});

test("entry supports HEAD and rejects mutations", async () => {
  assert.equal(await roomEntry(new Request("https://www.trydemigod.com/room/", { method: "HEAD" })).text(), "");
  const response = roomEntry(new Request("https://www.trydemigod.com/room", { method: "POST" }));
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET, HEAD");
});
