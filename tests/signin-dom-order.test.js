import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
test("sign-in contains primary controls without passive legal copy, divider or room join", () => {
  const auth = html.slice(html.indexOf('id="auth-panel"'), html.indexOf('id="workspace-nav"'));
  assert.doesNotMatch(auth, /terms-notice|signin-divider|join-code-link|Join a room/);
  assert.ok(auth.indexOf('id="google-signin"') < auth.indexOf('id="signin-controller"'));
  assert.match(auth, /id="agent-signin-button"/);
});
test("signed-in rooms workspace retains a visible join link", () => {
  const rooms = html.slice(html.indexOf('id="account-rooms-panel"'), html.indexOf('id="account-room-create"'));
  assert.match(rooms, /<a class="button" href=".\/join">Join with an invitation<\/a>/);
});
