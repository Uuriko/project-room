import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doingFromToolAction } from "../client/doing-status.mjs";
import { checkHostContext } from "../server/agent-heartbeats.mjs";
import { doingCommand, repoContext, repoFromRemote } from "../cli/commands/doing.mjs";

test("tool actions become short doing lines without paths or arguments", () => {
  assert.equal(doingFromToolAction({ tool_name: "Edit", tool_input: { file_path: "/home/me/src/math.js" } }), "Edit math.js");
  assert.equal(doingFromToolAction({ tool_name: "Write", tool_input: { file_path: "C:\\r\\a.md" } }), "Write a.md");
  assert.equal(doingFromToolAction({ tool_name: "Bash", tool_input: { command: "npm test -- --token=abc" } }), "Run npm");
  assert.equal(doingFromToolAction({ tool_name: "Bash", tool_input: { command: "FOO=secret npm" } }), "Run a command");
  assert.equal(doingFromToolAction({ tool_name: "Grep", tool_input: { pattern: "x" } }), "Search files");
  assert.equal(doingFromToolAction({ tool_name: "mcp__room__room_post_message" }), "room_post_message");
  assert.equal(doingFromToolAction({}), null);
});

test("heartbeat context accepts a doing line and rejects bad ones", () => {
  assert.deepEqual(checkHostContext({ doing: " Edit math.js " }), { doing: "Edit math.js" });
  assert.throws(() => checkHostContext({ doing: "x".repeat(81) }), /doing/);
  assert.throws(() => checkHostContext({ doing: "a\nb" }), /doing/);
});

test("repoFromRemote never carries remote userinfo into presence", () => {
  // FAKE tokens only — these specimens pin the seq 16450 leak shapes.
  assert.equal(repoFromRemote("https://oauth2:FAKE_TOKEN@git.example.com/project.git"), "project");
  assert.equal(repoFromRemote("https://FAKE_TOKEN@git.example.com/project.git"), "project");
  assert.equal(repoFromRemote("https://oauth2:FAKE_TOKEN@git.example.com:8443/project.git"), "project");
  assert.equal(repoFromRemote("https://git.example.com/project.git"), "project");
  // Plain remotes are byte-unchanged.
  assert.equal(repoFromRemote("https://github.com/Uuriko/project-room.git"), "Uuriko/project-room");
  assert.equal(repoFromRemote("https://github.com/Uuriko/project-room"), "Uuriko/project-room");
  assert.equal(repoFromRemote("git@github.com:Uuriko/project-room.git"), "Uuriko/project-room");
  assert.equal(repoFromRemote("ssh://git@github.com/Uuriko/project-room.git"), "Uuriko/project-room");
  assert.equal(repoFromRemote("https://gitlab.example.com/group/sub/project.git"), "sub/project");
  assert.equal(repoFromRemote(""), undefined);
  assert.equal(repoFromRemote(undefined), undefined);
});

test("repoContext on a token-bearing one-segment remote posts no credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-doing-remote-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://oauth2:FAKE_TOKEN@git.example.com/project.git"]);
    const context = repoContext(dir);
    assert.equal(context.repo, "project");
    assert.ok(!JSON.stringify(context).includes("FAKE_TOKEN"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("room doing posts the line from hook JSON as presence context", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, status: 200 }; };
  const stdin = (async function* () { yield JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/x/math.js" } }); })();
  const env = { ROOM_ORIGIN: "https://room.example", ROOM_ID: "r1", PROJECT_ROOM_SECRET: "s" };
  assert.equal(await doingCommand([], { env, cwd: "/", fetchImpl, stdin }), 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/agent-heartbeats$/);
  assert.equal(calls[0].body.context.doing, "Edit math.js");
  assert.equal(calls[0].body.context.activity, "busy");
});
