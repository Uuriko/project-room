// Board UI pure helpers: escapeHtml, columnOf, claimUpdateText,
// collapseClaimUpdates, boardToolNames, canWriteClaims.
// The browser checks own the rendered board and its controls; these tests
// guard the classification, copy, and permission contracts the renderer
// consumes, independent of any DOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  columnOf,
  claimUpdateText,
  collapseClaimUpdates,
  boardToolNames,
  canWriteClaims,
} from "../src/board-ui.js";

// --- escapeHtml: the XSS boundary every board string crosses ---

test("escapeHtml escapes the five HTML metacharacters", () => {
  assert.equal(escapeHtml(`<script>alert("x&y")</script>`), "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml("a>b"), "a&gt;b");
});

test("escapeHtml tolerates nullish and non-string input", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml("plain"), "plain");
});

// --- columnOf: board placement is a pure function of claim state ---

const NOW = Date.parse("2026-10-03T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();
const claim = (id, extra = {}) => ({ id, title: id, state: "unclaimed", owner: null, dependsOn: [], ...extra });
const byId = items => new Map(items.map(item => [item.id, item]));

test("columnOf drops a null item and unknown states instead of guessing", () => {
  assert.equal(columnOf(null, new Map(), NOW), null);
  assert.equal(columnOf(claim("x", { state: "mystery" }), byId([]), NOW), null);
});

test("columnOf lands only completions from the last week", () => {
  const fresh = claim("fresh", { state: "done", updatedAt: iso(NOW - DAY) });
  const stale = claim("stale", { state: "done", updatedAt: iso(NOW - 8 * DAY) });
  assert.equal(columnOf(fresh, byId([fresh]), NOW), "landed");
  assert.equal(columnOf(stale, byId([stale]), NOW), null);
});

test("columnOf prefers the newest history stamp over updatedAt", () => {
  const item = claim("h", {
    state: "done",
    updatedAt: iso(NOW - 8 * DAY),
    history: [{ at: iso(NOW - 8 * DAY) }, { at: iso(NOW - DAY) }],
  });
  assert.equal(columnOf(item, byId([item]), NOW), "landed");
});

test("columnOf blocks unclaimed work with unfinished prerequisites, readies the rest", () => {
  const dep = claim("dep", { state: "in_progress", owner: "w" });
  const waiting = claim("waiting", { dependsOn: ["dep"] });
  const free = claim("free");
  const map = byId([dep, waiting, free]);
  assert.equal(columnOf(waiting, map, NOW), "blocked");
  assert.equal(columnOf(free, map, NOW), "ready");
});

test("columnOf never shows an owned-but-unclaimed row in a column", () => {
  // An unclaimed item that already has an owner is mid-transition; the board
  // must not invent a column for it.
  const item = claim("owned", { owner: "w" });
  assert.equal(columnOf(item, byId([item]), NOW), null);
});

test("columnOf sends open pull requests to review ahead of their state", () => {
  const open = claim("open", {
    state: "claimed", owner: "w",
    pullRequest: { url: "https://github.com/o/r/pull/12" },
  });
  const decided = claim("decided", {
    state: "claimed", owner: "w",
    pullRequest: { url: "https://github.com/o/r/pull/13", outcome: "merged" },
  });
  assert.equal(columnOf(open, byId([open]), NOW), "review");
  assert.equal(columnOf(decided, byId([decided]), NOW), "claimed");
});

test("columnOf maps blocked/claimed/in_progress to their columns", () => {
  const blocked = claim("b", { state: "blocked", owner: "w" });
  const progress = claim("p", { state: "in_progress", owner: "w" });
  assert.equal(columnOf(blocked, byId([blocked]), NOW), "blocked");
  assert.equal(columnOf(progress, byId([progress]), NOW), "claimed");
});

// --- claimUpdateText: activity feed copy ---

const members = {
  agent1: { displayName: "Muse", kind: "agent" },
  human1: { displayName: "John Potter", kind: "human" },
};
const update = (data, extra = {}) => ({
  id: "e1", type: "work_claim.updated", at: "2026-10-06T10:00:00Z", actorId: "agent1", ...extra, data,
});

test("claimUpdateText renders a claim with file count and lease", () => {
  const event = update({
    action: "claimed", title: "Write tests", paths: ["src/a.js", "src/b.js"],
    leaseExpiresAt: "2026-10-06T15:00:00Z",
  });
  assert.equal(claimUpdateText(event, members), "@Muse claimed Write tests · 2 files · lease 5h");
});

test("claimUpdateText uses the singular file label", () => {
  const event = update({ action: "claimed", title: "T", paths: ["src/a.js"] });
  assert.equal(claimUpdateText(event, members), "@Muse claimed T · 1 file");
});

test("claimUpdateText maps CI states to words", () => {
  assert.equal(claimUpdateText(update({ action: "ci_changed", ciState: "failure", title: "T" }), members), "CI failed on T");
  assert.equal(claimUpdateText(update({ action: "ci_changed", ciState: "success", title: "T" }), members), "CI passed on T");
  assert.equal(claimUpdateText(update({ action: "ci_changed", ciState: "pending", title: "T" }), members), "CI is pending on T");
  assert.equal(claimUpdateText(update({ action: "ci_changed", title: "T" }), members), "CI changed on T");
});

test("claimUpdateText renders review verdicts without a title", () => {
  assert.equal(claimUpdateText(update({ verdict: "approve" }), members), "@Muse approved");
  assert.equal(claimUpdateText(update({ verdict: "changes_requested" }), members), "@Muse requested changes");
  assert.equal(claimUpdateText(update({ verdict: "comment" }), members), "@Muse commented");
  assert.equal(
    claimUpdateText(update({ action: "reviewed", reason: "reviewed", title: "T" }), members),
    "@Muse reviewed T",
  );
});

test("claimUpdateText covers the claim lifecycle verbs", () => {
  const verbs = [
    ["created", "@Muse opened T"],
    ["released", "@Muse released T"],
    ["lease_expired", "@Muse released T"],
    ["renewed", "@Muse renewed T"],
    ["reassigned", "@Muse reassigned T"],
    ["pr_merged", "@Muse merged T"],
    ["pr_closed", "@Muse closed the pull request on T"],
  ];
  for (const [action, expected] of verbs) {
    assert.equal(claimUpdateText(update({ action, title: "T" }), members), expected, action);
  }
  assert.equal(
    claimUpdateText(update({ action: "state_changed", claimState: "in_progress", title: "T" }), members),
    "@Muse marked T in progress",
  );
});

test("claimUpdateText falls back to a named someone for unknown actors and actions", () => {
  assert.equal(claimUpdateText(update({ action: "claimed", title: "T" }, { actorId: "ghost" }), members), "ghost claimed T");
  assert.equal(claimUpdateText(update({ action: "claimed", title: "T" }, { actorId: null }), members), "Someone claimed T");
  assert.equal(claimUpdateText(update({ action: "mystery", title: "T" }), members), "@Muse updated T");
  assert.equal(claimUpdateText(update({ action: "mystery" }, { actorId: null }), members), "Someone updated a claim");
  // Human names are not @-prefixed.
  assert.equal(
    claimUpdateText(update({ action: "created", title: "T" }, { actorId: "human1" }), members),
    "John Potter opened T",
  );
});

// --- collapseClaimUpdates: the 10-minute activity grouping ---

const logged = (id, at, claimId, extra = {}) => ({
  id, type: "work_claim.updated", at, data: { workClaim: claimId, action: "claimed", ...extra },
});

test("collapseClaimUpdates groups a claim's events inside ten minutes, keeping the latest", () => {
  const events = [
    logged("e1", "2026-10-06T10:00:00Z", "c1"),
    logged("e2", "2026-10-06T10:05:00Z", "c1", { action: "renewed" }),
  ];
  const groups = collapseClaimUpdates(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].claimId, "c1");
  assert.equal(groups[0].event.id, "e2");
});

test("collapseClaimUpdates splits when the window lapses from the group start", () => {
  // e3 is 9 minutes after e2 but 18 after the group start: new group.
  const events = [
    logged("e1", "2026-10-06T10:00:00Z", "c1"),
    logged("e2", "2026-10-06T10:09:00Z", "c1"),
    logged("e3", "2026-10-06T10:18:00Z", "c1"),
  ];
  const groups = collapseClaimUpdates(events);
  assert.deepEqual(groups.map(group => group.event.id), ["e2", "e3"]);
});

test("collapseClaimUpdates sorts chronologically and keeps claims apart", () => {
  const events = [
    logged("e2", "2026-10-06T10:05:00Z", "c2"),
    logged("e1", "2026-10-06T10:00:00Z", "c1"),
  ];
  const groups = collapseClaimUpdates(events);
  assert.deepEqual(groups.map(group => group.claimId), ["c1", "c2"]);
});

test("collapseClaimUpdates ignores non-claim events and claims without ids", () => {
  const events = [
    { id: "m1", type: "message.posted", at: "2026-10-06T10:00:00Z", data: {} },
    logged("e1", "2026-10-06T10:01:00Z", null),
    logged("e2", "2026-10-06T10:02:00Z", "c1"),
  ];
  const groups = collapseClaimUpdates(events);
  assert.deepEqual(groups.map(group => group.claimId), ["c1"]);
  assert.deepEqual(collapseClaimUpdates(null), []);
  assert.deepEqual(collapseClaimUpdates("nope"), []);
});

// --- boardToolNames: which agent capabilities reach the empty-board copy ---

test("boardToolNames keeps work-claim tools and drops the legacy board tools", () => {
  assert.deepEqual(
    boardToolNames(["work_claim_create", "room_read_board", "room_acquire_claim", "room_renew_claim", "room_release_claim"]),
    ["work_claim_create"],
  );
});

test("boardToolNames drops non-work-claim capabilities, dedupes, and tolerates junk", () => {
  assert.deepEqual(
    boardToolNames(["work_claim_create", "chat:write", "work-claim-renew", "work_claim_create", 42, null]),
    ["work_claim_create", "work-claim-renew"],
  );
  assert.deepEqual(boardToolNames(null), []);
  assert.deepEqual(boardToolNames("work_claim_create"), []);
});

// --- canWriteClaims: who may touch claims ---

const boardState = (ownerId, members) => ({ room: { ownerId }, members });
const session = id => ({ member: { id } });

test("canWriteClaims refuses anonymous sessions and memberless rooms", () => {
  assert.equal(canWriteClaims(boardState("owner1", {}), null), false);
  assert.equal(canWriteClaims(boardState("owner1", {}), {}), false);
  assert.equal(canWriteClaims({}, session("m1")), false);
});

test("canWriteClaims lets the owner write and skips enforcement without an ownerId", () => {
  const state = boardState("owner1", { owner1: { kind: "human", permissions: [] } });
  assert.equal(canWriteClaims(state, session("owner1")), true);
  assert.equal(canWriteClaims(boardState(null, { m1: { kind: "human", permissions: [] } }), session("m1")), true);
});

test("canWriteClaims gates humans on accept/complete work and rejects the inactive", () => {
  const members = {
    writer: { kind: "human", permissions: ["accept_work"] },
    reader: { kind: "human", permissions: ["chat:write"] },
    idle: { kind: "human", permissions: ["accept_work"], active: false },
  };
  const state = boardState("owner1", members);
  assert.equal(canWriteClaims(state, session("writer")), true);
  assert.equal(canWriteClaims(state, session("reader")), false);
  assert.equal(canWriteClaims(state, session("idle")), false);
  assert.equal(canWriteClaims(state, session("ghost")), false);
});

test("canWriteClaims gates agents on the accept+complete pair, verify, or the full steer set", () => {
  const members = {
    worker: { kind: "agent", permissions: ["accept_work", "complete_work"] },
    verifier: { kind: "agent", permissions: ["verify"] },
    steered: { kind: "agent", permissions: ["steer", "accept_work", "complete_work", "verify"] },
    partial: { kind: "agent", permissions: ["steer"] },
    none: { kind: "agent", permissions: [] },
  };
  const state = boardState("owner1", members);
  assert.equal(canWriteClaims(state, session("worker")), true);
  assert.equal(canWriteClaims(state, session("verifier")), true);
  assert.equal(canWriteClaims(state, session("steered")), true);
  assert.equal(canWriteClaims(state, session("partial")), false);
  assert.equal(canWriteClaims(state, session("none")), false);
});
