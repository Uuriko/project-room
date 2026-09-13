import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RoomStore } from "./store.mjs";
import { auditRecovery } from "./recovery.mjs";

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
    const watermark = { version: 1, backedUpAt: Date.now(), rooms, events };
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
export function reconcileRestoredAuthority(restored, current) {
  const stale = [];
  const currentCredentials = new Map(current.db.prepare("SELECT hash, revoked FROM credentials").all().map(r => [r.hash, r.revoked]));
  for (const row of restored.db.prepare("SELECT hash, room_id, member_id, kind, revoked, expires_at FROM credentials").all()) {
    if (row.revoked) continue;
    const now = currentCredentials.get(row.hash);
    if (now === undefined) stale.push({ kind: "credential", id: row.hash.slice(0, 12), detail: `${row.kind} key for ${row.member_id}@${row.room_id} unknown to the current store` });
    else if (now === 1) stale.push({ kind: "credential", id: row.hash.slice(0, 12), detail: `${row.kind} key for ${row.member_id}@${row.room_id} was revoked after the backup` });
  }
  const currentLinks = new Map(current.db.prepare("SELECT id, revoked_at FROM share_links").all().map(r => [r.id, r.revoked_at]));
  for (const row of restored.db.prepare("SELECT id, room_id, revoked_at FROM share_links").all()) {
    if (row.revoked_at !== null) continue;
    if (!currentLinks.has(row.id)) stale.push({ kind: "share_link", id: row.id, detail: `share link in ${row.room_id} unknown to the current store` });
    else if (currentLinks.get(row.id) !== null) stale.push({ kind: "share_link", id: row.id, detail: `share link in ${row.room_id} was cancelled after the backup` });
  }
  const currentConnections = new Map(current.db.prepare("SELECT room_id, member_id, status FROM agent_connections").all().map(r => [`${r.room_id}/${r.member_id}`, r.status]));
  for (const row of restored.db.prepare("SELECT room_id, member_id, status FROM agent_connections").all()) {
    if (row.status !== "issued") continue;
    const now = currentConnections.get(`${row.room_id}/${row.member_id}`);
    if (now === undefined) stale.push({ kind: "agent_connection", id: `${row.room_id}/${row.member_id}`, detail: "agent connection unknown to the current store" });
    else if (now === "disconnected") stale.push({ kind: "agent_connection", id: `${row.room_id}/${row.member_id}`, detail: "agent connection was disconnected after the backup" });
  }
  const currentAccounts = new Map(current.db.prepare("SELECT id, active FROM accounts").all().map(r => [r.id, r.active]));
  for (const row of restored.db.prepare("SELECT id, origin, active FROM accounts").all()) {
    if (!row.active) continue;
    const now = currentAccounts.get(row.id);
    if (now === undefined) stale.push({ kind: "account", id: row.id.slice(0, 12), detail: `active account (${row.origin}) unknown to the current store` });
    else if (now === 0) stale.push({ kind: "account", id: row.id.slice(0, 12), detail: `account (${row.origin}) was deactivated after the backup` });
  }
  for (const room of restored.db.prepare("SELECT id FROM rooms").all()) {
    const restoredMembers = restored.room(room.id).state.members;
    const currentMembers = current.room(room.id).state.members;
    for (const [memberId, member] of Object.entries(restoredMembers)) {
      if (!member.active) continue;
      const now = currentMembers[memberId];
      if (!now) stale.push({ kind: "member", id: `${room.id}/${memberId}`, detail: "active membership unknown to the current store" });
      else if (!now.active) stale.push({ kind: "member", id: `${room.id}/${memberId}`, detail: "membership was deactivated after the backup" });
    }
  }
  return { stale, checked: {
    credentials: restored.db.prepare("SELECT count(*) AS n FROM credentials").get().n,
    shareLinks: restored.db.prepare("SELECT count(*) AS n FROM share_links").get().n,
    agentConnections: restored.db.prepare("SELECT count(*) AS n FROM agent_connections").get().n,
    accounts: restored.db.prepare("SELECT count(*) AS n FROM accounts").get().n,
    rooms: restored.db.prepare("SELECT count(*) AS n FROM rooms").get().n } };
}
