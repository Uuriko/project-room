import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("archived rooms replace the composer with a short archived line", () => {
  assert.match(html, /<p id="archived-composer-note"[^>]*hidden>This room is archived\.<\/p>/);
  assert.ok(html.indexOf('id="archived-composer-note"') < html.indexOf('id="message-form"'));
  assert.match(app, /\$\("#message-form"\)\.hidden = archived; \$\("#archived-composer-note"\)\.hidden = !archived;/);
  const sync = app.indexOf('$("#message-form").hidden = archived');
  const archivedDef = app.lastIndexOf("const archived = Boolean(state) && isRoomArchived(state);", sync);
  assert.ok(archivedDef !== -1 && sync - archivedDef < 400, "the toggle uses the composer's archived flag");
  assert.match(css, /#message-form\[hidden\] \{ display: none; \}/);
});
