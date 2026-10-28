import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "./store.mjs";
import { auditRecovery } from "./recovery.mjs";

// REL-14: content digests, so a restore proves byte equality instead of
// matching row counts only. events: every row in (room_id, sequence) order.
// attachments: every room_attachments row with a hash of its stored bytes;
// `mismatched` counts rows whose bytes no longer hash to their sha256 column.
export function backupDigests(db) {
  const events = createHash("sha256");
  let eventRows = 0;
  for (const row of db.prepare("SELECT room_id, sequence, id, body FROM events ORDER BY room_id, sequence").iterate()) {
    events.update(JSON.stringify([row.room_id, row.sequence, row.id, row.body]) + "\n");
    eventRows++;
  }
  const files = createHash("sha256");
  let fileRows = 0, fileBytes = 0, mismatched = 0;
  const hasFiles = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='room_attachments'").get();
  if (hasFiles) {
    for (const row of db.prepare("SELECT room_id, id, state, byte_length, sha256, bytes FROM room_attachments ORDER BY room_id, id").iterate()) {
      const content = row.bytes == null ? null : createHash("sha256").update(row.bytes).digest("hex");
      if (content !== null && content !== row.sha256) mismatched++;
      files.update(JSON.stringify([row.room_id, row.id, row.state, row.byte_length, row.sha256, content]) + "\n");
      fileRows++;
      fileBytes += row.bytes == null ? 0 : row.bytes.length;
    }
  }
  return { events: { rows: eventRows, sha256: events.digest("hex") },
    attachments: { rows: fileRows, bytes: fileBytes, mismatched, sha256: files.digest("hex") } };
}

// Fresh private destination only; never overwrite or restore into the live DB.
export async function backupRoom(source, destinationDirectory) {
  const input = realpathSync(source);
  const directory = realpathSync(destinationDirectory);
  if (!statSync(input).isFile() || !statSync(directory).isDirectory()) throw new Error("Backup requires an existing database and destination directory");
  const destination = mkdtempSync(join(directory, "room-backup-"));
  chmodSync(destination, 0o700);
  const filename = join(destination, "room.sqlite");
  const db = new DatabaseSync(input, { readOnly: true });
  try { await backup(db, filename); } finally { db.close(); }
  chmodSync(filename, 0o600);
  let restored;
  try {
    restored = new RoomStore(filename, { readOnly: true });
    const recovery = auditRecovery(restored);
    const audit = restored.verifyInvitationAudit();
    // B5: every backup carries a watermark so a later restore can prove which
    // authority the snapshot knew about. Anything revoked after backedUpAt is
    // resurrected by a restore and must be reconciled, never trusted silently.
    const rooms = restored.db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
    const events = restored.db.prepare("SELECT count(*) AS n FROM events").get().n;
    const digests = backupDigests(restored.db);
    if (digests.attachments.mismatched) throw new Error(`Backup holds ${digests.attachments.mismatched} attachment(s) whose bytes do not match their sha256`);
    const watermark = { version: 1, backedUpAt: Date.now(), rooms, events, digests };
    const sidecar = join(destination, "room-backup.json");
    writeFileSync(sidecar, JSON.stringify(watermark, null, 2));
    chmodSync(sidecar, 0o600);
    return { filename, watermark: sidecar, verified: true, ...audit, recovery };
  } finally { restored?.close(); }
}

// B5 restore rehearsal: a restored backup resurrects the authority that was
// live at the watermark - keys, links, agent connections, accounts, and
// memberships revoked since. Compare a restored store against a current
// reference and name every entry the restore made current-looking again.
//
// IR-1: the checked set is the whole capability graph, organised as one
// class table (RECONCILE_CLASSES). Each entry names its stale-entry kind,
// examines the restored store against the current reference, and returns
// how many restored rows it examined; the report's `checked` (the legacy
// summary keys) and `checkedClasses` (per kind) are both generated from
// this table, so there is no second list to drift. Kinds for the classes
// the capability-graph census derived are the graph node ids; the six
// legacy kinds predate the census and keep their names (the restore
// rehearsal asserts them). The completeness guard in
// tests/restore-reconcile-coverage.test.js fails if the census gains a
// resurrecting class with no entry here.
//
// Idiom, shared by every class: a row live in the restored store whose
// current counterpart is revoked / consumed / terminal is named
// "... after the backup"; a row the current store does not hold at all is
// "unknown to the current store". Classes whose revocation state is not a
// row flag (OAuth refresh families, autonomy tiers, login-method bindings,
// stitch presence) state their comparison in their examine() below.

const tableExists = (db, name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// Row-state comparison for the classes whose revocation state is a per-row
// flag or status in the same table in both stores. `select` returns every
// row of the class table; keyOf identifies a row across stores; stateOf
// classifies a row as "live" or names its terminal state ("revoked",
// "consumed", ...). Returns the number of restored rows examined.
function checkRowClass({ restored, current, stale, kind, table, select, keyOf, idOf, describe, stateOf,
  absentDetail = row => `${describe(row)} unknown to the current store`,
  terminalDetail = (row, state) => `${describe(row)} was ${state} after the backup` }) {
  if (!tableExists(restored.db, table)) return 0;
  const restoredRows = restored.db.prepare(select).all();
  const currentByKey = new Map();
  if (tableExists(current.db, table)) {
    for (const row of current.db.prepare(select).all()) currentByKey.set(keyOf(row), row);
  }
  for (const row of restoredRows) {
    if (stateOf(row) !== "live") continue;
    const now = currentByKey.get(keyOf(row));
    if (now === undefined) stale.push({ kind, id: idOf(row), detail: absentDetail(row) });
    else {
      const state = stateOf(now);
      if (state !== "live") stale.push({ kind, id: idOf(row), detail: terminalDetail(row, state) });
    }
  }
  return restoredRows.length;
}

const RECONCILE_CLASSES = [
  // ---- Legacy classes (B5): behaviour and detail strings unchanged. ----
  { kind: "credential", checkedKey: "credentials", examine(restored, current, stale) {
    const currentCredentials = new Map(current.db.prepare("SELECT hash, revoked FROM credentials").all().map(r => [r.hash, r.revoked]));
    for (const row of restored.db.prepare("SELECT hash, room_id, member_id, kind, revoked, expires_at FROM credentials").all()) {
      if (row.revoked) continue;
      const now = currentCredentials.get(row.hash);
      if (now === undefined) stale.push({ kind: "credential", id: row.hash.slice(0, 12), detail: `${row.kind} key for ${row.member_id}@${row.room_id} unknown to the current store` });
      else if (now === 1) stale.push({ kind: "credential", id: row.hash.slice(0, 12), detail: `${row.kind} key for ${row.member_id}@${row.room_id} was revoked after the backup` });
    }
    return restored.db.prepare("SELECT count(*) AS n FROM credentials").get().n;
  } },
  { kind: "share_link", checkedKey: "shareLinks", examine(restored, current, stale) {
    const currentLinks = new Map(current.db.prepare("SELECT id, revoked_at FROM share_links").all().map(r => [r.id, r.revoked_at]));
    // A5: joins spent after the backup regain their slots in the restored
    // store even when the link itself was never revoked. A join is a
    // share_link_joins row (one invitation = one slot); the membership-
    // reuse path writes no such row and spends no slot.
    const joinCounts = db => {
      const counts = new Map();
      if (tableExists(db, "share_link_joins")) {
        for (const row of db.prepare("SELECT link_id, count(*) AS n FROM share_link_joins GROUP BY link_id").all()) counts.set(row.link_id, row.n);
      }
      return counts;
    };
    const restoredJoins = joinCounts(restored.db);
    const currentJoins = joinCounts(current.db);
    for (const row of restored.db.prepare("SELECT id, room_id, revoked_at, max_joins FROM share_links").all()) {
      if (row.revoked_at !== null) continue;
      if (!currentLinks.has(row.id)) stale.push({ kind: "share_link", id: row.id, detail: `share link in ${row.room_id} unknown to the current store` });
      else if (currentLinks.get(row.id) !== null) stale.push({ kind: "share_link", id: row.id, detail: `share link in ${row.room_id} was cancelled after the backup` });
      else {
        const spent = (currentJoins.get(row.id) ?? 0) - (restoredJoins.get(row.id) ?? 0);
        if (spent > 0) stale.push({ kind: "share_link", id: row.id,
          detail: `share link in ${row.room_id} regains ${spent} join(s) spent after the backup (${restoredJoins.get(row.id) ?? 0} of ${row.max_joins} used in the backup, ${currentJoins.get(row.id)} in the current store)` });
      }
    }
    return restored.db.prepare("SELECT count(*) AS n FROM share_links").get().n;
  } },
  { kind: "agent_connection", checkedKey: "agentConnections", examine(restored, current, stale) {
    const currentConnections = new Map(current.db.prepare("SELECT room_id, member_id, status FROM agent_connections").all().map(r => [`${r.room_id}/${r.member_id}`, r.status]));
    for (const row of restored.db.prepare("SELECT room_id, member_id, status FROM agent_connections").all()) {
      if (row.status !== "issued") continue;
      const now = currentConnections.get(`${row.room_id}/${row.member_id}`);
      if (now === undefined) stale.push({ kind: "agent_connection", id: `${row.room_id}/${row.member_id}`, detail: "agent connection unknown to the current store" });
      else if (now === "disconnected") stale.push({ kind: "agent_connection", id: `${row.room_id}/${row.member_id}`, detail: "agent connection was disconnected after the backup" });
    }
    return restored.db.prepare("SELECT count(*) AS n FROM agent_connections").get().n;
  } },
  { kind: "account", checkedKey: "accounts", examine(restored, current, stale) {
    const currentAccounts = new Map(current.db.prepare("SELECT id, active FROM accounts").all().map(r => [r.id, r.active]));
    for (const row of restored.db.prepare("SELECT id, origin, active FROM accounts").all()) {
      if (!row.active) continue;
      const now = currentAccounts.get(row.id);
      if (now === undefined) stale.push({ kind: "account", id: row.id.slice(0, 12), detail: `active account (${row.origin}) unknown to the current store` });
      else if (now === 0) stale.push({ kind: "account", id: row.id.slice(0, 12), detail: `account (${row.origin}) was deactivated after the backup` });
    }
    return restored.db.prepare("SELECT count(*) AS n FROM accounts").get().n;
  } },
  { kind: "membership_delegation", checkedKey: "membershipDelegations", examine(restored, current, stale) {
    // A restored capture can resurrect an owner-granted administrator even
    // when the room event projection looks unchanged. Name that stale authority.
    const currentDelegations = new Map(current.db.prepare(`SELECT room_id, identity_id, revoked_at
      FROM membership_delegation_grants`).all().map(row => [`${row.room_id}/${row.identity_id}`, row.revoked_at]));
    for (const row of restored.db.prepare(`SELECT room_id, identity_id FROM membership_delegation_grants
      WHERE revoked_at IS NULL`).all()) {
      const id = `${row.room_id}/${row.identity_id}`;
      if (!currentDelegations.has(id)) stale.push({ kind: "membership_delegation", id,
        detail: "membership administration grant unknown to the current store" });
      else if (currentDelegations.get(id) !== null) stale.push({ kind: "membership_delegation", id,
        detail: "membership administration grant was revoked after the backup" });
    }
    return restored.db.prepare("SELECT count(*) AS n FROM membership_delegation_grants").get().n;
  } },
  { kind: "member", checkedKey: "rooms", examine(restored, current, stale) {
    const rooms = restored.db.prepare("SELECT id FROM rooms").all();
    for (const room of rooms) {
      const restoredMembers = restored.room(room.id).state.members;
      // A room deleted from the current store after the backup is exactly the
      // resurrection case this rehearsal exists to report: RoomStore.room()
      // throws 404 room_not_found for it, and that must not abort the whole
      // reconciliation. Treat the missing room as having no current members,
      // so every active restored member is named stale below. Any other error
      // (storage, corruption) still propagates.
      let currentMembers;
      try {
        currentMembers = current.room(room.id).state.members;
      } catch (error) {
        if (error?.code !== "room_not_found") throw error;
        currentMembers = {};
      }
      for (const [memberId, member] of Object.entries(restoredMembers)) {
        if (!member.active) continue;
        const now = currentMembers[memberId];
        if (!now) stale.push({ kind: "member", id: `${room.id}/${memberId}`, detail: "active membership unknown to the current store" });
        else if (!now.active) stale.push({ kind: "member", id: `${room.id}/${memberId}`, detail: "membership was deactivated after the backup" });
      }
    }
    return rooms.length;
  } },

  // ---- IR-1 classes: the capability graph's resurrect-and-blind set. ----
  { kind: "identity_secret", examine(restored, current, stale) {
    // Revocation state is revoked_at; rotation is the second revocation
    // edge (it retires the old secret), so a secret_hash divergence
    // between two live rows names the restored store's retired secret.
    if (!tableExists(restored.db, "agent_identities")) return 0;
    const select = "SELECT identity_id, secret_hash, revoked_at FROM agent_identities";
    const rows = restored.db.prepare(select).all();
    const now = new Map();
    if (tableExists(current.db, "agent_identities")) {
      for (const row of current.db.prepare(select).all()) now.set(row.identity_id, row);
    }
    for (const row of rows) {
      if (row.revoked_at !== null) continue;
      const cur = now.get(row.identity_id);
      if (cur === undefined) stale.push({ kind: "identity_secret", id: row.identity_id, detail: `identity secret for ${row.identity_id} unknown to the current store` });
      else if (cur.revoked_at !== null) stale.push({ kind: "identity_secret", id: row.identity_id, detail: `identity secret for ${row.identity_id} was revoked after the backup` });
      else if (cur.secret_hash !== row.secret_hash) stale.push({ kind: "identity_secret", id: row.identity_id, detail: `identity secret for ${row.identity_id} was rotated after the backup; the restored store holds the retired secret` });
    }
    return rows.length;
  } },
  { kind: "rotation_receipt", examine(restored, current, stale) {
    // Receipts carry no state column: presence IS usability (inside the
    // TTL the module checks at read time). Rotation and identity revoke
    // delete the rows, so a restored receipt the current store no longer
    // holds was consumed, superseded, or revoked away after the backup.
    return checkRowClass({ restored, current, stale, kind: "rotation_receipt",
      table: "agent_identity_rotation_receipts",
      select: "SELECT identity_id, request_id FROM agent_identity_rotation_receipts",
      keyOf: row => `${row.identity_id}\n${row.request_id}`,
      idOf: row => `${row.identity_id}/${String(row.request_id).slice(0, 24)}`,
      describe: row => `rotation receipt for ${row.identity_id}`,
      stateOf: () => "live",
      absentDetail: row => `rotation receipt for ${row.identity_id} was consumed or superseded after the backup and is live again in the restored store` });
  } },
  { kind: "claim_key", examine(restored, current, stale) {
    // Revocation state is revoked_at on the append-only registry row. A
    // rotation also closes a key's window (valid_until): a restored key
    // whose window the current store has closed or narrowed would verify
    // evidence the current store refuses, so that is named too.
    if (!tableExists(restored.db, "agent_key_registry")) return 0;
    const select = "SELECT identity_id, public_key, valid_until, revoked_at FROM agent_key_registry";
    const rows = restored.db.prepare(select).all();
    const now = new Map();
    if (tableExists(current.db, "agent_key_registry")) {
      for (const row of current.db.prepare(select).all()) now.set(`${row.identity_id}\n${row.public_key}`, row);
    }
    for (const row of rows) {
      if (row.revoked_at !== null) continue;
      const id = `${row.identity_id}/${row.public_key.slice(0, 12)}`;
      const cur = now.get(`${row.identity_id}\n${row.public_key}`);
      if (cur === undefined) stale.push({ kind: "claim_key", id, detail: `claim-signing key for ${row.identity_id} unknown to the current store` });
      else if (cur.revoked_at !== null) stale.push({ kind: "claim_key", id, detail: `claim-signing key for ${row.identity_id} was revoked after the backup` });
      else if (cur.valid_until !== null && (row.valid_until === null || row.valid_until > cur.valid_until)) {
        stale.push({ kind: "claim_key", id, detail: `claim-signing key window for ${row.identity_id} was closed after the backup (valid until ${cur.valid_until} in the current store)` });
      }
    }
    return rows.length;
  } },
  { kind: "link_code", examine(restored, current, stale) {
    // Consumption is a timestamp, not a flag: a code spent after the
    // backup has consumed_at in the current store and NULL in a faithful
    // restored copy. A restored copy whose consumed_at DIFFERS from the
    // current store's was spent again after the restore (the C-D repro
    // demonstrates the re-spend before reconciling) — both shapes are
    // named; identical timestamps are the faithful-copy case and pass.
    if (!tableExists(restored.db, "identity_link_codes")) return 0;
    const select = "SELECT code_hash, identity_id, consumed_at FROM identity_link_codes";
    const rows = restored.db.prepare(select).all();
    const now = new Map();
    if (tableExists(current.db, "identity_link_codes")) {
      for (const row of current.db.prepare(select).all()) now.set(row.code_hash, row);
    }
    for (const row of rows) {
      const id = row.code_hash.slice(0, 12);
      const cur = now.get(row.code_hash);
      if (cur === undefined) {
        if (row.consumed_at === null) stale.push({ kind: "link_code", id, detail: `link code for ${row.identity_id} unknown to the current store` });
      } else if (row.consumed_at === null && cur.consumed_at !== null) {
        stale.push({ kind: "link_code", id, detail: `link code for ${row.identity_id} was consumed after the backup` });
      } else if (row.consumed_at !== null && cur.consumed_at !== null && row.consumed_at !== cur.consumed_at) {
        stale.push({ kind: "link_code", id, detail: `link code for ${row.identity_id} was consumed after the backup and its restored copy was spent again` });
      }
    }
    return rows.length;
  } },
  { kind: "approved_access_row", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "approved_access_row",
      table: "access_requests",
      select: "SELECT request_id, room_id, identity_id, status FROM access_requests",
      keyOf: row => row.request_id,
      idOf: row => row.request_id,
      describe: row => `approved access row for ${row.identity_id}@${row.room_id}`,
      stateOf: row => (row.status === "approved" ? "live" : row.status),
      terminalDetail: (row, state) => `approved access row for ${row.identity_id}@${row.room_id} reads ${state} in the current store, not approved` });
  } },
  { kind: "owner_delegate_grant", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "owner_delegate_grant",
      table: "owner_delegate_grants",
      select: "SELECT room_id, identity_id, revoked_at FROM owner_delegate_grants",
      keyOf: row => `${row.room_id}\n${row.identity_id}`,
      idOf: row => `${row.room_id}/${row.identity_id}`,
      describe: row => `owner delegation grant for ${row.identity_id}@${row.room_id}`,
      stateOf: row => (row.revoked_at !== null ? "revoked" : "live") });
  } },
  { kind: "capability_grant", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "capability_grant",
      table: "agent_capability_grants",
      select: "SELECT room_id, agent_id, capability, revoked_at FROM agent_capability_grants",
      keyOf: row => `${row.room_id}\n${row.agent_id}\n${row.capability}`,
      idOf: row => `${row.room_id}/${row.agent_id}/${row.capability}`,
      describe: row => `capability grant (${row.capability}) for ${row.agent_id}@${row.room_id}`,
      stateOf: row => (row.revoked_at !== null ? "revoked" : "live") });
  } },
  { kind: "spend_terms", examine(restored, current, stale) {
    // Terms rows carry no revocation flag of their own — revocation stamps
    // the grant edge (capability_grant, above) — so the terms class is
    // compared by content: terms removed after the backup, or re-issued
    // with different caps/allowlist, are rewound by a restore while the
    // edge stays live in both timelines.
    if (!tableExists(restored.db, "spend_grant_terms")) return 0;
    const select = "SELECT room_id, agent_id, denomination, cap_cents, per_tx_cap_cents, allowlist, single_use FROM spend_grant_terms";
    const rows = restored.db.prepare(select).all();
    const now = new Map();
    if (tableExists(current.db, "spend_grant_terms")) {
      for (const row of current.db.prepare(select).all()) now.set(`${row.room_id}\n${row.agent_id}`, row);
    }
    for (const row of rows) {
      const id = `${row.room_id}/${row.agent_id}`;
      const cur = now.get(`${row.room_id}\n${row.agent_id}`);
      if (cur === undefined) stale.push({ kind: "spend_terms", id, detail: `spend grant terms for ${row.agent_id}@${row.room_id} unknown to the current store` });
      else if (cur.denomination !== row.denomination || cur.cap_cents !== row.cap_cents
        || cur.per_tx_cap_cents !== row.per_tx_cap_cents || cur.allowlist !== row.allowlist
        || cur.single_use !== row.single_use) {
        stale.push({ kind: "spend_terms", id, detail: `spend grant terms for ${row.agent_id}@${row.room_id} were changed after the backup (cap ${row.cap_cents} in the backup, ${cur.cap_cents} in the current store)` });
      }
    }
    return rows.length;
  } },
  { kind: "rak_key", examine: (restored, current, stale) => checkApiKeys(restored, current, stale, "rak_key", false) },
  { kind: "onboarding_token", examine: (restored, current, stale) => checkApiKeys(restored, current, stale, "onboarding_token", true) },
  { kind: "agent_invite_code", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "agent_invite_code",
      table: "agent_invite_codes",
      select: "SELECT code_hash, room_id, redeemed_at, revoked_at FROM agent_invite_codes",
      keyOf: row => row.code_hash,
      idOf: row => row.code_hash.slice(0, 8),
      describe: row => `agent invite code in ${row.room_id}`,
      stateOf: row => (row.revoked_at !== null ? "revoked" : row.redeemed_at !== null ? "redeemed" : "live") });
  } },
  { kind: "guest_invite", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "guest_invite",
      table: "guest_invites",
      select: "SELECT id, room_id, status FROM guest_invites",
      keyOf: row => row.id,
      idOf: row => row.id,
      describe: row => `guest invite in ${row.room_id}`,
      stateOf: row => (row.status === "active" ? "live" : row.status) });
  } },
  { kind: "referral_token", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "referral_token",
      table: "referral_invites",
      select: "SELECT jti, room_id, status FROM referral_invites",
      keyOf: row => row.jti,
      idOf: row => row.jti,
      describe: row => `referral invite in ${row.room_id}`,
      stateOf: row => (row.status === "minted" ? "live" : row.status) });
  } },
  { kind: "attestation", examine(restored, current, stale) {
    // The verification row's presence IS the attestation (unverify deletes
    // the row), so this is a presence comparison.
    return checkRowClass({ restored, current, stale, kind: "attestation",
      table: "agent_identity_verification",
      select: "SELECT identity_id FROM agent_identity_verification",
      keyOf: row => row.identity_id,
      idOf: row => row.identity_id,
      describe: row => `verification attestation for ${row.identity_id}`,
      stateOf: () => "live",
      absentDetail: row => `verification attestation for ${row.identity_id} was withdrawn after the backup (present in the backup, absent from the current store)` });
  } },
  { kind: "directory_card", examine(restored, current, stale) {
    if (!tableExists(restored.db, "agent_directory_cards")) return 0;
    const select = "SELECT agent_id, visibility, withdrawn FROM agent_directory_cards";
    const rows = restored.db.prepare(select).all();
    const now = new Map();
    if (tableExists(current.db, "agent_directory_cards")) {
      for (const row of current.db.prepare(select).all()) now.set(row.agent_id, row);
    }
    const reach = visibility => ({ public: 2, room: 1, private: 0 })[visibility] ?? 0;
    for (const row of rows) {
      if (row.withdrawn) continue;
      const cur = now.get(row.agent_id);
      if (cur === undefined) stale.push({ kind: "directory_card", id: row.agent_id, detail: `directory card for ${row.agent_id} unknown to the current store` });
      else if (cur.withdrawn) stale.push({ kind: "directory_card", id: row.agent_id, detail: `directory card for ${row.agent_id} was withdrawn after the backup` });
      else if (reach(cur.visibility) < reach(row.visibility)) stale.push({ kind: "directory_card", id: row.agent_id, detail: `directory card for ${row.agent_id} was made ${cur.visibility} after the backup; the restored store reads it as ${row.visibility}` });
    }
    return rows.length;
  } },
  { kind: "webhook_subscription", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "webhook_subscription",
      table: "agent_webhook_subs",
      select: "SELECT subscription_id, agent_id, enabled FROM agent_webhook_subs",
      keyOf: row => row.subscription_id,
      idOf: row => row.subscription_id,
      describe: row => `webhook subscription for ${row.agent_id}`,
      stateOf: row => (row.enabled ? "live" : "disabled") });
  } },
  { kind: "push_config", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "push_config",
      table: "agent_push_configs",
      select: "SELECT agent_id, host_id, push_suspended FROM agent_push_configs",
      keyOf: row => `${row.agent_id}\n${row.host_id}`,
      idOf: row => `${row.agent_id}/${row.host_id}`,
      describe: row => `wake push config for ${row.agent_id}`,
      stateOf: row => (row.push_suspended ? "suspended" : "live") });
  } },
  { kind: "autonomy_tier", examine(restored, current, stale) {
    // No revocation flag: the revocation is a DEMOTION, and an absent row
    // reads as the default (t2_standard). Compare effective tiers over the
    // union of both stores' rows — a restored store more permissive than
    // the current store has had a demotion rewound.
    const rank = tier => ({ t1_readonly: 0, t2_standard: 1 })[tier] ?? 1;
    const effective = store => {
      const map = new Map();
      if (tableExists(store.db, "agent_autonomy_tiers")) {
        for (const row of store.db.prepare("SELECT room_id, member_id, autonomy_tier FROM agent_autonomy_tiers").all()) {
          map.set(`${row.room_id}\n${row.member_id}`, row.autonomy_tier);
        }
      }
      return map;
    };
    const restoredTiers = effective(restored);
    const currentTiers = effective(current);
    const keys = new Set([...restoredTiers.keys(), ...currentTiers.keys()]);
    for (const key of keys) {
      const restoredTier = restoredTiers.get(key) ?? "t2_standard";
      const currentTier = currentTiers.get(key) ?? "t2_standard";
      if (rank(restoredTier) > rank(currentTier)) {
        const [roomId, memberId] = key.split("\n");
        stale.push({ kind: "autonomy_tier", id: `${roomId}/${memberId}`,
          detail: `autonomy tier for ${memberId}@${roomId} reads ${restoredTier} in the restored store but was demoted to ${currentTier} after the backup` });
      }
    }
    return keys.size;
  } },
  { kind: "membership_invitation", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "membership_invitation",
      table: "membership_invitations",
      select: "SELECT id, room_id, intended_member_id, status FROM membership_invitations",
      keyOf: row => row.id,
      idOf: row => row.id,
      describe: row => `membership invitation for ${row.intended_member_id}@${row.room_id}`,
      stateOf: row => (row.status === "pending" ? "live" : row.status) });
  } },
  { kind: "oauth_client", examine(restored, current, stale) {
    // Client registrations carry no revocation flag: deregistration is a
    // row deletion, so this is a presence comparison.
    return checkRowClass({ restored, current, stale, kind: "oauth_client",
      table: "oauth_provider_clients",
      select: "SELECT client_id, name FROM oauth_provider_clients",
      keyOf: row => row.client_id,
      idOf: row => row.client_id,
      describe: row => `OAuth client ${row.name}`,
      stateOf: () => "live",
      absentDetail: row => `OAuth client ${row.name} was deregistered after the backup and is registered again in the restored store` });
  } },
  { kind: "oauth_code", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "oauth_code",
      table: "oauth_provider_codes",
      select: "SELECT code_hash, client_id, used FROM oauth_provider_codes",
      keyOf: row => row.code_hash,
      idOf: row => row.code_hash.slice(0, 12),
      describe: row => `OAuth authorization code for client ${row.client_id}`,
      stateOf: row => (row.used ? "used" : "live") });
  } },
  { kind: "oauth_access", examine(restored, current, stale) {
    return checkRowClass({ restored, current, stale, kind: "oauth_access",
      table: "oauth_provider_access_tokens",
      select: "SELECT token_hash, client_id, user_id, revoked FROM oauth_provider_access_tokens",
      keyOf: row => row.token_hash,
      idOf: row => row.token_hash.slice(0, 12),
      describe: row => `OAuth access token for ${row.user_id}`,
      stateOf: row => (row.revoked ? "revoked" : "live") });
  } },
  { kind: "oauth_refresh", examine(restored, current, stale) {
    // Family semantics: a refresh token is dead when revoked OR rotated
    // out (rotated_by set); family revocation stamps revoked on the
    // family's rows, so the per-token comparison against the current
    // family state is the family comparison.
    return checkRowClass({ restored, current, stale, kind: "oauth_refresh",
      table: "oauth_provider_refresh_tokens",
      select: "SELECT token_hash, client_id, user_id, family_id, revoked, rotated_by FROM oauth_provider_refresh_tokens",
      keyOf: row => row.token_hash,
      idOf: row => row.token_hash.slice(0, 12),
      describe: row => `OAuth refresh token (family ${String(row.family_id).slice(0, 12)}) for ${row.user_id}`,
      stateOf: row => (row.revoked ? "revoked" : row.rotated_by ? "rotated out" : "live") });
  } },
  { kind: "login_method", examine(restored, current, stale) {
    // Binding-set difference, both directions (the charter's stated
    // comparison for this class): a binding removed after the backup
    // must not return, and a binding added after the backup must not
    // silently un-happen in the restored store. Consumable codes and
    // account session credentials compare in the restored direction.
    let examined = 0;
    const bindings = [
      { table: "account_login_methods", key: "id", noun: "login method" },
      { table: "account_passkey_credentials", key: "credential_id", noun: "passkey credential" },
    ];
    for (const { table, key, noun } of bindings) {
      const select = `SELECT ${key} AS k, account_id, disabled FROM ${table}`;
      const restoredRows = tableExists(restored.db, table) ? restored.db.prepare(select).all() : [];
      const currentRows = tableExists(current.db, table) ? current.db.prepare(select).all() : [];
      examined += restoredRows.length;
      const restoredByKey = new Map(restoredRows.map(row => [row.k, row]));
      const currentByKey = new Map(currentRows.map(row => [row.k, row]));
      for (const row of restoredRows) {
        if (row.disabled) continue;
        const cur = currentByKey.get(row.k);
        if (cur === undefined) stale.push({ kind: "login_method", id: row.k, detail: `${noun} for account ${String(row.account_id).slice(0, 12)} was removed after the backup and is bound again in the restored store` });
        else if (cur.disabled) stale.push({ kind: "login_method", id: row.k, detail: `${noun} for account ${String(row.account_id).slice(0, 12)} was disabled after the backup` });
      }
      for (const row of currentRows) {
        if (row.disabled) continue;
        if (!restoredByKey.has(row.k)) stale.push({ kind: "login_method", id: row.k, detail: `${noun} for account ${String(row.account_id).slice(0, 12)} was bound after the backup and is missing from the restored store` });
      }
    }
    examined += checkRowClass({ restored, current, stale, kind: "login_method",
      table: "account_magic_codes",
      select: "SELECT code_hash, account_id, consumed_at FROM account_magic_codes",
      keyOf: row => row.code_hash,
      idOf: row => row.code_hash.slice(0, 12),
      describe: row => `magic login code for account ${String(row.account_id).slice(0, 12)}`,
      stateOf: row => (row.consumed_at !== null ? "consumed" : "live") });
    examined += checkRowClass({ restored, current, stale, kind: "login_method",
      table: "account_recovery_codes",
      select: "SELECT code_hash, account_id, used_at FROM account_recovery_codes",
      keyOf: row => row.code_hash,
      idOf: row => row.code_hash.slice(0, 12),
      describe: row => `recovery code for account ${String(row.account_id).slice(0, 12)}`,
      stateOf: row => (row.used_at !== null ? "used" : "live") });
    examined += checkRowClass({ restored, current, stale, kind: "login_method",
      table: "account_credentials",
      select: "SELECT hash, account_id, revoked FROM account_credentials",
      keyOf: row => row.hash,
      idOf: row => row.hash.slice(0, 12),
      describe: row => `account credential for account ${String(row.account_id).slice(0, 12)}`,
      stateOf: row => (row.revoked ? "revoked" : "live") });
    return examined;
  } },
  { kind: "stitch_link", examine(restored, current, stale) {
    // Presence comparison against two current-side facts: the link row
    // itself (account deletion erases links, so a restored link the
    // current store no longer holds is a deletion rewound) and the
    // revocations table (a revocation row matches a link when its
    // channel/source_id are the link's or NULL-wildcarded).
    if (!tableExists(restored.db, "stitch_links")) return 0;
    const links = restored.db.prepare("SELECT account_id, stitch_key, channel, source_id FROM stitch_links").all();
    const currentLinks = new Set();
    if (tableExists(current.db, "stitch_links")) {
      for (const row of current.db.prepare("SELECT account_id, stitch_key, channel, source_id FROM stitch_links").all()) {
        currentLinks.add(`${row.account_id}\n${row.stitch_key}\n${row.channel}\n${row.source_id}`);
      }
    }
    const revocations = tableExists(current.db, "stitch_revocations")
      ? current.db.prepare("SELECT account_id, stitch_key, channel, source_id FROM stitch_revocations").all() : [];
    for (const link of links) {
      const id = `${link.account_id}/${link.stitch_key.slice(0, 12)}`;
      const revoked = revocations.some(row => row.account_id === link.account_id && row.stitch_key === link.stitch_key
        && (row.channel === null || row.channel === link.channel)
        && (row.source_id === null || row.source_id === link.source_id));
      if (revoked) stale.push({ kind: "stitch_link", id, detail: `stitch link for account ${link.account_id} was revoked after the backup` });
      else if (!currentLinks.has(`${link.account_id}\n${link.stitch_key}\n${link.channel}\n${link.source_id}`)) {
        stale.push({ kind: "stitch_link", id, detail: `stitch link for account ${link.account_id} erased after the backup is present again in the restored store` });
      }
    }
    return links.length;
  } },
];

// agent_api_keys holds two graph classes in one table: general rak_ keys
// and the onboarding MCP token. issueOnboardingMcpToken's scope bundle
// (an mcp:room: scope plus mcp:inbox and mcp:wake) is the discriminator —
// a key carrying that bundle is functionally an onboarding token. Each
// row is classified into exactly one kind so a row is never named twice.
function checkApiKeys(restored, current, stale, kind, onboarding) {
  if (!tableExists(restored.db, "agent_api_keys")) return 0;
  const select = "SELECT key_id, identity_id, scopes_json, revoked FROM agent_api_keys";
  const isOnboarding = row => {
    try {
      const scopes = JSON.parse(row.scopes_json);
      return Array.isArray(scopes) && scopes.includes("mcp:inbox") && scopes.includes("mcp:wake");
    } catch { return false; }
  };
  const rows = restored.db.prepare(select).all().filter(row => isOnboarding(row) === onboarding);
  const now = new Map();
  if (tableExists(current.db, "agent_api_keys")) {
    for (const row of current.db.prepare(select).all()) now.set(row.key_id, row);
  }
  const noun = onboarding ? "onboarding token" : "API key";
  for (const row of rows) {
    if (row.revoked) continue;
    const cur = now.get(row.key_id);
    if (cur === undefined) stale.push({ kind, id: row.key_id, detail: `${noun} for ${row.identity_id} unknown to the current store` });
    else if (cur.revoked) stale.push({ kind, id: row.key_id, detail: `${noun} for ${row.identity_id} was revoked after the backup` });
  }
  return rows.length;
}

// The class kinds the reconciliation checks, in table order — exported
// for the completeness guard (tests/restore-reconcile-coverage.test.js),
// which fails if the capability-graph census lists a resurrecting class
// with no kind here.
export const RECONCILE_CLASS_KINDS = Object.freeze(RECONCILE_CLASSES.map(entry => entry.kind));

export function reconcileRestoredAuthority(restored, current) {
  const stale = [];
  const checkedClasses = {};
  const legacy = {};
  for (const entry of RECONCILE_CLASSES) {
    const examined = entry.examine(restored, current, stale);
    checkedClasses[entry.kind] = examined;
    if (entry.checkedKey) legacy[entry.checkedKey] = examined;
  }
  return { stale, checked: {
    credentials: legacy.credentials ?? 0,
    shareLinks: legacy.shareLinks ?? 0,
    agentConnections: legacy.agentConnections ?? 0,
    accounts: legacy.accounts ?? 0,
    membershipDelegations: legacy.membershipDelegations ?? 0,
    rooms: legacy.rooms ?? 0 }, checkedClasses };
}
