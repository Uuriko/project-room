// FIX-77: sybil-resistant claim caps — advisory mint-cluster detection.
//
// Threat: per-member claim caps (docs/WORK-CLAIMS.md "Caps": 20 open claims
// per member) are identity-based, but anonymous identities are self-minted
// at POST /api/agent-identities (server/agent-identities.mjs), so one
// operator can mint N identities and hold N x 20 claims. The mint path
// already binds cost instead of identity (anonymousMintBuckets /
// admitAnonymous: per-address, per-network and per-day budgets plus adaptive
// proof-of-work via requiredPowBits), and the per-room cap (200) bounds
// total damage regardless of identity count. This module adds the remaining
// cheap signal: an ADVISORY flag when N distinct anonymous-mint identities
// sharing one mint fingerprint hold claims in the same room within a
// window. It never refuses a claim and never throws — a telemetry failure
// degrades to silence, not a broken claim path.
//
// Fleet safety: invite/in-process mints carry no mint fingerprint
// (mint_address IS NULL in agent_identities), so they are excluded by
// construction. A provisioned fleet (e.g. John's own hundreds of agents,
// provisioned rather than anonymously self-minted) cannot trip this — the
// heuristic does not try to distinguish a fleet from a sybil, it only
// watches anonymous self-mints.

export const SYBIL_CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
// Distinct anonymous-mint identities on one mint network holding claims in
// one room inside the window before the advisory fires.
export const SYBIL_CLUSTER_THRESHOLD = 5;

// Pure core. holders: [{ memberId, identityId, claimedAt }]. fingerprints:
// Map identityId -> { address, network } | null; a null entry (invite or
// in-process mint) is excluded. Returns one cluster per mint network at or
// above threshold, largest first.
export function detectSybilClusters({ holders, fingerprints, now, windowMs = SYBIL_CLUSTER_WINDOW_MS, threshold = SYBIL_CLUSTER_THRESHOLD }) {
  if (!Array.isArray(holders) || !(fingerprints instanceof Map)) return [];
  const stamp = Number.isFinite(now) ? now : Date.now();
  const byNetwork = new Map(); // network -> Map identityId -> Set memberId
  for (const h of holders) {
    if (!h || typeof h.identityId !== 'string' || typeof h.memberId !== 'string') continue;
    // claimedAt may be epoch ms or an ISO string (work-claim items store ISO).
    const claimedMs = typeof h.claimedAt === 'string' ? Date.parse(h.claimedAt) : h.claimedAt;
    if (!Number.isFinite(claimedMs) || stamp - claimedMs > windowMs) continue;
    const fp = fingerprints.get(h.identityId);
    if (!fp || typeof fp.network !== 'string' || !fp.network) continue; // no fingerprint: not an anonymous mint
    let group = byNetwork.get(fp.network);
    if (!group) { group = new Map(); byNetwork.set(fp.network, group); }
    let members = group.get(h.identityId);
    if (!members) { members = new Set(); group.set(h.identityId, members); }
    members.add(h.memberId);
  }
  const clusters = [];
  for (const [network, identities] of byNetwork) {
    if (identities.size < threshold) continue;
    const memberIds = [...new Set([...identities.values()].flatMap(set => [...set]))].sort();
    clusters.push({
      network,
      size: identities.size,
      memberIds,
      identityIds: [...identities.keys()].sort(),
      windowMs,
      threshold,
      text: '', // filled by sybilAdvisoryText below
    });
  }
  clusters.sort((a, b) => b.size - a.size);
  for (const c of clusters) c.text = sybilAdvisoryText(c);
  return clusters;
}

export function sybilAdvisoryText(cluster) {
  const size = cluster?.size ?? 0;
  const network = cluster?.network ?? 'unknown';
  return `Advisory: ${size} distinct anonymous-mint identities from one mint ` +
    `fingerprint (${network}) hold claims in this room within the last 24h. ` +
    `This is a signal, not a verdict — per-member caps assume one identity ` +
    `per agent, and anonymous identities are self-minted, so treat clustered ` +
    `claim pressure with skepticism. Nothing was blocked or penalized; ` +
    `invite/provisioned identities are excluded from this signal by design.`;
}

// Shape guard for the room-event field. Size must already be at threshold:
// a hand-built advisory below threshold is not a cluster.
export function validateSybilAdvisory(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.network !== 'string' || !value.network || value.network.length > 128) return false;
  if (!Number.isInteger(value.size) || value.size < SYBIL_CLUSTER_THRESHOLD) return false;
  if (!Array.isArray(value.memberIds) || value.memberIds.length === 0) return false;
  if (!value.memberIds.every(m => typeof m === 'string' && m.length > 0 && m.length <= 128)) return false;
  if (!Number.isInteger(value.windowMs) || value.windowMs <= 0) return false;
  if (!Number.isInteger(value.threshold) || value.threshold < SYBIL_CLUSTER_THRESHOLD) return false;
  if (typeof value.text !== 'string' || !/advisory/i.test(value.text)) return false;
  return true;
}

// --- DB-backed convenience for the claim route. Never throws: any
// telemetry failure returns an empty result so the claim path is unaffected.

export function mintFingerprintsFor(db, identityIds) {
  const out = new Map();
  try {
    const ids = [...new Set((identityIds ?? []).filter(id => typeof id === 'string'))];
    if (ids.length === 0 || !db?.prepare) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT identity_id AS identityId, mint_address AS address, mint_network AS network ` +
      `FROM agent_identities WHERE identity_id IN (${placeholders}) AND mint_address IS NOT NULL`
    ).all(...ids);
    for (const row of rows) out.set(row.identityId, { address: row.address, network: row.network });
  } catch { /* advisory only: degrade to silence */ }
  return out;
}

export function memberIdentityIds(db, roomId, memberIds) {
  const out = new Map();
  try {
    const ids = [...new Set((memberIds ?? []).filter(id => typeof id === 'string'))];
    if (ids.length === 0 || !db?.prepare || typeof roomId !== 'string') return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT member_id AS memberId, identity_id AS identityId FROM identity_links ` +
      `WHERE room_id=? AND member_id IN (${placeholders})`
    ).all(roomId, ...ids);
    for (const row of rows) out.set(row.memberId, row.identityId);
  } catch { /* advisory only: degrade to silence */ }
  return out;
}

// holders: [{ memberId, claimedAt }] for the room's open-claim holders,
// including the just-committed claim. Returns the first (largest) cluster's
// advisory payload, or null. Never throws.
export function detectSybilAdvisoryForHolders(db, roomId, holders, { now, windowMs, threshold } = {}) {
  try {
    const memberIds = (holders ?? []).map(h => h?.memberId).filter(id => typeof id === 'string');
    const links = memberIdentityIds(db, roomId, memberIds);
    const withIdentity = (holders ?? [])
      .filter(h => h && typeof h.memberId === 'string' && links.has(h.memberId))
      .map(h => ({ memberId: h.memberId, identityId: links.get(h.memberId), claimedAt: h.claimedAt }));
    const fingerprints = mintFingerprintsFor(db, withIdentity.map(h => h.identityId));
    const clusters = detectSybilClusters({ holders: withIdentity, fingerprints, now, windowMs, threshold });
    if (clusters.length === 0) return null;
    const { network, size, memberIds: mids, windowMs: wms, threshold: thr, text } = clusters[0];
    const advisory = { network, size, memberIds: mids, windowMs: wms, threshold: thr, text };
    return validateSybilAdvisory(advisory) ? advisory : null;
  } catch {
    return null;
  }
}
