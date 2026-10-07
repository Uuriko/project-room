// server/routing.mjs — affinity router, SHADOW MODE (lane B18, design lane D6).
//
// PURE SCORING. No I/O. This module computes routing records and nothing else:
// it never claims, never settles, never posts to the room, never touches auth
// or payments. Routing decisions MUST NOT change — the module only exports
// scores, the guard, the record builder, and backtest metrics. It is never
// called from routing paths (enforced by tests/routing-shadow.test.js).
//
// All weights and tunables live in server/routing-config.json (one
// ROUTING_WEIGHTS block). This module takes `config` as an argument so it
// stays dependency-free; DEFAULT_CONFIG mirrors the JSON and is used when no
// config is supplied. If they drift, routing-config.json wins.

export const ROUTER_VERSION = "routing/1.0";
export const SHADOW_MODE = true; // shadow has no automatic promotion — D6 §4.3

// Mirrors server/routing-config.json. Canonical source is the JSON file;
// this fallback exists so the pure scorer never needs I/O.
export const DEFAULT_CONFIG = Object.freeze({
  ROUTING_WEIGHTS: Object.freeze({
    fileClaimOverlap: 0.35,
    prRecency: 0.20,
    capabilityMatch: 0.15,
    keywordOverlap: 0.10,
    loadPenalty: -0.20,
    leaseHealthPenalty: -0.10,
  }),
  decay: Object.freeze({
    prHalfLifeDays: 14,
    prLookbackDays: 60,
    keywordLookbackDays: 90,
    leaseWindowDays: 30,
  }),
  memberClaimCap: 20,
  freshnessMinutes: 15,
  confidence: Object.freeze({ highScore: 0.65, highLead: 0.10, mediumScore: 0.35, topK: 3 }),
});

export const SIGNAL_KEYS = Object.freeze([
  "fileClaimOverlap",
  "prRecency",
  "capabilityMatch",
  "keywordOverlap",
  "loadPenalty",
  "leaseHealthPenalty",
]);

const DAY_MS = 86_400_000;

// Path normalization — same rules as server/claim-collisions.mjs (trim, drop
// leading ./, collapse duplicate slashes, drop trailing slashes; case kept).
const normalizeFile = path => {
  if (typeof path !== "string" || path.trim().length === 0) throw new Error("files must be non-empty strings");
  let p = path.trim().replace(/\\+/g, "/").replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p.length === 0 || p === ".") throw new Error("files must name a real path");
  return p;
};

const dirnameOf = p => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
};

// Path affinity between one wanted path and one held path:
// exact = 1.0, same directory = 0.4, else 0.
const pathAffinity = (wanted, held) => {
  if (wanted === held) return { score: 1.0, match: "exact" };
  if (dirnameOf(wanted) !== "" && dirnameOf(wanted) === dirnameOf(held)) return { score: 0.4, match: "directory" };
  return { score: 0.0, match: "none" };
};

// Overlap of a work item's files against a set of held files. Returns the best
// {score, heldFile, match} per wanted path, averaged over wanted paths.
const overlapScore = (wantedFiles, heldFiles, { cite } = {}) => {
  const wanted = [...new Set((wantedFiles ?? []).map(normalizeFile))];
  if (wanted.length === 0) return { score: 0, detail: null };
  const held = [...new Set((heldFiles ?? []).map(normalizeFile))];
  let total = 0;
  let best = null;
  for (const w of wanted) {
    let bw = { score: 0, match: "none", heldFile: null };
    for (const h of held) {
      const a = pathAffinity(w, h);
      if (a.score > bw.score) bw = { ...a, heldFile: h };
    }
    total += bw.score;
    if (!best || bw.score > best.score) best = { wantedFile: w, ...bw };
  }
  return { score: total / wanted.length, detail: best, fileCount: wanted.length };
};

const STOPWORDS = new Set(("a,an,the,and,or,to,of,in,on,for,with,from,by,is,are,was,were,be,as,at,it,this,that,these,those,not,no,do,does,did,will,would,can,could,should,into,over,under,up,out,off,fix,fixed,fixes,add,added,new,use,used,using,via,per,all,any,each,more,most,other,some,such,than,then,too,very,when,while,which,who,whom,what,where,why,how,because,until,against,between,through,during,before,after,above,below,again,once,here,there,their,theirs,them,they,we,you,your,our,my,me,him,her,his,its,i").split(","));
const stem = word => word.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(ing|ies|es|ed|s)$/, "");
const keywordsOf = text => {
  const out = new Set();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const w = stem(raw);
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
};

const jaccard = (a, b) => {
  const A = new Set(a ?? []);
  const B = new Set(b ?? []);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

const clamp01 = x => Math.min(1, Math.max(0, x));
const withinDays = (ts, now, days) => typeof ts === "number" && now - ts <= days * DAY_MS && ts <= now;

// --- lane context -------------------------------------------------------------
// workItem: { taskId?, title, brief?, files?: string[], tags?: string[] }
// lane: { id, openClaims?: [{id, files?}], mergedPRs?: [{number, files?, mergedAt?}],
//         openRedCiPRs?: [{number, files?}], completedClaims?: [{id, title?, files?, tags?, completedAt?, state?}],
//         capabilities?: {tags?, areas?}, cap? }
// ctx: { config?, now?, capabilities?: {lanes: {<id>: {tags?, areas?}}}, memberCaps?: {<id>: n} }

const laneConfig = (lane, ctx) => {
  const cfg = ctx?.config ?? DEFAULT_CONFIG;
  const cap = lane.cap ?? ctx?.memberCaps?.[lane?.id] ?? cfg.memberClaimCap;
  return { cfg, cap };
};

const openClaimList = lane => (lane?.openClaims ?? []).filter(c => c && typeof c.id === "string");

export function scoreLane(workItem, lane, ctx = {}) {
  if (!workItem || typeof workItem.title !== "string" || workItem.title.length === 0) {
    throw new Error("workItem.title is required");
  }
  if (!lane || typeof lane.id !== "string" || lane.id.length === 0) {
    throw new Error("lane.id is required");
  }
  const { cfg, cap } = laneConfig(lane, ctx);
  const w = cfg.ROUTING_WEIGHTS;
  const now = ctx?.now ?? Date.now();
  const reasons = [];
  const signals = {};

  // Signal 1 — open file-claim overlap: best per-claim overlap wins, cited.
  let bestOverlap = { score: 0, detail: null, claimId: null };
  for (const claim of openClaimList(lane)) {
    const o = overlapScore(workItem.files, claim.files);
    if (o.score > bestOverlap.score) bestOverlap = { ...o, claimId: claim.id };
  }
  signals.fileClaimOverlap = clamp01(bestOverlap.score);
  if (bestOverlap.score > 0) {
    reasons.push({
      signal: "fileClaimOverlap",
      text: `holds open claim ${bestOverlap.claimId} on ${bestOverlap.detail.heldFile} (${bestOverlap.detail.match} file match)`,
    });
  } else {
    reasons.push({ signal: "fileClaimOverlap", text: "no open claims on these files" });
  }

  // Signal 2 — merged PR recency, 14-day half-life; red-CI open PRs never add affinity.
  const halfLife = cfg.decay.prHalfLifeDays;
  const lookback = cfg.decay.prLookbackDays;
  let bestPr = { score: 0, number: null, detail: null };
  for (const pr of lane?.mergedPRs ?? []) {
    if (!withinDays(pr?.mergedAt, now, lookback)) continue;
    const o = overlapScore(workItem.files, pr.files);
    if (o.score <= 0) continue;
    const days = (now - pr.mergedAt) / DAY_MS;
    const s = o.score * Math.exp(-Math.LN2 * days / halfLife);
    if (s > bestPr.score) bestPr = { score: s, number: pr.number, detail: o.detail, days };
  }
  signals.prRecency = clamp01(bestPr.score);
  if (bestPr.number != null) {
    const stale = bestPr.days > halfLife ? " (decayed)" : "";
    reasons.push({
      signal: "prRecency",
      text: `merged PR #${bestPr.number} touching ${bestPr.detail.heldFile} ${Math.round(bestPr.days)} days ago${stale}`,
    });
  } else {
    reasons.push({ signal: "prRecency", text: "no merged PRs in this area within lookback" });
  }

  // Signal 3 — capability tag match: history augments declared tags, never overridden.
  const historyTags = new Set();
  for (const c of lane?.completedClaims ?? []) for (const t of c?.tags ?? []) historyTags.add(t);
  const declared = ctx?.capabilities?.lanes?.[lane.id] ?? lane?.capabilities ?? {};
  const laneTags = new Set([...historyTags, ...((declared?.tags ?? []))]);
  signals.capabilityMatch = clamp01(jaccard(workItem.tags ?? [], [...laneTags]));
  const matchedTags = (workItem.tags ?? []).filter(t => laneTags.has(t));
  if (matchedTags.length > 0) {
    const fromHistory = matchedTags.filter(t => historyTags.has(t)).length;
    reasons.push({
      signal: "capabilityMatch",
      text: `capability tag${matchedTags.length > 1 ? "s" : ""} ${matchedTags.map(t => `'${t}'`).join(", ")}${fromHistory > 0 ? ` (${fromHistory} from completed claims)` : " (declared)"}`,
    });
  } else {
    reasons.push({ signal: "capabilityMatch", text: "no capability tag overlap" });
  }

  // Signal 4 — brief/keyword overlap vs done-claim titles (90d), stemmed, stop-worded.
  const wantKw = keywordsOf(`${workItem.title} ${workItem.brief ?? ""}`);
  const doneTitles = (lane?.completedClaims ?? [])
    .filter(c => withinDays(c?.completedAt, now, cfg.decay.keywordLookbackDays) && typeof c?.title === "string")
    .map(c => c.title);
  let kwHit = 0;
  const kwEvidence = [];
  for (const title of doneTitles) {
    const tk = keywordsOf(title);
    for (const k of wantKw) if (tk.has(k)) { kwHit++; kwEvidence.push(k); break; }
  }
  signals.keywordOverlap = wantKw.size === 0 ? 0 : clamp01(kwHit / wantKw.size);
  if (kwHit > 0) {
    reasons.push({
      signal: "keywordOverlap",
      text: `keyword overlap with ${kwHit} done claim${kwHit > 1 ? "s" : ""} (e.g. '${[...new Set(kwEvidence)].slice(0, 3).join("', '")}')`,
    });
  } else {
    reasons.push({ signal: "keywordOverlap", text: "no keyword overlap with recent done-claim titles" });
  }

  // Signal 5 — claim load penalty. Over cap = ineligible before scoring.
  const openCount = openClaimList(lane).length;
  signals.loadPenalty = cap > 0 ? openCount / cap : 1;
  const ineligible = cap > 0 && openCount >= cap;
  reasons.push({
    signal: "loadPenalty",
    text: ineligible ? `load: ${openCount}/${cap} open claims — over cap, ineligible` : `load: ${openCount}/${cap} open claims`,
  });

  // Signal 6 — lease health: lapsed share in 30d; open red-CI PRs count against too.
  const window = lane?.claimsWindow30d ?? (lane?.completedClaims ?? []).filter(c => withinDays(c?.claimedAt ?? c?.completedAt, now, cfg.decay.leaseWindowDays));
  const redCi = lane?.openRedCiPRs ?? [];
  const lapsed = window.filter(c => c && ["released", "expired", "withdrawn"].includes(c.state)).length;
  const basis = window.length + redCi.length;
  signals.leaseHealthPenalty = basis === 0 ? 0 : clamp01((lapsed + redCi.length) / basis);
  if (signals.leaseHealthPenalty > 0) {
    const bits = [];
    if (lapsed > 0) bits.push(`${lapsed}/${window.length} claims lapsed in 30d`);
    for (const pr of redCi.slice(0, 3)) bits.push(`open PR #${pr.number} has red CI`);
    reasons.push({ signal: "leaseHealthPenalty", text: bits.join("; ") });
  } else {
    reasons.push({ signal: "leaseHealthPenalty", text: "no lapsed leases in 30d" });
  }

  if (ineligible) {
    return { lane: lane.id, score: 0, confidence: "ineligible", ineligible: true, signals, reasons };
  }
  const score = clamp01(
    w.fileClaimOverlap * signals.fileClaimOverlap +
    w.prRecency * signals.prRecency +
    w.capabilityMatch * signals.capabilityMatch +
    w.keywordOverlap * signals.keywordOverlap +
    w.loadPenalty * signals.loadPenalty +
    w.leaseHealthPenalty * signals.leaseHealthPenalty
  );
  return { lane: lane.id, score, signals, reasons };
}

// Deterministic ranking: score desc, then higher fileClaimOverlap, then lower
// load, then lane id alphabetical. A tie is always explainable.
export function rankCandidates(workItem, lanes, ctx = {}) {
  const scored = lanes.map(lane => scoreLane(workItem, lane, ctx));
  const eligible = scored.filter(c => !c.ineligible);
  eligible.sort((a, b) =>
    b.score - a.score ||
    b.signals.fileClaimOverlap - a.signals.fileClaimOverlap ||
    a.signals.loadPenalty - b.signals.loadPenalty ||
    (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
  );
  // Mark where the alphabetical tie-break was the decider, for the audit trail.
  for (let i = 1; i < eligible.length; i++) {
    const p = eligible[i - 1], c = eligible[i];
    if (p.score === c.score && p.signals.fileClaimOverlap === c.signals.fileClaimOverlap &&
        p.signals.loadPenalty === c.signals.loadPenalty) {
      c.reasons.push({ signal: "tiebreak", text: `tie with ${p.lane} broken alphabetically (${c.lane} after ${p.lane})` });
    }
  }
  return { ranked: eligible, ineligible: scored.filter(c => c.ineligible) };
}

// Pre-score guard: the board is checked BEFORE scoring. A guard hit vetoes any
// route — the record explains why instead of proposing a second owner.
export function guardCheck(workItem, boardState, claimRegistry = null) {
  if (!workItem || typeof workItem.title !== "string") throw new Error("workItem.title is required");
  const claims = boardState?.claims ?? [];
  const guard = {
    overlapsChecked: true,
    alreadyClaimedBy: null,
    duplicateOf: null,
    fileLeaseConflicts: [],
    staleBoard: false,
  };
  const OPEN = new Set(["claimed", "in_progress", "blocked"]);
  // Already claimed: same taskId held by a lane in an open state.
  if (workItem.taskId) {
    const hit = claims.find(c => c?.id === workItem.taskId && OPEN.has(c.state));
    if (hit) guard.alreadyClaimedBy = hit.owner ?? hit.lane ?? "unknown";
  }
  // Duplicate: caller-supplied duplicate read (board duplicates surface).
  for (const dup of boardState?.duplicates ?? []) {
    if (dup?.of === workItem.taskId || dup?.title === workItem.title) { guard.duplicateOf = dup.id ?? dup.of; break; }
  }
  // File-lease conflicts: open claims holding overlapping files.
  const wanted = [...new Set((workItem.files ?? []).map(normalizeFile))];
  for (const claim of claims) {
    if (!OPEN.has(claim?.state)) continue;
    if (workItem.taskId && claim.id === workItem.taskId) continue;
    const held = (claim.files ?? []).map(normalizeFile);
    // Lease conflicts are exact-path overlaps (per-file leases, same rule as
    // server/claim-collisions.mjs). Same-directory overlap is an affinity
    // signal for scoring, not a lease conflict.
    const overlap = wanted.filter(f => held.some(h => pathAffinity(f, h).score === 1));
    if (overlap.length > 0) {
      guard.fileLeaseConflicts.push({ claimId: claim.id, owner: claim.owner ?? claim.lane ?? "unknown", files: overlap });
    }
  }
  // Claim-registry check (loop lanes): a live registry claim on the task id vetoes.
  if (claimRegistry && workItem.taskId) {
    const reg = claimRegistry(workItem.taskId);
    if (reg && reg.held) guard.alreadyClaimedBy = guard.alreadyClaimedBy ?? reg.lane ?? "registry";
  }
  return guard;
}

// Build the routing record — the ONLY output of a routing run (D6 §3).
// Empty reason lists are invalid by construction: decide() throws if a ranked
// candidate carries none.
// Shadow mode: there is NO auto_route path. Requesting one throws — promotion
// out of shadow requires a recorded human decision (D6 §4.3), never a flag.
export function decide({ workItem, lanes, boardState, ctx = {}, now = Date.now(), roomId = null,
                         routingId = null, topK = null, reporter = null, enableAutoRoute = false } = {}) {
  if (enableAutoRoute) {
    throw new Error("auto_route is not available in shadow mode — leaving shadow requires a recorded human decision (D6 §4.3); there is no automatic promotion, ever");
  }
  const cfg = ctx?.config ?? DEFAULT_CONFIG;
  const k = topK ?? cfg.confidence.topK;
  const id = routingId ?? `route-${now.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const freshAtMs = boardState?.freshAt ?? null;
  const staleBoard = typeof freshAtMs === "number" && now - freshAtMs > cfg.freshnessMinutes * 60_000;

  const guard = guardCheck(workItem, boardState, ctx?.claimRegistry ?? null);
  guard.staleBoard = staleBoard;

  const { ranked, ineligible } = rankCandidates(workItem, lanes ?? [], { ...ctx, config: cfg, now });
  const candidates = ranked.slice(0, k);
  // Invalid by construction: a ranked candidate must carry ≥1 reason.
  for (const c of candidates) {
    if (!Array.isArray(c.reasons) || c.reasons.length === 0) {
      throw new Error(`routing record invalid: candidate ${c.lane} has an empty reason list`);
    }
    for (const r of c.reasons) {
      if (!r || typeof r.signal !== "string" || typeof r.text !== "string" || r.text.length === 0) {
        throw new Error(`routing record invalid: candidate ${c.lane} has a malformed reason`);
      }
    }
  }

  let confidence = "low";
  let action = "broadcast";
  let routedTo = null;
  let note = "";
  const guardHit = guard.alreadyClaimedBy || guard.duplicateOf || guard.fileLeaseConflicts.length > 0;

  if (guardHit) {
    action = "no_route";
    const why = guard.alreadyClaimedBy ? `already claimed by ${guard.alreadyClaimedBy}`
      : guard.duplicateOf ? `duplicate of ${guard.duplicateOf}`
      : `file-lease conflict with ${guard.fileLeaseConflicts.map(f => `${f.claimId} (${f.owner})`).join(", ")}`;
    note = `guard veto — ${why}; not routed, pointing at the existing claim instead`;
  } else if (candidates.length > 0) {
    const top = candidates[0];
    const lead = candidates.length > 1 ? top.score - candidates[1].score : 1;
    // Confidence is computed on the fresh-board reading; a stale board then
    // downgrades it exactly one level (D6 §5.3) — never silently scored.
    if (top.score >= cfg.confidence.highScore && lead >= cfg.confidence.highLead && !guardHit) confidence = "high";
    else if (top.score >= cfg.confidence.mediumScore) confidence = "medium";
    if (staleBoard) {
      confidence = confidence === "high" ? "medium" : "low";
    }
    if (confidence === "low") {
      action = "broadcast";
      note = staleBoard
        ? `no confident candidate — board state is stale (${Math.round((now - freshAtMs) / 60000)}min old), refusing to score on it`
        : `no confident candidate — best score ${top.score.toFixed(2)} below ${cfg.confidence.mediumScore}; uncertainty announced, never routed silently`;
    } else {
      action = "suggest";
      routedTo = top.lane;
      note = top.signals.fileClaimOverlap >= 1
        ? "affinity continuation — same file already held"
        : `best fit by board history (score ${top.score.toFixed(2)}, confidence ${confidence})`;
      if (staleBoard) note += "; board stale — confidence downgraded one level";
    }
  } else {
    note = "no eligible candidates";
  }

  const expectedButRejected = [];
  if (reporter && !candidates.slice(0, k).some(c => c.lane === reporter)) {
    const rc = ranked.find(c => c.lane === reporter);
    expectedButRejected.push({
      lane: reporter,
      whyNot: rc
        ? `reported the work but ranked #${ranked.indexOf(rc) + 1} — score ${rc.score.toFixed(2)} (${rc.reasons[0]?.text ?? "no affinity signals"})`
        : "reported the work but is not an eligible candidate",
    });
  }

  return {
    routingId: id,
    workItem: {
      taskId: workItem.taskId ?? null,
      title: workItem.title,
      brief: workItem.brief ?? null,
      files: [...new Set((workItem.files ?? []).map(normalizeFile))],
      tags: workItem.tags ?? [],
    },
    roomId,
    boardFreshAt: freshAtMs != null ? new Date(freshAtMs).toISOString() : null,
    shadow: SHADOW_MODE,
    routerVersion: ROUTER_VERSION,
    guard,
    candidates: candidates.map(c => ({
      lane: c.lane,
      score: c.score,
      confidence: c === candidates[0] ? confidence : (c.score >= cfg.confidence.highScore ? "high" : c.score >= cfg.confidence.mediumScore ? "medium" : "low"),
      signals: { ...c.signals },
      reasons: c.reasons.map(r => ({ signal: r.signal, text: r.text })),
    })),
    ineligible: ineligible.map(c => c.lane),
    expectedButRejected,
    decision: { action, routedTo, note },
  };
}

// --- backtest metrics (pure; the eval harness feeds these) -------------------------
// cases: [{ workItem, lanes, boardState, eventualClaimant, ctx }]
// Returns precision@1, precision@3, MRR, and per-case ranks for calibration review.
export function evaluateBacktest(cases, { topK = 3 } = {}) {
  const ranks = [];
  for (const c of cases) {
    const rec = decide({
      workItem: c.workItem, lanes: c.lanes, boardState: c.boardState,
      ctx: { ...(c.ctx ?? {}), now: c.at ?? Date.now() },
      now: c.at ?? Date.now(), routingId: `eval-${ranks.length}`,
    });
    const idx = rec.candidates.findIndex(x => x.lane === c.eventualClaimant);
    ranks.push({ taskId: c.workItem?.taskId ?? null, rank: idx === -1 ? null : idx + 1, action: rec.decision.action });
  }
  const scored = ranks.filter(r => r.rank != null);
  const n = ranks.length;
  const hit = k => scored.filter(r => r.rank <= k).length;
  const mrr = n === 0 ? 0 : ranks.reduce((s, r) => s + (r.rank == null ? 0 : 1 / r.rank), 0) / n;
  return {
    n,
    ranked: scored.length,
    unranked: n - scored.length,
    precisionAt1: n === 0 ? 0 : hit(1) / n,
    [`precisionAt${topK}`]: n === 0 ? 0 : hit(topK) / n,
    mrr,
    ranks,
  };
}
