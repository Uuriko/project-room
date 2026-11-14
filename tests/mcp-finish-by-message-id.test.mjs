import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("hosted MCP: room_submit_text_result finishes with only the evidence message id", async (t) => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.store.close(); try { rmSync(f.directory, { recursive: true, force: true }); } catch {} });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = f.store.identities.create("FinishAgent");
  linkWithProof(f.store, f.keys.owner, "commons", id, { memberId: "finish-agent", displayName: "FinishAgent", permissions: ["accept_work", "complete_work"] });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: "finish-one", title: "One-call finish",
    definitionOfDone: "Answer in Room", accountableMemberId: "finish-agent", mode: "read" } });
  let n = 0;
  const call = async (name, args) => {
    const r = await fetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + id.secret },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: { roomId: "commons", ...args } } }) });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = JSON.parse(text.match(/data: (.*)/)[1]); }
    return j.result?.structuredContent ?? j;
  };
  const rev = async () => (await call("room_read_work", { workItemId: "finish-one" })).work.revision;
  for (const tool of ["room_accept_work", "room_start_work"]) {
    const out = await call(tool, { requestId: randomUUID(), workItemId: "finish-one", expectedRevision: await rev() });
    assert.equal(out.status, "recorded", JSON.stringify(out));
  }
  const posted = await call("room_post_message", { workItemId: "finish-one", body: "Answer: done in one call." });
  const messageId = posted.command?.data?.messageId ?? posted.messageId;
  assert.ok(messageId, JSON.stringify(posted));
  const done = await call("room_submit_text_result", { requestId: randomUUID(), workItemId: "finish-one", evidenceMessageId: messageId,
    summary: "Answered", nextAction: "Review" });
  assert.equal(done.status, "recorded", JSON.stringify(done));
  assert.match(done.result.evidenceVersion, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await call("room_read_work", { workItemId: "finish-one" })).work.state, "completed");
});
