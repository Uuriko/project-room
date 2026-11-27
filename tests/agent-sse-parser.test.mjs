import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const roomId = "commons";
const memberId = "fixture-agent";
const sequence = 20;
const event = {
  id: "fixture-event", actorId: "owner", roomId, type: "message.posted",
  data: { requestKind: "reply", toMemberId: memberId, messageId: "fixture-request", body: "ready 🛠" },
};
const document = JSON.stringify({ sequence, event });
const eventFrame = ({ newline = "\n", data = [document], id = sequence } = {}) =>
  ["event: room-event", "id: " + id, ...data.map(line => "data: " + line), "", ""].join(newline);
const controlFrame = kind => `event: ${kind}\ndata: {}\n\n`;

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey(roomId, "owner");
  const identity = store.identities.create("Fixture");
  linkWithProof(store, owner, roomId, identity, { memberId, permissions: [] });
  const server = createRoomServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const encoder = new TextEncoder();
  return (chunks, { eof = false, after = sequence - 1 } = {}) => {
    let cancelled = 0;
    const client = new RoomAgentClient({
      origin: "http://127.0.0.1:" + server.address().port, roomId, memberId, token: identity.secret,
      fetchImpl(url, options) {
        if (!new URL(url).pathname.endsWith("/stream")) return fetch(url, options);
        const body = new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            if (eof) controller.close();
          },
          cancel() { cancelled++; },
        });
        return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      },
    });
    return { wait: () => client.waitForChange(after, { requestHints: true }), cancellations: () => cancelled };
  };
}

test("agent SSE accepts bare CR, split CRLF, and multiline JSON without losing exact hints", async t => {
  const run = await fixture(t);
  const crlf = eventFrame({ newline: "\r\n" });
  const splitAt = crlf.indexOf("\r") + 1;
  const jsonPieces = [`{"sequence":${sequence},`, `"event":${JSON.stringify(event)}}`];
  const streamBytes = new TextEncoder().encode(eventFrame({ data: jsonPieces }));
  const multibyte = streamBytes.indexOf(0xf0) + 1;
  const notAddressed = JSON.stringify({ sequence: sequence - 1, event: {
    ...event, data: { ...event.data, toMemberId: "other-agent" },
  } });
  const samples = [
    [eventFrame() + controlFrame("access-ended")],
    [crlf.slice(0, splitAt), crlf.slice(splitAt)],
    [eventFrame({ newline: "\r" })],
    [streamBytes.slice(0, multibyte), streamBytes.slice(multibyte)],
  ];
  for (const chunks of samples) {
    const prior = eventFrame({ id: sequence - 1, data: [notAddressed] });
    const valid = run([": keepalive\n\n", prior, ...chunks], { after: sequence - 2 });
    const result = await valid.wait();
    assert.equal(result.sequence, sequence);
    assert.equal(result.requestHint.id, "fixture-request");
    assert.equal(result.requestHint.recipientId, memberId);
    assert.equal(result.requestHint.body, undefined);
    assert.equal(valid.cancellations(), 1);
  }
});

test("agent SSE preserves terminal frames, raw-frame budget, and unfinished EOF", async t => {
  const run = await fixture(t);
  const large = "x".repeat(262144);
  const cases = [
    [[controlFrame("access-ended") + eventFrame()], "access_ended"],
    [[eventFrame({ id: sequence - 1 }) + eventFrame()], "invalid_response"],
    [[eventFrame({ data: [large] })], "invalid_response"],
    [[": " + large.slice(0, 140000) + "\n", ": " + large.slice(140000) + "\n"], "invalid_response"],
  ];
  for (const [chunks, code] of cases) {
    const stream = run(chunks);
    await assert.rejects(stream.wait(), { code });
    assert.equal(stream.cancellations(), 1);
  }
  const lagged = run([controlFrame("stream_lagging") + eventFrame()]);
  assert.deepEqual(await lagged.wait(), { changed: true });
  assert.equal(lagged.cancellations(), 1);
  const unfinished = run([eventFrame().slice(0, -1)], { eof: true });
  assert.deepEqual(await unfinished.wait(), { changed: false, through: sequence - 1 });
});
