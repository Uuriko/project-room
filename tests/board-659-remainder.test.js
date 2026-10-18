// #659 remainder: per-member lanes, per-card state chips, and the inline
// receipt card in the chat timeline. The board view, lease countdowns and
// the typed receipt_card message already existed; these tests pin the three
// pieces that were missing — lane grouping matches the ledger's per-member
// claim states for a fixture room, chips equal the recorded states (a
// Verified chip only where a verification fact exists), and the timeline
// card renders the receipt record's canonical fields.
import test from "node:test";
import assert from "node:assert/strict";
import {
  boardHtml,
  claimStateChipHtml,
  placeClaimsByMember,
  receiptCardMessageHtml
} from "../src/board-ui.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";

const members = {
  "agent-1": { id: "agent-1", kind: "agent", displayName: "Muse", active: true, permissions: [] },
  "human-1": { id: "human-1", kind: "human", displayName: "Ana", active: true, permissions: [] }
};
const viewer = { id: "human-1", manage: false, owner: false, write: true };

const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "claimed", owner: "agent-1",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, updatedAt: T0, ...extra
});

// The fixture room: two members hold claims in mixed states, one claim is
// unclaimed, and one done claim carries a verification fact while another
// done claim does not.
const fixture = [
  claim("wc-a", { state: "in_progress", owner: "agent-1" }),
  claim("wc-b", { state: "done", owner: "agent-1", verification: { state: "verified", by: "human-1", at: T0 } }),
  claim("wc-c", { state: "claimed", owner: "human-1" }),
  claim("wc-d", { state: "done", owner: "human-1" }),
  claim("wc-e", { state: "unclaimed", owner: null })
];

// --- per-member lanes ---

test("placeClaimsByMember groups every claim into exactly its owner's lane", () => {
  const lanes = placeClaimsByMember(fixture, members);
  const seen = lanes.flatMap(lane => lane.items.map(item => item.id));
  assert.deepEqual([...seen].sort(), fixture.map(item => item.id).sort(), "no claim is dropped or duplicated");
  for (const lane of lanes) {
    for (const item of lane.items) assert.equal(item.owner, lane.ownerId, "a card sits in its recorded owner's lane");
  }
  const byOwner = Object.fromEntries(lanes.map(lane => [lane.ownerId, lane.items.map(item => item.id)]));
  assert.deepEqual(byOwner["agent-1"], ["wc-a", "wc-b"]);
  assert.deepEqual(byOwner["human-1"], ["wc-c", "wc-d"]);
  assert.deepEqual(byOwner[null], ["wc-e"], "ownerless claims land in the unclaimed lane");
  assert.equal(lanes[lanes.length - 1].ownerId, null, "the unclaimed lane is last");
});

test("placeClaimsByMember names lanes from the room's member records", () => {
  const lanes = placeClaimsByMember(fixture, members);
  assert.equal(lanes.find(lane => lane.ownerId === "agent-1").name, "@Muse");
  assert.equal(lanes.find(lane => lane.ownerId === "human-1").name, "Ana");
  assert.equal(lanes.find(lane => lane.ownerId === null).name, "Unclaimed");
});

test("boardHtml member grouping renders lanes with the same cards as the state columns", () => {
  const stateHtml = boardHtml(fixture, null, viewer, members, NOW, {});
  const laneHtml = boardHtml(fixture, null, viewer, members, NOW, { grouping: "member" });
  for (const item of fixture) {
    assert.ok(stateHtml.includes(`data-claim-id="${item.id}"`), `state board carries ${item.id}`);
    assert.ok(laneHtml.includes(`data-claim-id="${item.id}"`), `lane board carries ${item.id}`);
  }
  assert.match(laneHtml, /id="board-lane-agent-1"/);
  assert.match(laneHtml, /id="board-lane-human-1"/);
  assert.match(laneHtml, /id="board-lane-unclaimed"/);
  assert.match(laneHtml, /data-board-group="member"[^>]*aria-pressed="true"/, "the toggle reports the active grouping");
  assert.match(stateHtml, /data-board-group="state"[^>]*aria-pressed="true"/);
});

// --- state chips ---

test("claimStateChipHtml names the recorded state and nothing else", () => {
  assert.match(claimStateChipHtml(claim("x", { state: "claimed" })), />Claimed</);
  assert.match(claimStateChipHtml(claim("x", { state: "in_progress" })), />In progress</);
  assert.match(claimStateChipHtml(claim("x", { state: "blocked" })), />Blocked</);
  assert.match(claimStateChipHtml(claim("x", { state: "delivered" })), />Delivered</);
  assert.match(claimStateChipHtml(claim("x", { state: "unclaimed", owner: null })), />Unclaimed</);
  assert.equal(claimStateChipHtml(claim("x", { state: "mystery" })), "", "an unrecorded state gets no chip");
  assert.equal(claimStateChipHtml(null), "");
});

test("a Verified chip appears only where a verification fact exists", () => {
  const verified = claimStateChipHtml(claim("x", { state: "done", verification: { state: "verified", by: "human-1", at: T0 } }));
  assert.match(verified, />Completed</);
  assert.match(verified, /claim-chip-verified">Verified</);
  const plainDone = claimStateChipHtml(claim("x", { state: "done" }));
  assert.match(plainDone, />Completed</);
  assert.doesNotMatch(plainDone, /Verified/, "done without a verification fact is never shown as verified");
});

test("board cards carry the chip for their recorded state", () => {
  const html = boardHtml(fixture, null, viewer, members, NOW, {});
  const cardB = html.split('data-claim-id="wc-b"')[1].split("</article>")[0];
  assert.match(cardB, /claim-chip-verified/, "the verified fixture card shows the Verified chip");
  const cardD = html.split('data-claim-id="wc-d"')[1].split("</article>")[0];
  assert.match(cardD, />Completed</);
  assert.doesNotMatch(cardD, /claim-chip-verified/, "the unverified done card does not");
});

// --- inline receipt cards in the chat timeline ---

const receiptMessage = (extra = {}) => ({
  id: "rc-message-1", kind: "receipt_card", claimId: "wc-b",
  receiptId: "rc_wc-b", title: "Ship the board", closedBy: "Muse",
  deliveryMode: "merged", evidence: "PR merged; checks green.",
  pullRequestUrl: "https://github.com/Uuriko/project-room/pull/42",
  body: "Ship the board closed as merged.", ...extra
});

test("receiptCardMessageHtml renders the receipt record's canonical fields", () => {
  const html = receiptCardMessageHtml(receiptMessage());
  assert.match(html, /data-receipt-card="wc-b"/);
  assert.match(html, /Receipt · <code>rc_wc-b<\/code>/, "the card names the receipt id the receipts surface resolves");
  assert.match(html, /Ship the board/);
  assert.match(html, /Closed as merged/);
  assert.match(html, /Closed by Muse/);
  assert.match(html, /PR merged; checks green\./);
  assert.match(html, /href="https:\/\/github\.com\/Uuriko\/project-room\/pull\/42">PR #42</);
});

test("receiptCardMessageHtml renders nothing for ordinary messages", () => {
  assert.equal(receiptCardMessageHtml({ id: "m1", body: "hello" }), "");
  assert.equal(receiptCardMessageHtml(null), "");
});

test("receiptCardMessageHtml escapes recorded fields and drops unrecorded modes", () => {
  const html = receiptCardMessageHtml(receiptMessage({
    title: "<script>alert(1)</script>", evidence: "a & b", deliveryMode: "teleported",
    pullRequestUrl: "https://evil.example/pull/1"
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.doesNotMatch(html, /Closed as/, "a delivery mode the ledger never recorded is not rendered");
  assert.doesNotMatch(html, /evil\.example/, "a non-canonical PR url is not linked");
});

test("receiptCardMessageHtml derives the rc_ id for older cards that predate receiptId", () => {
  const html = receiptCardMessageHtml(receiptMessage({ receiptId: undefined }));
  assert.match(html, /<code>rc_wc-b<\/code>/);
});
