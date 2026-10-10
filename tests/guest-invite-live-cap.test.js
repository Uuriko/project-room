// D-7 (John's Tab week audit, room seq 7032): the guest-invite mint cap
// counted every guest_invites row ever written, deployment-wide, and nothing
// prunes redeemed/revoked/expired rows. After 5,000 lifetime mints anywhere,
// every room's owner got 409 pilot_limit. The cap now counts only this room's
// live invites (active and still inside redeem_by).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
// Namespace import so the file still loads on a tree without the constant
// (the old 5,000 literal), and the fail-first run shows per-test results.
import * as guestInvites from "../server/guest-invites.mjs";

const LIMIT = guestInvites.GUEST_INVITE_LIVE_LIMIT_PER_ROOM ?? 5000;
const HOUR = 3600 * 1000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-invite-cap-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mint = () => fetch(`${origin}/api/rooms/commons/guest-invites`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID(), guestLabel: "Cap check", expectedOwnerRevision: 0 }),
  });
  return { store, mint, advance: ms => { clock += ms; }, now: () => clock };
}

// Seed rows straight into the table: minting 5,000 through HTTP is slow and
// the cap only reads the table. status/redeem_by decide liveness.
function seed(store, n, { status, redeemBy, createdAt, roomId = "commons" }) {
  const insert = store.db.prepare(`INSERT INTO guest_invites(id, code_hash, room_id, tier, credential_ttl_ms, guest_label,
    minted_by_member_id, minted_by_account_id, issue_request_id, created_at, redeem_by, status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  store.db.exec("BEGIN");
  try {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      insert.run(`gx-seed-${id}`, id.replace(/-/g, "").padEnd(64, "0"), roomId, "observer", 72 * HOUR, "seed",
        "owner", null, `seed-${id}`, createdAt, redeemBy, status);
    }
    store.db.exec("COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

test("5,000 redeemed, revoked and expired invites do not block a new mint", async t => {
  const { store, mint, now } = await serve(t);
  const past = now() - 48 * HOUR;
  const third = Math.ceil(LIMIT / 3);
  seed(store, third, { status: "redeemed", createdAt: past, redeemBy: past + 24 * HOUR });
  seed(store, third, { status: "revoked", createdAt: past, redeemBy: past + 24 * HOUR });
  // Still 'active' in the row but past redeem_by: expired, like list() reports.
  seed(store, LIMIT - 2 * third, { status: "active", createdAt: past, redeemBy: past + 24 * HOUR });
  assert.ok(store.db.prepare("SELECT count(*) n FROM guest_invites").get().n >= LIMIT);
  const res = await mint();
  assert.equal(res.status, 201, `mint refused: ${await res.clone().text()}`);
  const body = await res.json();
  assert.match(body.code, /^GX-/);
});

test("the live cap still holds, and frees up once invites expire", async t => {
  const { store, mint, now, advance } = await serve(t);
  seed(store, LIMIT, { status: "active", createdAt: now(), redeemBy: now() + 24 * HOUR });
  const refused = await mint();
  assert.equal(refused.status, 409);
  const error = await refused.json();
  assert.equal(error.error?.code ?? error.code, "pilot_limit");
  assert.equal(store.db.prepare("SELECT count(*) n FROM guest_invites").get().n, LIMIT, "no row written on refusal");
  advance(25 * HOUR);
  const after = await mint();
  assert.equal(after.status, 201, `mint after expiry refused: ${await after.clone().text()}`);
});

test("live invites in another room do not count against this room", async t => {
  const { store, mint, now } = await serve(t);
  // A second room's rows; foreign keys are relaxed only for this seed so
  // the test doesn't need a whole second room bootstrapped.
  store.db.exec("PRAGMA foreign_keys=OFF");
  try { seed(store, LIMIT, { status: "active", createdAt: now(), redeemBy: now() + 24 * HOUR, roomId: "elsewhere" }); }
  finally { store.db.exec("PRAGMA foreign_keys=ON"); }
  const res = await mint();
  assert.equal(res.status, 201, `mint refused: ${await res.clone().text()}`);
});
