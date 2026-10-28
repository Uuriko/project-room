// QA4: the served OpenAPI document omitted the room event log, the command
// write path, and room search. Those three are how an agent reads and writes
// a room. This checks the generated document and that a live room serves them.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, owner: f.keys.owner };
}

const names = parameters => (parameters ?? []).filter(item => item.in === "query").map(item => item.name);

test("served openapi.json documents room events, commands, and search", async t => {
  const { origin, owner } = await serve(t);
  const doc = await (await fetch(`${origin}/openapi.json`)).json();
  const events = doc.paths["/api/rooms/{roomId}/events"]?.get;
  const commands = doc.paths["/api/rooms/{roomId}/commands"]?.post;
  const search = doc.paths["/api/rooms/{roomId}/search"]?.get;
  assert.equal(events?.operationId, "getRoomEvents");
  assert.deepEqual(names(events?.parameters), ["after", "limit", "actor", "since", "until", "type", "mentions", "compact", "tail"]);
  assert.equal(commands?.operationId, "postRoomCommand");
  assert.deepEqual(commands?.requestBody?.content?.["application/json"]?.schema?.required, ["id", "type", "data"]);
  assert.equal(typeof commands?.responses?.["201"]?.description, "string");
  assert.equal(typeof commands?.responses?.["200"]?.description, "string");
  assert.equal(search?.operationId, "searchRoom");
  const q = (search?.parameters ?? []).find(item => item.name === "q");
  assert.equal(q?.required, true);
  assert.deepEqual(names(search?.parameters), ["q", "kind", "limit", "before"]);

  const headers = { authorization: `Bearer ${owner}` };
  const room = `${origin}/api/rooms/commons`;
  const anonEvents = await fetch(`${room}/events`);
  assert.equal(anonEvents.status, 401);
  const eventPage = await fetch(`${room}/events?after=0&limit=1`, { headers });
  assert.equal(eventPage.status, 200);
  const page = await eventPage.json();
  assert.ok(Array.isArray(page.events));
  assert.equal(typeof page.next, "number");

  const missingQuery = await fetch(`${room}/search`, { headers });
  assert.equal(missingQuery.status, 422);
  const found = await fetch(`${room}/search?q=hello`, { headers });
  assert.equal(found.status, 200);

  const command = { id: "cmd-openapi-1", type: "message.posted", data: { messageId: "msg-openapi-1", body: "hello from the spec" } };
  const post = (body) => fetch(`${room}/commands`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${room}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const created = await post(command);
  assert.equal(created.status, 201);
  const replay = await post(command);
  assert.equal(replay.status, 200);
});
