// Unknown input is refused on search, events, and the five write routes that
// used to ignore it.
// Search: an unknown or repeated key is 422 invalid_search and the message
// names it. cursor is an alias of before. next.before repeats nextCursor.
// Events: since/until need a zone. limit and after are plain integers.
// Typing, wants-work DELETE, and directory seed take no fields. Suppressions
// and the envelope sweep name unknown fields. Malformed JSON is 400.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const EXAMPLE = "2026-10-24T20:30:00Z";
const DEEP_ARRAY = "[".repeat(3000) + "]".repeat(3000);
const DEEP_OBJECT = '{"a":'.repeat(40) + "0" + "}".repeat(40);
const MALFORMED = [["brace", "{"], ["array", "[]"], ["string", '"x"'], ["deep array", DEEP_ARRAY], ["deep object", DEEP_OBJECT]];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-strict-input-"));
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Strict Agent");
  linkWithProof(store, ownerKey, "commons", identity, {
    memberId: "strict-agent",
    displayName: "Strict Agent", permissions: ["accept_work"],
  });
  const agentKey = store.issueAccessKey("commons", "strict-agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", token = ownerKey, body, raw } = {}) => {
    const headers = { Origin: origin, Authorization: `Bearer ${token}` };
    let payload;
    if (raw !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = raw;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return fetch(origin + path, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
  };
  const postMessage = text => {
    clock += 2000;
    return store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body: text },
    }).event.data.messageId;
  };
  return { request, ownerKey, agentKey, postMessage };
}

async function errorOf(response) {
  const payload = await response.json();
  return { status: response.status, code: payload.error?.code, message: payload.error?.message ?? "" };
}

test("search names unknown and repeated keys, and cursor walks every match", async t => {
  const { request, postMessage } = await serve(t);
  const ids = [];
  for (let i = 0; i < 44; i += 1) ids.push(postMessage(`q9page note ${i}`));

  const unknown = await errorOf(await request("/api/rooms/commons/search?q=q9page&kind=messages&bogus=1&after=3"));
  assert.equal(unknown.status, 422);
  assert.equal(unknown.code, "invalid_search");
  assert.match(unknown.message, /bogus/);
  assert.match(unknown.message, /after/);

  const repeated = await errorOf(await request("/api/rooms/commons/search?q=q9page&q=other&kind=messages"));
  assert.equal(repeated.status, 422);
  assert.equal(repeated.code, "invalid_search");
  assert.match(repeated.message, /\bq\b/);

  const both = await errorOf(await request("/api/rooms/commons/search?q=q9page&kind=messages&before=abc&cursor=def"));
  assert.equal(both.status, 422);
  assert.equal(both.code, "invalid_search");
  assert.match(both.message, /before or cursor/);

  const auth = await request("/api/rooms/commons/search?q=q9page&kind=messages&limit=10&auth=room");
  assert.equal(auth.status, 200);
  const repeatedAuth = await errorOf(await request("/api/rooms/commons/search?q=q9page&auth=room&auth=account"));
  assert.equal(repeatedAuth.status, 422);
  assert.match(repeatedAuth.message, /auth/);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const path = `/api/rooms/commons/search?q=q9page&kind=messages&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await request(path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 44);
    assert.ok(body.messages.length > 0 && body.messages.length <= 10);
    if (body.nextCursor) assert.deepEqual(body.next, { before: body.nextCursor });
    else assert.equal(Object.hasOwn(body, "next"), false);
    if (pages === 0 && body.nextCursor) {
      const viaBefore = await (await request(`/api/rooms/commons/search?q=q9page&kind=messages&limit=10&before=${encodeURIComponent(body.nextCursor)}`)).json();
      const viaCursor = await (await request(`/api/rooms/commons/search?q=q9page&kind=messages&limit=10&cursor=${encodeURIComponent(body.next.before)}`)).json();
      assert.deepEqual(viaCursor.messages.map(hit => hit.id), viaBefore.messages.map(hit => hit.id));
      assert.notDeepEqual(viaCursor.messages.map(hit => hit.id), body.messages.map(hit => hit.id));
    }
    seen.push(...body.messages.map(hit => hit.id));
    cursor = body.nextCursor ?? null;
    pages += 1;
    assert.ok(pages <= 5);
  } while (cursor);
  assert.equal(pages, 5);
  assert.equal(seen.length, 44);
  assert.equal(new Set(seen).size, 44);
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("events require a zoned timestamp and a plain integer limit and after", async t => {
  const { request, postMessage } = await serve(t);
  postMessage("q9 event note");
  const timestamp = async (query, field) => {
    const body = await errorOf(await request(`/api/rooms/commons/events?${query}`));
    assert.equal(body.status, 422, query);
    assert.equal(body.code, "invalid_event_cursor", query);
    assert.match(body.message, new RegExp(field), query);
    assert.match(body.message, new RegExp(EXAMPLE), query);
  };
  await timestamp("since=2026-10-24T20:30:00", "since");
  await timestamp("since=2026-10-24", "since");
  await timestamp("until=2026-10-24", "until");
  await timestamp("since=2026-02-31T00:00:00Z", "since");

  const reversed = await errorOf(await request("/api/rooms/commons/events?since=2026-10-24T20:30:01-07:00&until=2026-10-25T03:30:00Z"));
  assert.equal(reversed.status, 422);
  assert.equal(reversed.code, "invalid_event_cursor");
  assert.equal(reversed.message, "since is after until");

  const future = await (await request("/api/rooms/commons/events?since=2099-01-01T00:00:00Z")).json();
  assert.equal(future.events.length, 0);
  const offset = await request("/api/rooms/commons/events?since=2020-01-01T00:00:00-07:00&until=2099-01-01T00:00:00Z");
  assert.equal(offset.status, 200);
  assert.ok((await offset.json()).events.length > 0);
  const sameInstant = await request("/api/rooms/commons/events?since=2026-10-24T20:30:00-07:00&until=2026-10-25T03:30:00Z");
  assert.equal(sameInstant.status, 200);

  for (const query of ["limit=1e2", "limit=%2010", "limit=200", "limit=01", "limit=0"]) {
    const body = await errorOf(await request(`/api/rooms/commons/events?${query}`));
    assert.equal(body.status, 422, query);
    assert.equal(body.code, "invalid_event_cursor", query);
    assert.equal(body.message, "limit must be an integer from 1 to 100", query);
  }
  for (const query of ["after=01", "after=1e2", "after=%2010", "after=-1", "after=1.5"]) {
    const body = await errorOf(await request(`/api/rooms/commons/events?${query}`));
    assert.equal(body.status, 422, query);
    assert.equal(body.code, "invalid_event_cursor", query);
    assert.equal(body.message, "after must be an integer of 0 or more", query);
  }
  assert.equal((await request("/api/rooms/commons/events?after=0&limit=1")).status, 200);
  assert.equal((await request("/api/rooms/commons/events?limit=100")).status, 200);
});

test("typing, wants-work delete, and directory seed refuse a bad body and accept an empty one", async t => {
  const { request, agentKey } = await serve(t);
  const routes = [
    ["POST", "/api/rooms/commons/typing", "owner", "invalid_body"],
    ["DELETE", "/api/rooms/commons/members/me/wants-work", "agent", "invalid_request"],
    ["POST", "/api/rooms/commons/directory/seed", "owner", "invalid_body"],
  ];
  for (const [method, path, who, code] of routes) {
    const token = who === "agent" ? agentKey : undefined;
    for (const [label, raw] of MALFORMED) {
      const body = await errorOf(await request(path, { method, token, raw }));
      assert.equal(body.status, 400, `${method} ${path} ${label}`);
      assert.equal(body.code, "invalid_json", `${method} ${path} ${label}`);
    }
    const unknown = await errorOf(await request(path, { method, token, body: { extra: 1 } }));
    assert.equal(unknown.status, 422, `${method} ${path}`);
    assert.equal(unknown.code, code, `${method} ${path}`);
    assert.match(unknown.message, /extra/, `${method} ${path}`);
    const oversized = await errorOf(await request(path, { method, token, raw: '{"a":'.repeat(3000) + "0" + "}".repeat(3000) }));
    assert.equal(oversized.status, 413, `${method} ${path}`);
    assert.equal(oversized.code, "too_large", `${method} ${path}`);
  }

  const beat = await request("/api/rooms/commons/typing", { method: "POST" });
  assert.equal(beat.status, 200);
  assert.equal((await beat.json()).ok, true);

  const set = await request("/api/rooms/commons/members/me/wants-work", {
    method: "PUT", token: agentKey, body: { labels: ["docs"] },
  });
  assert.equal(set.status, 200, JSON.stringify(await set.clone().json()));
  const kept = await errorOf(await request("/api/rooms/commons/members/me/wants-work", {
    method: "DELETE", token: agentKey, raw: "{",
  }));
  assert.equal(kept.status, 400);
  const still = await (await request("/api/rooms/commons/members/me/wants-work", { token: agentKey })).json();
  assert.deepEqual(still.wantsWork.labels, ["docs"]);
  const cleared = await request("/api/rooms/commons/members/me/wants-work", { method: "DELETE", token: agentKey });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).wantsWork, null);

  const seeded = await request("/api/rooms/commons/directory/seed", { method: "POST" });
  assert.equal(seeded.status, 200);
  assert.deepEqual((await seeded.json()).seeded, ["strict-agent"]);
});

test("suppressions and envelope sweep name unknown fields and refuse malformed JSON", async t => {
  const { request } = await serve(t);
  const routes = [
    ["PUT", "/api/rooms/commons/next-actions-suppressions"],
    ["POST", "/api/rooms/commons/collab/envelopes/sweep"],
  ];
  for (const [method, path] of routes) {
    for (const [label, raw] of MALFORMED) {
      const body = await errorOf(await request(path, { method, raw }));
      assert.equal(body.status, 400, `${method} ${path} ${label}`);
      assert.equal(body.code, "invalid_json", `${method} ${path} ${label} ${body.message}`);
    }
    const unknown = await errorOf(await request(path, { method, body: { extra: 1 } }));
    assert.equal(unknown.status, 422, `${method} ${path} ${unknown.message}`);
    assert.equal(unknown.code, "invalid_input");
    assert.match(unknown.message, /extra/);
    const oversized = await errorOf(await request(path, { method, raw: '{"a":'.repeat(3000) + "0" + "}".repeat(3000) }));
    assert.equal(oversized.status, 413, `${method} ${path}`);
    assert.equal(oversized.code, "too_large");
  }
  const nested = await errorOf(await request("/api/rooms/commons/next-actions-suppressions", {
    method: "PUT", body: { suppressions: [{ kind: "note", extra: true }] },
  }));
  assert.equal(nested.status, 422);
  assert.match(nested.message, /extra/);
  const replaced = await request("/api/rooms/commons/next-actions-suppressions", {
    method: "PUT", body: { suppressions: [{ kind: "note" }] },
  });
  assert.equal(replaced.status, 200, JSON.stringify(await replaced.clone().json()));
  const emptySweep = await request("/api/rooms/commons/collab/envelopes/sweep", { method: "POST" });
  assert.equal(emptySweep.status, 200);
  assert.deepEqual((await emptySweep.json()).swept, { expired: [], escalated: [] });
  const blank = await errorOf(await request("/api/rooms/commons/next-actions-suppressions", { method: "PUT", raw: "" }));
  assert.equal(blank.status, 400);
  assert.equal(blank.code, "invalid_json");
});
