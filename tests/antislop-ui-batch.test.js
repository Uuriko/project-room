// antislop batch (2026-10-09): small UI states from John's Tab's audit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rewardLine } from "../src/share-links.js";

test("the invite reward line stays hidden until it means something (antislop #4)", () => {
  assert.equal(rewardLine({ tier: "Member", activeCount: 0, credits: 0, next: { remaining: 1, name: "Host" } }), "");
  assert.match(rewardLine({ tier: "Member", activeCount: 1, credits: 0 }), /^Member · 1 active · 0 room credits$/);
  assert.match(rewardLine({ tier: "Member", activeCount: 0, credits: 0, welcomeCredit: 1 }), /1 room credit\b/);
  assert.equal(rewardLine(null), "");
});

test("the inbox empty state names Connect Gmail only while that button can show (antislop #11)", () => {
  const source = readFileSync(new URL("../src/inbox-ui.js", import.meta.url), "utf8");
  assert.match(source, /gmailUnavailable \? INBOX_EMPTY_PLAIN : INBOX_EMPTY_GMAIL/);
  assert.match(source, /gmailUnavailable = unavailable;/);
});

test("sign-in form text links are 44 px tap targets; Advanced on Add agent shows a marker", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /#auth-signin-ui \.text-button, #agent-auth-step \.text-button \{ min-height: 44px; font-size: var\(--text-sm\); \}/);
  assert.match(css, /#agent-connect-advanced > summary \{ cursor: pointer; list-style: disclosure-closed; \}/);
});
