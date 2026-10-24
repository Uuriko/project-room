import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectionStatusState } from "../src/room-layout.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("signed-out and first-connect labels are not shown as faults", () => {
  assert.equal(connectionStatusState("Not connected · sign in required"), "signed-out");
  assert.equal(connectionStatusState("Not connected · account sign-in required"), "signed-out");
  for (const text of ["Connecting to room service…", "Opening Room…", "Not connected", "Not connected · invitation preview",
    "Not connected · open an invitation link to join", "Not connected · your invitation to “Demo” is still open in the address bar"]) {
    assert.equal(connectionStatusState(text), "pending", text);
  }
  assert.equal(connectionStatusState("Room service unavailable · not connected"), "other");
  assert.equal(connectionStatusState("Connection interrupted · reconnecting; displayed history may be stale"), "other");
  assert.equal(connectionStatusState("anything", true), "connected");
});

test("pending is hidden on the sign-in wall and invitations, and delayed elsewhere", () => {
  const css = read("src/styles.css"), html = read("index.html");
  assert.match(css, /#auth-panel:not\(\[hidden\]\)\) \.connection-bar:has\(\[data-state="pending"\]\)/);
  assert.match(css, /#join-link-dialog\[open\]\) \.connection-bar:has\(\[data-state="pending"\]\)/);
  assert.match(css, /animation: connection-pending-reveal 0s linear 1\.5s both/);
  assert.match(html, /id="connection-status"[^>]*data-state="pending"/);
});

test("the room cookie still wins over an account session for its own room", () => {
  const app = read("src/app.js");
  assert.doesNotMatch(app, /probeRoomCookie/);
  assert.match(app, /if \(requestedRoom && !accountHomeFromLocation\(\)\) \{\n      try \{\n        const joined = await client\.restore\(\);/);
});

test("a too-short new password names the rule on reset too", () => {
  const ui = read("src/auth-signin-ui.js");
  assert.match(ui, /field\?\.type === "password" && \(field\.minLength > 0/);
});
