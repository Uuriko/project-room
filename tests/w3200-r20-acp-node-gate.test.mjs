// W3200 R-20: room-acp must refuse the invite/connect flow on a Node older
// than the package's declared engines floor (>=24.19.0) BEFORE any invite
// probe, redemption, agent probe or other network mutation — a mid-join
// failure can burn a single-use invite. Test seam: main(argv, io) accepts
// io.nodeVersion to force the version the gate sees (production defaults
// to process.version). Modules under test are imported dynamically, after
// any local fixture writes, so this file also runs in sandboxes that
// restrict writes from processes that loaded the credential-handling
// modules.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

const LINK = "https://room.trydemigod.com/join/RM-ABCDEFGHJKMNPQRS";

function freshEnv() {
  const home = mkdtempSync(pathJoin(tmpdir(), "room-acp-home-"));
  return { ...process.env, ROOM_ACP_HOME: home };
}

for (const version of ["v22.14.0", "v24.18.9"]) {
  test(`join refuses on Node ${version} before touching the invitation`, async () => {
    const { main } = await import("../room-acp/src/cli.mjs");
    const { loadConnection } = await import("../room-acp/src/credentials.mjs");
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls++; throw new Error("network touched"); };
    const env = freshEnv();
    const lines = [];
    const code = await main([LINK, "--name", "Coder"], {
      print: line => lines.push(line), env, joinOnly: true, fetchImpl, nodeVersion: version,
    });
    assert.equal(code, 1, lines.join("\n"));
    assert.match(lines.join("\n"), /Node\.js 24\.19 or newer/);
    assert.match(lines.join("\n"), /nodejs\.org|nvm/);
    assert.match(lines.join("\n"), /invitation has not been used/);
    assert.equal(fetchCalls, 0, "no invite probe/redemption may happen before the gate");
    assert.equal(loadConnection({}, env), null, "no connection may be saved");
  });
}

for (const version of ["v24.19.0", "v25.2.0"]) {
  test(`satisfying Node ${version} is not refused by the gate (flow reaches fetch)`, async () => {
    const { main } = await import("../room-acp/src/cli.mjs");
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls++; throw new Error("network touched"); };
    const lines = [];
    const code = await main([LINK, "--name", "Coder"], {
      print: line => lines.push(line), env: freshEnv(), joinOnly: true, fetchImpl, nodeVersion: version,
    });
    assert.equal(code, 1, lines.join("\n")); // the stub fetch fails the join, not the gate
    assert.ok(fetchCalls > 0, "the flow proceeded past the gate to the invitation probe");
    assert.doesNotMatch(lines.join("\n"), /Node\.js 24\.19 or newer/);
  });
}

test("join proceeds end to end on a satisfying version (real Room fixture)", async t => {
  const { main } = await import("../room-acp/src/cli.mjs");
  const { loadConnection } = await import("../room-acp/src/credentials.mjs");
  const { startRoom } = await import("./room-acp-fixture.mjs");
  const room = await startRoom(t);
  const { link } = room.invite();
  const lines = [];
  const code = await main([link, "--name", "Coder"], {
    print: line => lines.push(line), env: room.env, joinOnly: true, nodeVersion: "v24.19.0",
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(loadConnection({}, room.env)?.roomId, "commons");
});

test("splitCommand honours single-quoted segments with spaces", async () => {
  const { splitCommand } = await import("../room-acp/src/agents.mjs");
  assert.deepEqual(splitCommand("'/a b/node' 'x y.mjs'"), { command: "/a b/node", args: ["x y.mjs"] });
  assert.deepEqual(splitCommand(`"/a b/node" 'arg one' plain`), { command: "/a b/node", args: ["arg one", "plain"] });
  // Existing double-quote behaviour is unchanged.
  assert.deepEqual(splitCommand('"/a b/node" x.mjs'), { command: "/a b/node", args: ["x.mjs"] });
});
