import test from "node:test";
import assert from "node:assert/strict";
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

test("setup failure keeps the join and still prints the invite line", async () => {
  const lines = [];
  const code = await joinCommand(["https://room.example/r/open", "--tool", "codex"], {
    env: {}, out: line => lines.push(line),
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
