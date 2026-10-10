// A failed New-room submit must be visible: the first missing field is named,
// the validation sees whitespace-only values that native `required` lets
// through, and the silent early return in the submit handler is gone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import catalog from "../strings/en.js";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const handler = app.slice(app.indexOf('$("#account-room-form").addEventListener("submit"'),
  app.indexOf('$("#choose-room").addEventListener("click"'));

test("every required field has a catalog message and a form selector, in form order", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("const ROOM_FORM_FIELDS"), app.indexOf("const missingRoomFormFields"));
  const rows = [...block.matchAll(/key: "(\w+)", selector: "#([\w-]+)", message: "([\w.]+)"/g)];
  assert.deepEqual(rows.map(row => row[1]), ["title", "purpose", "displayName"]);
  for (const [, , id, message] of rows) {
    assert.ok(Object.hasOwn(catalog, message), message);
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(app, /values\[field\.key\]\.trim\(\) === ""/, "whitespace-only counts as missing");
});

test("submit handler marks the field invalid, focuses it and names it", () => {
  assert.match(handler, /setAttribute\("aria-invalid", "true"\)/);
  assert.match(handler, /\$\(missing\[0\]\.selector\)\.focus\(\)/);
  assert.match(handler, /uiText\(missing\[0\]\.message\)/);
});

test("the unauthenticated / committing / signing-out early return now says why", () => {
  assert.doesNotMatch(handler, /if \(!owned\?\.authenticated \|\| form\.dataset\.busy === "true"[^\n]*\) return;/);
  assert.match(handler, /uiText\("room\.create\.loading"\)/);
});

test("the status line is an alert and the denied copy states the real rule", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="account-room-status" class="status form-status" role="alert"/);
  assert.doesNotMatch(catalog["room.create.denied"], /first room is free/);
  assert.match(catalog["room.create.denied"], /membership administration/);
});
