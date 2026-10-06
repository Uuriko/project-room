// Code drops repair (Claude, 2026-10-06). One owner per defect Codex's
// recovery review found in d7ac4024, plus the missing-identity apply failure.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { summarizePatch, cardBody } from "../server/code-drops.mjs";
import { codeCommand } from "../cli/commands/code.mjs";

const DIFF = `--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n`;

async function room(t, members = ["author", "reviewer", "second"]) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-code-repair-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const memberId of members) {
    store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["complete_work"] } });
  }
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = process.cwd();
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  t.after(() => {
    process.chdir(home);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    server.closeStreams(); server.closeAllConnections(); server.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const lines = [];
  const io = who => ({ connection: { origin, roomId: "commons", secret: store.issueAccessKey("commons", who) }, out: m => lines.push(m) });
  return { store, origin, directory, io, lines };
}

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" } }).trim();

function repo(directory) {
  const path = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  writeFileSync(join(path, "a.txt"), "one\n");
  sh(path, "add", "."); sh(path, "commit", "-qm", "base");
  return { path, base: sh(path, "rev-parse", "HEAD") };
}

test("a unified diff card says git apply, not git am", () => {
  const summary = summarizePatch("diff", Buffer.from(DIFF));
  const body = cardBody({ id: "cd-0123456789ab", roomId: "commons", title: "t", kind: "diff", base: null,
    branch: null, claimId: null, supersedes: null, summary, sha256: "f".repeat(64), byteLength: DIFF.length });
  assert.match(body, /room code fetch cd-0123456789ab \| git apply --3way/);
  assert.doesNotMatch(body, /git am/);
});

test("two reviewers with identical checks each get their own reply", async t => {
  const { store } = await room(t);
  const author = store.issueAccessKey("commons", "author");
  const { drop } = store.codeDrops.share(author, "commons", { kind: "diff", title: "x", data: Buffer.from(DIFF).toString("base64") });
  const same = { verdict: "approve", applies: "clean", onBase: "abcdef0123456789", tests: "3/3 pass" };
  store.codeDrops.check(store.issueAccessKey("commons", "reviewer"), "commons", drop.id, same);
  store.codeDrops.check(store.issueAccessKey("commons", "second"), "commons", drop.id, same);
  const replies = store.room("commons").state.messages.filter(m => m.replyToId === drop.messageId);
  assert.equal(replies.length, 2, "second reviewer's reply was swallowed by the first one's command id");
  assert.deepEqual(new Set(replies.map(m => m.authorId ?? m.memberId ?? m.from)).size, 2);
  // Approve, ask for changes, approve again: the author hears the second approve.
  const reviewer = store.issueAccessKey("commons", "reviewer");
  store.codeDrops.check(reviewer, "commons", drop.id, { verdict: "changes", note: "one thing" });
  const result = store.codeDrops.check(reviewer, "commons", drop.id, same);
  assert.equal(result.drop.checks.find(c => c.checkerId === "reviewer").verdict, "approve");
  const after = store.room("commons").state.messages.filter(m => m.replyToId === drop.messageId);
  assert.equal(after.length, 4, "a repeated check must still reach the author");
  // A retry of the current check is a no-op, not a fifth reply.
  assert.equal(store.codeDrops.check(reviewer, "commons", drop.id, same).status, "unchanged");
  assert.equal(store.room("commons").state.messages.filter(m => m.replyToId === drop.messageId).length, 4);
});

test("fetch refuses bytes that arrive without X-Content-SHA256", async t => {
  const { io } = await room(t);
  const stripped = async (url, init) => {
    const real = await fetch(url, init);
    if (!String(url).endsWith("/raw")) return real;
    const headers = new Headers(real.headers); headers.delete("x-content-sha256");
    return new Response(await real.arrayBuffer(), { status: real.status, headers });
  };
  const author = io("author");
  writeFileSync(join(tmpdir(), "cd-repair.diff"), DIFF);
  await codeCommand(["share", "--file", join(tmpdir(), "cd-repair.diff"), "--title", "x"], author);
  const { drops } = await (await fetch(`${author.connection.origin}/api/rooms/commons/code`, { headers: { Authorization: `Bearer ${author.connection.secret}` } })).json();
  const id = drops[0].id;
  await assert.rejects(codeCommand(["fetch", id], { ...io("reviewer"), fetchImpl: stripped, write: () => {} }), /sha256/i);
});

test("try exits non-zero and never reports approve when the tests fail", async t => {
  const { io, lines, directory, store } = await room(t);
  const { path, base } = repo(directory);
  sh(path, "checkout", "-qb", "agent/feature");
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  sh(path, "commit", "-qam", "Add two");
  process.chdir(path);
  assert.equal(await codeCommand(["share", "--base", base, "--title", "Add two"], io("author")), 0);
  const id = /shared (cd-[0-9a-f]{12})/.exec(lines.join(""))[1];
  const review = join(directory, "review");
  execFileSync("git", ["clone", "-q", path, review]);
  sh(review, "checkout", "-q", base);
  process.chdir(review);
  const code = await codeCommand(["try", id, "--test", "grep -q three a.txt", "--report", "--verdict", "approve"], io("reviewer"));
  assert.notEqual(code, 0, "failed tests must not exit 0");
  const drop = store.codeDrops.get(store.issueAccessKey("commons", "owner"), "commons", id).drop;
  assert.notEqual(drop.checks[0].verdict, "approve", "a failing try must not be recorded as approve");
});

test("try tests a bundle merged onto the reviewer's HEAD, the base it reports", async t => {
  const { io, lines, directory, store } = await room(t);
  const { path, base } = repo(directory);
  sh(path, "checkout", "-qb", "agent/feature");
  writeFileSync(join(path, "feature.txt"), "feature\n");
  sh(path, "add", "."); sh(path, "commit", "-qm", "Add feature");
  process.chdir(path);
  assert.equal(await codeCommand(["share", "--bundle", "--base", base, "--title", "Feature"], io("author")), 0);
  const id = /shared (cd-[0-9a-f]{12})/.exec(lines.join(""))[1];
  const review = join(directory, "review");
  execFileSync("git", ["clone", "-q", path, review]);
  sh(review, "checkout", "-q", "main");
  writeFileSync(join(review, "main-only.txt"), "landed after the drop\n");
  sh(review, "add", "."); sh(review, "commit", "-qm", "Main moved on");
  const head = sh(review, "rev-parse", "HEAD");
  process.chdir(review);
  const code = await codeCommand(["try", id, "--test", "test -f main-only.txt && test -f feature.txt", "--report", "--verdict", "approve"], io("reviewer"));
  assert.equal(code, 0, lines.join(""));
  const check = store.codeDrops.get(store.issueAccessKey("commons", "owner"), "commons", id).drop.checks[0];
  assert.equal(check.onBase, head);
  assert.equal(check.verdict, "approve");
  assert.equal(sh(review, "for-each-ref", "refs/room/"), "", "try leaves no refs behind");
});

test("try applies an mbox for a reviewer with no git identity configured", async t => {
  const { io, lines, directory } = await room(t);
  const { path, base } = repo(directory);
  sh(path, "checkout", "-qb", "agent/feature");
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  sh(path, "commit", "-qam", "Add two");
  process.chdir(path);
  await codeCommand(["share", "--base", base, "--title", "Add two"], io("author"));
  const id = /shared (cd-[0-9a-f]{12})/.exec(lines.join(""))[1];
  const review = join(directory, "review");
  execFileSync("git", ["clone", "-q", path, review]);
  sh(review, "checkout", "-q", base);
  const empty = join(directory, "empty-gitconfig"); writeFileSync(empty, "");
  process.env.GIT_CONFIG_GLOBAL = empty; process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.chdir(review);
  assert.equal(await codeCommand(["try", id], io("reviewer")), 0, lines.join(""));
  assert.match(lines.join(""), new RegExp(`${id}: applies clean`));
});
