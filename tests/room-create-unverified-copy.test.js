// User test 2026-10-19 (John's Tab 15478/15491, Instinct-3 15481 #1/#3): an
// unverified account creating a second room got 403 email_unverified and the
// form said "Couldn't create the room. Try again." The copy must name the real
// gate, and the form must open Sign-in & security (where the code box is).
// 409 pilot_limit had the same bare "Try again" (research r79).
// app.js cannot be imported under node, so the pure copy function is extracted
// verbatim (precedent: tests/acquisition-template-failure.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(join(ROOT, "src/app.js"), "utf8");
const catalog = JSON.parse(readFileSync(join(ROOT, "strings/en.json"), "utf8"));

function extractFunction(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === "\\") { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function load() {
  const body = extractFunction(app, "accountRoomCreateFailure");
  assert.ok(body, "app.js declares accountRoomCreateFailure");
  const uiText = key => catalog[key] ?? key;
  return new Function("uiText", `${body}; return accountRoomCreateFailure;`)(uiText);
}

test("email_unverified names verification, not a retry", () => {
  const copy = load()({ status: 403, code: "email_unverified" });
  assert.match(copy, /verify your email/i);
  assert.doesNotMatch(copy, /try again/i);
});

test("pilot_limit says capacity is full, not a bare retry", () => {
  const copy = load()({ status: 409, code: "pilot_limit" });
  assert.match(copy, /capacity is full/i);
  assert.doesNotMatch(copy, /Couldn’t create the room/);
});

test("other refusals keep their existing copy", () => {
  const f = load();
  assert.match(f({ status: 403, code: "room_creation_denied" }), /membership administration/);
  assert.match(f({ status: 429 }), /Too many rooms/);
  assert.match(f({ status: 422 }), /Check the room name/);
  assert.match(f({ status: 500 }), /Couldn’t create the room/);
});

test("the create form opens Sign-in & security on email_unverified", () => {
  const start = app.indexOf('$("#account-room-form").addEventListener("submit"');
  assert.ok(start > -1);
  const handler = app.slice(start, app.indexOf("\n});", start));
  assert.match(handler, /accountRoomCreateFailure\(error\)/);
  assert.match(handler, /email_unverified"\)\s*openAccountSettings\(\)/);
});
