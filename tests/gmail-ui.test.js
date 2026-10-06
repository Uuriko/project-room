// Gmail UI pure helpers (src/gmail-ui.js): error-code -> user message mapping
// and email-address extraction. Pure extraction of the closures inside
// installGmailWorkspace; the module's install path arms a 60s setInterval
// and needs a full browser DOM, so these are the importable surface.
import test from "node:test";
import assert from "node:assert/strict";
import { extractEmailAddresses, gmailErrorText } from "../src/gmail-ui.js";

test("extractEmailAddresses pulls every address from reply headers", () => {
  assert.deepEqual(
    extractEmailAddresses("Ada Lovelace <ada@example.com>, bob@EXAMPLE.com"),
    ["ada@example.com", "bob@EXAMPLE.com"],
  );
});

test("extractEmailAddresses returns [] when nothing matches", () => {
  assert.deepEqual(extractEmailAddresses("no addresses here"), []);
  assert.deepEqual(extractEmailAddresses(""), []);
});

test("gmailErrorText: reconnect-required codes map to the recovery message", () => {
  const message = "Reconnect Gmail from All messages to allow sending and organizing email.";
  assert.equal(gmailErrorText({ code: "gmail_reconnect_required" }), message);
  assert.equal(gmailErrorText({ code: "gmail_write_permission_required" }), message);
});

test("gmailErrorText: a changed draft gets its own message", () => {
  assert.equal(
    gmailErrorText({ code: "gmail_draft_changed" }),
    "This draft changed in Gmail. Close and reopen it before editing.",
  );
});

test("gmailErrorText: unknown codes fall back to the server message, then generic", () => {
  assert.equal(gmailErrorText({ code: "rate_limited", message: "Slow down." }), "Slow down.");
  assert.equal(gmailErrorText({ code: "mystery_code" }), "Gmail could not complete this request.");
  assert.equal(gmailErrorText({}), "Gmail could not complete this request.");
});
