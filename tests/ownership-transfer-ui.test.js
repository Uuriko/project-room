// 8375: the ownership.transferred event and its agent route existed, but a
// human owner had no control that issues one - account deletion even told
// people to "Transfer ownership before deleting" with no way to do it. The
// settings dialog now carries an owner-only transfer panel that sends the
// event through the browser command path (same as archive/leave).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const html = read("../index.html");
const app = read("../src/app.js");
const grouping = read("../src/account-settings-ui.js");

test("settings dialog carries an owner-only transfer panel", () => {
  assert.match(html, /<details id="room-transfer"[^>]*hidden>/);
  assert.match(html, /<select id="room-transfer-member" required><\/select>/);
  assert.match(html, /<input id="room-transfer-reason"[^>]*maxlength="280"/);
  assert.ok(html.indexOf('id="room-transfer"') < html.indexOf('id="results-panel"'), "sits in the Room group before Results");
  assert.ok(grouping.includes('"room-transfer"'), "organizeRoomSettings groups the panel under Room");
});

test("the panel is owner-gated in sync and issues ownership.transferred via client.send", () => {
  const sync = /const transfer = \$\("#room-transfer"\);\n  transfer\.hidden = !viewer \|\| archived \|\| !owner;/;
  assert.match(app, sync);
  assert.match(app, /client\.send\(\{ id: crypto\.randomUUID\(\), type: T\.OWNERSHIP_TRANSFERRED,/);
  assert.match(app, /window\.confirm\(`Transfer ownership of this room to \$\{name\}\?/);
  assert.match(app, /filter\(m => m\.id !== room\.ownerId && m\.active !== false\)/, "the owner and inactive members are never transfer targets");
  assert.match(app, /reason\.length|maxlength/, "reason stays inside the 280-char event bound");
});
