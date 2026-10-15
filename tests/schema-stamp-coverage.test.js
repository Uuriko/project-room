// Warm-wake schema stamp coverage (johnstab-schema-stamp-spend).
// A deferred-integrity wake whose stored stamp matches roomSchemaStamp()
// skips the whole schema pass. Every deploy from ffd1e455 (spend grants)
// through 51803999 wrote the same stamp, because SPEND_GRANTS_SCHEMA and the
// other additive ensure*Schema helpers were not hashed. A room stamped before
// the spend deploy therefore never got spend_authorizations, and every priced
// MCP call by a non-owner (room_put_file, add_land_item) died on
// "no such table" -> 500 internal.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, ADDITIVE_SCHEMA_ENSURES } from "../server/store.mjs";
import { createHash } from "node:crypto";
import { authorizeSpend, SpendGrantError } from "../server/spend-grants.mjs";

const NOW = Date.parse("2026-10-05T20:00:00Z");
// roomSchemaStamp() as written by every deploy from ffd1e455 through 51803999 (prod 0172ecd5).
const PRE_FIX_STAMP = "ebd1738b4a4e4ad98b76fe66ce38221e86c7bf95cd1edc80d3a5986ec0e1ac4f";
const SPEND_TABLES = ["spend_grant_terms", "spend_authorizations", "spend_room_reservations"];

test("a room stamped before the spend deploy converges spend tables on a warm wake", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-stamp-"));
  try {
    const filename = join(dir, "room.sqlite");
    const first = new RoomStore(filename, { now: () => NOW });
    for (const table of SPEND_TABLES) first.db.exec(`DROP TABLE IF EXISTS ${table}`);
    first.db.prepare("UPDATE room_schema_stamp SET stamp=? WHERE singleton=1").run(PRE_FIX_STAMP);
    first.close();

    const woken = new RoomStore(filename, { now: () => NOW, integrity: "deferred" });
    try {
      const present = woken.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${SPEND_TABLES.map(() => "?").join(",")})`)
        .all(...SPEND_TABLES).map(row => row.name).sort();
      assert.deepEqual(present, [...SPEND_TABLES].sort());
      // A non-owner with no grant gets the typed refusal, not a SQLite error.
      assert.throws(
        () => authorizeSpend(woken.db, { roomId: "room-x", agentId: "ai_member_no_grant", toolName: "room_put_file", priceCents: 1, nonce: "n-1", nowMs: NOW }),
        error => error instanceof SpendGrantError && error.status >= 400 && error.status < 500
      );
    } finally { woken.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every additive schema step in the full pass is part of the warm-wake stamp", () => {
  const source = readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");
  const stampFn = source.slice(source.indexOf("function roomSchemaStamp()"), source.indexOf("return hash.digest", source.indexOf("function roomSchemaStamp()")));
  const ensureList = source.slice(source.indexOf("const ADDITIVE_SCHEMA_ENSURES"), source.indexOf("];", source.indexOf("const ADDITIVE_SCHEMA_ENSURES")));
  assert.ok(ensureList.length > 0, "ADDITIVE_SCHEMA_ENSURES is missing");
  const pass = source.slice(source.indexOf("const stampMatches ="), source.indexOf("schemaStampMatches() {"));
  const ensures = [...new Set([...pass.matchAll(/\b(ensure\w+Schema)\(this\.db\)/g)].map(m => m[1]))];
  const execs = [...new Set([...pass.matchAll(/this\.db\.exec\(([A-Za-z_][A-Za-z0-9_]*)\)/g)].map(m => m[1]))];
  assert.ok(ensures.length >= 5 && execs.length >= 5, "schema pass not found");
  const missingEnsures = ensures.filter(name => !new RegExp(`\\b${name}\\b`).test(ensureList));
  const missingDdl = execs.filter(name => !new RegExp(`\\b${name}\\b`).test(stampFn));
  assert.deepEqual({ missingEnsures, missingDdl }, { missingEnsures: [], missingDdl: [] },
    "add these to ADDITIVE_SCHEMA_ENSURES / roomSchemaStamp parts, or a warm wake on an older room skips them");
});

// The stamp hashes each helper's "name@revision" label, not its source: the
// Workers bundle rewrites source, so a source hash split the Worker's stamp
// from Node's (cloudflare CI, #1627). This pin keeps change detection: edit an
// ensure*Schema helper and this fails until you bump its @revision in
// ADDITIVE_SCHEMA_ENSURES (so deployed rooms re-run the pass) and update the pin.
const SOURCE_PINS = {
  "ensureIdentitySecretSchema@1": "2e0e097a8be76772",
  "ensureIdentityCapacitySchema@1": "33e15d3c51616945",
  "ensureIdentityLinkCodeSchema@1": "2e027731951257ac",
  "ensureAutonomyTiersSchema@1": "10220d71e7134ef8",
  "ensureOperatorActionsSchema@1": "766e8f9fed79c6e6",
  "ensureGrantsSchema@1": "fe4b311a64923973",
  "ensureSpendGrantsSchema@3": "0f3f6dab2ae7d25b",
  "ensureAccountProfileSchema@1": "3fb6bfb33febc621",
  "ensureVerifiedEmailSchema@1": "a8321ba9d34e6ad4",
  "ensureAttachmentSchema@1": "3189ca5ebea7bf33"
};

test("each additive ensure helper's source is pinned to its stamp label", () => {
  const actual = Object.fromEntries(ADDITIVE_SCHEMA_ENSURES.map(([fn, label]) =>
    [label, createHash("sha256").update(fn.toString()).digest("hex").slice(0, 16)]));
  assert.deepEqual(actual, SOURCE_PINS, "a helper changed: bump its @revision in ADDITIVE_SCHEMA_ENSURES and update SOURCE_PINS");
  for (const [fn, label] of ADDITIVE_SCHEMA_ENSURES) assert.ok(label.startsWith(`${fn.name}@`), `${label} names ${fn.name}`);
});

test("the stamp does not depend on function source text", () => {
  const source = readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");
  const stampFn = source.slice(source.indexOf("function roomSchemaStamp()"), source.indexOf("return hash.digest", source.indexOf("function roomSchemaStamp()")));
  assert.equal(/\.toString\(\)/.test(stampFn), false);
});

// Warm-wake stamp coverage for the account-session slot columns (CX4, #3500).
// A deferred-integrity warm wake whose stored stamp matches skips the whole
// schema pass. CX4 added login_method_kind/login_method_ref only through a
// migration-tail ALTER that no hashed constant covers, so a room stamped by
// the pre-CX4 deploy skips the pass on the next wake and every password,
// magic-link and OAuth sign-in dies writing the session slot
// ("no such column: login_method_kind", prod 0584dc9e, 2026-10-15).
// roomSchemaStamp() as written by the CX4 deploy 0584dc9e3 (prod, deploy of
// 2026-10-15T01:38Z), identical to the pre-CX4 9bb81c609 stamp.
const PRE_CX4_STAMP = "714cefdbdc9fd585d48465360fc40924ea50202c6b3952e440fd4554ea4a6a3c";
const SLOT_COLUMNS = ["login_method_kind", "login_method_ref"];

test("a room stamped by the pre-CX4 deploy converges account-session slot columns on a warm wake", () => {
  const dir = mkdtempSync(join(tmpdir(), "slot-stamp-"));
  try {
    const filename = join(dir, "room.sqlite");
    const first = new RoomStore(filename, { now: () => NOW });
    for (const column of SLOT_COLUMNS) first.db.exec(`ALTER TABLE account_session_slots DROP COLUMN ${column}`);
    first.db.prepare("UPDATE room_schema_stamp SET stamp=? WHERE singleton=1").run(PRE_CX4_STAMP);
    first.close();

    const woken = new RoomStore(filename, { now: () => NOW, integrity: "deferred" });
    try {
      const present = woken.db.prepare("SELECT name FROM pragma_table_info('account_session_slots')").all().map((row) => row.name);
      for (const column of SLOT_COLUMNS) assert.ok(present.includes(column), `${column} missing after warm wake`);
      // The session-slot write that 500s on prod must succeed.
      woken.db.prepare("UPDATE account_session_slots SET login_method_kind=?, login_method_ref=? WHERE account_id=?").run("password", "m1", "acc-x");
    } finally { woken.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
