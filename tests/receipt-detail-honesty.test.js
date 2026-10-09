// tests/receipt-detail-honesty.test.js — receipt honesty: the public receipt
// detail page must say precisely what a receipt proves, no more.
//
// A stranger reading /receipts/<id> sees "Agents", "Humans", "Merged" and
// "Hash evidence". What those actually prove:
//   - "Merged" is server-verified: the server's own poll wrote pr_merged +
//     syncedAt (server/public-read-model.mjs serverVerifiedMerge); a
//     member-supplied outcome "merged" never qualifies. The page may say the
//     merge was verified — but only when one is shown.
//   - Names are room data: work-claim receipts use member displayNames;
//     public-work receipts use a self-supplied agentName. None is
//     identity-verified, so the page must not let a reader assume it.
//   - Hashes are stored sha256: values, never re-verified at read time.
//   - The JSON envelope is unsigned (docs/RECEIPTS-PAGE.md).
//
// Behavior protected: renderReceiptDetailHtml emits an explicit
// "what this proves" note with the exact qualifiers for the receipt's
// source. A later edit that drops the note, claims a verified merge on a
// public-work receipt, or re-words the qualifiers into an overpromise
// fails the assertions below.
//
// Production seam: the real renderer, real receipt shapes, no mocks.
//
// Run: node --test tests/receipt-detail-honesty.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";

import { renderReceiptDetailHtml } from "../server/receipts-page.mjs";

const mergedReceipt = {
  schema: "project-room-public-receipt/1",
  id: "wcr_room_claim1",
  title: "Fix the needs-attention card overflow",
  source: "work-claim",
  room: { id: "commons", title: "Commons" },
  agents: ["agent-alice"],
  humans: ["Bob"],
  pullRequest: "https://github.com/Uuriko/project-room/pull/2099",
  mergedAt: "2026-10-07T18:00:00.000Z",
  hashes: ["sha256:" + "ab".repeat(32)],
  at: "2026-10-07T18:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room",
};

const publicWorkReceipt = {
  schema: "project-room-public-receipt/1",
  id: "pwr_room_offer1",
  title: "Public work: write a teardown",
  source: "public-work",
  room: { id: "commons", title: "Commons" },
  agents: ["self-reported-name"],
  humans: [],
  pullRequest: null,
  mergedAt: null,
  hashes: ["sha256:" + "cd".repeat(32)],
  at: "2026-10-07T18:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room",
};

test("merged receipt says the merge was verified but names and hashes are not", () => {
  const html = renderReceiptDetailHtml(mergedReceipt);
  assert.match(html, /verified the merge against the linked pull request/,
    "a server-verified merge may be stated, because serverVerifiedMerge settled it");
  assert.match(html, /not identity-verified/,
    "names are room data, not attested identities");
  assert.match(html, /not re-verified/,
    "hashes are stored values, never re-checked at read time");
  assert.match(html, /unsigned/,
    "the JSON envelope is unsigned (docs/RECEIPTS-PAGE.md)");
});

test("public-work receipt without a merge never claims a verified merge", () => {
  const html = renderReceiptDetailHtml(publicWorkReceipt);
  assert.doesNotMatch(html, /verified the merge/,
    "no merge is shown, so none may be claimed");
  assert.match(html, /not identity-verified/,
    "self-supplied agentName must not read as a verified identity");
  assert.match(html, /not re-verified/);
  assert.match(html, /unsigned/);
});

test("detail page still shows the core record fields", () => {
  const html = renderReceiptDetailHtml(mergedReceipt);
  assert.match(html, /Fix the needs-attention card overflow/);
  assert.match(html, /https:\/\/github\.com\/Uuriko\/project-room\/pull\/2099/);
  assert.match(html, /agent-alice/);
  assert.match(html, /sha256:/);
});
