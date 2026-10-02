// Auth and room-list lookups used to walk whole tables because the primary
// key did not lead with the filter column. These plans are the contract:
// each lookup searches its index, and a database that predates the indexes
// gains them on the next full open.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";

const NOW = Date.parse("2026-10-02T00:00:00.000Z");

const LOOKUPS = [
  {
    index: "identity_links_identity",
    sql: "SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?",
    args: ["identity"],
    search: "identity_links",
    constraint: /identity_id=\?/
  },
  {
    index: "member_accounts_account",
    sql: "SELECT room_id FROM member_accounts WHERE account_id=? AND room_id>? ORDER BY room_id LIMIT 51",
    args: ["account", "room"],
    search: "member_accounts",
    constraint: /account_id=\? AND room_id>\?/
  },
  {
    index: "share_link_joins_slot",
    sql: "SELECT 1 FROM share_link_joins WHERE slot_hash=? LIMIT 1",
    args: ["slot"],
    search: "share_link_joins"
  },
  {
    index: "account_passkey_method",
    sql: "DELETE FROM account_passkey_credentials WHERE method_id=?",
    args: ["method"],
    search: "account_passkey_credentials"
  },
  {
    index: "oauth_pending_slot",
    sql: "DELETE FROM oauth_pending_states WHERE provider=? AND slot_token=?",
    args: ["google", "slot"],
    search: "oauth_pending_states"
  },
  {
    index: "agent_connections_sponsor",
    sql: "SELECT credential_hash FROM agent_connections WHERE sponsor_account_id=?",
    args: ["account"],
    search: "agent_connections"
  },
  {
    index: "private_email_connections_id",
    sql: "SELECT c.account_id FROM private_email_connections c WHERE c.id=?",
    args: ["connection"],
    search: "c"
  },
  {
    index: "public_work_receipts_offer",
    sql: "SELECT receipt_id, identity_id FROM public_work_receipts WHERE offer_id=? AND generation=?",
    args: ["offer", 1],
    search: "public_work_receipts"
  },
  {
    index: "gmail_pending_account",
    sql: "DELETE FROM gmail_pending WHERE account_id=?",
    args: ["account"],
    search: "gmail_pending"
  },
  {
    index: "guest_selfserve_idem_member",
    sql: "DELETE FROM guest_selfserve_idem WHERE member_id=?",
    args: ["member"],
    search: "guest_selfserve_idem"
  }
];

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "room-lookup-indexes-"));
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename, { now: () => NOW });
  try { return fn(store, filename); }
  finally {
    try { store.close(); } catch { /* a reopened handle owns the close */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

function planOf(store, lookup) {
  return store.db.prepare("EXPLAIN QUERY PLAN " + lookup.sql).all(...lookup.args).map(row => row.detail).join("\n");
}

function assertIndexed(store, lookup) {
  const plan = planOf(store, lookup);
  assert.match(plan, new RegExp(`SEARCH ${lookup.search} USING (?:COVERING )?INDEX ${lookup.index}`), plan);
  assert.doesNotMatch(plan, new RegExp(`SCAN ${lookup.search}\\b`), plan);
  if (lookup.constraint) assert.match(plan, lookup.constraint, plan);
}

test("auth and room-list lookups search an index", () => {
  withStore(store => {
    for (const lookup of LOOKUPS) assertIndexed(store, lookup);
    const slotDelete = planOf(store, {
      sql: "DELETE FROM account_session_slots WHERE hash=?",
      args: ["slot"],
      search: "share_link_joins",
      index: "share_link_joins_slot"
    });
    assert.match(slotDelete, /SEARCH share_link_joins USING (?:COVERING )?INDEX share_link_joins_slot/);
    assert.doesNotMatch(slotDelete, /SCAN share_link_joins/);
  });
});

test("a deferred open installs lookup indexes missing from an older stamp", () => {
  withStore((store, filename) => {
    for (const lookup of LOOKUPS) {
      store.db.exec(`DROP INDEX ${lookup.index}`);
      const plan = planOf(store, lookup);
      assert.doesNotMatch(plan, new RegExp(lookup.index), `${lookup.index} plan before install:\n${plan}`);
    }
    store.db.prepare("UPDATE room_schema_stamp SET stamp=? WHERE singleton=1").run("stale");
    store.close();
    const reopened = new RoomStore(filename, { now: () => NOW, integrity: "deferred" });
    try {
      for (const lookup of LOOKUPS) assertIndexed(reopened, lookup);
      const stamp = reopened.db.prepare("SELECT stamp FROM room_schema_stamp WHERE singleton=1").get();
      assert.notEqual(stamp.stamp, "stale");
    } finally { reopened.close(); }
  });
});
