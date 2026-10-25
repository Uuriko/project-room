// FIX12-7: the first HTML document is the sign-in wall. Workspace panes,
// dialogs and inactive tabs load with the room, from src/workspace-shell.html.
// This counts the document the server serves for GET /, which is index.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const landing = readFileSync(new URL("../index.html", import.meta.url));
const html = landing.toString("utf8");
const shell = readFileSync(new URL("../src/workspace-shell.html", import.meta.url), "utf8");

test("the landing document does not include the hidden workspace", () => {
  const hidden = html.match(/\shidden\b/g)?.length ?? 0;
  const buttons = html.match(/<button\b/g)?.length ?? 0;
  assert.ok(landing.byteLength < 16_000, `landing HTML is ${landing.byteLength} bytes`);
  assert.ok(hidden <= 24, `landing HTML has ${hidden} hidden markers`);
  assert.ok(buttons <= 16, `landing HTML has ${buttons} buttons`);
  assert.match(html, /id="auth-panel"/);
  assert.match(html, /id="workspace-slot"/);
  assert.doesNotMatch(html, /id="main"/);
  assert.doesNotMatch(html, /id="settings-dialog"/);
});

test("the workspace shell still carries the room document", () => {
  assert.match(shell, /id="main"[^>]*hidden/);
  assert.match(shell, /id="settings-dialog"/);
  assert.match(shell, /id="workspace-nav"[^>]*hidden/);
  assert.ok((shell.match(/<button\b/g) || []).length > 100, "the room controls moved with the shell");
});
