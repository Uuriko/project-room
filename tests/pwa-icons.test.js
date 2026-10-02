// Committed PWA icons. Dimensions come from the PNG header. The manifest
// entries that point at them wait until SEC-1's content-type fix has merged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { declarativePushPayload } from "../server/human-push.mjs";

function pngSize(name) {
  const bytes = readFileSync(new URL(`../icons/${name}`, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("PWA icons are PNGs at the installable sizes", () => {
  assert.deepEqual(pngSize("icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("maskable-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngSize("apple-touch-icon-180.png"), { width: 180, height: 180 });
});

test("a declarative push stays under 4KB and is omitted when the flag is off", () => {
  const base = { v: 1, roomId: "commons", unread: 2, counts: { mention: 1, dm: 1 }, sequence: 9, needsMeCount: 2 };
  const off = declarativePushPayload(base, { enabled: false });
  assert.equal(off.web_push, undefined);
  const on = declarativePushPayload(base, { enabled: true });
  assert.equal(on.web_push, 8030);
  assert.equal(on.notification.title.length > 0, true);
  assert.equal(on.notification.body.length > 0, true);
  assert.equal(on.notification.navigate_url, "/?room=commons");
  assert.equal(on.notification.tag, "room:commons");
  assert.equal(on.notification.app_badge, 2);
  assert.equal(on.counts.mention, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(on)) < 4096);
  const huge = declarativePushPayload({ ...base, pad: "x".repeat(5000) }, { enabled: true });
  assert.equal(huge.web_push, undefined);
});
