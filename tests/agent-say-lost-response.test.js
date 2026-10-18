// QA r16 (agent on a flaky network): `agent-inbox say` posts through
// RoomAgentClient.say(), which mints a fresh command id per call. When the
// connection drops after the Room saved the post, the CLI printed
// "Could not complete the request. Check the service address and retry." with
// the hint "Unknown error 'service_unavailable' ... no known recovery".
// Following that advice posted the message twice. A lost response must say the
// outcome is unknown and point at a read before any write is repeated.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient, RoomClientError } from "../client/room-agent.mjs";
import { connectionDiagnostic } from "../client/agent-connection.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test("a lost say response warns that the post may already be saved", async t => {
  const f = createAcceptanceFixture();
  f.store.roomFlood = { consume() {} };
  const ident = f.store.identities.create("Flaky agent");
  linkWithProof(f.store, f.keys.owner, "commons", ident, { permissions: ["accept_work"] });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let dropNextWrite = true;
  const fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (dropNextWrite && options?.method === "POST" && String(url).endsWith("/commands")) {
      dropNextWrite = false; await response.arrayBuffer(); throw new TypeError("fetch failed");
    }
    return response;
  };
  const client = new RoomAgentClient({ origin, roomId: "commons", token: ident.secret, fetchImpl });
  let caught;
  try { await client.say("flaky network hello"); } catch (error) { caught = error; }
  assert.ok(caught, "the dropped response surfaces as an error");
  const read = await fetch(origin + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json",
    authorization: "Bearer " + ident.secret }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "room_read_messages", arguments: { roomId: "commons", after: 0, limit: 100 } } }) }).then(r => r.json());
  const saved = JSON.parse(read.result.content[0].text).messages.filter(m => m.body === "flaky network hello").length;
  assert.equal(saved, 1, "the Room saved the post even though the response was lost");
  const diagnostic = connectionDiagnostic(caught);
  assert.equal(diagnostic.code, "service_unavailable");
  assert.doesNotMatch(diagnostic.hint, /Unknown error/, "a dropped connection is a known case, not an unknown code");
  assert.match(diagnostic.hint, /may already have (been )?saved|may already be saved/i);
  assert.match(diagnostic.hint, /before (repeating|retrying)/i);
  assert.ok(diagnostic.next.some(step => step.tool === "room_check_access"));
  assert.ok(diagnostic.next.some(step => /agent-inbox\.mjs find /.test(step.command ?? "")), "next names a read that finds the post");
});

test("a timeout is also an unknown outcome", () => {
  const diagnostic = connectionDiagnostic(new DOMException("slow", "TimeoutError"));
  assert.equal(diagnostic.code, "request_timeout");
  assert.match(diagnostic.hint, /may already/i);
});

test("a refused write keeps the shared guidance: nothing was saved", () => {
  const diagnostic = connectionDiagnostic(new RoomClientError(409, "something_new", "Refused"));
  assert.equal(diagnostic.code, "service_unavailable");
  assert.doesNotMatch(diagnostic.hint, /may already/i);
});
