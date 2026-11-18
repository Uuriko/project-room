import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../cli/main.mjs";
import { connectionHome, connectionsRoot, writePointer } from "../cli/paths.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

test("room submit uses two calls and reconciles lost replies without duplicate writes", async t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "room-submit-"));
  const env = { HOME: home, PROJECT_ROOM_KEYCHAIN: "0" };
  const store = new RoomStore(join(home, "fixture.sqlite"));
  store.initialize(initialRoom(), { representation: "normalized-current-v1" });
  const owner = store.issueAccessKey("commons", "owner");
  const producer = store.identities.create("Producer");
  linkWithProof(store, owner, "commons", producer, {
    displayName: "Producer", permissions: ["accept_work", "complete_work"]
  });
  setTier(store.db, "commons", producer.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(connectionsRoot(env), { recursive: true, mode: 0o700 });
  const directory = connectionHome("producer", env);
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons",
    memberId: producer.identityId, token: producer.secret });
  writePointer("producer", directory, env);
  const rpc = async (name, args) => {
    const response = await fetch(origin + "/mcp", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + producer.secret },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: { roomId: "commons", ...args } } }) });
    const data = await response.json();
    assert.equal(data.error, undefined);
    assert.notEqual(data.result?.isError, true, JSON.stringify(data));
    return data.result.structuredContent;
  };
  const prepare = async workItemId => {
    store.command(owner, "commons", { id: "propose-" + workItemId, type: "work.proposed", data: {
      workItemId, title: "Review the evidence", definitionOfDone: "Test the exact pickup",
      accountableMemberId: producer.identityId, mode: "read",
      independentVerificationRequired: false, ownerDecisionRequired: false
    } });
    await rpc("room_begin_work", { workItemId });
    const read = await rpc("room_read_work", { workItemId });
    return { body: "The exact contribution.", summary: "Checked the evidence", nextAction: "Read the contribution",
      producerId: producer.identityId, expectedRevision: read.work.revision };
  };
  const run = async (workItemId, intent, failAfter = "") => {
    const calls = [];
    const outputs = [];
    const code = await main(["submit", workItemId, "--operation", workItemId], {
      cwd: home, env, stdin: Readable.from([JSON.stringify(intent)]), out: value => outputs.push(JSON.parse(value)),
      fetchImpl: async (url, init) => {
        const name = JSON.parse(init.body).params.name;
        calls.push(name);
        const response = await fetch(url, init);
        if (name === failAfter) {
          await response.arrayBuffer();
          throw new Error("simulated lost reply after server handled request");
        }
        return response;
      }
    });
    assert.equal(outputs.length, 1);
    assert.doesNotMatch(JSON.stringify(outputs[0]), /The exact contribution/);
    return { code, output: outputs[0], calls };
  };

  const normal = await prepare("normal");
  assert.equal((await run("normal", { ...normal, maxCodeUnits: 5 })).output.code, "result_too_large");
  const first = await run("normal", normal);
  assert.equal(first.code, 0, JSON.stringify(first));
  assert.deepEqual(first.calls, ["room_post_message", "room_submit_text_result"]);
  assert.equal(first.output.currentStateVerified, false);
  const observed = await rpc("room_read_result", first.output.next.arguments);
  assert.equal(observed.result.text.body, normal.body);

  const draft = await prepare("lost-draft");
  assert.equal((await run("lost-draft", draft, "room_post_message")).output.status, "unknown");
  const recoveredDraft = await run("lost-draft", draft);
  assert.equal(recoveredDraft.code, 0, JSON.stringify(recoveredDraft));
  assert.deepEqual(recoveredDraft.calls, ["room_post_message", "room_read_result", "room_submit_text_result"]);

  const completion = await prepare("lost-completion");
  assert.equal((await run("lost-completion", completion, "room_submit_text_result")).output.status, "unknown");
  const recordedThrough = store.headSequence("commons");
  assert.equal((await run("lost-completion", { ...completion, summary: "Changed intent" })).output.code,
    "operation_input_changed");
  const recoveredCompletion = await run("lost-completion", completion);
  assert.equal(recoveredCompletion.code, 0, JSON.stringify(recoveredCompletion));
  assert.deepEqual(recoveredCompletion.calls, ["room_submit_text_result"]);
  assert.equal(recoveredCompletion.output.duplicate, true);
  assert.equal(store.headSequence("commons"), recordedThrough);

  const changed = await prepare("changed-after-draft");
  assert.equal((await run("changed-after-draft", changed, "room_post_message")).output.status, "unknown");
  await rpc("room_block_work", { workItemId: "changed-after-draft", reason: "New requirement",
    nextAction: "Revisit the fixture" });
  const stale = await run("changed-after-draft", changed);
  assert.equal(stale.output.code, "draft_recorded_basis_unavailable");
  assert.deepEqual(stale.calls, ["room_post_message", "room_read_result"]);
});
