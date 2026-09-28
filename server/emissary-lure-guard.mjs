// Emissary slice 3 (IB-029) — lure-generation abuse guardrails
// (RC-2026-09-28-2905).
//
// The abuse layer that sits in front of slice-2's lure generation
// (emissary_drop / emissary_pitch / human_invite_mint). It answers one
// question per call — "should this generation proceed, and what does the
// evidence say?" — and returns findings. It never punishes: no tier
// demotions, no revocations, no writes. Enforcement decisions belong to
// the owner/operator (spec §5.2), who acts on the findings this module
// produces.
//
// All state is caller-owned: ledger rows are passed in (shaped like
// slice-2's emissary_drops / emissary_invite_attribution rows); the
// caller-owned `journal` array collects findings when provided. This
// module never opens a socket, never touches a database, never persists
// anything, and never sees a real identity: offender refs are
// SYNTH-*-shaped fixture ids only, enforced by assertSyntheticRef.

const fail = (code, message, details) => {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  throw err;
};

export const SYNTH_REF_RE = /^SYNTH-[A-Za-z0-9-]+$/;

/**
 * assertSyntheticRef(ref) — the "never real identities" enforcement.
 * Offender refs in this layer are fixture-shaped ids only. Anything that
 * does not match SYNTH-* (including anything shaped like a real on-chain
 * address or a real member id) is rejected before it can enter the
 * history hook.
 */
export function assertSyntheticRef(ref) {
  if (typeof ref !== "string" || !SYNTH_REF_RE.test(ref)) {
    fail("emissary_guard_non_synthetic_ref", "offender refs must be synthetic fixture ids (SYNTH-*)", { ref });
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Rate limits — drop ledger rows (slice-2 emissary_drops shape)
// ---------------------------------------------------------------------------

const DEFAULT_DROP_CAP = 10; // per member / venue / day (spec §5.2)
const DEFAULT_INVITE_CAP = 20; // per member / day (slice-2 plan)
const DAY_MS = 86_400_000;

/**
 * checkDropRateLimit(rows, { memberId, venue, nowMs, cap, windowMs })
 * -> { allowed, used, cap, resetsAt }
 * rows: [{ issuer_member_id, venue, created_at }] — slice-2
 * emissary_drops-shaped. Pure read; nothing written.
 */
export function checkDropRateLimit(rows, { memberId, venue, nowMs = Date.now(), cap = DEFAULT_DROP_CAP, windowMs = DAY_MS } = {}) {
  if (!Array.isArray(rows)) fail("emissary_guard_bad_rows", "rows must be an array");
  if (typeof memberId !== "string" || typeof venue !== "string") {
    fail("emissary_guard_bad_input", "memberId and venue are required strings");
  }
  const since = nowMs - windowMs;
  const used = rows.filter(
    (r) => r.issuer_member_id === memberId && r.venue === venue && r.created_at >= since && r.created_at <= nowMs
  ).length;
  const oldest = rows
    .filter((r) => r.issuer_member_id === memberId && r.venue === venue && r.created_at >= since && r.created_at <= nowMs)
    .reduce((min, r) => Math.min(min, r.created_at), nowMs);
  return {
    allowed: used < cap,
    used,
    cap,
    resetsAt: used >= cap ? oldest + windowMs : nowMs,
  };
}

/**
 * checkInviteMintCap(rows, { memberId, nowMs, cap, windowMs })
 * -> { allowed, used, cap, resetsAt }
 * rows: [{ issuer_member_id, minted_at }] — slice-2
 * emissary_invite_attribution-shaped.
 */
export function checkInviteMintCap(rows, { memberId, nowMs = Date.now(), cap = DEFAULT_INVITE_CAP, windowMs = DAY_MS } = {}) {
  if (!Array.isArray(rows)) fail("emissary_guard_bad_rows", "rows must be an array");
  const since = nowMs - windowMs;
  const inWindow = rows.filter(
    (r) => r.issuer_member_id === memberId && r.minted_at >= since && r.minted_at <= nowMs
  );
  const oldest = inWindow.reduce((min, r) => Math.min(min, r.minted_at), nowMs);
  const used = inWindow.length;
  return {
    allowed: used < cap,
    used,
    cap,
    resetsAt: used >= cap ? oldest + windowMs : nowMs,
  };
}

/**
 * checkIdentityCaps(dropRows, { memberId, nowMs, perVenueCap, totalCap, windowMs })
 * -> { perVenue: { [venue]: { used, cap, allowed } }, total: { used, cap, allowed } }
 * Per-identity caps: a farm spreads across venues, so the cross-venue
 * total is the binding constraint, not any single venue's cap.
 */
export function checkIdentityCaps(dropRows, { memberId, nowMs = Date.now(), perVenueCap = DEFAULT_DROP_CAP, totalCap = 30, windowMs = DAY_MS } = {}) {
  if (!Array.isArray(dropRows)) fail("emissary_guard_bad_rows", "rows must be an array");
  const since = nowMs - windowMs;
  const mine = dropRows.filter(
    (r) => r.issuer_member_id === memberId && r.created_at >= since && r.created_at <= nowMs
  );
  const perVenue = {};
  for (const r of mine) {
    perVenue[r.venue] = perVenue[r.venue] || { used: 0, cap: perVenueCap, allowed: true };
    perVenue[r.venue].used += 1;
  }
  for (const v of Object.values(perVenue)) v.allowed = v.used < v.cap;
  const totalUsed = mine.length;
  return {
    perVenue,
    total: { used: totalUsed, cap: totalCap, allowed: totalUsed < totalCap },
  };
}

// ---------------------------------------------------------------------------
// Mirror-drop detection — same artifact text reposted across venues
// ---------------------------------------------------------------------------

const normalizeText = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

const tokenJaccard = (a, b) => {
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
};

/**
 * detectMirrorDrops(artifacts, { similarity })
 * -> [{ issuer, venues, count, similarity, sample }]
 * artifacts: [{ issuer_member_id, venue, text, created_at }].
 * Flags near-duplicate copy posted by ONE issuer across MULTIPLE venues
 * (spam-farm shape). Same issuer posting distinct copy per venue is not
 * flagged; different issuers posting similar copy is a separate concern
 * (coordinated inauthentic behavior — out of scope here, noted).
 */
export function detectMirrorDrops(artifacts, { similarity = 0.9 } = {}) {
  if (!Array.isArray(artifacts)) fail("emissary_guard_bad_rows", "artifacts must be an array");
  const byIssuer = new Map();
  for (const a of artifacts) {
    if (!byIssuer.has(a.issuer_member_id)) byIssuer.set(a.issuer_member_id, []);
    byIssuer.get(a.issuer_member_id).push(a);
  }
  const findings = [];
  for (const [issuer, list] of byIssuer) {
    const norms = list.map((a) => ({ ...a, norm: normalizeText(a.text) }));
    // exact duplicates first
    const byHash = new Map();
    for (const n of norms) {
      if (!byHash.has(n.norm)) byHash.set(n.norm, []);
      byHash.get(n.norm).push(n);
    }
    const groups = [];
    const claimed = new Set();
    for (const group of byHash.values()) {
      const venues = new Set(group.map((g) => g.venue));
      if (venues.size >= 2) {
        groups.push({ members: group, similarity: 1, venues: [...venues].sort() });
        for (const g of group) claimed.add(g);
      }
    }
    // fuzzy pass over the unclaimed
    const rest = norms.filter((n) => !claimed.has(n));
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        if (rest[i].venue === rest[j].venue) continue;
        const sim = tokenJaccard(rest[i].norm, rest[j].norm);
        if (sim >= similarity) {
          groups.push({
            members: [rest[i], rest[j]],
            similarity: Math.round(sim * 100) / 100,
            venues: [rest[i].venue, rest[j].venue].sort(),
          });
        }
      }
    }
    for (const g of groups) {
      findings.push({
        kind: "mirror_drop",
        issuer,
        venues: g.venues,
        count: g.members.length,
        similarity: g.similarity,
        sample: String(g.members[0].text).slice(0, 160),
      });
    }
  }
  findings.sort((a, b) => b.similarity - a.similarity || (a.issuer < b.issuer ? -1 : 1));
  return findings;
}

// ---------------------------------------------------------------------------
// Earnings-drift re-scan — stored artifacts re-checked over time
// ---------------------------------------------------------------------------

/**
 * DRIFT_PATTERNS — the guard's own drift subset. The canonical forbidden
 * list lives in slice-2's lure module (FORBIDDEN_PATTERNS); this module
 * re-scans STORED artifacts for the highest-risk drift class
 * (earnings-shaped claims sneaking in via member words or template edits)
 * and accepts caller-injected validators for the rest.
 */
export const DRIFT_PATTERNS = Object.freeze([
  { name: "drift_earnings_up_to", pattern: /earn\s+(up\s+to|over)\b/i },
  { name: "drift_earnings_rate", pattern: /\$\s?\d[\d,]*(\.\d+)?\s*(per|a)\s*(day|week|month)\b/i },
  { name: "drift_guaranteed", pattern: /\bguarantee[ds]?\b/i },
  { name: "drift_passive_income", pattern: /passive\s+income/i },
]);

/**
 * rescanStoredArtifacts(artifacts, { validators, journal })
 * -> [{ artifact, violations: [{ name, message }] }]
 * artifacts: [{ artifact_id?, issuer_member_id, venue, text }].
 * validators: extra (name, fn) pairs — e.g. slice-2's validateLureTemplate
 *   wired in by the caller. Each fn receives the text and returns an array
 *   of violation names (empty = clean).
 * Findings only: the caller decides whether to quarantine, nudge, or
 *   demote — this module never acts.
 */
export function rescanStoredArtifacts(artifacts, { validators = [], journal = null } = {}) {
  if (!Array.isArray(artifacts)) fail("emissary_guard_bad_rows", "artifacts must be an array");
  const findings = [];
  for (const a of artifacts) {
    const text = String(a.text ?? "");
    const violations = [];
    for (const { name, pattern } of DRIFT_PATTERNS) {
      if (pattern.test(text)) violations.push({ name, message: `stored artifact matches drift pattern ${name}` });
    }
    for (const v of validators) {
      const names = v.fn(text) || [];
      for (const name of names) violations.push({ name, message: `injected validator ${v.name} flagged ${name}` });
    }
    if (violations.length > 0) {
      const finding = {
        kind: "earnings_drift",
        artifact: a.artifact_id ?? null,
        issuer: a.issuer_member_id,
        venue: a.venue,
        violations,
        at: Date.now(),
      };
      findings.push(finding);
      if (journal) journal.push(finding);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Velocity anomalies — spike detection over generation events
// ---------------------------------------------------------------------------

/**
 * detectVelocityAnomalies(events, { nowMs, windowMs, baselineWindows, ratio })
 * -> [{ member, kind, current, baselineMean, ratio }]
 * events: [{ member_id, kind, created_at }], kind e.g. "drop" | "invite".
 * A member generating >= ratio x their own recent baseline inside one
 * window is a velocity anomaly (account-takeover or farm-script shape).
 */
export function detectVelocityAnomalies(
  events,
  { nowMs = Date.now(), windowMs = 3_600_000, baselineWindows = 4, ratio = 4 } = {}
) {
  if (!Array.isArray(events)) fail("emissary_guard_bad_rows", "events must be an array");
  const byKey = new Map();
  for (const e of events) {
    const key = `${e.member_id}\u0000${e.kind}`;
    if (!byKey.has(key)) byKey.set(key, { member: e.member_id, kind: e.kind, counts: new Array(baselineWindows + 1).fill(0) });
    const slot = byKey.get(key);
    const age = nowMs - e.created_at;
    if (age < 0 || age >= windowMs * (baselineWindows + 1)) continue;
    const idx = Math.floor(age / windowMs);
    slot.counts[idx] += 1;
  }
  const out = [];
  for (const slot of byKey.values()) {
    const current = slot.counts[0];
    const baseline = slot.counts.slice(1);
    const baselineMean = baseline.reduce((s, c) => s + c, 0) / baseline.length;
    if (current === 0) continue;
    if (baselineMean === 0) {
      // cold baseline: any meaningful burst is anomalous
      if (current >= 3) out.push({ member: slot.member, kind: slot.kind, current, baselineMean: 0, ratio: Infinity });
      continue;
    }
    const r = current / baselineMean;
    if (r >= ratio) {
      out.push({
        member: slot.member,
        kind: slot.kind,
        current,
        baselineMean: Math.round(baselineMean * 100) / 100,
        ratio: Math.round(r * 100) / 100,
      });
    }
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

// ---------------------------------------------------------------------------
// Serial-offender history hook — Wazz watchlist SHAPE matching
// ---------------------------------------------------------------------------

/**
 * WATCHLIST_SHAPES — the Wazz watchlist's shape, not its data. The node
 * ROLES and evidence grades below are copied from the watchlist doc
 * (wazz-watchlist/WATCHLIST.md in the workspace). NO addresses (the
 * report published only truncated prefixes), NO identities, NO
 * accusations. The honesty rule travels with the shape: a shape match
 * is a checkable structural observation, never a conclusion about who
 * controls a node or why.
 */
export const WATCHLIST_SHAPES = Object.freeze([
  { role: "collector_hub", description: "fan-in hub: many wallets -> one node in seconds (179.88 ETH, 98 wallets, 3s)", evidenceGrade: "verified" },
  { role: "distributor", description: "fan-out node: one key funds dozens of addresses, rapid pass-through (20 ETH in, 15.98 ETH -> 50 addresses, 16s)", evidenceGrade: "verified" },
  { role: "distribution_set", description: "the funded set: many addresses acting in lockstep (sell-off into the pool)", evidenceGrade: "reported" },
  { role: "cashout_destination", description: "fresh address receiving the bridged proceeds (~231k DAI)", evidenceGrade: "reported" },
]);

const GRADE_RANK = { reported: 0, verified: 1 };

/**
 * checkSerialOffenderHistory({ candidateRoles, history, nowMs, journal })
 * -> { shapeMatch, matchedRoles, evidenceGrade, repeatOffender, priorCount, offenderRef }
 *
 * candidateRoles: [{ role, offenderRef }] — roles extracted from a
 *   candidate flow (e.g. from ringdetect findings), refs SYNTH-* only.
 * history: [{ offender_ref, matched_roles, first_seen, last_seen, count }]
 *   — prior findings, fixture refs only.
 *
 * Returns whether the candidate matches a known serial-ring shape AND
 * whether that shape has been seen before (repeat offender). Findings
 * only — the caller decides the response.
 */
export function checkSerialOffenderHistory({ candidateRoles, history = [], nowMs = Date.now(), journal = null } = {}) {
  if (!Array.isArray(candidateRoles)) fail("emissary_guard_bad_input", "candidateRoles must be an array");
  if (!Array.isArray(history)) fail("emissary_guard_bad_input", "history must be an array");
  const knownRoles = new Set(WATCHLIST_SHAPES.map((s) => s.role));
  const matchedRoles = [];
  let minGrade = null;
  for (const c of candidateRoles) {
    assertSyntheticRef(c.offenderRef);
    if (!knownRoles.has(c.role)) continue;
    const shape = WATCHLIST_SHAPES.find((s) => s.role === c.role);
    matchedRoles.push(c.role);
    if (minGrade === null || GRADE_RANK[shape.evidenceGrade] < GRADE_RANK[minGrade]) {
      minGrade = shape.evidenceGrade;
    }
  }
  const shapeMatch = matchedRoles.length > 0;
  // repeat offender: a prior history row whose ref prefix-family matches
  // any candidate ref's family (the part before the trailing index).
  const families = new Set(candidateRoles.map((c) => c.offenderRef.replace(/-\d+$/, "")));
  let priorCount = 0;
  let firstSeen = null;
  let lastSeen = null;
  for (const h of history) {
    assertSyntheticRef(h.offender_ref);
    if (families.has(h.offender_ref.replace(/-\d+$/, ""))) {
      priorCount += h.count || 1;
      if (firstSeen === null || h.first_seen < firstSeen) firstSeen = h.first_seen;
      if (lastSeen === null || h.last_seen > lastSeen) lastSeen = h.last_seen;
    }
  }
  const result = {
    shapeMatch,
    matchedRoles: [...new Set(matchedRoles)].sort(),
    evidenceGrade: minGrade,
    repeatOffender: priorCount > 0,
    priorCount,
    firstSeen,
    lastSeen,
    at: nowMs,
  };
  if (journal && shapeMatch) journal.push({ kind: "serial_offender_shape", ...result });
  return result;
}
