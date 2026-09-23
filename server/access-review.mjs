// BUILD-01 D4: periodic access review, read-only.
//
// One report per room that an owner can read on a schedule and compare with
// the last one: who is a member and what they may do, which guests are still
// inside and until when, which invitation links and one-time agent invite
// codes can still admit someone, which agent identities and connections exist
// and in what state, and when each member last acted. Assembly is a pure read over the store; the HTTP route
// and the CLI print the same object. No token, secret or hash is ever
// selected — the report is meant to be pasted into a review ticket.
import { ServiceError } from "./store.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

export const ACCESS_REVIEW_FORMAT = "project-room-access-review-v1";
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const isGuest = member => member.role === "guest" || isGuestAgentMemberId(member.id);

// Owner-only, like the sibling administrative reads. Accepts the owner's
// signed-in account session or their room key, so the CLI (bearer-only) can
// pull the same report a browser would. #643: the owner capability follows
// the owner identity, not the member kind — an agent owner holds full
// authority, including manage_members.
export function accessReviewOwner(store, token, roomId, binding) {
  const auth = store.authenticate(token, roomId, binding);
  if (auth.member.id !== store.room(roomId).state.room.ownerId
    || !auth.member.permissions.includes("manage_members")) {
    fail(403, "owner_required", "Only the room owner can read the access review");
  }
  return auth;
}

export function accessReviewReport(store, token, roomId, binding = null) {
  return store.readTransaction(() => {
    accessReviewOwner(store, token, roomId, binding);
    return assembleAccessReview(store, roomId);
  });
}

export function listRoomIds(store) {
  return store.db.prepare("SELECT id FROM rooms ORDER BY id").all().map(row => row.id);
}

// Unauthenticated assembly for a caller that already holds the database file
// (the CLI in store mode) or has passed accessReviewOwner (the route).
export function assembleAccessReview(store, roomId) {
  const { state } = store.room(roomId), now = store.now(), db = store.db;
  const lastActivity = new Map(db.prepare(`SELECT json_extract(body,'$.actorId') AS actor, max(json_extract(body,'$.at')) AS at
    FROM events WHERE room_id=? GROUP BY actor`).all(roomId).map(row => [row.actor, row.at]));
  const liveKeys = new Map(db.prepare(`SELECT member_id, count(*) AS n, max(expires_at) AS latest FROM credentials
    WHERE room_id=? AND kind='access' AND revoked=0 AND expires_at>? GROUP BY member_id`).all(roomId, now).map(row => [row.member_id, row]));
  const joined = new Map(db.prepare(`SELECT json_extract(body,'$.data.memberId') AS member, min(json_extract(body,'$.at')) AS at
    FROM events WHERE room_id=? AND json_extract(body,'$.type') IN ('member.added','member.joined_via_invitation') GROUP BY member`).all(roomId).map(row => [row.member, row.at]));
  const accounts = new Map(db.prepare("SELECT member_id, account_id FROM member_accounts WHERE room_id=?").all(roomId).map(row => [row.member_id, row.account_id]));
  const delegationRows = db.prepare(`SELECT identity_id AS identityId, granted_by AS grantedBy, granted_at AS grantedAt
    FROM membership_delegation_grants WHERE room_id=? AND revoked_at IS NULL ORDER BY granted_at ASC, identity_id ASC`).all(roomId);
  const delegationByIdentity = new Map(delegationRows.map(row => [row.identityId, row]));
  const authorityOf = member => {
    const paths = [];
    if (member.id === state.room.ownerId) paths.push("owner");
    if (member.delegatedAdmin === true) paths.push("delegated_admin");
    if (member.identityId && delegationByIdentity.has(member.identityId)) paths.push("membership_delegation");
    return { authorityPaths: paths, dualGrantHazard: paths.includes("delegated_admin") && paths.includes("membership_delegation") };
  };
  const active = Object.values(state.members).filter(member => member.active !== false);
  const members = active.filter(member => !isGuest(member)).map(member => ({
    memberId: member.id, displayName: member.displayName, kind: member.kind, role: member.role ?? null,
    permissions: [...member.permissions], revision: member.revision, accountableHumanId: member.accountableHumanId ?? null,
    // #643: surfaces owner-delegated administration — an agent member holding
    // admin bits via an explicit owner grant. The grant is server-stamped;
    // this flag makes the exception inspectable in review output.
    delegatedAdmin: member.delegatedAdmin === true,
    identityId: member.identityId ?? null, ...authorityOf(member), accountBound: accounts.has(member.id),
    membershipOrigin: member.membershipOrigin?.kind ?? (member.id === state.room.ownerId ? "bootstrap" : "added"), joinedAt: joined.get(member.id) ?? null,
    liveAccessKeys: liveKeys.get(member.id)?.n ?? 0, latestAccessKeyExpiresAt: iso(liveKeys.get(member.id)?.latest),
    lastActivityAt: lastActivity.get(member.id) ?? null
  }));
  const guests = active.filter(isGuest).map(member => {
    // A share-link guest is bounded by its one-time 8 h account key (falling
    // back to the link expiry its invitation copied); a guest agent by its
    // 2 h room credential. Either way the bound is a time, never a token.
    const latest = (sql, ...params) => db.prepare(sql).get(...params)?.latest ?? null;
    const bound = member.kind === "agent"
      ? latest("SELECT max(expires_at) AS latest FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0", roomId, member.id)
      : (accounts.has(member.id) ? latest("SELECT max(expires_at) AS latest FROM account_credentials WHERE account_id=? AND revoked=0", accounts.get(member.id)) : null)
        ?? latest("SELECT max(expires_at) AS latest FROM membership_invitations WHERE room_id=? AND intended_member_id=? AND status='accepted'", roomId, member.id);
    return { memberId: member.id, displayName: member.displayName, kind: member.kind, permissions: [...member.permissions],
      joinedAt: joined.get(member.id) ?? null, expiresAt: iso(bound), status: bound !== null && bound > now ? "active" : "expired",
      lastActivityAt: lastActivity.get(member.id) ?? null };
  });
  const shareLinks = db.prepare("SELECT * FROM share_links WHERE room_id=? ORDER BY created_at DESC,id DESC").all(roomId).map(row => {
    const { id, role, permissions, createdAt, expiresAt, maxJoins, joins, remainingJoins, status } = store.shareLinks.view(row);
    return { id, role, permissions, issuerMemberId: row.issuer_member_id, createdAt: iso(createdAt), expiresAt: iso(expiresAt), maxJoins, joins, remainingJoins, status };
  });
  // One-time agent invite codes that are neither redeemed nor revoked: what
  // could still admit an agent, plus those that lapsed unredeemed (for the
  // record, like an expired link). Only the hash-free inviteId handle that
  // revoke() takes is selected — never the code or its stored hash.
  const pendingInvites = db.prepare("SELECT * FROM agent_invite_codes WHERE room_id=? AND redeemed_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC,code_hash").all(roomId).map(row => {
    const { inviteId, displayName, permissions, createdBy, createdAt, expiresAt, status } = store.invites.view(row, now);
    return { inviteId, displayName, permissions, inviterMemberId: createdBy, createdAt: iso(createdAt), expiresAt: iso(expiresAt), status };
  });
  const agentIdentities = db.prepare(`SELECT l.identity_id AS identityId, l.member_id AS memberId, l.linked_at AS linkedAt,
      i.display_name AS displayName FROM identity_links l JOIN agent_identities i ON i.identity_id=l.identity_id
      WHERE l.room_id=? ORDER BY l.linked_at, l.identity_id`).all(roomId).map(row => {
    const member = state.members[row.memberId];
    const authority = member ? authorityOf(member) : { authorityPaths: delegationByIdentity.has(row.identityId) ? ["membership_delegation"] : [], dualGrantHazard: false };
    return {
      identityId: row.identityId, displayName: row.displayName, memberId: row.memberId, linkedAt: iso(row.linkedAt),
      memberActive: member?.active !== false, lastActivityAt: lastActivity.get(row.memberId) ?? null,
      authorityPaths: authority.authorityPaths, dualGrantHazard: authority.dualGrantHazard
    };
  });
  const agentConnections = db.prepare("SELECT * FROM agent_connections WHERE room_id=? ORDER BY created_at,member_id").all(roomId).map(row => {
    const { memberId, displayName, generation, memberRevision, permissions, expiresAt, status, firstActionAt } = store.agentConnections.view(row);
    return { memberId, displayName, generation, memberRevision, permissions, sponsorMemberId: row.sponsor_member_id,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), expiresAt: iso(expiresAt), status, firstActionAt,
      lastActivityAt: lastActivity.get(memberId) ?? null };
  });
  const membershipDelegations = delegationRows.map(row => {
    const identity = agentIdentities.find(item => item.identityId === row.identityId);
    return {
      identityId: row.identityId, memberId: identity?.memberId ?? null, grantedBy: row.grantedBy, grantedAt: iso(row.grantedAt),
      authorityPaths: identity?.authorityPaths ?? ["membership_delegation"], dualGrantHazard: identity?.dualGrantHazard === true
    };
  });
  const roomLastActivityAt = [...lastActivity.values()].filter(Boolean).sort().at(-1) ?? null;
  return { format: ACCESS_REVIEW_FORMAT, roomId, roomTitle: state.room.title, ownerId: state.room.ownerId, generatedAt: iso(now),
    lastActivityAt: roomLastActivityAt, counts: { members: members.length, guests: guests.length, shareLinks: shareLinks.length,
      pendingInvites: pendingInvites.length, agentIdentities: agentIdentities.length, agentConnections: agentConnections.length,
      membershipDelegations: membershipDelegations.length },
    members, guests, shareLinks, pendingInvites, agentIdentities, agentConnections, membershipDelegations };
}

// Plain-text rendering shared by the CLI; one block per room.
export function renderAccessReview(report) {
  const lines = [], when = value => value ?? "never", grants = list => list.length ? list.join(", ") : "none";
  lines.push(`Room ${report.roomId} — ${report.roomTitle} (owner ${report.ownerId}); generated ${report.generatedAt}; last activity ${when(report.lastActivityAt)}`);
  lines.push(`Members (${report.members.length}):`);
  for (const m of report.members) lines.push(`  ${m.memberId}  ${m.displayName}  ${m.kind}${m.role ? ` (${m.role})` : ""}  grants: ${grants(m.permissions)}  paths: ${grants(m.authorityPaths ?? [])}${m.dualGrantHazard ? "  [DUAL-GRANT HAZARD]" : ""}  live keys: ${m.liveAccessKeys}  last activity: ${when(m.lastActivityAt)}`);
  lines.push(`Guests (${report.guests.length}):`);
  for (const g of report.guests) lines.push(`  ${g.memberId}  ${g.displayName}  ${g.kind}  ${g.status}  joined ${when(g.joinedAt)}  expires ${when(g.expiresAt)}  last activity: ${when(g.lastActivityAt)}`);
  lines.push(`Share links (${report.shareLinks.length}):`);
  for (const l of report.shareLinks) lines.push(`  ${l.id}  ${l.status}  joins ${l.joins}/${l.maxJoins} (${l.remainingJoins} remaining)  issued by ${l.issuerMemberId}  expires ${l.expiresAt}`);
  lines.push(`Pending agent invites (${report.pendingInvites.length}):`);
  for (const i of report.pendingInvites) lines.push(`  ${i.inviteId}  ${i.displayName ?? "(unnamed)"}  ${i.status}  grants: ${grants(i.permissions)}  issued by ${i.inviterMemberId}  created ${i.createdAt}  expires ${i.expiresAt}`);
  lines.push(`Membership delegations (${report.membershipDelegations?.length ?? 0}):`);
  for (const grant of report.membershipDelegations ?? []) lines.push(`  ${grant.identityId}  member ${grant.memberId ?? "unlinked"}  granted by ${grant.grantedBy}  at ${when(grant.grantedAt)}  paths: ${grants(grant.authorityPaths)}${grant.dualGrantHazard ? "  [DUAL-GRANT HAZARD]" : ""}`);
  lines.push(`Agent identities (${report.agentIdentities.length}):`);
  for (const i of report.agentIdentities) lines.push(`  ${i.identityId}  ${i.displayName}  member ${i.memberId}${i.memberActive ? "" : " (inactive)"}  linked ${i.linkedAt}  last activity: ${when(i.lastActivityAt)}`);
  lines.push(`Agent connections (${report.agentConnections.length}):`);
  for (const c of report.agentConnections) lines.push(`  ${c.memberId}  ${c.displayName}  ${c.status}  generation ${c.generation}  grants: ${grants(c.permissions)}  expires ${c.expiresAt}  last activity: ${when(c.lastActivityAt)}`);
  return lines.join("\n") + "\n";
}
