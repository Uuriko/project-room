// server/emissary-ringdetect.mjs
// Emissary growth layer — Slice 3 (IB-029): collusion-ring detection
// simulator library.
//
// Pure functions over in-memory event streams; no DB, no tables, no
// network I/O. This is the detection half of slice 3: the union-find /
// burst / fan-in / refund-loop / multi-signal pipeline from research §K
// (the Wazz serial-rugpull investigation transfer), validated against the
// synthetic Wazz-ring fixtures in tests/fixtures/wazz-rings.json before any
// real data exists (IB-002).
//
// Doctrine (research §K, transferred analysis — design rationale, not
// evidence):
//   1. Funding-key transitive closure is the serial-offender detector:
//      union-find entity clustering over shared attributes (payout address,
//      inviter, device fingerprint) is the EVM analogue of co-spend
//      clustering (Meiklejohn et al. 2013).
//   2. Bundle detection is a compound fingerprint, never one signal:
//      funding-hub topology + temporal synchrony + reward concentration
//      coincide or nothing flags.
//   3. False-positive discipline: one signal alone never suffices;
//      exclusions are journaled with reasons.
//   4. Detection operates on receipts/edges, never self-reports.
//   5. Per-entity prior-campaign record feeds the pipeline (supported via
//      the `campaign_id` edge attribute on identity events).
//
// Honesty: fixtures are SYNTHETIC and labeled. Findings are findings, not
// verdicts — this module never suspends, demotes, or accuses; the response
// path is the room's existing spec §5.2 (audit sampler / owner review).
//
// Wire prefixes: ent1. (detected entity), rng1. (flagged ring),
// brs1. (burst window). Collision-checked against main 2026-09-28: none of
// ent1./rng1./brs1. appear in server/ or src/.

import { createHash } from "node:crypto";

export class EmissaryRingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "EmissaryRingError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new EmissaryRingError(status, code, message); };

const sha32 = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
export const ENTITY_ID_PATTERN = /^ent1\.[0-9a-f]{32}$/;
export const RING_ID_PATTERN = /^rng1\.[0-9a-f]{32}$/;
export const BURST_ID_PATTERN = /^brs1\.[0-9a-f]{32}$/;

// Input shapes (plain objects; extra fields ignored):
//   identity: { external_id: string, created_at: number (ms epoch),
//               inviter_member_id?: string|null, payout_address?: string|null,
//               device_fingerprint?: string|null, campaign_id?: string|null }
//   receipt:  { receipt_id: string, kind: string, worker_external_id?: string,
//               payout_address: string, amount_raw?: string, created_at: number,
//               campaign_id?: string|null }
//   funding:  { from_address: string, to_address: string, created_at: number,
//               campaign_id?: string|null, note?: string }

const UNION_ATTRS = ["payout_address", "inviter_member_id", "device_fingerprint"];

function checkIdentities(identities) {
  if (!Array.isArray(identities)) fail(400, "emissary_ring_bad_input", "identities must be an array");
  for (const id of identities) {
    if (!id || typeof id.external_id !== "string" || id.external_id === "")
      fail(400, "emissary_ring_bad_input", "identity.external_id must be a non-empty string");
    if (typeof id.created_at !== "number" || !Number.isFinite(id.created_at))
      fail(400, "emissary_ring_bad_input", "identity.created_at must be a finite ms epoch");
  }
}

function checkReceipts(receipts) {
  if (!Array.isArray(receipts)) fail(400, "emissary_ring_bad_input", "receipts must be an array");
  for (const r of receipts) {
    if (!r || typeof r.payout_address !== "string" || r.payout_address === "")
      fail(400, "emissary_ring_bad_input", "receipt.payout_address must be a non-empty string");
  }
}

// Union-find entity clustering over shared attributes.
// Two identities join the same entity when they share any non-null
// attribute in UNION_ATTRS. Transitive by construction.
export function clusterEntities(identities) {
  checkIdentities(identities);
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // path compression
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const id of identities) parent.set(id.external_id, id.external_id);
  for (const attr of UNION_ATTRS) {
    const seen = new Map();
    for (const id of identities) {
      const v = id[attr];
      if (v === null || v === undefined || v === "") continue;
      if (seen.has(v)) union(id.external_id, seen.get(v));
      else seen.set(v, id.external_id);
    }
  }
  const groups = new Map();
  for (const id of identities) {
    const root = find(id.external_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  const entities = [];
  for (const members of groups.values()) {
    const memberIds = members.map((m) => m.external_id).sort();
    const shared = {};
    for (const attr of UNION_ATTRS) {
      const vals = new Set(members.map((m) => m[attr]).filter((v) => v !== null && v !== undefined && v !== ""));
      if (vals.size === 1) shared[attr] = [...vals][0];
    }
    const campaigns = [...new Set(members.map((m) => m.campaign_id).filter(Boolean))].sort();
    entities.push({
      entity_id: `ent1.${sha32(`entity|${memberIds.join(",")}`)}`,
      members: memberIds,
      size: memberIds.length,
      shared,
      campaigns,
    });
  }
  // Deterministic order for tests: largest first, then by entity_id.
  entities.sort((a, b) => b.size - a.size || (a.entity_id < b.entity_id ? -1 : 1));
  return entities;
}

// Burst detection: >= minSize identities of one campaign created within
// windowMs of each other. Organic spread (same count, wide window) scores
// nothing.
export function detectBursts(identities, { windowMs = 60000, minSize = 10 } = {}) {
  checkIdentities(identities);
  if (!Number.isFinite(windowMs) || windowMs <= 0) fail(400, "emissary_ring_bad_input", "windowMs must be positive");
  if (!Number.isInteger(minSize) || minSize < 2) fail(400, "emissary_ring_bad_input", "minSize must be an integer >= 2");
  const bursts = [];
  const byCampaign = new Map();
  for (const id of identities) {
    const c = id.campaign_id ?? "";
    if (!byCampaign.has(c)) byCampaign.set(c, []);
    byCampaign.get(c).push(id);
  }
  for (const [campaign, members] of byCampaign) {
    const sorted = [...members].sort((a, b) => a.created_at - b.created_at);
    let start = 0;
    for (let end = 0; end < sorted.length; end++) {
      while (sorted[end].created_at - sorted[start].created_at > windowMs) start++;
      const size = end - start + 1;
      if (size >= minSize) {
        // Emit one burst per maximal run: only when the run cannot extend.
        const next = end + 1;
        const maximal = next >= sorted.length || sorted[next].created_at - sorted[start].created_at > windowMs;
        if (maximal) {
          const windowIds = sorted.slice(start, end + 1).map((m) => m.external_id).sort();
          bursts.push({
            burst_id: `brs1.${sha32(`burst|${campaign}|${sorted[start].created_at}`)}`,
            campaign_id: campaign,
            member_ids: windowIds,
            window_start: sorted[start].created_at,
            window_end: sorted[end].created_at,
            size,
          });
          start = end + 1; // do not double-emit overlapping runs
        }
      }
    }
  }
  bursts.sort((a, b) => a.window_start - b.window_start);
  return bursts;
}

// Fan-in motif: >= minWorkers distinct workers whose release receipts
// converge on one payout address. The hub is flagged; the workers' inviter
// graph is returned so the caller can check the "proceeds fund the next
// campaign" loop.
export function detectFanIn(receipts, identities = [], { minWorkers = 5 } = {}) {
  checkReceipts(receipts);
  if (!Number.isInteger(minWorkers) || minWorkers < 2) fail(400, "emissary_ring_bad_input", "minWorkers must be an integer >= 2");
  const inviterOf = new Map();
  for (const id of identities ?? []) inviterOf.set(id.external_id, id.inviter_member_id ?? null);
  const byHub = new Map();
  for (const r of receipts) {
    if (!byHub.has(r.payout_address)) byHub.set(r.payout_address, []);
    byHub.get(r.payout_address).push(r);
  }
  const hubs = [];
  for (const [hub, rows] of byHub) {
    const workers = [...new Set(rows.map((r) => r.worker_external_id).filter(Boolean))].sort();
    if (workers.length < minWorkers) continue;
    const inviters = [...new Set(workers.map((w) => inviterOf.get(w)).filter(Boolean))].sort();
    hubs.push({
      hub,
      worker_ids: workers,
      receipt_ids: rows.map((r) => r.receipt_id).filter(Boolean).sort(),
      worker_count: workers.length,
      inviter_member_ids: inviters,
    });
  }
  hubs.sort((a, b) => b.worker_count - a.worker_count || (a.hub < b.hub ? -1 : 1));
  return hubs;
}

// Serial-refunding check ("proceeds fund the next campaign"):
// a funding edge H -> K is a loop when K bankrolls >= minFunded identities
// of a campaign that is not one of H's own campaigns (H's campaigns are
// the campaigns of identities referencing H by any union attribute; H may
// also be a fan-in hub from the receipts layer).
export function detectRefunding(funding, hubs, identities = [], { minFunded = 3 } = {}) {
  if (!Array.isArray(funding)) fail(400, "emissary_ring_bad_input", "funding must be an array");
  checkIdentities(identities);
  const candidateSources = new Set([...hubs.map((h) => h.hub), ...funding.map((e) => e.from_address)]);
  // campaigns referencing an address via any union attribute
  const refCampaigns = new Map();
  for (const id of identities) {
    for (const attr of UNION_ATTRS) {
      const v = id[attr];
      if (v === null || v === undefined || v === "" || !id.campaign_id) continue;
      if (!refCampaigns.has(v)) refCampaigns.set(v, new Set());
      refCampaigns.get(v).add(id.campaign_id);
    }
  }
  // identities bankrolled by an address (funding-key role: inviter or payout)
  const fundedBy = new Map();
  for (const id of identities) {
    for (const attr of ["inviter_member_id", "payout_address"]) {
      const v = id[attr];
      if (v === null || v === undefined || v === "") continue;
      if (!fundedBy.has(v)) fundedBy.set(v, new Set());
      fundedBy.get(v).add(id);
    }
  }
  const loops = [];
  for (const e of funding) {
    if (!candidateSources.has(e.from_address)) continue;
    const funded = fundedBy.get(e.to_address);
    if (!funded || funded.size < minFunded) continue;
    const own = refCampaigns.get(e.from_address) ?? new Set();
    const nextCampaigns = [...new Set([...funded].map((i) => i.campaign_id).filter(Boolean))]
      .filter((c) => !own.has(c)).sort();
    if (nextCampaigns.length === 0) continue;
    loops.push({
      from_hub: e.from_address,
      funding_key: e.to_address,
      funded_count: funded.size,
      next_campaign_ids: nextCampaigns,
      funded_at: e.created_at,
    });
  }
  loops.sort((a, b) => (a.funded_at ?? 0) - (b.funded_at ?? 0));
  return loops;
}

// Multi-signal rule. Signals per entity cluster:
//   shared_attribute_cluster (always true for a cluster of size >= 3)
//   temporal_synchrony (burst covering >= half the entity's members)
//   reward_concentration (fan-in hub covering >= half the entity's members)
//   serial_refunding (refund loop touching the entity's hub)
// Flagged iff cluster + synchrony + concentration coincide (§K finding 2).
// Anything less is journaled as excluded-with-reason (§K finding 3).
export function detectRings({ identities = [], receipts = [], funding = [], burstOpts, fanInOpts, refundOpts } = {}) {
  checkIdentities(identities);
  checkReceipts(receipts);
  const entities = clusterEntities(identities);
  const bursts = detectBursts(identities, burstOpts);
  const hubs = detectFanIn(receipts, identities, fanInOpts);
  const loops = detectRefunding(funding, hubs, identities, refundOpts);

  const memberSet = (ids) => new Set(ids);
  const burstSets = bursts.map((b) => ({ ...b, set: memberSet(b.member_ids) }));
  const hubSets = hubs.map((h) => ({ ...h, set: memberSet(h.worker_ids) }));

  const flagged = [];
  const excluded = [];
  const byId = new Map(identities.map((i) => [i.external_id, i]));
  const membersById = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  for (const e of entities) {
    if (e.size < 3) {
      excluded.push({ entity_id: e.entity_id, members: e.members, reason: "below cluster size floor (2 or fewer)" });
      continue;
    }
    const overlap = (set) => e.members.filter((m) => set.has(m)).length;
    const synchrony = burstSets.filter((b) => overlap(b.set) >= Math.ceil(e.size / 2));
    const concentration = hubSets.filter((h) => overlap(h.set) >= Math.ceil(e.size / 2));
    // Refund loop touches the entity when the loop's funding key is one of
    // the entity's shared attributes (the key that bankrolled the entity)
    // or when a member references the loop's source hub by payout address.
    const sharedVals = new Set(Object.values(e.shared));
    const memberAddrs = new Set();
    for (const m of membersById(e.members)) {
      if (m.payout_address) memberAddrs.add(m.payout_address);
      if (m.inviter_member_id) memberAddrs.add(m.inviter_member_id);
    }
    const refunding = loops.filter((l) => sharedVals.has(l.funding_key) || memberAddrs.has(l.from_hub));
    const signals = ["shared_attribute_cluster"];
    if (synchrony.length) signals.push("temporal_synchrony");
    if (concentration.length) signals.push("reward_concentration");
    if (refunding.length) signals.push("serial_refunding");
    const evidence = {
      entity_id: e.entity_id,
      members: e.members,
      shared: e.shared,
      bursts: synchrony.map(({ set, ...b }) => b),
      hubs: concentration.map(({ set, ...h }) => h),
      refund_loops: refunding,
    };
    if (signals.includes("temporal_synchrony") && signals.includes("reward_concentration")) {
      const ringId = `rng1.${sha32(`ring|${e.entity_id}|${signals.slice().sort().join(",")}`)}`;
      flagged.push({ ring_id: ringId, signals: signals.slice().sort(), evidence });
    } else {
      const missing = ["temporal_synchrony", "reward_concentration"].filter((s) => !signals.includes(s));
      excluded.push({
        entity_id: e.entity_id,
        members: e.members,
        reason: `single-signal exclusion: present [${signals.join(", ")}]; missing [${missing.join(", ")}] — no fraud finding`,
      });
    }
  }
  return { flagged, excluded, entities, bursts, hubs, refund_loops: loops };
}

// Journal line for an exclusion — the false-positive discipline made
// concrete: exclusions are recorded with their reason, not dropped.
export function formatExclusion(entry) {
  return `excluded ${entry.entity_id} (${entry.members.length} members): ${entry.reason}`;
}
