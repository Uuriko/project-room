import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";
import { AccountClient } from "../src/account-client.js";
import { failureTextWithHint } from "../src/share-links.js";

const html = status => ({
  ok: false,
  status,
  json: async () => { throw new SyntaxError("Unexpected token '<'"); }
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("an HTML 502 or 524 tells a reader the room is busy", async () => {
  for (const status of [502, 524]) {
    const client = new RoomClient({ fetcher: async () => html(status) });
    const error = await client.request("/api/rooms/commons").catch(caught => caught);
    assert.equal(error.status, status);
    assert.equal(error.code, "room_busy");
    assert.match(error.message, /room is busy/i);
    assert.doesNotMatch(error.message, /Unexpected token|<html|failed/i);
  }
});

test("a timed-out post says maybe saved and retries the same idempotency key", async () => {
  const seen = [];
  let abort = true;
  const client = new RoomClient({ fetcher: async (_path, options) => {
    const body = JSON.parse(options.body);
    seen.push({ id: body.id, key: options.headers["Idempotency-Key"] });
    if (abort) {
      abort = false;
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    return json({ duplicate: true, id: body.id });
  } });
  const first = { id: "command-a", type: "message.posted", data: { body: "hello", messageId: "m1" } };
  const error = await client.request("/api/rooms/commons/commands", { method: "POST", data: first }).catch(caught => caught);
  assert.equal(error.code, "maybe_saved");
  assert.equal(error.unconfirmed, true);
  assert.match(error.message, /Maybe saved/);
  assert.doesNotMatch(error.message, /\bfailed\b/i);
  assert.match(failureTextWithHint(error, "Your entries were kept; try again."), /Maybe saved/);
  assert.doesNotMatch(failureTextWithHint(error, "Your entries were kept; try again."), /\bfailed\b/i);

  const retry = { id: "command-b", type: "message.posted", data: { body: "hello", messageId: "m1" } };
  const saved = await client.request("/api/rooms/commons/commands", { method: "POST", data: retry });
  assert.equal(saved.duplicate, true);
  assert.equal(seen[0].key, "command-a");
  assert.equal(seen[1].key, "command-a");
  assert.equal(seen[1].id, "command-a");
  assert.equal(retry.id, "command-a");

  const fresh = { id: "command-c", type: "message.posted", data: { body: "hello", messageId: "m1" } };
  await client.request("/api/rooms/commons/commands", { method: "POST", data: fresh });
  assert.equal(seen[2].id, "command-c", "a confirmed post does not reuse the previous key");
});

test("an HTML 524 on a post is unconfirmed, and a refused post can use a new key", async () => {
  const client = new RoomClient({ fetcher: async () => html(524) });
  const lost = await client.request("/api/rooms/commons/commands", {
    method: "POST", data: { id: "command-a", type: "message.posted", data: { body: "hello" } }
  }).catch(caught => caught);
  assert.equal(lost.status, 524);
  assert.equal(lost.unconfirmed, true);
  assert.match(lost.message, /Maybe saved/);

  const seen = [];
  let refuse = true;
  const refused = new RoomClient({ fetcher: async (_path, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.id);
    if (refuse) {
      refuse = false;
      return json({ error: { code: "invalid_command", message: "That command was refused." } }, 422);
    }
    return json({ ok: true });
  } });
  await assert.rejects(
    refused.request("/api/rooms/commons/commands", { method: "POST", data: { id: "keep-a", type: "message.posted", data: { body: "hello" } } }),
    /refused/
  );
  await refused.request("/api/rooms/commons/commands", { method: "POST", data: { id: "keep-b", type: "message.posted", data: { body: "hello" } } });
  assert.deepEqual(seen, ["keep-a", "keep-b"]);
});

test("account requests hide an HTML 502 the same way", async () => {
  const client = new AccountClient({ fetcher: async () => html(502) });
  const error = await client.request("/api/account-session").catch(caught => caught);
  assert.equal(error.code, "room_busy");
  assert.match(error.message, /room is busy/i);
  assert.doesNotMatch(error.message, /Unexpected token/);
});
