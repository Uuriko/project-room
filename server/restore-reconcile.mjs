// Restore reconciliation: naming (IR-1) and re-applying (IR-2) the
// authority a whole-store restore resurrects.
//
// This module is the runtime-safe half of server/backup.mjs's restore
// machinery: backup.mjs is node-only (node:sqlite file backups), but the
// IR-2 gate runs inside the Durable Object restore paths
// (server/restore-ndjson.mjs), so the class table, the extract, the gate
// and the boot-lock state live here with no node-only imports.
// server/backup.mjs re-exports reconcileRestoredAuthority and
// RECONCILE_CLASS_KINDS so the node-side callers (restore rehearsal,
// IR-1's coverage suite) keep their import surface.
//
// The gate's contract (Fix Programme v2, IR-2): a restore door captures
// a pre-restore authority extract from the live store, replays the
// backup, reconciles the restored store against the extract, re-applies
// every named post-watermark revocation in one transaction, and writes
// the reconcile report into operator_actions in the restored store —
// the one audit row a restore may never erase, because it is written
// after the rewind. A store whose restore never reconciled (an
// out-of-band file swap, an abandoned replay session) boots
// restored-unreconciled: agent authentication is refused until an
// operator runs the reconcile or acknowledges that no reference exists.
import { createHash } from "node:crypto";
import { appendOperatorAction } from "./operator-actions.mjs";
import { applyEvent, event, MEMBERSHIP_AUTHORITY_POLICY_VERSION } from "../src/events.js";

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

// ---------------------------------------------------------------------------
// IR-2: the restore gate. Everything below is new in IR-2; everything above
// is IR-1's diagnostic, moved verbatim from server/backup.mjs (which
// re-exports it) so the gate can run it inside the Durable Object restore
// paths, where node:sqlite does not exist.
// ---------------------------------------------------------------------------

// The boot-lock state: one singleton row per store, created on store open
// (additive ensure, operator_actions idiom — outside the writer fence).
// A row is present only once a restore has touched the store:
//   restored_from — the backedUpAt watermark of the restore that produced
//     the current contents (NULL while a streamed restore is in flight);
//   reconciled_at — the watermark the gate has reconciled up to.
// The store is restored-unreconciled while a row exists with
// reconciled_at NULL or below restored_from. No row = never restored =
// not locked. The table is target-side state: exports never carry it
// (REPLAY_SKIPPED_TABLES / RESTORE_SKIP_TABLES) and a restore never
// imports it.
export const RESTORE_RECONCILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS restore_reconcile_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  restored_from INTEGER,
  reconciled_at INTEGER,
  updated_at INTEGER NOT NULL,
  extract_json TEXT
);
`;

export function ensureRestoreReconcileSchema(db) {
  db.exec(RESTORE_RECONCILE_SCHEMA);
}

export function restoreReconcileState(db) {
  if (!tableExists(db, "restore_reconcile_state")) return null;
  return db.prepare("SELECT restored_from AS restoredFrom, reconciled_at AS reconciledAt, updated_at AS updatedAt, extract_json AS extractJson FROM restore_reconcile_state WHERE singleton=1").get() ?? null;
}

export function storeRestoredUnreconciled(db) {
  const state = restoreReconcileState(db);
  if (!state) return false;
  if (state.reconciledAt === null) return true;
  return state.restoredFrom !== null && state.reconciledAt < state.restoredFrom;
}

// extractJson: undefined preserves the persisted extract, null clears
// it, a string replaces it. The extract is persisted by the restore
// doors when a restore begins (see markRestoredUnreconciled) so a retry
// after an abandoned streamed session reconciles against the same
// pre-restore reference instead of the partial data the abandonment
// left behind; it is cleared the moment the store reconciles.
function writeRestoreReconcileState(db, restoredFrom, reconciledAt, nowMs, extractJson = undefined) {
  const previous = restoreReconcileState(db);
  const extract = extractJson === undefined ? previous?.extractJson ?? null : extractJson;
  db.prepare(`INSERT INTO restore_reconcile_state (singleton, restored_from, reconciled_at, updated_at, extract_json)
    VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
    restored_from=excluded.restored_from, reconciled_at=excluded.reconciled_at, updated_at=excluded.updated_at, extract_json=excluded.extract_json`)
    .run(restoredFrom, reconciledAt, nowMs, extract);
}

// A restore has begun (or landed) whose contents are as of backedUpAt
// (null while a streamed restore has not yet shown its watermark) and
// has not been reconciled. `extract` is the pre-restore authority
// extract captured from the live store, persisted with the stamp.
export function markRestoredUnreconciled(db, backedUpAt, nowMs = Date.now(), extract = null) {
  ensureRestoreReconcileSchema(db);
  const previous = restoreReconcileState(db);
  const restoredFrom = backedUpAt ?? previous?.restoredFrom ?? null;
  writeRestoreReconcileState(db, restoredFrom, null, nowMs,
    extract ? serializeAuthorityExtract(extract) : undefined);
}

// The gate (or the operator's acknowledgement) reconciled the store at
// the given watermark; the persisted extract is spent and cleared.
export function markRestoreReconciled(db, backedUpAt, nowMs = Date.now()) {
  ensureRestoreReconcileSchema(db);
  const previous = restoreReconcileState(db);
  writeRestoreReconcileState(db, previous?.restoredFrom ?? backedUpAt ?? null, backedUpAt ?? previous?.restoredFrom ?? null, nowMs, null);
}

// The operator action that clears a restored-unreconciled store when no
// current reference exists anywhere (a true loss): the restore stands as
// of its watermark, the post-watermark revocations are unknowable, and
// the acknowledgement — never silence — is what unlocks agent auth. The
// row this appends into operator_actions is the record.
export function acknowledgeRestoredUnreconciled(store, { reason = null } = {}) {
  const state = restoreReconcileState(store.db);
  if (!state || !storeRestoredUnreconciled(store.db)) return { acknowledged: false, state };
  const nowMs = typeof store.now === "function" ? store.now() : Date.now();
  markRestoreReconciled(store.db, state.restoredFrom, nowMs);
  appendOperatorAction(store, {
    action: "restore_reconcile", result: "acknowledged_no_reference",
    reason: reason ?? "operator acknowledged a restore with no surviving current reference; post-watermark revocations are unknowable and were NOT re-applied",
    counts: { restoredFrom: state.restoredFrom, reapplied: 0, stale: [] },
  });
  return { acknowledged: true, state };
}

// --- The pre-restore authority extract -------------------------------------
//
// The full current-side content of every class table the reconciliation
// reads, plus each room's member active flags (the member class reads
// room state, not a table). Captured from the live store BEFORE a restore
// replaces it; the gate then reconciles the restored store against this
// serialised reference — "the same comparisons, serialised" (IR-2
// charter). Full rows, not column subsets: the extract must serve any
// comparison IR-1's table makes, and the re-apply handlers below read
// the current rows from the same capture.
export const AUTHORITY_EXTRACT_TABLES = Object.freeze([
  "credentials", "share_links", "share_link_joins", "agent_connections", "accounts",
  "membership_delegation_grants", "agent_identities", "agent_identity_rotation_receipts",
  "agent_key_registry", "identity_link_codes", "access_requests", "owner_delegate_grants",
  "agent_capability_grants", "spend_grant_terms", "agent_api_keys", "agent_invite_codes",
  "guest_invites", "referral_invites", "agent_identity_verification", "agent_directory_cards",
  "agent_webhook_subs", "agent_push_configs", "agent_autonomy_tiers", "membership_invitations",
  "oauth_provider_clients", "oauth_provider_codes", "oauth_provider_access_tokens",
  "oauth_provider_refresh_tokens", "account_login_methods", "account_passkey_credentials",
  "account_magic_codes", "account_recovery_codes", "account_credentials",
  "stitch_links", "stitch_revocations",
]);

export function captureAuthorityExtract(store) {
  const db = store?.db;
  if (!db) throw new Error("Authority extract needs an open store");
  const tables = {};
  const tablesPresent = [];
  for (const table of AUTHORITY_EXTRACT_TABLES) {
    if (!tableExists(db, table)) continue;
    tablesPresent.push(table);
    tables[table] = db.prepare(`SELECT * FROM "${table}"`).all();
  }
  // The NDJSON exporter scrubs token-shaped substrings (rak_/pri_/ga1.)
  // in every cell, so a restored agent_api_keys row carries the sha256
  // of its key_id where the live store carries the key_id itself. Alias
  // each token-shaped key_id to its scrubbed form so the reconciliation
  // and the re-apply match restored rows to their live counterparts —
  // without the alias, every live API key reads "unknown to the current
  // store" on an export-based restore and the honest case cannot be
  // quiet. File copies (backupRoom) are never scrubbed; there the alias
  // simply never matches.
  const apiKeyRows = tables.agent_api_keys;
  if (apiKeyRows) {
    const scrubbed = value => value.replace(/(?:pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}/g,
      match => createHash("sha256").update(match).digest("hex"));
    for (const row of [...apiKeyRows]) {
      if (typeof row.key_id === "string" && scrubbed(row.key_id) !== row.key_id) {
        apiKeyRows.push({ ...row, key_id: scrubbed(row.key_id) });
      }
    }
  }
  const members = {};
  const memberGaps = [];
  let roomCount = 0;
  if (tableExists(db, "rooms")) {    const rooms = db.prepare("SELECT id FROM rooms ORDER BY id").all();
    roomCount = rooms.length;
    for (const { id } of rooms) {
      try {
        const state = store.room(id).state;
        const captured = {};
        for (const [memberId, member] of Object.entries(state?.members ?? {})) {
          captured[memberId] = { active: member?.active !== false };
        }
        members[id] = captured;
      } catch {
        // A room whose state cannot be read (the corrupt-projection case
        // is a restore's whole reason) must not sink the extract for
        // every other room: the facade treats the room as unknown, its
        // restored members are named, and the gap is reported.
        memberGaps.push(id);
      }
    }
  }
  return {
    version: 1,
    capturedAt: typeof store.now === "function" ? store.now() : Date.now(),
    empty: roomCount === 0,
    tablesPresent,
    tables,
    members,
    memberGaps,
  };
}

// True when the extract holds no authority at all: no rooms and every
// class table empty. Only then is the gate vacuous — a store with
// accounts but no rooms still has authority worth reconciling.
export function extractIsEmpty(extract) {
  if (!extract || !extract.empty) return false;
  return Object.values(extract.tables).every(rows => rows.length === 0);
}

// Serialise an extract for persistence in the boot-lock state row. Byte
// cells (passkey material) round-trip through a {$bytes:[...]} marker so
// a reused extract is byte-identical to the captured one.
export function serializeAuthorityExtract(extract) {
  return JSON.stringify(extract, (key, value) => value instanceof Uint8Array ? { $bytes: [...value] } : value);
}

export function parseAuthorityExtract(json) {
  if (typeof json !== "string" || !json) return null;
  try {
    const extract = JSON.parse(json, (key, value) =>
      value && typeof value === "object" && Array.isArray(value.$bytes) && Object.keys(value).length === 1
        ? Uint8Array.from(value.$bytes) : value);
    return extract && extract.version === 1 && typeof extract.tables === "object" ? extract : null;
  } catch { return null; }
}

// A store-shaped facade over an extract: reconcileRestoredAuthority reads
// its `current` argument through db.prepare(...).all()/.get() and
// room(id).state.members only, so the extract can stand in for the live
// store the restore replaced. The prepared-statement surface is exactly
// the query shapes IR-1's class table issues against the current store;
// anything else throws — a new current-side query shape must extend the
// facade deliberately, and the equivalence test in
// tests/restore-gate.test.js pins facade results to live-store results.
export function extractAsCurrentStore(extract) {
  const rowsOf = table => extract.tables[table] ?? [];
  const db = {
    prepare(sql) {
      const text = String(sql);
      const run = (...params) => {
        if (/FROM\s+sqlite_master/i.test(text)) {
          const name = params[0];
          return extract.tablesPresent.includes(name) ? [{ ok: 1 }] : [];
        }
        if (/FROM\s+"?share_link_joins"?\s+GROUP BY\s+link_id/i.test(text)) {
          const counts = new Map();
          for (const row of rowsOf("share_link_joins")) counts.set(row.link_id, (counts.get(row.link_id) ?? 0) + 1);
          return [...counts.entries()].map(([link_id, n]) => ({ link_id, n }));
        }
        const from = /FROM\s+"?([a-z_][a-z0-9_]*)"?/i.exec(text);
        if (from) return rowsOf(from[1]);
        throw new Error(`Authority extract facade cannot answer: ${text.slice(0, 80)}`);
      };
      return {
        all: (...params) => run(...params),
        get: (...params) => run(...params)[0],
      };
    },
  };
  return {
    db,
    room(roomId) {
      if (Object.hasOwn(extract.members, roomId)) return { state: { members: extract.members[roomId] } };
      const error = new Error(`room_not_found: ${roomId}`);
      error.code = "room_not_found";
      throw error;
    },
  };
}

// --- Re-apply ---------------------------------------------------------------
//
// For every stale entry the reconcile names, apply the current timeline's
// terminal state to the restored store. The principle is mirroring, not
// invention: copy the revocation flag / status / content from the extract
// row; where the current store no longer holds the row at all, set the
// class's revocation flag when it has one and delete the restored row
// when the class is presence- or status-shaped. Handlers key rows exactly
// as the class table's examines do and report the examine-style entry id
// of everything they applied, so the gate can journal reapplied entries
// and name — never hide — any stale entry no handler could apply.

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const quoteIdent = name => {
  if (!IDENT_RE.test(name)) throw new Error(`Restore-reconcile names a table or column it will not write: ${name}`);
  return `"${name}"`;
};
const entryKey = entry => `${entry.kind}\n${entry.id}`;

function allRows(db, table) {
  return tableExists(db, table) ? db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() : [];
}
function indexBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) map.set(keyOf(row), row);
  return map;
}
function updateByKey(db, table, set, keyColumn, keyValue) {
  const assignments = Object.keys(set).map(column => `${quoteIdent(column)}=?`).join(", ");
  return db.prepare(`UPDATE ${quoteIdent(table)} SET ${assignments} WHERE ${quoteIdent(keyColumn)}=?`)
    .run(...Object.values(set), keyValue).changes;
}
function updateByKeys(db, table, set, where) {
  const assignments = Object.keys(set).map(column => `${quoteIdent(column)}=?`).join(", ");
  const conditions = Object.keys(where).map(column => `${quoteIdent(column)}=?`).join(" AND ");
  return db.prepare(`UPDATE ${quoteIdent(table)} SET ${assignments} WHERE ${conditions}`)
    .run(...Object.values(set), ...Object.values(where)).changes;
}
function deleteByKeys(db, table, where) {
  const conditions = Object.keys(where).map(column => `${quoteIdent(column)}=?`).join(" AND ");
  return db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${conditions}`).run(...Object.values(where)).changes;
}
function insertCapturedRow(db, table, row) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(column => column.name)
    .filter(column => Object.hasOwn(row, column) && row[column] !== undefined);
  if (!columns.length) return 0;
  return db.prepare(`INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map(column => row[column])).changes;
}

// Shared shape for the flag/status classes: walk the restored rows the
// examine walks, find each row's extract counterpart, and sync it.
function syncClass(ctx, { table, keyOf, idOf, live, apply }) {
  const current = indexBy(ctx.extract.tables[table] ?? [], keyOf);
  for (const row of allRows(ctx.db, table)) {
    if (!live(row)) continue;
    const cur = current.get(keyOf(row));
    const outcome = apply(row, cur);
    if (outcome === "applied") ctx.applied.add(entryKey({ kind: ctx.kind, id: idOf(row) }));
    else if (typeof outcome === "string") ctx.skipped.set(entryKey({ kind: ctx.kind, id: idOf(row) }), outcome);
  }
}

const REAPPLY_HANDLERS = {
  credential(ctx) {
    syncClass(ctx, { table: "credentials",
      keyOf: row => row.hash, idOf: row => row.hash.slice(0, 12),
      live: row => !row.revoked,
      apply: (row, cur) => {
        if (cur && !cur.revoked) return null;
        updateByKey(ctx.db, "credentials", { revoked: 1 }, "hash", row.hash);
        return "applied";
      } });
  },
  share_link(ctx) {
    const joinsByLink = new Map();
    for (const join of ctx.extract.tables.share_link_joins ?? []) {
      joinsByLink.set(join.link_id, (joinsByLink.get(join.link_id) ?? 0) + 1);
    }
    const restoredJoins = new Map();
    for (const join of allRows(ctx.db, "share_link_joins")) {
      restoredJoins.set(join.link_id, (restoredJoins.get(join.link_id) ?? 0) + 1);
    }
    syncClass(ctx, { table: "share_links",
      keyOf: row => row.id, idOf: row => row.id,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        // revoked_at and revoked_by_member_id are CHECK-paired: every
        // cancellation writes both. A gate cancellation (no current row,
        // or the A5 compensation) is recorded under the link's issuer.
        if (!cur) { updateByKey(ctx.db, "share_links", { revoked_at: ctx.extract.capturedAt, revoked_by_member_id: row.issuer_member_id }, "id", row.id); return "applied"; }
        if (cur.revoked_at !== null) { updateByKey(ctx.db, "share_links", { revoked_at: cur.revoked_at, revoked_by_member_id: cur.revoked_by_member_id }, "id", row.id); return "applied"; }
        // A5: joins spent after the backup cannot be re-accounted —
        // the join rows reference invitations and session slots the
        // backup never held (foreign keys forbid re-inserting them),
        // and the link's scope including max_joins is immutable by
        // trigger. The honest re-apply is to cancel the link rather
        // than leave it holding resurrected join slots; the gate
        // journals the compensation by name.
        const spent = (joinsByLink.get(row.id) ?? 0) - (restoredJoins.get(row.id) ?? 0);
        if (spent > 0) {
          updateByKey(ctx.db, "share_links", { revoked_at: ctx.extract.capturedAt, revoked_by_member_id: row.issuer_member_id }, "id", row.id);
          ctx.compensations.set(entryKey({ kind: "share_link", id: row.id }),
            `${spent} join(s) spent after the backup cannot be re-accounted (link scope is immutable and the join rows reference invitations the backup never held), so the link was cancelled instead of leaving resurrected join slots`);
          return "applied";
        }
        return null;
      } });
  },
  agent_connection(ctx) {
    syncClass(ctx, { table: "agent_connections",
      keyOf: row => `${row.room_id}/${row.member_id}`, idOf: row => `${row.room_id}/${row.member_id}`,
      live: row => row.status === "issued",
      apply: (row, cur) => {
        const status = cur ? cur.status : "disconnected";
        if (status === "issued") return null;
        updateByKeys(ctx.db, "agent_connections", { status }, { room_id: row.room_id, member_id: row.member_id });
        return "applied";
      } });
  },
  account(ctx) {
    syncClass(ctx, { table: "accounts",
      keyOf: row => row.id, idOf: row => row.id.slice(0, 12),
      live: row => Boolean(row.active),
      apply: (row, cur) => {
        if (cur && cur.active) return null;
        updateByKey(ctx.db, "accounts", { active: 0 }, "id", row.id);
        return "applied";
      } });
  },
  membership_delegation(ctx) {
    syncClass(ctx, { table: "membership_delegation_grants",
      keyOf: row => `${row.room_id}/${row.identity_id}`, idOf: row => `${row.room_id}/${row.identity_id}`,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        if (cur && cur.revoked_at === null) return null;
        updateByKeys(ctx.db, "membership_delegation_grants",
          { revoked_at: cur?.revoked_at ?? ctx.extract.capturedAt },
          { room_id: row.room_id, identity_id: row.identity_id });
        return "applied";
      } });
  },
  member(ctx) {
    for (const roomRow of allRows(ctx.db, "rooms")) {
      const roomId = roomRow.id;
      let room;
      try { room = ctx.store.room(roomId); } catch { continue; }
      const extractMembers = ctx.extract.members[roomId];
      for (const [memberId, member] of Object.entries(room.state?.members ?? {})) {
        if (!member || member.active === false) continue;
        const cur = extractMembers?.[memberId];
        if (cur && cur.active !== false) continue;
        const key = entryKey({ kind: "member", id: `${roomId}/${memberId}` });
        const outcome = deactivateRestoredMember(ctx, roomId, memberId);
        if (outcome === "applied") ctx.applied.add(key);
        else if (typeof outcome === "string") ctx.skipped.set(key, outcome);
      }
    }
  },
  identity_secret(ctx) {
    syncClass(ctx, { table: "agent_identities",
      keyOf: row => row.identity_id, idOf: row => row.identity_id,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        if (!cur) { updateByKey(ctx.db, "agent_identities", { revoked_at: ctx.extract.capturedAt }, "identity_id", row.identity_id); return "applied"; }
        if (cur.revoked_at !== null) { updateByKey(ctx.db, "agent_identities", { revoked_at: cur.revoked_at }, "identity_id", row.identity_id); return "applied"; }
        if (cur.secret_hash !== row.secret_hash) {
          // Rotation retired the restored secret: the current hash takes
          // its place, so the retired secret stops authenticating and
          // the rotated one works — the current timeline, mirrored.
          updateByKey(ctx.db, "agent_identities", { secret_hash: cur.secret_hash }, "identity_id", row.identity_id);
          return "applied";
        }
        return null;
      } });
  },
  rotation_receipt(ctx) {
    syncClass(ctx, { table: "agent_identity_rotation_receipts",
      keyOf: row => `${row.identity_id}\n${row.request_id}`,
      idOf: row => `${row.identity_id}/${String(row.request_id).slice(0, 24)}`,
      live: () => true,
      apply: (row, cur) => {
        if (cur) return null;
        deleteByKeys(ctx.db, "agent_identity_rotation_receipts", { identity_id: row.identity_id, request_id: row.request_id });
        return "applied";
      } });
  },
  claim_key(ctx) {
    syncClass(ctx, { table: "agent_key_registry",
      keyOf: row => `${row.identity_id}\n${row.public_key}`,
      idOf: row => `${row.identity_id}/${row.public_key.slice(0, 12)}`,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        if (!cur) { updateByKeys(ctx.db, "agent_key_registry", { revoked_at: ctx.extract.capturedAt }, { identity_id: row.identity_id, public_key: row.public_key }); return "applied"; }
        if (cur.revoked_at !== null) { updateByKeys(ctx.db, "agent_key_registry", { revoked_at: cur.revoked_at }, { identity_id: row.identity_id, public_key: row.public_key }); return "applied"; }
        if (cur.valid_until !== null && (row.valid_until === null || row.valid_until > cur.valid_until)) {
          updateByKeys(ctx.db, "agent_key_registry", { valid_until: cur.valid_until }, { identity_id: row.identity_id, public_key: row.public_key });
          return "applied";
        }
        return null;
      } });
  },
  link_code(ctx) {
    syncClass(ctx, { table: "identity_link_codes",
      keyOf: row => row.code_hash, idOf: row => row.code_hash.slice(0, 12),
      live: () => true,
      apply: (row, cur) => {
        if (!cur) {
          if (row.consumed_at !== null) return null;
          deleteByKeys(ctx.db, "identity_link_codes", { code_hash: row.code_hash });
          return "applied";
        }
        if (cur.consumed_at !== null && row.consumed_at !== cur.consumed_at) {
          updateByKey(ctx.db, "identity_link_codes", { consumed_at: cur.consumed_at }, "code_hash", row.code_hash);
          return "applied";
        }
        return null;
      } });
  },
  approved_access_row(ctx) {
    syncClass(ctx, { table: "access_requests",
      keyOf: row => row.request_id, idOf: row => row.request_id,
      live: row => row.status === "approved",
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "access_requests", { request_id: row.request_id }); return "applied"; }
        if (cur.status === "approved") return null;
        updateByKey(ctx.db, "access_requests", { status: cur.status }, "request_id", row.request_id);
        return "applied";
      } });
  },
  owner_delegate_grant(ctx) {
    syncClass(ctx, { table: "owner_delegate_grants",
      keyOf: row => `${row.room_id}\n${row.identity_id}`, idOf: row => `${row.room_id}/${row.identity_id}`,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        if (cur && cur.revoked_at === null) return null;
        updateByKeys(ctx.db, "owner_delegate_grants",
          { revoked_at: cur?.revoked_at ?? ctx.extract.capturedAt },
          { room_id: row.room_id, identity_id: row.identity_id });
        return "applied";
      } });
  },
  capability_grant(ctx) {
    syncClass(ctx, { table: "agent_capability_grants",
      keyOf: row => `${row.room_id}\n${row.agent_id}\n${row.capability}`,
      idOf: row => `${row.room_id}/${row.agent_id}/${row.capability}`,
      live: row => row.revoked_at === null,
      apply: (row, cur) => {
        if (cur && cur.revoked_at === null) return null;
        updateByKeys(ctx.db, "agent_capability_grants",
          { revoked_at: cur?.revoked_at ?? ctx.extract.capturedAt },
          { room_id: row.room_id, agent_id: row.agent_id, capability: row.capability });
        return "applied";
      } });
  },
  spend_terms(ctx) {
    syncClass(ctx, { table: "spend_grant_terms",
      keyOf: row => `${row.room_id}\n${row.agent_id}`, idOf: row => `${row.room_id}/${row.agent_id}`,
      live: () => true,
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "spend_grant_terms", { room_id: row.room_id, agent_id: row.agent_id }); return "applied"; }
        const changed = cur.denomination !== row.denomination || cur.cap_cents !== row.cap_cents
          || cur.per_tx_cap_cents !== row.per_tx_cap_cents || cur.allowlist !== row.allowlist
          || cur.single_use !== row.single_use;
        if (!changed) return null;
        updateByKeys(ctx.db, "spend_grant_terms",
          { denomination: cur.denomination, cap_cents: cur.cap_cents, per_tx_cap_cents: cur.per_tx_cap_cents, allowlist: cur.allowlist, single_use: cur.single_use },
          { room_id: row.room_id, agent_id: row.agent_id });
        return "applied";
      } });
  },
  rak_key(ctx) { syncApiKeyReapply(ctx, false); },
  onboarding_token(ctx) { syncApiKeyReapply(ctx, true); },
  agent_invite_code(ctx) {
    syncClass(ctx, { table: "agent_invite_codes",
      keyOf: row => row.code_hash, idOf: row => row.code_hash.slice(0, 8),
      live: row => row.revoked_at === null && row.redeemed_at === null,
      apply: (row, cur) => {
        if (cur && cur.revoked_at === null && cur.redeemed_at === null) return null;
        updateByKey(ctx.db, "agent_invite_codes",
          { revoked_at: cur?.revoked_at ?? ctx.extract.capturedAt, redeemed_at: cur?.redeemed_at ?? row.redeemed_at },
          "code_hash", row.code_hash);
        return "applied";
      } });
  },
  guest_invite(ctx) {
    syncClass(ctx, { table: "guest_invites",
      keyOf: row => row.id, idOf: row => row.id,
      live: row => row.status === "active",
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "guest_invites", { id: row.id }); return "applied"; }
        if (cur.status === "active") return null;
        updateByKey(ctx.db, "guest_invites", { status: cur.status }, "id", row.id);
        return "applied";
      } });
  },
  referral_token(ctx) {
    syncClass(ctx, { table: "referral_invites",
      keyOf: row => row.jti, idOf: row => row.jti,
      live: row => row.status === "minted",
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "referral_invites", { jti: row.jti }); return "applied"; }
        if (cur.status === "minted") return null;
        updateByKey(ctx.db, "referral_invites", { status: cur.status }, "jti", row.jti);
        return "applied";
      } });
  },
  attestation(ctx) {
    syncClass(ctx, { table: "agent_identity_verification",
      keyOf: row => row.identity_id, idOf: row => row.identity_id,
      live: () => true,
      apply: (row, cur) => {
        if (cur) return null;
        deleteByKeys(ctx.db, "agent_identity_verification", { identity_id: row.identity_id });
        return "applied";
      } });
  },
  directory_card(ctx) {
    syncClass(ctx, { table: "agent_directory_cards",
      keyOf: row => row.agent_id, idOf: row => row.agent_id,
      live: row => !row.withdrawn,
      apply: (row, cur) => {
        if (!cur) { updateByKey(ctx.db, "agent_directory_cards", { withdrawn: 1 }, "agent_id", row.agent_id); return "applied"; }
        const reach = visibility => ({ public: 2, room: 1, private: 0 })[visibility] ?? 0;
        if (!cur.withdrawn && reach(cur.visibility) >= reach(row.visibility)) return null;
        updateByKey(ctx.db, "agent_directory_cards", { withdrawn: cur.withdrawn ? 1 : 0, visibility: cur.visibility }, "agent_id", row.agent_id);
        return "applied";
      } });
  },
  webhook_subscription(ctx) {
    syncClass(ctx, { table: "agent_webhook_subs",
      keyOf: row => row.subscription_id, idOf: row => row.subscription_id,
      live: row => Boolean(row.enabled),
      apply: (row, cur) => {
        if (cur && cur.enabled) return null;
        updateByKey(ctx.db, "agent_webhook_subs", { enabled: 0 }, "subscription_id", row.subscription_id);
        return "applied";
      } });
  },
  push_config(ctx) {
    syncClass(ctx, { table: "agent_push_configs",
      keyOf: row => `${row.agent_id}\n${row.host_id}`, idOf: row => `${row.agent_id}/${row.host_id}`,
      live: row => !row.push_suspended,
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "agent_push_configs", { agent_id: row.agent_id, host_id: row.host_id }); return "applied"; }
        if (!cur.push_suspended) return null;
        updateByKeys(ctx.db, "agent_push_configs", { push_suspended: 1 }, { agent_id: row.agent_id, host_id: row.host_id });
        return "applied";
      } });
  },
  autonomy_tier(ctx) {
    const rank = tier => ({ t1_readonly: 0, t2_standard: 1 })[tier] ?? 1;
    const restored = indexBy(allRows(ctx.db, "agent_autonomy_tiers"), row => `${row.room_id}\n${row.member_id}`);
    const current = indexBy(ctx.extract.tables.agent_autonomy_tiers ?? [], row => `${row.room_id}\n${row.member_id}`);
    for (const key of new Set([...restored.keys(), ...current.keys()])) {
      const restoredTier = restored.get(key)?.autonomy_tier ?? "t2_standard";
      const currentTier = current.get(key)?.autonomy_tier ?? "t2_standard";
      if (rank(restoredTier) <= rank(currentTier)) continue;
      const [roomId, memberId] = key.split("\n");
      const entryId = `${roomId}/${memberId}`;
      if (current.has(key)) insertOrReplaceTier(ctx, current.get(key));
      else deleteByKeys(ctx.db, "agent_autonomy_tiers", { room_id: roomId, member_id: memberId });
      ctx.applied.add(entryKey({ kind: "autonomy_tier", id: entryId }));
    }
  },
  membership_invitation(ctx) {
    syncClass(ctx, { table: "membership_invitations",
      keyOf: row => row.id, idOf: row => row.id,
      live: row => row.status === "pending",
      apply: (row, cur) => {
        if (!cur) { deleteByKeys(ctx.db, "membership_invitations", { id: row.id }); return "applied"; }
        if (cur.status === "pending") return null;
        updateByKey(ctx.db, "membership_invitations", { status: cur.status }, "id", row.id);
        return "applied";
      } });
  },
  oauth_client(ctx) {
    syncClass(ctx, { table: "oauth_provider_clients",
      keyOf: row => row.client_id, idOf: row => row.client_id,
      live: () => true,
      apply: (row, cur) => {
        if (cur) return null;
        deleteByKeys(ctx.db, "oauth_provider_clients", { client_id: row.client_id });
        return "applied";
      } });
  },
  oauth_code(ctx) {
    syncClass(ctx, { table: "oauth_provider_codes",
      keyOf: row => row.code_hash, idOf: row => row.code_hash.slice(0, 12),
      live: row => !row.used,
      apply: (row, cur) => {
        if (cur && !cur.used) return null;
        updateByKey(ctx.db, "oauth_provider_codes", { used: 1 }, "code_hash", row.code_hash);
        return "applied";
      } });
  },
  oauth_access(ctx) {
    syncClass(ctx, { table: "oauth_provider_access_tokens",
      keyOf: row => row.token_hash, idOf: row => row.token_hash.slice(0, 12),
      live: row => !row.revoked,
      apply: (row, cur) => {
        if (cur && !cur.revoked) return null;
        updateByKey(ctx.db, "oauth_provider_access_tokens", { revoked: 1 }, "token_hash", row.token_hash);
        return "applied";
      } });
  },
  oauth_refresh(ctx) {
    syncClass(ctx, { table: "oauth_provider_refresh_tokens",
      keyOf: row => row.token_hash, idOf: row => row.token_hash.slice(0, 12),
      live: row => !row.revoked && !row.rotated_by,
      apply: (row, cur) => {
        if (cur && !cur.revoked && !cur.rotated_by) return null;
        updateByKey(ctx.db, "oauth_provider_refresh_tokens",
          { revoked: 1, rotated_by: cur?.rotated_by ?? row.rotated_by },
          "token_hash", row.token_hash);
        return "applied";
      } });
  },
  login_method(ctx) {
    // Bindings, both directions (mirroring IR-1's comparison).
    for (const { table, key } of [
      { table: "account_login_methods", key: "id" },
      { table: "account_passkey_credentials", key: "credential_id" },
    ]) {
      const current = indexBy(ctx.extract.tables[table] ?? [], row => row[key]);
      const restoredKeys = new Set(allRows(ctx.db, table).map(row => row[key]));
      syncClass(ctx, { table,
        keyOf: row => row[key], idOf: row => row[key],
        live: row => !row.disabled,
        apply: (row, cur) => {
          if (!cur) { deleteByKeys(ctx.db, table, { [key]: row[key] }); return "applied"; }
          if (cur.disabled) { updateByKey(ctx.db, table, { disabled: 1 }, key, row[key]); return "applied"; }
          return null;
        } });
      for (const [id, cur] of current) {
        if (cur.disabled || restoredKeys.has(id)) continue;
        insertCapturedRow(ctx.db, table, cur);
        ctx.applied.add(entryKey({ kind: "login_method", id }));
      }
    }
    syncClass(ctx, { table: "account_magic_codes",
      keyOf: row => row.code_hash, idOf: row => row.code_hash.slice(0, 12),
      live: row => row.consumed_at === null,
      apply: (row, cur) => {
        if (cur && cur.consumed_at === null) return null;
        updateByKey(ctx.db, "account_magic_codes", { consumed_at: cur?.consumed_at ?? ctx.extract.capturedAt }, "code_hash", row.code_hash);
        return "applied";
      } });
    syncClass(ctx, { table: "account_recovery_codes",
      keyOf: row => row.code_hash, idOf: row => row.code_hash.slice(0, 12),
      live: row => row.used_at === null,
      apply: (row, cur) => {
        if (cur && cur.used_at === null) return null;
        updateByKey(ctx.db, "account_recovery_codes", { used_at: cur?.used_at ?? ctx.extract.capturedAt }, "code_hash", row.code_hash);
        return "applied";
      } });
    syncClass(ctx, { table: "account_credentials",
      keyOf: row => row.hash, idOf: row => row.hash.slice(0, 12),
      live: row => !row.revoked,
      apply: (row, cur) => {
        if (cur && !cur.revoked) return null;
        updateByKey(ctx.db, "account_credentials", { revoked: 1 }, "hash", row.hash);
        return "applied";
      } });
  },
  stitch_link(ctx) {
    const revocations = ctx.extract.tables.stitch_revocations ?? [];
    syncClass(ctx, { table: "stitch_links",
      keyOf: row => `${row.account_id}\n${row.stitch_key}\n${row.channel}\n${row.source_id}`,
      idOf: row => `${row.account_id}/${row.stitch_key.slice(0, 12)}`,
      live: () => true,
      apply: (row, cur) => {
        const matching = revocations.filter(rev => rev.account_id === row.account_id && rev.stitch_key === row.stitch_key
          && (rev.channel === null || rev.channel === row.channel)
          && (rev.source_id === null || rev.source_id === row.source_id));
        if (!matching.length && cur) return null;
        deleteByKeys(ctx.db, "stitch_links", { account_id: row.account_id, stitch_key: row.stitch_key, channel: row.channel, source_id: row.source_id });
        for (const rev of matching) {
          const exists = ctx.db.prepare("SELECT 1 FROM stitch_revocations WHERE account_id=? AND stitch_key=? AND channel IS ? AND source_id IS ?")
            .get(rev.account_id, rev.stitch_key, rev.channel, rev.source_id);
          if (!exists) insertCapturedRow(ctx.db, "stitch_revocations", rev);
        }
        return "applied";
      } });
  },
};

function insertOrReplaceTier(ctx, row) {
  deleteByKeys(ctx.db, "agent_autonomy_tiers", { room_id: row.room_id, member_id: row.member_id });
  insertCapturedRow(ctx.db, "agent_autonomy_tiers", row);
}

function syncApiKeyReapply(ctx, onboarding) {
  const isOnboarding = row => {
    try {
      const scopes = JSON.parse(row.scopes_json);
      return Array.isArray(scopes) && scopes.includes("mcp:inbox") && scopes.includes("mcp:wake");
    } catch { return false; }
  };
  const kind = onboarding ? "onboarding_token" : "rak_key";
  const current = indexBy(ctx.extract.tables.agent_api_keys ?? [], row => row.key_id);
  for (const row of allRows(ctx.db, "agent_api_keys")) {
    if (isOnboarding(row) !== onboarding || row.revoked) continue;
    const cur = current.get(row.key_id);
    if (cur && !cur.revoked) continue;
    updateByKey(ctx.db, "agent_api_keys", { revoked: 1 }, "key_id", row.key_id);
    ctx.applied.add(entryKey({ kind, id: row.key_id }));
  }
}

// A restored member's exit, re-applied as the seat's own leave event —
// the reducer's leave-request shape (actor is the member, permissions
// unchanged, active false), so no administration authority is needed or
// claimed. Written through the real reducer and persisted exactly as
// receipt-cards' appendRoomEvent persists, minus the wake fan-out: a
// restore must not re-notify a room about exits it already saw, and the
// gate's operator_actions journal is the record. Deterministic event id
// (room, member, watermark) makes a re-run of the gate idempotent.
function deactivateRestoredMember(ctx, roomId, memberId) {
  const { db, store } = ctx;
  let room;
  try { room = store.room(roomId); } catch { return "room state unreadable in the restored store"; }
  const state = room.state;
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return "applied";
  if (memberId === state?.room?.ownerId) return "room owner is never deactivated by the gate";
  const material = `${roomId}\0${memberId}\0${ctx.backedUpAt ?? ""}`;
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 40);
  const id = `rr${digest}`;
  if (db.prepare("SELECT 1 FROM events WHERE id=?").get(id)) return "applied";
  const incoming = event({
    id, idempotencyKey: id, type: "member.access_changed", actorId: memberId, roomId,
    at: new Date(ctx.nowMs).toISOString(),
    data: {
      memberId, expectedMemberRevision: member.revision,
      permissions: [...(member.permissions ?? [])], active: false,
      authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
    },
  });
  let next;
  try { next = applyEvent(state, incoming); }
  catch (error) { return `reducer refused the re-applied exit: ${String(error?.message ?? error).slice(0, 120)}`; }
  const sequence = room.sequence + 1;
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  const compact = { ...next, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, store.storedProjection(roomId, compact), roomId);
  return "applied";
}

export function reapplyStaleAuthority(store, extract, stale, { backedUpAt = null, nowMs = Date.now() } = {}) {
  const ctx = { db: store.db, store, extract, backedUpAt, nowMs, applied: new Set(), skipped: new Map(), compensations: new Map(), kind: null };
  const kinds = [...new Set(stale.map(entry => entry.kind))];
  for (const kind of kinds) {
    const handler = REAPPLY_HANDLERS[kind];
    if (!handler) {
      for (const entry of stale.filter(e => e.kind === kind)) ctx.skipped.set(entryKey(entry), `no re-apply handler for kind ${kind}`);
      continue;
    }
    ctx.kind = kind;
    handler(ctx);
  }
  return { applied: ctx.applied, skipped: ctx.skipped, compensations: ctx.compensations };
}

// --- The gate ---------------------------------------------------------------
//
// Runs after a restore's data has landed in `store`: reconcile the
// restored store against the pre-restore extract, re-apply every named
// revocation, journal the outcome into operator_actions (per-revocation
// rows plus the summary row carrying the full stale list), and stamp the
// store reconciled. The caller owns the surrounding transaction where
// one exists (the buffered replay path); the session path calls this in
// its own transaction. A gate failure throws — the restore must fail
// loudly rather than land unreconciled authority in silence.
export function runRestoreGate(store, extract, { backedUpAt = null, source = "restore", extractReused = false } = {}) {
  const db = store.db;
  const nowMs = typeof store.now === "function" ? store.now() : Date.now();
  if (!extract) throw new Error("runRestoreGate needs an authority extract; the no-extract outcome is runRestoreGateLocked");
  if (extractIsEmpty(extract)) {
    appendOperatorAction(store, {
      action: "restore_reconcile", result: "reconciled",
      counts: { stale: [], reapplied: 0, skipped: [], checkedClasses: {}, backedUpAt, extractEmpty: true, source, memberGaps: extract?.memberGaps ?? [] },
    });
    markRestoreReconciled(db, backedUpAt, nowMs);
    return { status: "reconciled", stale: [], reapplied: [], skipped: [], checked: {}, checkedClasses: {}, extractEmpty: true };
  }
  const report = reconcileRestoredAuthority(store, extractAsCurrentStore(extract));
  const { applied, skipped, compensations } = reapplyStaleAuthority(store, extract, report.stale, { backedUpAt, nowMs });
  // The delegation journal: the gate's direct revoked_at writes fire the
  // journal's pending triggers by design, and its reconcileRollback()
  // imports exactly those trigger-recorded transitions (the store
  // constructor runs it at open; the gate runs it now so the journal is
  // consistent in this session too, not just at the next open).
  if (report.stale.some(entry => entry.kind === "membership_delegation")
    && typeof store.delegationJournal?.reconcileRollback === "function") {
    store.delegationJournal.reconcileRollback();
  }
  const reapplied = [];
  const skippedList = [];
  const compensatedList = [];
  for (const entry of report.stale) {
    if (applied.has(entryKey(entry))) reapplied.push(entry);
    else skippedList.push({ ...entry, reason: skipped.get(entryKey(entry)) ?? "no re-apply effect" });
    if (compensations.has(entryKey(entry))) compensatedList.push({ ...entry, note: compensations.get(entryKey(entry)) });
  }
  for (const entry of reapplied) {
    appendOperatorAction(store, {
      action: "restore_reconcile_reapply", targetKind: entry.kind, targetId: entry.id,
      result: "reapplied", reason: entry.detail, counts: { backedUpAt, source },
    });
  }
  appendOperatorAction(store, {
    action: "restore_reconcile", result: "reconciled",
    counts: {
      stale: report.stale, reapplied: reapplied.length, skipped: skippedList,
      compensated: compensatedList,
      checkedClasses: report.checkedClasses, backedUpAt, extractEmpty: false,
      source, memberGaps: extract.memberGaps,
      extractCapturedAt: extract.capturedAt, extractReused,
    },
  });
  markRestoreReconciled(db, backedUpAt, nowMs);
  return { status: "reconciled", stale: report.stale, reapplied, skipped: skippedList, compensated: compensatedList, checked: report.checked, checkedClasses: report.checkedClasses, extractEmpty: false };
}

// The no-extract outcome: the restore landed but there was no valid
// current reference (the store was itself an unreconciled restore, or
// its extract could not be captured). The data stands, agent auth stays
// locked, and the journal says why — loudly, in the restored store.
export function runRestoreGateLocked(store, { backedUpAt = null, source = "restore", reason } = {}) {
  appendOperatorAction(store, {
    action: "restore_reconcile", result: "locked_no_extract",
    reason: reason ?? "no pre-restore authority extract was available; post-watermark revocations were NOT re-applied",
    counts: { stale: [], reapplied: 0, skipped: [], backedUpAt, source },
  });
  return { status: "locked", stale: [], reapplied: [], skipped: [], checked: {}, checkedClasses: {}, extractEmpty: false, reason: reason ?? null };
}
