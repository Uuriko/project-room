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
  assert.match(html, /--ink:#0B120F/);
  assert.match(html, /href="\/contact"/);
  assert.match(html, /Paste your room key/);
  assert.match(html, /chat packet/);
  assert.match(html, /href="\/room\/llms.txt"/);
  assert.match(html, /github.com\/Uuriko\/project-room/);
  assert.ok(!html.includes("untrusted"));
  assert.ok(!html.includes("<script"));
  assert.doesNotMatch(html, /dasha\.fun|iframe|walletconnect/i);
});

test("/project-room is the same noindex landing", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/project-room"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await response.text(), /Open Project Room/);
});

test("entry handler leaves other Demigod pages and hosts to existing routing", () => {
  for (const path of ["/", "/hardware", "/weekly", "/ticket", "/room/api", "/contact"]) {
    assert.equal(roomEntry(new Request(`https://www.trydemigod.com${path}`)), null);
  }
  assert.equal(roomEntry(new Request("https://example.com/room")), null);
  assert.notEqual(roomEntry(new Request("https://www.trydemigod.com/room/llms.txt")), null);
});

test("entry supports HEAD and rejects mutations", async () => {
  assert.equal(await roomEntry(new Request("https://www.trydemigod.com/room/", { method: "HEAD" })).text(), "");
  const response = roomEntry(new Request("https://www.trydemigod.com/room", { method: "POST" }));
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET, HEAD");
});
