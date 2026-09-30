import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { parseRoomWork, syncCommandId, runWorkSync } from "../scripts/github-work-sync.mjs";

const repo = "Uuriko/project-room";

test("Room-Work lines parse, dedupe and ignore prose", () => {
  assert.deepEqual(parseRoomWork("Fixes it.\n\nRoom-Work: together-begin\n- Room-Work: muse-room/wk-2\nRoom-Work: together-begin\nnot Room-Work: x y"),
    [{ roomId: null, workItemId: "together-begin" }, { roomId: "muse-room", workItemId: "wk-2" }]);
  assert.deepEqual(parseRoomWork(null), []);
  assert.equal(syncCommandId(repo, 7, "a"), syncCommandId(repo, 7, "a"));
  assert.notEqual(syncCommandId(repo, 7, "a"), syncCommandId(repo, 8, "a"));
});

test("real Room: a merged PR posts once on its open work item and mentions the owner", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-work-sync-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [memberId, displayName] of [["door", "GitHub door"], ["grok", "Grok"]]) {
    store.command(ownerKey, "commons", { id: `add-${memberId}`, type: "member.added", data: {
      memberId, displayName, kind: "agent", permissions: [], accountableHumanId: "owner" } });
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const token = store.issueAccessKey("commons", "door");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const door = new RoomAgentClient({ origin, roomId: "commons", token });
  await owner.command({ id: "p1", type: "work.proposed", data: { workItemId: "wk-seat", title: "Show the seat",
    definitionOfDone: "Seat shows what it can do", accountableMemberId: "grok" } });

  const event = { action: "closed", pull_request: { merged: true, number: 1034, title: "Show what a seat can do",
    html_url: "https://github.com/Uuriko/project-room/pull/1034", merge_commit_sha: "abcdef1234567890",
    body: "Room-Work: wk-seat\nRoom-Work: missing-item\nRoom-Work: other-room/wk-seat" } };
  const first = await runWorkSync({ event, repo, client: door, roomId: "commons" });
  assert.deepEqual(first.results.map(r => r.posted ? "posted" : r.skipped), ["posted", "no such work item", "other room"]);
  const again = await runWorkSync({ event, repo, client: door, roomId: "commons" });
  assert.equal(again.results[0].duplicate, true);
  const posts = (await owner.snapshot()).state.messages.filter(m => m.workItemId === "wk-seat");
  assert.equal(posts.length, 1); assert.equal(posts[0].authorId, "door");
  assert.match(posts[0].body, /^@Grok PR #1034 "Show what a seat can do" merged at `abcdef123456`/);
  assert.equal((await owner.snapshot()).state.workItems["wk-seat"].state, "proposed", "the door never changes work state");

  assert.equal((await runWorkSync({ event: { ...event, pull_request: { ...event.pull_request, merged: false } }, repo, client: door, roomId: "commons" })).skipped, "not a merged pull request");
});
