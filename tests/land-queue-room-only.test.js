// REL-07: land queue room-only items. A land-kind work claim with no PR has no
// land_queue row, so viewFromClaim built mergeable:"unknown" + checks:"pending"
// forever. The list view must flag those items as roomOnly so the board can
// render them as room items ("no PR", no checks dot) instead of stuck PR cards.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork } from "../server/work-claims.mjs";
import { landCardModel, landCardHtml } from "../src/land-queue-board.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-roomonly-"));
  const clock = { now: NOW };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store };
}

function addLandClaim(store, fields) {
  const item = createWork({ kind: "land", ...fields }, { now: NOW, agentId: "owner" });
  store.workClaims.set("commons", item);
  return item;
}

test("list flags a land claim with no PR as room-only", t => {
  const { store } = fixture(t);
  addLandClaim(store, { id: "room-task-1", title: "Room task" });
  const items = store.landQueue.list("commons", "owner").items;
  const item = items.find(i => i.itemId === "room-task-1");
  assert.ok(item, "room-only claim appears in the land queue list");
  assert.equal(item.roomOnly, true);
  assert.equal(item.prNumber, null);
  assert.equal(item.url, null);
});

test("a land claim with a PR is not room-only", t => {
  const { store } = fixture(t);
  addLandClaim(store, {
    id: "pr-task-1", title: "PR task",
    pullRequest: "https://github.com/acme/demo/pull/12"
  });
  const items = store.landQueue.list("commons", "owner").items;
  const item = items.find(i => i.itemId === "pr-task-1");
  assert.ok(item, "PR claim appears in the land queue list");
  assert.ok(!item.roomOnly, "PR-backed claim is not room-only");
  assert.equal(item.prNumber, 12);
});

test("room-only board card names the room item and shows no PR with no checks dot", () => {
  const html = landCardHtml({ roomOnly: true, title: "Room task", prNumber: null, url: null, checks: "pending" });
  assert.match(html, /room item/);
  assert.match(html, /no PR/);
  assert.ok(!html.includes("land-checks-"), "no checks dot on room-only cards");
  assert.ok(!html.includes("#null"), "no broken PR-number label");
});

test("PR board cards are unchanged: checks dot still renders", () => {
  const model = landCardModel({ prNumber: 12, title: "PR task", url: "https://github.com/acme/demo/pull/12", checks: "pending" });
  assert.ok(!model.roomOnly);
  const html = landCardHtml({ prNumber: 12, title: "PR task", url: "https://github.com/acme/demo/pull/12", checks: "pending" });
  assert.ok(html.includes("land-checks-pending"), "PR card keeps its checks dot");
  assert.ok(html.includes("#12"));
});
