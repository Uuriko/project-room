// tests/approval-inbox-roomjs.test.js
//
// Contract tests for src/approval-inbox-room.js — the client-side renderer for
// unified approval-inbox card events in the room message stream.
//
// Contract under test (defined in the module header, since the card-projection
// slice is not landed yet):
//   inbox.card_opened  -> headline + kind badge + "Decide" link
//   inbox.card_decided -> outcome + decided-by + receipt link
//   inbox.card_expired -> quiet, honest note (no action affordance)
//   anything else      -> "" so the renderer never breaks the message stream
//
// Credible regressions pinned here:
//  - unescaped card headline/requester/outcome text (user-supplied, XSS risk)
//  - an expired card rendering nothing at all (silence hides a dead decision)
//  - unknown event types throwing or emitting junk into the stream
//  - a decided card without a receipt link emitting a broken empty anchor
import test from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_CARD_OPENED,
  INBOX_CARD_DECIDED,
  INBOX_CARD_EXPIRED,
  INBOX_KINDS,
  kindBadge,
  renderInboxCardOpened,
  renderInboxCardDecided,
  renderInboxCardExpired,
  renderInboxCardEvent,
} from "../src/approval-inbox-room.js";

const openedCard = {
  cardId: "card-42",
  kind: "money",
  headline: "Send $500 to bounty winner",
  summary: "Pays the bug-bounty pot to the winning lane.",
  requesterName: "Grok Bot",
  decideUrl: "/inbox/card-42",
  expiresAt: "2026-10-11T19:00:00.000Z",
};

test("opened card renders headline, kind badge, and decide link", () => {
  const html = renderInboxCardOpened(openedCard);
  assert.ok(html.includes("Send $500 to bounty winner"), "headline visible");
  assert.ok(html.includes('class="inbox-kind inbox-kind-money"'), "kind badge class");
  assert.ok(html.includes(">Money<"), "kind badge label");
  assert.ok(html.includes('href="/inbox/card-42"'), "decide link href");
  assert.ok(html.includes(">Decide<"), "decide link label");
  assert.ok(html.includes("inbox-card-opened"), "opened card class");
});

test("opened card escapes user-supplied text (headline, requester, summary)", () => {
  const html = renderInboxCardOpened({
    cardId: "card-x",
    kind: "publish",
    headline: "<script>alert(1)</script> & friends",
    requesterName: '"quoted" <b>name</b>',
    summary: "a > b && c < d",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "no raw script tag");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "headline escaped");
  assert.ok(html.includes("&quot;quoted&quot;"), "quotes escaped");
  assert.ok(html.includes("a &gt; b &amp;&amp; c &lt; d"), "summary escaped");
});

test("opened card with unknown kind renders an honest badge, not a crash", () => {
  const html = renderInboxCardOpened({ cardId: "card-1", kind: "telepathy", headline: "???" });
  assert.ok(html.includes("inbox-kind-unknown"), "unknown-kind badge class");
  assert.ok(html.includes("Unknown kind"), "honest label");
  assert.ok(!html.includes("inbox-kind-telepathy"), "no fabricated kind class");
});

test("opened card without a headline degrades to Untitled decision", () => {
  const html = renderInboxCardOpened({ cardId: "card-1", kind: "deploy" });
  assert.ok(html.includes("Untitled decision"), "fallback headline");
  assert.ok(html.includes("inbox-card-opened"), "still renders a card");
});

test("decided card renders outcome, decided-by, and receipt link", () => {
  const html = renderInboxCardDecided({
    cardId: "card-42",
    kind: "money",
    headline: "Send $500 to bounty winner",
    outcome: "approved",
    decidedBy: "John",
    decidedAt: "2026-10-10T20:00:00.000Z",
    receiptUrl: "/receipts/r-7",
  });
  assert.ok(html.includes(">Approved<"), "outcome label");
  assert.ok(html.includes("John"), "decider named");
  assert.ok(html.includes('href="/receipts/r-7"'), "receipt link href");
  assert.ok(html.includes(">Receipt<"), "receipt link label");
  assert.ok(html.includes("inbox-card-decided"), "decided card class");
});

test("decided card without a receipt link still renders, no broken anchor", () => {
  const html = renderInboxCardDecided({
    cardId: "card-9",
    kind: "deploy",
    headline: "Deploy room build",
    outcome: "rejected",
    decidedBy: "John",
  });
  assert.ok(html.includes(">Rejected<"), "rejected outcome label");
  assert.ok(!html.includes('href=""'), "no empty href");
  assert.ok(!html.includes('class="inbox-receipt"'), "no receipt element at all");
});

test("decided card escapes decider name", () => {
  const html = renderInboxCardDecided({
    cardId: "card-9",
    kind: "deploy",
    headline: "Deploy",
    outcome: "approved",
    decidedBy: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes("<img src=x"), "no raw markup");
  assert.ok(html.includes("&lt;img src=x"), "decider escaped");
});

test("expired card is quiet and honest, with no decide affordance", () => {
  const html = renderInboxCardExpired({
    cardId: "card-42",
    kind: "money",
    headline: "Send $500 to bounty winner",
    expiredAt: "2026-10-11T19:00:00.000Z",
  });
  assert.ok(html.includes("Send $500 to bounty winner"), "card still named");
  assert.ok(html.includes("expired"), "honest expiry note");
  assert.ok(html.includes("inbox-card-expired"), "expired card class");
  assert.ok(!html.includes(">Decide<"), "no decide link");
  assert.ok(!html.includes("<a "), "no anchors at all");
});

test("dispatcher routes the three inbox card events and passes through the rest", () => {
  assert.ok(renderInboxCardEvent({ type: INBOX_CARD_OPENED, data: openedCard }).includes("inbox-card-opened"));
  const decided = renderInboxCardEvent({
    type: INBOX_CARD_DECIDED,
    data: { cardId: "c", kind: "identity", headline: "Post as John", outcome: "approved", decidedBy: "John" },
  });
  assert.ok(decided.includes("inbox-card-decided"));
  assert.ok(renderInboxCardEvent({ type: INBOX_CARD_EXPIRED, data: { cardId: "c", headline: "Old" } }).includes("inbox-card-expired"));
  assert.equal(renderInboxCardEvent({ type: "message.posted", data: {} }), "", "non-inbox events pass through");
  assert.equal(renderInboxCardEvent({ type: "work.proposed", data: {} }), "", "work events pass through");
  assert.equal(renderInboxCardEvent(null), "", "null event is safe");
  assert.equal(renderInboxCardEvent({}), "", "missing type is safe");
});

test("module advertises the inbox kind vocabulary", () => {
  assert.deepEqual([...INBOX_KINDS], ["money", "identity", "deploy", "permission", "publish", "other"]);
  assert.ok(kindBadge("money").includes("inbox-kind-money"));
  assert.ok(kindBadge("bogus").includes("inbox-kind-unknown"));
});
