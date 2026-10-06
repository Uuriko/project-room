import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { summarizePatch, cardBody } from "../server/code-drops.mjs";

const MBOX = `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Claude <noreply@anthropic.com>
Date: Mon, 5 Oct 2026 12:00:00 +0000
Subject: [PATCH 1/2] Add a greeting
 that wraps

---
 hello.txt | 2 ++
 1 file changed, 2 insertions(+)

diff --git a/hello.txt b/hello.txt
new file mode 100644
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1,2 @@
+hello
+room
--
2.43.0

From 2222222222222222222222222222222222222222 Mon Sep 17 00:00:00 2001
From: Claude <noreply@anthropic.com>
Subject: [PATCH 2/2] Trim the greeting

---
diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1 @@
 hello
-room
--
2.43.0

base-commit: abcdef0123456789abcdef0123456789abcdef01
`;

const DIFF = `--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n`;

test("summarizePatch reads commits, files, line counts and base from the bytes", () => {
  const summary = summarizePatch("mbox", Buffer.from(MBOX));
  assert.deepEqual(summary.commits.map(c => c.subject), ["Add a greeting that wraps", "Trim the greeting"]);
  assert.deepEqual(summary.files, [{ path: "hello.txt", adds: 2, dels: 1 }]);
  assert.equal(summary.base, "abcdef0123456789abcdef0123456789abcdef01");
  const diff = summarizePatch("diff", Buffer.from(DIFF));
  assert.deepEqual(diff.files, [{ path: "notes.md", adds: 1, dels: 1 }]);
  assert.throws(() => summarizePatch("mbox", Buffer.from("just words")), error => error.code === "invalid_code_drop");
  const bundle = summarizePatch("bundle", Buffer.concat([
    Buffer.from(`# v2 git bundle\n-${"a".repeat(40)} base\n${"b".repeat(40)} refs/heads/claude/x\n\n`), Buffer.from([0x50, 0x41, 0x43, 0x4b])
  ]));
  assert.deepEqual(bundle.refs, [{ commit: "b".repeat(40), ref: "refs/heads/claude/x" }]);
  assert.equal(bundle.base, "a".repeat(40));
});

test("the card stays short however large the patch is", () => {
  const big = MBOX.replace("@@ -0,0 +1,2 @@\n+hello\n+room\n", `@@ -0,0 +1,20002 @@\n+hello\n+room\n${"+x\n".repeat(20000)}`);
  const summary = summarizePatch("mbox", Buffer.from(big));
  const body = cardBody({ id: "cd-0123456789ab", roomId: "commons", title: "t", kind: "mbox", base: summary.base,
    branch: "claude/x", claimId: "c1", supersedes: null, summary, sha256: "f".repeat(64), byteLength: big.length });
  assert.ok(body.length < 500, body);
  assert.match(body, /^CODE cd-0123456789ab · t · mbox · base abcdef01 · claude\/x · 2 commits · 1 file \+20002\/−1/);
  assert.match(body, /room code fetch cd-0123456789ab \| git am -3/);
});

test("code drop routes share, list, fetch raw bytes, and record checks", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-code-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const memberId of ["author", "reviewer"]) {
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["complete_work"] } });
  }
  const author = store.issueAccessKey("commons", "author");
  const reviewer = store.issueAccessKey("commons", "reviewer");
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, { token = author, method = "GET", data } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const data = Buffer.from(MBOX).toString("base64");
  const sha = createHash("sha256").update(MBOX).digest("hex");

  assert.equal((await request("/api/rooms/commons/code", { token: null })).status, 401);
  const bad = await request("/api/rooms/commons/code", { method: "POST", data: { kind: "mbox", title: "x", data, extra: 1 } });
  assert.equal(bad.status, 422);

  const shared = await request("/api/rooms/commons/code", { method: "POST",
    data: { kind: "mbox", title: "Greeting", data, branch: "claude/greeting" } });
  assert.equal(shared.status, 201);
  const { drop } = await shared.json();
  assert.equal(drop.id, `cd-${sha.slice(0, 12)}`);
  assert.equal(drop.base, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(drop.summary.commits.length, 2);
  assert.equal(drop.authorId, "author");

  // One short card in the room, with the file committed onto it.
  const card = store.room("commons").state.messages.find(m => m.id === drop.messageId);
  assert.ok(card.body.startsWith(`CODE ${drop.id} · Greeting · mbox`));
  assert.ok(card.body.length < 600);
  const files = await (await request("/api/rooms/commons/files", { token: reviewer })).json();
  assert.ok(files.files.some(f => f.id === drop.attachmentId && f.state === "committed" && f.messageId === drop.messageId));

  // Same bytes again: the first drop, no second card.
  const again = await request("/api/rooms/commons/code", { method: "POST", data: { kind: "mbox", title: "Greeting again", data } });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).drop.id, drop.id);
  assert.equal(store.room("commons").state.messages.filter(m => m.body?.startsWith("CODE ")).length, 1);

  // Raw bytes are exact, for curl | git am.
  const raw = await request(`/api/rooms/commons/code/${drop.id}/raw`, { token: reviewer });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("x-content-sha256"), sha);
  assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await raw.text(), MBOX);

  // The author cannot approve their own drop; another member can.
  const self = await request(`/api/rooms/commons/code/${drop.id}/checks`, { method: "POST", data: { verdict: "approve" } });
  assert.equal(self.status, 403);
  const checked = await request(`/api/rooms/commons/code/${drop.id}/checks`, { token: reviewer, method: "POST",
    data: { verdict: "approve", applies: "clean", onBase: "abcdef0123456789", tests: "31/31", note: "LGTM" } });
  assert.equal(checked.status, 200);
  const after = (await checked.json()).drop;
  assert.deepEqual(after.checks.map(c => [c.checkerId, c.verdict, c.applies, c.tests]), [["reviewer", "approve", "clean", "31/31"]]);
  const reply = store.room("commons").state.messages.find(m => m.replyToId === drop.messageId);
  assert.match(reply.body, /^APPROVE cd-[0-9a-f]{12} · clean on abcdef01 · tests 31\/31\nLGTM$/);

  // A second check from the same reviewer replaces the first.
  await request(`/api/rooms/commons/code/${drop.id}/checks`, { token: reviewer, method: "POST",
    data: { verdict: "changes", note: "one more thing", announce: false } });
  const read = await (await request(`/api/rooms/commons/code/${drop.id}`)).json();
  assert.equal(read.drop.checks.length, 1);
  assert.equal(read.drop.checks[0].verdict, "changes");

  // A new version replaces the old one; only the author may do that.
  const v2 = Buffer.from(MBOX.replace("Trim the greeting", "Trim the greeting (v2)")).toString("base64");
  const stranger = await request("/api/rooms/commons/code", { token: reviewer, method: "POST",
    data: { kind: "mbox", title: "Greeting v2", data: v2, supersedes: drop.id } });
  assert.equal(stranger.status, 403);
  const replaced = await request("/api/rooms/commons/code", { method: "POST",
    data: { kind: "mbox", title: "Greeting v2", data: v2, supersedes: drop.id } });
  assert.equal(replaced.status, 201);
  const list = await (await request("/api/rooms/commons/code", { token: reviewer })).json();
  assert.equal(list.drops.length, 2);
  assert.equal(list.drops.find(d => d.id === drop.id).supersededBy, (await replaced.json()).drop.id);

  assert.equal((await request("/api/rooms/commons/code/cd-000000000000")).status, 404);
  assert.equal((await request("/api/rooms/commons/code/not-a-drop/raw")).status, 404);

  // Deleting the card removes the bytes, the drop, and its checks.
  store.command(author, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_DELETED,
    data: { messageId: drop.messageId, expectedMessageRevision: 0, reason: "remove" } });
  assert.equal((await request(`/api/rooms/commons/code/${drop.id}`)).status, 404);
  assert.equal((await request(`/api/rooms/commons/code/${drop.id}/raw`)).status, 404);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM room_code_checks WHERE drop_id=?").get(drop.id).n, 0);
});

test("room code CLI shares a branch, and a reviewer tries it in a worktree and reports back", async t => {
  const { codeCommand } = await import("../cli/commands/code.mjs");
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "project-room-code-cli-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const memberId of ["author", "reviewer"]) {
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["complete_work"] } });
  }
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = process.cwd();
  t.after(() => { process.chdir(home); server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });

  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" } }).trim();
  const repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-qb", "agent/feature");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  sh(repo, "commit", "-qam", "Add two");

  const lines = [];
  const io = who => ({ connection: { origin, roomId: "commons", secret: store.issueAccessKey("commons", who) }, out: m => lines.push(m) });
  process.chdir(repo);
  assert.equal(await codeCommand(["share", "--base", base, "--title", "Add two"], io("author")), 0);
  const id = /shared (cd-[0-9a-f]{12})/.exec(lines.join(""))[1];

  const review = join(directory, "review");
  execFileSync("git", ["clone", "-q", repo, review]);
  sh(review, "checkout", "-q", base);
  process.chdir(review);
  const code = await codeCommand(["try", id, "--test", "grep -q two a.txt", "--report", "--verdict", "approve"], io("reviewer"));
  assert.equal(code, 0, lines.join(""));
  assert.match(lines.join(""), new RegExp(`${id}: applies clean on ${base.slice(0, 8)}`));
  const drop = store.codeDrops.get(store.issueAccessKey("commons", "owner"), "commons", id).drop;
  assert.deepEqual(drop.checks.map(c => [c.checkerId, c.verdict, c.applies, c.tests]), [["reviewer", "approve", "clean", "pass"]]);
  assert.equal(sh(review, "worktree", "list").split("\n").length, 1, "try removes its worktree");

  const fetched = [];
  await codeCommand(["fetch", id], { ...io("reviewer"), write: chunk => fetched.push(chunk) });
  assert.match(Buffer.concat(fetched).toString("utf8"), /^From [0-9a-f]{40} /);
  assert.match(Buffer.concat(fetched).toString("utf8"), new RegExp(`base-commit: ${base}`));
});
