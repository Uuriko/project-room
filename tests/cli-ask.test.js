import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { askCommand, parseAskArgs } from "../cli/commands/ask.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function setup(t) {
  const fixture = createAcceptanceFixture();
  const identity = fixture.store.identities.create("ask-agent");
  fixture.store.identities.link(fixture.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "helper", displayName: "Helper", permissions: ["accept_work"],
  });
  const asker = fixture.store.identities.create("asker-agent");
  fixture.store.identities.link(fixture.keys.owner, "commons", {
    identityId: asker.identityId, memberId: "asker", displayName: "Asker", permissions: ["accept_work"],
  });
  return { fixture, identity, asker };
}

test("parseAskArgs: default timeout 600s, --fyi and --timeout", () => {
  assert.deepEqual(parseAskArgs(["Helper", "are", "you", "there"]), { agent: "Helper", message: "are you there", timeout: 600, fyi: false });
  assert.equal(parseAskArgs(["@Helper", "x", "--fyi"]).fyi, true);
  assert.equal(parseAskArgs(["Helper", "x", "--timeout", "5"]).timeout, 5);
  assert.throws(() => parseAskArgs(["Helper"]), /room ask/);
  assert.throws(() => parseAskArgs(["Helper", "x", "--timeout", "0"]), /timeout/);
});

test("room ask blocks until the agent replies, then prints the reply", async t => {
  const { fixture, identity, asker } = setup(t);
  const origin = await startServer(t, fixture);
  const env = { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: asker.secret };
  const lines = [];
  let polls = 0;
  const sleep = async () => {
    polls += 1;
    if (polls === 1) {
      fixture.store.command(identity.secret, "commons", { id: randomUUID(), type: "message.posted",
        data: { messageId: randomUUID(), body: "Yes, on it." } });
    }
  };
  const code = await askCommand(["Helper", "can", "you", "check", "CI?"], { env, out: line => lines.push(line), sleep });
  assert.equal(code, 0);
  assert.deepEqual(lines, ["Yes, on it."]);
  const asked = fixture.store.room("commons").state.messages.find(m => m.body === "@Helper can you check CI?");
  assert.ok(asked, "the ask was posted with an @mention");
});

test("room ask times out with exit 3", async t => {
  const { fixture, asker } = setup(t);
  const origin = await startServer(t, fixture);
  const env = { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: asker.secret };
  let clock = 0;
  const lines = [];
  const code = await askCommand(["Helper", "ping", "--timeout", "3"], { env, out: l => lines.push(l), sleep: async () => {}, now: () => (clock += 1000) });
  assert.equal(code, 3);
  assert.match(lines[0], /No reply from Helper within 3s/);
});

test("room ask --fyi posts a silent mention and returns at once", async t => {
  const { fixture, asker } = setup(t);
  const origin = await startServer(t, fixture);
  const env = { ROOM_ORIGIN: origin, ROOM_ID: "commons", PROJECT_ROOM_SECRET: asker.secret };
  const code = await askCommand(["Helper", "deploy", "done", "--fyi"], { env, out: () => {} });
  assert.equal(code, 0);
  assert.ok(fixture.store.room("commons").state.messages.some(m => m.body === "@_Helper deploy done"));
});
