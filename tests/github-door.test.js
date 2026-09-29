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
import { parseDoorComment, parseAllowlist, inboundCommand, commandIdFor, readCursor, outboundDigest,
  runInbound, runOutbound, OUT_MARKER } from "../scripts/github-door.mjs";

const repo = "Uuriko/project-room";

test("only trusted, non-empty, non-digest comments enter the room", () => {
  const allow = parseAllowlist("codex-cloud[bot], Some-Agent");
  assert.deepEqual(parseDoorComment({ body: "hi room", login: "uuriko", association: "OWNER" }), { text: "hi room" });
  assert.equal(parseDoorComment({ body: "hi", login: "stranger", association: "NONE" }), null);
  assert.deepEqual(parseDoorComment({ body: "hi", login: "some-agent", association: "NONE" }, { allow }), { text: "hi" });
  assert.equal(parseDoorComment({ body: "hi", login: "github-actions[bot]", association: "MEMBER", isBot: true }), null);
  assert.deepEqual(parseDoorComment({ body: "hi", login: "codex-cloud[bot]", association: "NONE", isBot: true }, { allow }), { text: "hi" });
  assert.equal(parseDoorComment({ body: `${OUT_MARKER} seq=3 -->\nx`, login: "uuriko", association: "OWNER" }), null);
  assert.equal(parseDoorComment({ body: "/skip just a note", login: "uuriko", association: "OWNER" }), null);
  assert.equal(parseDoorComment({ body: "/room   ", login: "uuriko", association: "OWNER" }), null);
  assert.deepEqual(parseDoorComment({ body: "/room reply-to: m-1\r\nyes, on it", login: "uuriko", association: "MEMBER" }),
    { text: "yes, on it", replyToId: "m-1" });
});

test("inbound command is attributed, capped and has a stable id", () => {
  const comment = { id: 42, login: "uuriko", url: "https://github.com/x/1#c42" };
  const a = inboundCommand({ repo, comment, parsed: { text: "x".repeat(70000) } });
  assert.equal(a.id, commandIdFor(repo, 42)); assert.equal(a.id, a.data.messageId);
  assert.match(a.data.body, /^\*\*@uuriko\*\* via GitHub \(unverified\): /);
  assert.ok(a.data.body.length <= 65536); assert.ok(a.data.body.endsWith("[source](https://github.com/x/1#c42)"));
  assert.notEqual(commandIdFor(repo, 43), a.id);
});

test("digest skips own and private messages and records the cursor", () => {
  const msgs = [
    { sequence: 5, messageId: "a", from: "door", body: "echo", private: false },
    { sequence: 6, messageId: "b", from: "grok", body: "line1\nline2", private: false },
    { sequence: 7, messageId: "c", from: "muse", body: "secret dm", private: true }
  ];
  const d = outboundDigest(msgs, { roomId: "r", selfMemberId: "door", names: { grok: "Grok" }, cursor: 4 });
  assert.equal(d.cursor, 7); assert.match(d.body, /seq=7 -->/); assert.match(d.body, /\*\*Grok\*\* · `b`\n> line1\n> line2/);
  assert.ok(!d.body.includes("echo")); assert.ok(!d.body.includes("secret dm"));
  assert.equal(readCursor([{ body: d.body }, { body: "<!-- room-door:out seq=3 -->" }]), 7);
  assert.equal(outboundDigest(msgs.slice(0, 1), { roomId: "r", selfMemberId: "door", cursor: 4 }).body, null);
});

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-door-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-door", type: "member.added", data: {
    memberId: "door", displayName: "GitHub door", kind: "agent", permissions: [], accountableHumanId: "owner" } });
  setTier(store.db, "commons", "door", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const token = store.issueAccessKey("commons", "door");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { owner: new RoomAgentClient({ origin, roomId: "commons", token: ownerKey }),
    door: new RoomAgentClient({ origin, roomId: "commons", token }) };
}

test("real Room: a door comment posts once, and a digest mirrors others but not itself", async t => {
  const f = await fixture(t);
  const event = { action: "created", issue: { number: 7 }, comment: { id: 99, html_url: "https://github.com/c/99",
    body: "/room hello from a sandbox", author_association: "OWNER", user: { login: "uuriko", type: "User" } } };
  const first = await runInbound({ event, repo, client: f.door, allow: new Set(), doorIssue: 7 });
  assert.equal(first.posted, true);
  const again = await runInbound({ event, repo, client: f.door, allow: new Set(), doorIssue: 7 });
  assert.equal(again.duplicate, true);
  assert.equal((await runInbound({ event: { ...event, issue: { number: 8 } }, repo, client: f.door, allow: new Set(), doorIssue: 7 })).skipped, "not the door issue");
  const posted = (await f.owner.snapshot()).state.messages.filter(m => m.body.includes("hello from a sandbox"));
  assert.equal(posted.length, 1); assert.equal(posted[0].authorId, "door");

  await f.owner.say("owner says hi to GitHub");
  const comments = []; const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? "GET", url]);
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify(comments), { status: 200 });
    comments.push(JSON.parse(init.body)); return new Response("{}", { status: 201 });
  };
  const out = await runOutbound({ repo, doorIssue: 7, token: "gh-test", client: f.door, roomId: "commons", selfMemberId: "door", fetchImpl });
  assert.equal(out.posted, true);
  assert.match(comments[0].body, /owner says hi to GitHub/); assert.ok(!comments[0].body.includes("hello from a sandbox"));
  const quiet = await runOutbound({ repo, doorIssue: 7, token: "gh-test", client: f.door, roomId: "commons", selfMemberId: "door", fetchImpl });
  assert.equal(quiet.posted, false); assert.equal(comments.length, 1);
  assert.ok(calls.every(([, url]) => url.startsWith("https://api.github.com/repos/Uuriko/project-room/issues/7/comments")));
});
