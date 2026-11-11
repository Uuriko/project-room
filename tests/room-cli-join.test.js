import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTool, joinCommand, oneLinePrompt, roomPageUrl, scrub } from "../cli/commands/join.mjs";
import { main } from "../cli/main.mjs";

const SECRET = "pri_" + "A".repeat(43);
const CODE = "RM-ABCDEF123456";

function fakeLogin(result, calls) {
  return async (args, io) => { calls.push(args); io.out(JSON.stringify(result)); return result.status === "connected" ? 0 : 1; };
}

test("one sentence joins, sets up the detected tool, and ends with a shareable invite line", async () => {
  const calls = []; const setups = []; const lines = [];
  const code = await joinCommand([`https://room.example/?invite=${CODE}`, "--name", "Peer"], {
    env: { CLAUDECODE: "1" },
    out: line => lines.push(line),
    login: fakeLogin({ status: "connected", origin: "https://room.example", roomId: "muse-room", memberId: "m1", connection: "peer" }, calls),
    setup: async (args, io) => { setups.push(args); io.out(`Wrote config; token ${SECRET}`); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["--room", `https://room.example/?invite=${CODE}`, "--name", "Peer", "--accept"]);
  assert.equal(setups[0][0], "claude-code");
  const last = lines.at(-1);
  assert.equal(last, oneLinePrompt("https://room.example/r/muse-room"));
  assert.match(last, /^Join my Project Room: run `npx -y github:Uuriko\/project-room join https:\/\/room\.example\/r\/muse-room` and follow what it prints\.$/);
  const all = lines.join("\n");
  assert.doesNotMatch(all, /pri_A/);
  assert.doesNotMatch(all, new RegExp(CODE));
});

test("a join that is not connected prints why, with no invite line and no code", async () => {
  const lines = [];
  const code = await joinCommand([`https://room.example/?invite=${CODE}`], {
    env: {}, out: line => lines.push(line),
    login: fakeLogin({ status: "approval_required", next: `Repeat with ${CODE}` }, []),
    setup: async () => { throw new Error("setup must not run"); },
  });
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Not joined yet \(approval_required\)/);
  assert.doesNotMatch(lines[0], new RegExp(CODE));
});

test("setup failure keeps the join and still prints the invite line", async t => {
  const home = mkdtempSync(join(tmpdir(), "join-codex-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lines = [];
  const code = await joinCommand(["https://room.example/r/open", "--tool", "codex"], {
    env: { HOME: home }, out: line => lines.push(line),
    login: fakeLogin({ status: "connected", origin: "https://room.example", roomId: "open" }, []),
    setup: async () => { throw new Error("boom"); },
  });
  assert.equal(code, 0);
  assert.ok(lines.some(l => /did not finish/.test(l)));
  assert.equal(lines.at(-1), oneLinePrompt("https://room.example/r/open"));
});

test("--no-setup skips tool config; unknown tools are refused", async () => {
  let ran = false;
  await joinCommand(["https://room.example/r/open", "--no-setup"], {
    env: {}, out: () => {},
    login: fakeLogin({ status: "connected", origin: "https://room.example", roomId: "open" }, []),
    setup: async () => { ran = true; return 0; },
  });
  assert.equal(ran, false);
  await assert.rejects(joinCommand(["x", "--tool", "nope"], { out: () => {} }), /Unknown tool/);
  await assert.rejects(joinCommand([], { out: () => {} }), /room join/);
});

test("helpers: tool detection falls back to generic, urls and scrubbing", () => {
  assert.equal(detectTool({}), "generic");
  assert.equal(detectTool({ CODEX_HOME: "/x" }), "codex");
  assert.equal(roomPageUrl("https://room.example/some/path?x=1", "a b"), "https://room.example/r/a%20b");
  assert.equal(scrub(`k ${SECRET} c ${CODE} u https://r.example/?code=zzz`), "k [redacted] c [redacted] u https://r.example/[redacted]");
});

test("room --help lists join", async () => {
  const lines = [];
  await main(["--help"], { out: l => lines.push(l) });
  assert.match(lines.join("\n"), /room join <invite-or-room-url>/);
});

for (const detected of [null, 'CODEX_HOME', 'CODEX_SANDBOX']) test(`join Codex conflict prevents login and setup (${detected ?? 'explicit'})`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'join-codex-conflict-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.codex'));
  const path = join(home, '.codex/config.toml'), before = '["mcp_servers"."project-room"]\nurl="https://existing.example/mcp"\n';
  writeFileSync(path, before);
  let logins = 0, setups = 0, requests = 0;
  await assert.rejects(joinCommand(['https://room.example/join/SYNTHETIC', ...(detected ? [] : ['--tool', 'codex'])], {
    env: { HOME: home, ...(detected ? { [detected]: detected==='CODEX_HOME' ? join(home,'.codex') : 'synthetic' } : {}) },
    out: () => {}, login: async () => { logins++; return 0; }, setup: async () => { setups++; return 0; },
    fetchImpl: async () => { requests++; throw Error('must not contact Room'); },
  }), /Existing Codex config conflicts/);
  assert.equal(logins, 0); assert.equal(setups, 0); assert.equal(requests, 0); assert.equal(readFileSync(path, 'utf8'), before);
});

test('join --no-setup and explicit non-Codex override bypass Codex config preflight', async t => {
  const home = mkdtempSync(join(tmpdir(), 'join-codex-bypass-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.codex'));
  const path = join(home, '.codex/config.toml'), before = '[mcp_servers.project-room]\n'; writeFileSync(path, before);
  for (const args of [['--tool', 'codex', '--no-setup'], ['--no-setup'], ['--tool', 'generic']]) {
    const calls = [], setups = [];
    assert.equal(await joinCommand(['https://room.example/r/open', ...args], {
      env: { HOME: home, CODEX_HOME: 'synthetic' }, out: () => {},
      login: fakeLogin({ status: 'connected', origin: 'https://room.example', roomId: 'open' }, calls),
      setup: async argv => { setups.push(argv); return 0; },
    }), 0);
    assert.equal(calls.length, 1); assert.equal(setups.length, args.includes('--no-setup') ? 0 : 1);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

// Dot seq 25409: choose_room lists survive login's public result and join shows them
// as choices (no auto-selection, no setup), with no secrets and sanitized titles.
test("choose_room prints your rooms and public rooms as choices without setup or secrets", async () => {
  const lines = [], calls = [];
  const result = { status: "choose_room", identityId: "id1", token: SECRET, secret: SECRET,
    memberships: [
      { roomId: "muse-room", title: "Muse\u001b[31m room", memberId: "m1", archivedAt: null, token: SECRET },
      { roomId: "muse-room", title: "Muse dup", memberId: "m1", archivedAt: null },
      { roomId: "old:room", title: "Old", memberId: "m2", archivedAt: "2026-10-01T00:00:00Z" },
    ],
    directory: { rooms: [{ roomId: "open", title: "Open $(rm -rf)", purpose: "p", kind: "team", memberCount: 3, listedAt: 1, joinToken: SECRET }], nextCursor: "c2" },
    next: "Run join again" };
  const code = await joinCommand(["https://room.example/", "--name", "Peer's bot", "--tool", "codex"], {
    env: {}, out: line => lines.push(line), login: fakeLogin(result, calls),
    setup: async () => { throw new Error("setup must not run"); },
  });
  assert.equal(code, 1);
  const all = lines.join("\n");
  assert.match(all, /Your rooms/);
  assert.match(all, /Public rooms — request access/);
  assert.equal((all.match(/#room\/muse-room/g) ?? []).length, 1, "deduped");
  assert.match(all, /Old \(archived; no join command\)/);
  assert.doesNotMatch(all, /#room\/old:room/, "archived rooms get no join/setup command");
  // Untrusted labels never share a line with an executable command.
  for (const line of lines.filter(line => /room join/.test(line))) assert.match(line, /^    room join '/);
  assert.ok(lines.some(line => line === "  Open $(rm -rf) — p"));
  assert.match(all, /https:\/\/room\.example\/#room\/open/);
  assert.doesNotMatch(all, /\/r\//);
  assert.match(all, /--name 'Peer'\\''s bot'/);
  assert.match(all, /--tool codex/);
  assert.match(all, /more public rooms/i);
  assert.doesNotMatch(all, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.doesNotMatch(all, /pri_A/);
});

test("choose_room with no rooms says so and still asks for a room link", async () => {
  const lines = [];
  const code = await joinCommand(["https://room.example/"], {
    env: {}, out: line => lines.push(line),
    login: fakeLogin({ status: "choose_room", identityId: "id1", memberships: [], directory: { rooms: [], nextCursor: null } }, []),
    setup: async () => { throw new Error("setup must not run"); },
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /no rooms yet/i);
  assert.doesNotMatch(lines.join("\n"), /more public rooms/i);
});

test("choose_room with an empty page that has a cursor does not claim there are no rooms", async () => {
  const lines = [];
  await joinCommand(["https://room.example/"], { env: {}, out: line => lines.push(line),
    login: fakeLogin({ status: "choose_room", memberships: [], directory: { rooms: [], nextCursor: "c9" } }, []),
    setup: async () => { throw new Error("setup must not run"); } });
  assert.match(lines.join("\n"), /more public rooms/i);
  assert.doesNotMatch(lines.join("\n"), /no rooms yet/i);
});

test("choose_room with a missing directory says unavailable instead of empty", async () => {
  const lines = [];
  await joinCommand(["https://room.example/"], { env: {}, out: line => lines.push(line),
    login: fakeLogin({ status: "choose_room", memberships: [], directory: "oops" }, []),
    setup: async () => { throw new Error("setup must not run"); } });
  assert.match(lines.join("\n"), /directory is unavailable/);
  assert.doesNotMatch(lines.join("\n"), /no rooms yet/i);
});
