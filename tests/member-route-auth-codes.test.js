// Member-route auth-boundary audit (WAVE-500 guild 6, worker g6-37).
//
// For the 10 highest-traffic member routes under /api/rooms/:roomId, every
// route must answer the three auth cases the same way:
//
//   A. unauthenticated (no credential)        -> 401 unauthenticated
//   B. authenticated, but not a member of an EXISTING room -> 403 access_denied
//   C. authenticated, room id does NOT exist  -> must equal B (403)
//
// Case C differing from case B (e.g. 404 for missing room while an existing
// room you cannot enter returns 403) would be a room-existence oracle: an
// attacker with any valid credential could enumerate room ids. The
// documented contract (docs/openapi.yaml) is 401 = "Invalid or missing
// credential", 403 = "Scope, binding or active membership denied", 404 =
// "No such room, work item, or invitation" — so 404 must be reserved for
// resources, never for the auth decision.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const EXISTING_OTHER_ROOM = "otherroom";
const MISSING_ROOM = "room-that-does-not-exist";

// The 10 highest-traffic member routes (read the room, live stream, event
// log, history, chat post, updates, work claims, land queue, presence).
const ROUTES = [
  ["GET", r => `/api/rooms/${r}`],
  ["GET", r => `/api/rooms/${r}/stream`],
  ["GET", r => `/api/rooms/${r}/events`],
  ["GET", r => `/api/rooms/${r}/conversation`],
  ["POST", r => `/api/rooms/${r}/commands`],
  ["GET", r => `/api/rooms/${r}/updates`],
  ["GET", r => `/api/rooms/${r}/work-claims`],
  ["POST", r => `/api/rooms/${r}/work-claims`],
  ["GET", r => `/api/rooms/${r}/list_land_queue`],
  ["GET", r => `/api/rooms/${r}/presence`],
  // Room files ride their own auth block (separate from the big section).
  ["GET", r => `/api/rooms/${r}/files`],
];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-auth-codes-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons", "owner"));
  store.initialize(initialRoom(EXISTING_OTHER_ROOM, "owner2"));
  const commonsKey = store.issueAccessKey("commons", "owner");
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
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { request, commonsKey };
}

const errorOf = async res => {
  const body = await res.json().catch(() => ({}));
  return { status: res.status, code: body?.error?.code };
};

for (const [method, pathFor] of ROUTES) {
  test(`${method} ${pathFor(":roomId")}: unauthenticated -> 401, non-member -> 403, missing room matches non-member`, async t => {
    const { request, commonsKey } = await serve(t);
    const label = `${method} ${pathFor(":roomId")}`;
    const data = method === "POST" ? {} : undefined;

    // A. No credential at all.
    const anon = await errorOf(await request(pathFor("commons"), { method, data }));
    assert.equal(anon.status, 401, `${label}: unauthenticated must be 401, got ${anon.status}`);
    assert.equal(anon.code, "unauthenticated", `${label}: unauthenticated code`);

    // B. Valid credential for "commons", but the target room exists and the
    //    caller is not a member of it.
    const other = await errorOf(await request(pathFor(EXISTING_OTHER_ROOM), { method, data, token: commonsKey }));
    assert.equal(other.status, 403, `${label}: non-member of existing room must be 403, got ${other.status}`);
    assert.equal(other.code, "access_denied", `${label}: non-member code`);

    // C. Valid credential, room id does not exist. Must be IDENTICAL to B —
    //    any 404 here is a room-existence oracle.
    const missing = await errorOf(await request(pathFor(MISSING_ROOM), { method, data, token: commonsKey }));
    assert.deepEqual(
      { status: missing.status, code: missing.code },
      { status: other.status, code: other.code },
      `${label}: missing room answered ${missing.status}/${missing.code} but existing-room non-member answered ${other.status}/${other.code} — existence oracle`,
    );
    assert.equal(missing.status, 403, `${label}: missing room must be 403, got ${missing.status}`);
  });
}
