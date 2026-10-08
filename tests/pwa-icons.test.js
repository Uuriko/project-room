// Committed PWA icons. Dimensions come from the PNG header. The manifest
// entries that point at them were gated on SEC-1's content-type fix (merged
// 2026-09-26, PR #1105); the hold is lifted and the manifest contract below
// pins the wiring.
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

test("manifest installability contract: PNG icons wired, theme-color matches the page", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const pageTheme = html.match(/<meta name="theme-color" content="([^"]+)"/)?.[1];
  assert.ok(pageTheme, "index.html must declare a theme-color meta");
  assert.equal(manifest.theme_color, pageTheme, "manifest theme_color must match the page");
  assert.equal(manifest.background_color, "#202127", "manifest background must match the app --bg");
  const pngIcons = manifest.icons.filter(icon => icon.type === "image/png");
  assert.ok(pngIcons.some(icon => icon.sizes === "192x192"), "manifest needs a 192px PNG icon");
  assert.ok(pngIcons.some(icon => icon.sizes === "512x512"), "manifest needs a 512px PNG icon");
  assert.ok(pngIcons.some(icon => icon.purpose === "maskable"), "manifest needs a maskable icon");
  for (const icon of pngIcons) {
    // Each manifest entry must point at a committed file at the declared size.
    const size = pngSize(icon.src.replace(/^\//, "").replace(/^icons\//, ""));
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.equal(size.width, width, icon.src);
    assert.equal(size.height, height, icon.src);
  }
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

test("#1606: service worker is registered at app startup (not only on push opt-in)", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(
    app,
    /navigator\.serviceWorker\.register\("\/push-sw\.js",\s*\{\s*scope:\s*"\/"/,
    "src/app.js registers /push-sw.js at startup with scope /"
  );
});
