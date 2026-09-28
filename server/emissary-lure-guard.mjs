// server/emissary-lure-guard.mjs
// Emissary growth layer — Slice 3 (IB-029): lure-generation abuse guardrails.
//
// Pure monitor functions over Slice 2's lure ledger row shapes. This module
// never suspends, demotes, or punishes anyone: it produces findings for the
// audit journal, and the response path is the room's existing spec §5.2
// (owner pause, repeated abuse → t1_readonly). Single anomalies are journaled
// as watch items; only compound signals escalate (§K finding 2/3 doctrine).
//
// Row contracts (shapes written by server/emissary-lure.mjs, Slice 2,
// RC-2026-09-28-2873; re-sync these shapes if that module changes):
//   drop:   { drop_id, room_id, issuer_member_id, venue, title, terms,
//             artifact_text, artifact_sha256, created_at (ms epoch) }
//   invite: { attribution_id, room_id, issuer_member_id, minted_at (ms epoch),
//             expires_at (ms epoch) }
//
// Limits mirrored from Slice 2: DROP_DAILY_LIMIT = 10 per member per venue
// per day; INVITE_DAILY_LIMIT = 20 per member per day. Slice 2 enforces
// these at generation time; this guard watches the ledger for farming
// patterns the caps alone do not see (mirror duplicates, sustained
// near-cap velocity, earnings drift in stored artifacts).

export const DROP_DAILY_LIMIT = 10;
export const INVITE_DAILY_LIMIT = 20;
const DAY_MS = 86_400_000;
// Composite map-key separator. A named constant so the control char is
// visible in review instead of a literal invisible byte in the source.
const KEY_SEP = "\u0001";

// Earnings-shaped claim patterns. Slice 2's template validator rejects
// these at generation; this guard re-scans stored artifacts for drift
// (a later edit or focus-word smuggling). Patterns are deliberately
// narrow: they must not flag honest recruiting copy ("earn" as a verb in
// "agents earn $DASHA doing real work" is fine — the patterns require a
// quantified payout promise).
export const FORBIDDEN_EARNINGS_PATTERNS = [
  /earn\s+up\s+to\s*\$?[\d,]+/i,                    // "earn up to $500"
  /\$?[\d,]+(\.\d+)?\s*(per|\/|a)\s*(day|week|month)/i, // "$500/day", "50 per week"
  /guaranteed\s+(income|returns?|profit|earnings?)/i,
  /passive\s+income/i,
  /get\s+rich/i,
  /risk[\s-]?free\s+(profit|returns?|earnings?|income)/i,
  /double\s+your\s+(money|investment|earnings?)/i,
];

function checkDrops(drops) {
  if (!Array.isArray(drops)) throw new Error("emissary_lure_guard_bad_input: drops must be an array");
  for (const d of drops) {
    if (!d || typeof d.drop_id !== "string" || typeof d.issuer_member_id !== "string")
      throw new Error("emissary_lure_guard_bad_input: drop needs drop_id and issuer_member_id");
    if (typeof d.created_at !== "number" || !Number.isFinite(d.created_at))
      throw new Error("emissary_lure_guard_bad_input: drop.created_at must be a finite ms epoch");
  }
}

// Duplicate-farming mirrors: the same artifact content (by sha256) minted
// as more than one drop — by different members, or by one member across
// venues. Slice 2 creates no ledger value, so a mirror cannot farm
// payouts; the harm is venue spam and copy-laundering.
export function findMirrorDrops(drops) {
  checkDrops(drops);
  const bySha = new Map();
  for (const d of drops) {
    const sha = d.artifact_sha256;
    if (!sha) continue;
    if (!bySha.has(sha)) bySha.set(sha, []);
    bySha.get(sha).push(d);
  }
  const mirrors = [];
  for (const [sha, rows] of bySha) {
    if (rows.length < 2) continue;
    const issuers = [...new Set(rows.map((r) => r.issuer_member_id))].sort();
    const venues = [...new Set(rows.map((r) => r.venue).filter(Boolean))].sort();
    const times = rows.map((r) => r.created_at).sort((a, b) => a - b);
    mirrors.push({
      artifact_sha256: sha,
      drop_ids: rows.map((r) => r.drop_id).sort(),
      issuers,
      venues,
      cross_member: issuers.length > 1,
      cross_venue: venues.length > 1,
      first_seen: times[0],
      last_seen: times[times.length - 1],
    });
  }
  mirrors.sort((a, b) => a.first_seen - b.first_seen);
  return mirrors;
}

// Re-scan stored artifacts for earnings-shaped claims (template drift).
export function scanArtifactDrift(drops) {
  checkDrops(drops);
  const hits = [];
  for (const d of drops) {
    const text = d.artifact_text ?? "";
    const violations = [];
    for (const pat of FORBIDDEN_EARNINGS_PATTERNS) {
      if (pat.test(text)) violations.push(pat.source);
    }
    if (violations.length) {
      hits.push({
        drop_id: d.drop_id,
        issuer_member_id: d.issuer_member_id,
        venue: d.venue ?? null,
        violations,
      });
    }
  }
  return hits;
}

// Velocity: per (member, venue) counts in a trailing window; plus the
// sustained near-cap pattern — >= nearCapFrac of the daily cap on at
// least sustainedDays of the last 7 days.
export function dropVelocity(drops, {
  windowMs = DAY_MS,
  limit = DROP_DAILY_LIMIT,
  nearCapFrac = 0.8,
  sustainedDays = 3,
  nowMs = Date.now(),
} = {}) {
  checkDrops(drops);
  const inWindow = drops.filter((d) => d.created_at <= nowMs && d.created_at > nowMs - windowMs);
  const counts = new Map();
  for (const d of inWindow) {
    const key = `${d.issuer_member_id}${KEY_SEP}${d.venue ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const breached = [];
  for (const [key, count] of counts) {
    const [member_id, venue] = key.split(KEY_SEP);
    if (count > limit) breached.push({ member_id, venue, count, limit, window_start: nowMs - windowMs, window_end: nowMs });
  }
  // Sustained near-cap: bucket trailing 7 days per (member, venue).
  const days = 7;
  const buckets = new Map();
  for (const d of drops) {
    if (d.created_at > nowMs || d.created_at <= nowMs - days * DAY_MS) continue;
    const day = Math.floor(d.created_at / DAY_MS);
    const key = `${d.issuer_member_id}${KEY_SEP}${d.venue ?? ""}${KEY_SEP}${day}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const perMemberVenue = new Map();
  for (const [key, count] of buckets) {
    const [member_id, venue] = key.split(KEY_SEP);
    const mk = `${member_id}${KEY_SEP}${venue}`;
    if (!perMemberVenue.has(mk)) perMemberVenue.set(mk, { member_id, venue, days_at_near_cap: 0 });
    if (count >= Math.ceil(limit * nearCapFrac)) perMemberVenue.get(mk).days_at_near_cap++;
  }
  const sustained = [];
  for (const row of perMemberVenue.values()) {
    if (row.days_at_near_cap >= sustainedDays) sustained.push(row);
  }
  sustained.sort((a, b) => b.days_at_near_cap - a.days_at_near_cap);
  breached.sort((a, b) => b.count - a.count);
  return { breached, sustained };
}

// Invite farming: cap-hit days per member; >= farmingDays cap hits in the
// trailing 7 days is the farming signal.
export function inviteFarming(invites, { dailyCap = INVITE_DAILY_LIMIT, farmingDays = 3, nowMs = Date.now() } = {}) {
  if (!Array.isArray(invites)) throw new Error("emissary_lure_guard_bad_input: invites must be an array");
  const buckets = new Map();
  for (const i of invites) {
    if (!i || typeof i.issuer_member_id !== "string" || !Number.isFinite(i.minted_at)) continue;
    if (i.minted_at > nowMs || i.minted_at <= nowMs - 7 * DAY_MS) continue;
    const key = `${i.issuer_member_id}${KEY_SEP}${Math.floor(i.minted_at / DAY_MS)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const capHits = new Map();
  for (const [key, count] of buckets) {
    if (count < dailyCap) continue;
    const [member_id] = key.split(KEY_SEP);
    if (!capHits.has(member_id)) capHits.set(member_id, []);
    capHits.get(member_id).push(count);
  }
  const farming = [];
  for (const [member_id, hits] of capHits) {
    if (hits.length >= farmingDays) farming.push({ member_id, cap_hit_days: hits.length, daily_cap: dailyCap });
  }
  farming.sort((a, b) => b.cap_hit_days - a.cap_hit_days);
  return farming;
}

// Compound assessment. Single anomalies -> watch (journaled). Escalation
// only when mirror duplication coincides with earnings drift, or when a
// sustained velocity pattern coincides with farming/invite abuse: the
// anti-gaming story is a compound fingerprint, never one signal.
export function assessLureRisk({ drops = [], invites = [], nowMs = Date.now() } = {}) {
  const mirrors = findMirrorDrops(drops);
  const drift = scanArtifactDrift(drops);
  const velocity = dropVelocity(drops, { nowMs });
  const farming = inviteFarming(invites, { nowMs });

  const watch = [];
  for (const m of mirrors) {
    watch.push({ kind: "mirror_drops", severity: "watch", drop_ids: m.drop_ids, issuers: m.issuers, cross_member: m.cross_member });
  }
  for (const d of drift) {
    watch.push({ kind: "earnings_drift", severity: "watch", drop_id: d.drop_id, issuer_member_id: d.issuer_member_id, violations: d.violations });
  }
  for (const v of velocity.breached) {
    watch.push({ kind: "drop_velocity_breach", severity: "watch", member_id: v.member_id, venue: v.venue, count: v.count });
  }
  for (const s of velocity.sustained) {
    watch.push({ kind: "sustained_velocity", severity: "watch", member_id: s.member_id, venue: s.venue, days_at_near_cap: s.days_at_near_cap });
  }
  for (const f of farming) {
    watch.push({ kind: "invite_farming", severity: "watch", member_id: f.member_id, cap_hit_days: f.cap_hit_days });
  }

  const escalations = [];
  const mirrorIssuers = new Set(mirrors.flatMap((m) => m.issuers));
  const escalated = new Set();
  for (const d of drift) {
    if (mirrorIssuers.has(d.issuer_member_id) && !escalated.has(d.issuer_member_id)) {
      escalated.add(d.issuer_member_id);
      escalations.push({
        kind: "mirror_plus_drift",
        severity: "escalate",
        issuer_member_id: d.issuer_member_id,
        reason: "duplicated artifact coincides with earnings-shaped claims — venue-spam plus dishonest copy",
      });
    }
  }
  const sustainedMembers = new Set(velocity.sustained.map((s) => s.member_id));
  for (const f of farming) {
    if (sustainedMembers.has(f.member_id)) {
      escalations.push({
        kind: "velocity_plus_invite_farming",
        severity: "escalate",
        issuer_member_id: f.member_id,
        reason: "sustained near-cap drop velocity coincides with invite-mint farming — coordinated funnel abuse",
      });
    }
  }

  return { watch, escalations, counts: { mirrors: mirrors.length, drift: drift.length, velocity_breaches: velocity.breached.length, sustained: velocity.sustained.length, farming: farming.length } };
}
