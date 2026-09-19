// QAU-006 (RC-2026-09-19-085): GET /api/session 401 surfaced as a console
// error on signed-out first paint. The browser session hints are the only
// client-side signal that a session could exist, so the first-paint probe
// only fires when hasSessionHint() is true; a hint-less first paint renders
// the signed-out state without issuing the doomed request.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LAST_ROOM_KEY, HAD_ACCOUNT_KEY, hasSessionHint } from "../src/browser-session.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function memoryStore(start = {}) {
  const data = { ...start };
  return {
    getItem(key) { return Object.hasOwn(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

test("hasSessionHint is false on a hint-less signed-out first paint", () => {
  assert.equal(hasSessionHint(memoryStore()), false);
});

test("hasSessionHint is true with a remembered room", () => {
  assert.equal(hasSessionHint(memoryStore({ [LAST_ROOM_KEY]: "commons" })), true);
});

test("hasSessionHint is true with an account hint", () => {
  assert.equal(hasSessionHint(memoryStore({ [HAD_ACCOUNT_KEY]: "1" })), true);
});

test("hasSessionHint ignores invalid leftovers", () => {
  assert.equal(hasSessionHint(memoryStore({ [LAST_ROOM_KEY]: "not a room id" })), false);
});

test("first-paint boot gates the session probe on hasSessionHint()", () => {
  const app = readFileSync(join(ROOT, "src/app.js"), "utf8");
  assert.match(
    app,
    /import \{[^}]*\bhasSessionHint\b[^}]*\} from "\.\/browser-session\.js"/,
    "app.js imports the probe gate"
  );
  const gate = app.indexOf("if (hasSessionHint()) {");
  assert.ok(gate !== -1, "the boot fallthrough consults hasSessionHint()");
  const probe = app.indexOf("await client.restore();", gate);
  assert.ok(probe > gate, "the first-paint GET /api/session probe sits inside the hint gate");
});
