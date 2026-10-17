// Front-door batch (QA Wave A consolidation §3, B-1…B-10 + #3794/#3796).
// Acceptance evidence at the level each item allows without a browser:
// B-6 is a pure-projection unit test; B-4's tier copy renders the real
// receipts page; the rest assert the shipped source carries the fix the
// QA beats re-run against (browser checks exercise them end to end).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roomOrientation } from "../src/work-selectors.js";
import { renderReceiptDetailHtml } from "../server/receipts-page.mjs";
import { DARK } from "../src/design-tokens.js";

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("B-6: Overview recent decisions include owner decisions on work results (#3773)", () => {
  const state = {
    room: { purpose: "", charter: null },
    workItems: {},
    eventLog: [
      { id: "e1", type: "owner.decision_recorded", actorId: "owner", at: "2026-10-15T00:00:00.000Z",
        data: { decision: "approved", reason: "Looks good", sourceMessageId: "m1" } },
      { id: "e2", type: "decision.recorded", actorId: "owner", at: "2026-10-15T01:00:00.000Z",
        data: { statement: "Ship it", sourceMessageId: "m2" } },
    ],
  };
  const decisions = roomOrientation(state).recentDecisions;
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].statement, "Ship it");
  assert.match(decisions[1].statement, /^Approved: Looks good$/);
});

test("B-4: receipt page states a named verification tier, not the self-disclaimer", () => {
  const base = { id: "wcr_x", title: "T", at: "2026-10-15T00:00:00.000Z", agents: [], humans: [], startHref: "/" };
  const merged = renderReceiptDetailHtml({ ...base, mergedAt: "2026-10-15T00:00:00.000Z", pullRequest: "https://github.com/Uuriko/project-room/pull/1" });
  assert.match(merged, /Verification tier: bytes re-verified/);
  const selfAttested = renderReceiptDetailHtml({ ...base, verification: { state: "self_attested" } });
  assert.match(selfAttested, /Verification tier: bundle unaltered \(self-asserted\)/);
  const memberVerified = renderReceiptDetailHtml({ ...base, verification: { state: "verified" } });
  assert.match(memberVerified, /Verification tier: human verdict \(member-verified\)/);
  for (const html of [merged, selfAttested, memberVerified]) {
    assert.doesNotMatch(html, /This record is unsigned/);
    assert.doesNotMatch(html, /Hashes are stored values, not re-verified/);
  }
});

test("B-4: View receipt links the human page; JSON stays as the secondary link", () => {
  const owner = read("src/owner-project-offers-ui.js");
  assert.match(owner, /href="\/receipts\/\$\{encodeURIComponent\(id\)\}"[^>]*>View receipt<\/a>/);
  assert.match(owner, />Receipt JSON<\/a>/);
  const offers = read("src/project-offers-ui.js");
  assert.match(offers, /id="contribution-receipt" href="\/receipts\//);
  assert.match(offers, />Receipt JSON<\/a>/);
});

test("B-5: the toggle's name is the name the /receipts copy uses", () => {
  const index = read("index.html");
  assert.match(index, /id="public-receipts-toggle"[^>]*> Public receipts — publish receipts/);
  const page = read("server/receipts-page.mjs");
  assert.match(page, /Settings, then Permissions, and turn on “Public receipts”/);
});

test("B-8: one coarse-pointer token, applied via the token", () => {
  assert.equal(DARK["--control-min-target-coarse"], "2.75rem");
  assert.match(read("src/styles.css"), /min-height: var\(--control-min-target-coarse\)/);
  assert.match(read("server/receipts-page.mjs"), /@media\(pointer:coarse\)\{a\{display:inline-flex;align-items:center;min-height:var\(--control-min-target-coarse\)\}/);
  assert.match(read("src/project-offers.css"), /min-height: var\(--control-min-target-coarse\)/);
});

test("B-9: the matcher sits below the offers workspace, and the copy assumes no agent", () => {
  const offers = read("src/project-offers-ui.js");
  assert.match(offers, /\(\$\('\.workspace'\) \?\? \$\('\.intro'\)\)\.after\(matching\)/);
  assert.doesNotMatch(read("offers.html"), /work on with your agent/);
});

test("B-2: New work has a visible labeled address in the Tasks navigation", () => {
  assert.match(read("index.html"), /id="new-work-open" type="button">New work<\/button>/);
  assert.match(read("src/app.js"), /\$\("#new-work-open"\)\?\.addEventListener\("click", \(\) => openWork\(\)\)/);
});

test("B-1: invalid submits name their field; the password survives a mode switch", () => {
  const app = read("src/app.js");
  assert.match(app, /is required — complete it before saving\./);
  const auth = read("src/auth-signin-ui.js");
  assert.match(auth, /preservedPassword/);
  assert.match(auth, /passwordInput\.value = preservedPassword/);
});

test("B-7: OAuth doors start hidden and are revealed only on a positive configured answer", () => {
  const index = read("index.html");
  assert.match(index, /id="google-signin"[^>]* hidden>/);
  assert.match(index, /id="github-signin"[^>]* hidden>/);
  const nav = read("src/signin-navigation.js");
  assert.match(nav, /setProviderAvailable\(name\)/);
  assert.match(nav, /!availableProviders\.has\("google"\)/);
});

test("B-10: mailer-less signup copy states the signed-in truth", async () => {
  const catalog = JSON.parse(read("strings/en.json"));
  assert.match(catalog["signin.copy.027"], /^You’re signed in\. Email delivery isn’t configured/);
});

test("#3794: creating an invite link surfaces that link and its access level", () => {
  const links = read("src/share-links.js");
  assert.match(links, /growthUrl\.value = inviteUrl/);
  assert.match(links, /link ready — the link shown above is the one to share/);
});

test("#3796: the post-signup join step is named, with its completion action", () => {
  const links = read("src/share-links.js");
  assert.match(links, /Step 2 of 2: confirm the name people in this room will see, then choose/);
});
