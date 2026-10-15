// Gmail UI pure helpers (src/gmail-ui.js): error-code -> user message mapping,
// email-address extraction, and the email-URL scheme block used by the HTML
// sanitizer. Pure extraction of the closures inside installGmailWorkspace;
// the module's install path arms a 60s setInterval and needs a full browser
// DOM, so these are the importable surface.
import test from "node:test";
import assert from "node:assert/strict";
import { extractEmailAddresses, gmailErrorText, isBlockedEmailUrl } from "../src/gmail-ui.js";

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

test("isBlockedEmailUrl blocks plain scriptable URLs", () => {
  assert.equal(isBlockedEmailUrl("javascript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("JaVaScRiPt:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="), true);
});

test("isBlockedEmailUrl sees through tab/newline/control characters in the scheme", () => {
  // href="java&#9;script:alert(1)" reaches the sanitizer with a literal tab
  // inside the scheme once the HTML parser decodes the entity. Browsers
  // strip tab/newline when parsing the URL, so the link would execute on
  // click; the old trim-only check let it through.
  assert.equal(isBlockedEmailUrl("java\tscript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("java\nscript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("java\r\nscript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("javascript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl(" javascript:alert(1)"), true);
  assert.equal(isBlockedEmailUrl("da\tta:text/html,<script>alert(1)</script>"), true);
});

test("isBlockedEmailUrl allows ordinary links and non-HTML data URLs", () => {
  assert.equal(isBlockedEmailUrl("https://example.com/path?q=1"), false);
  assert.equal(isBlockedEmailUrl("mailto:ada@example.com"), false);
  assert.equal(isBlockedEmailUrl("/relative/path"), false);
  assert.equal(isBlockedEmailUrl("data:image/png;base64,iVBORw0KGgo="), false);
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
