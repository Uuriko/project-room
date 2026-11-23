import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("workspace preview scope, publish authority, version binding and withdrawal", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("other"));
  const owner = store.issueAccessKey("commons", "owner");
  const outside = store.issueAccessKey("other", "owner");
  for (const [memberId, permissions] of [["publisher", ["complete_work"]], ["other-publisher", ["complete_work"]], ["viewer", []]]) {
    store.command(owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions } });
  }
  const publisher = store.issueAccessKey("commons", "publisher");
  const otherPublisher = store.issueAccessKey("commons", "other-publisher");
  const viewer = store.issueAccessKey("commons", "viewer");
  const server = createRoomServer({ store });
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = "a".repeat(32);
  async function call(key, method = "GET", input, query = "") {
    return fetch(`${origin}/api/rooms/commons/workspace-previews${query}`, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: input ? JSON.stringify(input) : undefined,
    });
  }
  const preview = { id, title: "First preview", base: "b".repeat(40), head: "c".repeat(40),
    expectedRevision: 0, html: "<h1>Initial</h1>" };
  assert.deepEqual((await (await call(viewer)).json()).items, []);
  assert.equal((await call(viewer, "POST", preview)).status, 403);
  assert.equal((await call(outside, "GET", null, "?id=" + id)).status, 403);
  const first = await (await call(publisher, "POST", preview)).json();
  assert.equal(first.revision, 1);
  assert.equal(first.publisherId, "publisher");
  const list = await (await call(viewer)).json();
  assert.equal(list.items[0].html, undefined);
  assert.equal((await (await call(viewer, "GET", null, "?id=" + id)).json()).item.html, preview.html);
  assert.equal((await call(otherPublisher, "POST", { ...preview, expectedRevision: 1 })).status, 403);
  assert.equal((await (await call(publisher, "POST", preview)).json()).revision, 1);
  assert.equal((await call(publisher, "POST", { ...preview, html: "<h1>Changed</h1>" })).status, 409);
  const second = await (await call(publisher, "POST", { ...preview, expectedRevision: 1, html: "<h1>Changed</h1>" })).json();
  assert.equal(second.revision, 2);
  assert.equal((await call(otherPublisher, "DELETE", { id, expectedRevision: 2 })).status, 403);
  assert.equal((await call(owner, "DELETE", { id, expectedRevision: 1 })).status, 409);
  assert.equal((await call(owner, "DELETE", { id, expectedRevision: 2 })).status, 200);
  assert.equal((await call(viewer, "GET", null, "?id=" + id)).status, 404);
});

test("new worktrees keep the project selection outside the working copy", async t => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspaceCommand } = await import("../cli/commands/workspace.mjs");
  const { writeProject } = await import("../cli/paths.mjs");
  const base = mkdtempSync(join(tmpdir(), "room-cli-worktrees-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(base, "init", "-q");
  writeFileSync(join(base, "page.html"), "<h1>Start</h1>");
  git(base, "add", "page.html");
  git(base, "-c", "user.name=Room test", "-c", "user.email=room-test@localhost", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
  writeProject(base, { connection: "first-room" });
  const receipts = [];
  for (const target of [join(base, "first"), join(base, "second")]) {
    const code = await workspaceCommand(["start", "--path", target], { cwd: base, out: line => receipts.push(JSON.parse(line)) });
    assert.equal(code, 0);
  }
  assert.notEqual(receipts[0].branch, receipts[1].branch);
  for (const receipt of receipts) {
    assert.equal(receipt.base, git(base, "rev-parse", "HEAD"));
    assert.equal(git(receipt.path, "status", "--porcelain"), "");
    const metadata = join(git(receipt.path, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
    assert.deepEqual(JSON.parse(readFileSync(metadata, "utf8")), { connection: "first-room" });
  }
});
