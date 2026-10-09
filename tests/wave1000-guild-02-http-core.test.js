import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// wave1000 guild-02 (http-core slice) mutation-regression tests.
// Each test pins a boundary a survived mutant moved:
//   M04 readText declared-bytes check (> vs >=) at the 16 KiB JSON cap,
//   M05 securityContactFrom CRLF rejection (header-injection guard),
//   M08 security.txt HEAD allowance,
//   M10 body() JSON-array rejection.
// Fail-first: every test was verified to FAIL on its mutant and PASS here.
// (M02, M11, M15 survived as EQUIVALENT mutants — see findings/guild-02/mutants.md.)

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-g02-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner", 30 * 86400000);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerToken };
}

const post = (origin, body, token) => fetch(`${origin}/api/rooms/commons/commands`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body,
});

test("readText: a declared body exactly at the route cap is accepted (M04)", async t => {
  // The commands route reads with limit MAX_MESSAGE_COMMAND_BYTES (512 KiB);
  // the mutant flips readText's declared-bytes check from > to >=, so an
  // exactly-at-limit body must be accepted here and 413 only above the cap.
  const LIMIT = 512 * 1024;
  const { origin, ownerToken } = await serve(t);
  const atLimit = `{"a":"${"x".repeat(LIMIT - 8)}"}`;
  assert.equal(Buffer.byteLength(atLimit), LIMIT);
  const ok = await post(origin, atLimit, ownerToken);
  // Body accepted and parsed -> the route runs (never 413).
  assert.notEqual(ok.status, 413);
  const over = `{"a":"${"x".repeat(LIMIT + 1 - 8)}"}`;
  assert.equal(Buffer.byteLength(over), LIMIT + 1);
  const big = await post(origin, over, ownerToken);
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.code, "too_large");
});

test("securityContactFrom: a contact with CRLF is rejected, security.txt 404s (M05)", async t => {
  const { origin } = await serve(t);
  const prev = process.env.ROOM_SECURITY_CONTACT;
  // No colon may appear: with a colon the downstream scheme check rejects it
  // anyway, so the CRLF guard's distinguishing input is a colon-free CRLF
  // (still a response-splitting vector via \r\n\r\n).
  process.env.ROOM_SECURITY_CONTACT = "security@example.com\r\n\r\ninjected";
  try {
    const res = await fetch(`${origin}/.well-known/security.txt`);
    assert.equal(res.status, 404);
  } finally {
    if (prev === undefined) delete process.env.ROOM_SECURITY_CONTACT;
    else process.env.ROOM_SECURITY_CONTACT = prev;
  }
});

test("security.txt: HEAD is allowed and returns 200 with no body (M08)", async t => {
  const { origin } = await serve(t);
  const prev = process.env.ROOM_SECURITY_CONTACT;
  process.env.ROOM_SECURITY_CONTACT = "security@example.com";
  try {
    const head = await fetch(`${origin}/.well-known/security.txt`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const get = await fetch(`${origin}/.well-known/security.txt`);
    assert.equal(get.status, 200);
    assert.match(await get.text(), /^Contact: mailto:security@example\.com\n/);
  } finally {
    if (prev === undefined) delete process.env.ROOM_SECURITY_CONTACT;
    else process.env.ROOM_SECURITY_CONTACT = prev;
  }
});

test("body(): a JSON array is rejected 400 invalid_json (M10)", async t => {
  const { origin, ownerToken } = await serve(t);
  const res = await post(origin, "[]", ownerToken);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_json");
});
