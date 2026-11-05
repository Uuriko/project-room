import test from "node:test";
import assert from "node:assert/strict";
import { gitRemoteEnabled, encodePktLine, parsePktLines, parseReceivePackCommands, advertiseRefs } from "../server/git-remote.mjs";

const A = "a".repeat(40), Z = "0".repeat(40);

test("flag is off by default", () => {
  assert.equal(gitRemoteEnabled({}), false);
  assert.equal(gitRemoteEnabled({ ROOM_GIT_REMOTE: "true" }), false);
  assert.equal(gitRemoteEnabled({ ROOM_GIT_REMOTE: "1" }), true);
});

test("pkt-line round trip", () => {
  const wire = encodePktLine("hello\n") + encodePktLine(null) + "PACK";
  assert.equal(encodePktLine("hello\n"), "000ahello\n");
  const { lines, rest } = parsePktLines(wire);
  assert.deepEqual(lines, ["hello\n", null]);
  assert.equal(wire.slice(rest), "PACK");
  assert.throws(() => parsePktLines("zzzz"));
  assert.throws(() => parsePktLines("000ahi"));
});

test("receive-pack commands only allow refs/heads/room/*", () => {
  const { commands, capabilities } = parseReceivePackCommands([`${Z} ${A} refs/heads/room/claude/fix\0report-status`, null]);
  assert.equal(commands[0].create, true);
  assert.deepEqual(capabilities, ["report-status"]);
  for (const ref of ["refs/heads/main", "refs/heads/room/../main", "refs/tags/x", "refs/heads/room/a.lock"])
    assert.throws(() => parseReceivePackCommands([`${Z} ${A} ${ref}`, null]));
  assert.throws(() => parseReceivePackCommands([null]));
});

test("advertisement for empty repo", () => {
  const out = advertiseRefs("git-receive-pack");
  assert.match(out, /^001f# service=git-receive-pack\n0000/);
  assert.match(out, /capabilities\^\{\}\0report-status/);
  assert.ok(out.endsWith("0000"));
  assert.throws(() => advertiseRefs("git-evil"));
});

test("status route answers 404 while ROOM_GIT_REMOTE is off and the phase when on", async () => {
  const { GIT_REMOTE_ROUTES } = await import("../server/routes/git-remote.mjs");
  const [row] = GIT_REMOTE_ROUTES;
  const calls = [];
  const ctx = { res: {}, json: (_res, status, body) => { calls.push({ status, body }); return true; } };
  const prior = process.env.ROOM_GIT_REMOTE;
  try {
    delete process.env.ROOM_GIT_REMOTE;
    row.handler(ctx);
    process.env.ROOM_GIT_REMOTE = "1";
    row.handler(ctx);
  } finally {
    if (prior === undefined) delete process.env.ROOM_GIT_REMOTE; else process.env.ROOM_GIT_REMOTE = prior;
  }
  assert.equal(calls[0].status, 404);
  assert.equal(calls[0].body.error, "git_remote_disabled");
  assert.equal(calls[1].status, 200);
  assert.equal(calls[1].body.phase, 0);
});
