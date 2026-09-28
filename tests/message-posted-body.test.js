// message.posted field trap: agents send data.text (or omit body) and used to
// get "Unexpected field: text" or a reducer "missing body" with a generic hint.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { validateCommand } from "../server/store.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const MESSAGE = "message.posted requires data.body (a string), not text";

function refusesBody(data) {
  assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, data }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_command");
    assert.equal(error.message, MESSAGE);
    return true;
  });
}

test("message.posted names data.body when text is sent or body is missing", () => {
  refusesBody({ text: "hello" });
  refusesBody({ text: "hello", messageId: "m1" });
  refusesBody({ text: "hello", body: "also sent" });
  refusesBody({ messageId: "m1" });
  refusesBody({});
  refusesBody({ body: "  " });
  refusesBody({ body: null });
  assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: 7 } }), /Invalid field: body/);
  assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, text: "hello", data: { body: "hello" } }), /Supply only id, type, data/);
  assert.throws(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_EDITED, data: { text: "hello" } }), /Unexpected field: text/);
  assert.doesNotThrow(() => validateCommand({ id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "hello" } }));

  const ax = agentErrorAx({ httpStatus: 422, code: "invalid_command", message: MESSAGE, roomId: "commons" });
  assert.equal(ax.status, "action_required");
  assert.equal(ax.reason, "input_refused");
  assert.match(ax.hint, /data\.body \(a string\), not text/);
  assert.ok(ax.hint.length < 160);
  assert.ok(validAgentNext(ax.next));
  assert.ok(ax.next.some(step => step.path === "/api/rooms/commons/commands"));
  assert.ok(ax.next.some(step => /data\.body \(a string\), not text/.test(step.command || "")));
  const generic = agentErrorAx({ httpStatus: 422, code: "invalid_command", message: "Unexpected field: channel" });
  assert.match(generic.hint, /Fix the refused fields/);
});

test("POST commands returns a body hint when message.posted sends text", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const post = data => fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.keys.guest}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: randomUUID(), type: T.MESSAGE_POSTED, data })
  });
  for (const data of [{ text: "hello from the wrong field" }, { messageId: "missing-body" }]) {
    const res = await post(data);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_command");
    assert.equal(body.error.message, MESSAGE);
    assert.match(body.hint, /data\.body \(a string\), not text/);
    assert.equal(body.reason, "input_refused");
    assert.ok(validAgentNext(body.next));
    assert.ok(body.next.some(step => step.path === "/api/rooms/commons/commands"));
    assert.ok(body.next.some(step => /data\.body \(a string\), not text/.test(step.command || "")));
    assert.doesNotMatch(body.hint, /Fix the refused fields/);
  }
  const ok = await post({ body: "hello" });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).event.data.body, "hello");
});


test('oversized non-message field has a typed, actionable limit', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const make = title => ({ id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: 'work-field-cap', title, definitionOfDone: 'Done',
    accountableMemberId: 'owner', verifierMemberId: 'owner', mode: 'read',
  } });
  assert.throws(() => f.store.command(f.keys.owner, 'commons', make('x'.repeat(4097))), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'payload_too_large');
    assert.match(error.message, /title must be at most 4096 characters/);
    return true;
  });
  assert.equal(f.store.room('commons').state.workItems['work-field-cap'], undefined);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/commands`, {
    method: 'POST', headers: { Authorization: `Bearer ${f.keys.owner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(make('x'.repeat(4097))),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'payload_too_large');
  assert.match(body.error.message, /title must be at most 4096 characters/);
});
