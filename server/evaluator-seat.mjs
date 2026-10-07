// Independent evaluator seat (BUILD LANE 6).
//
// The wedge against ACP's structurally empty evaluator seat: evaluators are
// bonded third parties (never the client, never the provider), paid a priced
// verdict fee from a dedicated evaluation budget on every terminal verdict —
// accept AND reject — under commit-reveal, with slashing only on proven fraud.
//
// Lifecycle per assignment (room_id, job_id):
//   assigned --commit--> committing --reveal--> revealing --finalize--> finalized | deadlocked
//     commits are opaque hashes (public count, hidden content)
//     reveals are hash-checked, then hidden until the reveal window closes
//     finalize takes the majority of VALID reveals; dissent is paid the same fee
//     no majority -> deadlocked (never a coin flip); 0 valid reveals -> deadlocked
//
// Bond lifecycle per evaluator: posted -> locked(assignment slice) ->
//   released (valid reveal) | forfeited (liveness: no commit / no valid reveal,
//   mechanical, to the room pool) | slashed (fraud only, signed decider only).
// Carries the claim-bonds invariant: automation may freeze, but only a signed
// verdict may burn/slash. Panel disagreement is never slashable.
//
// Money: integer milli-credits (1 credit = 1000), like server/bounty-escrow.mjs.
// Bonds are face-denominated in $DASHA at the settlement leg: the module stores
// face_dasha_millis + the credit->$DASHA rate snapshot at posting time; the
// prototype settles in milli-credits and the chain leg is out of scope.
//
// Seams (sibling ACP lanes):
// - acp-build-escrow-flow (routes) consumes finalizeVerdict's settlement
//   instruction; this module never touches http.mjs.
// - acp-build-escrow-machine executes the settlement instruction (version "v1").
// - acp-build-bond-registry owns canonical bond custody: every eval_bonds row
//   carries a nullable registry_bond_id; when the registry lands this table
//   becomes a receipt cache with no schema change.
// - acp-build-settlement-evidence consumes finalized reveals as attestations.
//
// Persistence: additive tables only (CREATE TABLE IF NOT EXISTS), registered in
// unfencedAdditiveTables (server/writer-fence.mjs). Older writers have no code
// path to these tables.
import { createHash, randomUUID } from "node:crypto";

export class EvaluatorSeatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluatorSeatError";
    this.code = code;
  }
}

const err = (code, message) => { throw new EvaluatorSeatError(code, message); };

// ---- pricing ----

export const JUDGE_TIERS = Object.freeze(["budget", "mid", "frontier"]);
// Verdict fee floors in milli-credits, per judge tier. Derived in the lane-6
// design doc from 2026-10-05 inference price data: floor >= fully-loaded
// verdict cost x (1 + margin) at 1 credit ~= $0.05. The "mid" floor is the
// room minimum for value-bearing jobs; "budget" is evaluation theater.
export const DEFAULT_FLOORS = Object.freeze({ budget: 100, mid: 600, frontier: 20_000 });
export const DEFAULT_BPS = 500; // 5% of job value, a ceiling supplement — not the whole pay
export const DEFAULT_TIER = "mid";
export const DEFAULT_MARGIN = 0.5; // 50% over modeled inference cost, baked into the floors

// verdict_fee = max(floor[tier], ceil(bps x job_value / 10_000))
// Deliberately verdict-independent: rejections are paid verdicts.
export function priceVerdict({ tier = DEFAULT_TIER, jobValueMillis, bps = DEFAULT_BPS, floors = DEFAULT_FLOORS } = {}) {
  if (!JUDGE_TIERS.includes(tier)) err("seat/bad-tier", `unknown judge tier: ${tier}`);
  if (!Number.isInteger(jobValueMillis) || jobValueMillis < 0) err("seat/bad-job-value", "jobValueMillis must be a non-negative integer");
  if (!Number.isInteger(bps) || bps < 0) err("seat/bad-bps", "bps must be a non-negative integer");
  const floor = floors[tier];
  if (!Number.isInteger(floor) || floor < 0) err("seat/bad-floor", `no floor for tier ${tier}`);
  return Math.max(floor, Math.ceil(jobValueMillis * bps / 10_000));
}

// ---- commit-reveal crypto ----

// commitment = sha256(canonical_json({evidenceHash, salt, verdict}))
// The canonical form is fixed key order in a single literal — deterministic
// by construction, no key-sorting dependency.
export function commitmentFor({ verdict, evidenceHash, salt }) {
  if (verdict !== "accept" && verdict !== "reject") err("seat/invalid-verdict", "verdict must be accept or reject");
  if (typeof evidenceHash !== "string" || !evidenceHash) err("seat/bad-evidence", "evidenceHash must be a non-empty string");
  if (typeof salt !== "string" || salt.length < 16) err("seat/bad-salt", "salt must be a string of at least 16 chars");
  return createHash("sha256")
    .update(JSON.stringify({ evidenceHash, salt, verdict }), "utf8")
    .digest("hex");
}

// ---- schema ----

export function evaluatorSeatSchema() {
  return `
CREATE TABLE IF NOT EXISTS eval_seats (
  room_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_assignments (
  room_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  panel_json TEXT NOT NULL,
  client TEXT NOT NULL,
  provider TEXT NOT NULL,
  job_value_millis INTEGER NOT NULL,
  fee_millis_per_evaluator INTEGER NOT NULL,
  state TEXT NOT NULL,
  commit_window_ends_at INTEGER NOT NULL,
  reveal_window_ends_at INTEGER NOT NULL,
  verdict TEXT,
  settlement_json TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  PRIMARY KEY (room_id, job_id)
);
CREATE TABLE IF NOT EXISTS eval_commits (
  room_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, job_id, evaluator)
);
CREATE TABLE IF NOT EXISTS eval_reveals (
  room_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  revealed_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, job_id, evaluator)
);
CREATE TABLE IF NOT EXISTS eval_bonds (
  bond_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  posted_millis INTEGER NOT NULL,
  encumbered_millis INTEGER NOT NULL DEFAULT 0,
  forfeited_millis INTEGER NOT NULL DEFAULT 0,
  slashed_millis INTEGER NOT NULL DEFAULT 0,
  released_millis INTEGER NOT NULL DEFAULT 0,
  assignment_slice_millis INTEGER NOT NULL,
  registry_bond_id TEXT,
  face_dasha_millis INTEGER,
  dasha_per_credit_rate REAL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_bonds_room_evaluator ON eval_bonds (room_id, evaluator);
CREATE TABLE IF NOT EXISTS eval_challenges (
  challenge_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  challenger TEXT NOT NULL,
  target TEXT NOT NULL,
  allegation TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  bond_millis INTEGER NOT NULL,
  bond_state TEXT NOT NULL DEFAULT 'locked',
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decider TEXT
);`;
}

export const DEFAULT_SEAT_CONFIG = Object.freeze({
  judgeTier: DEFAULT_TIER,
  feeBps: DEFAULT_BPS,
  feeFloorMillis: null, // null -> DEFAULT_FLOORS[judgeTier]
  commitWindowMs: 24 * 3600 * 1000,
  revealWindowMs: 24 * 3600 * 1000,
  challengeWindowMs: 72 * 3600 * 1000,
  panelSize: 3,
  minBondMillis: 5000,
  assignmentSliceMillis: 1000,
});

// Only what a third party can verify from signed artifacts. Panel-outlier
// verdicts (honest disagreement) are never in this list.
export const FRAUD_REASONS = Object.freeze(["double-sign", "evidence-fraud", "conflict-of-interest"]);

const isHex64 = s => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

export function createEvaluatorSeat(store, opts = {}) {
  const now = opts.now || (() => Date.now());
  const { db } = store;
  const tx = store.transaction || (fn => fn());
  db.exec(evaluatorSeatSchema());

  const q = {
    seatGet: db.prepare("SELECT config_json FROM eval_seats WHERE room_id = ?"),
    seatPut: db.prepare(`INSERT INTO eval_seats (room_id, config_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (room_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`),
    bondByEvaluator: db.prepare("SELECT * FROM eval_bonds WHERE room_id = ? AND evaluator = ?"),
    bondById: db.prepare("SELECT * FROM eval_bonds WHERE bond_id = ?"),
    bondInsert: db.prepare(`INSERT INTO eval_bonds (bond_id, room_id, evaluator, posted_millis,
      assignment_slice_millis, registry_bond_id, face_dasha_millis, dasha_per_credit_rate,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bondMove: db.prepare(`UPDATE eval_bonds SET encumbered_millis = ?, forfeited_millis = ?,
      slashed_millis = ?, released_millis = ?, state = ?, updated_at = ? WHERE bond_id = ?`),
    assignGet: db.prepare("SELECT * FROM eval_assignments WHERE room_id = ? AND job_id = ?"),
    assignInsert: db.prepare(`INSERT INTO eval_assignments (room_id, job_id, panel_json, client, provider,
      job_value_millis, fee_millis_per_evaluator, state, commit_window_ends_at, reveal_window_ends_at,
      created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?, ?)`),
    assignFinalize: db.prepare(`UPDATE eval_assignments SET state = ?, verdict = ?, settlement_json = ?,
      finalized_at = ? WHERE room_id = ? AND job_id = ?`),
    commitGet: db.prepare("SELECT * FROM eval_commits WHERE room_id = ? AND job_id = ? AND evaluator = ?"),
    commitCount: db.prepare("SELECT COUNT(*) AS n FROM eval_commits WHERE room_id = ? AND job_id = ?"),
    commitInsert: db.prepare(`INSERT INTO eval_commits (room_id, job_id, evaluator, commit_hash, committed_at)
      VALUES (?, ?, ?, ?, ?)`),
    revealGet: db.prepare("SELECT * FROM eval_reveals WHERE room_id = ? AND job_id = ? AND evaluator = ?"),
    revealAll: db.prepare("SELECT * FROM eval_reveals WHERE room_id = ? AND job_id = ? ORDER BY evaluator"),
    revealInsert: db.prepare(`INSERT INTO eval_reveals (room_id, job_id, evaluator, verdict, evidence_hash, salt, revealed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    challengeGet: db.prepare("SELECT * FROM eval_challenges WHERE challenge_id = ?"),
    challengeInsert: db.prepare(`INSERT INTO eval_challenges (challenge_id, room_id, job_id, challenger, target,
      allegation, proof_json, bond_millis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    challengeResolve: db.prepare(`UPDATE eval_challenges SET state = ?, bond_state = ?, resolved_at = ?, decider = ?
      WHERE challenge_id = ?`),
  };

  function getSeat(roomId) {
    const row = q.seatGet.get(roomId);
    const stored = row ? JSON.parse(row.config_json) : {};
    return { ...DEFAULT_SEAT_CONFIG, ...stored };
  }

  function configureSeat(roomId, config = {}) {
    if (typeof roomId !== "string" || !roomId) err("seat/bad-room", "roomId required");
    const merged = { ...getSeat(roomId), ...config };
    if (!JUDGE_TIERS.includes(merged.judgeTier)) err("seat/bad-tier", `unknown judge tier: ${merged.judgeTier}`);
    for (const k of ["feeBps", "feeFloorMillis", "minBondMillis", "assignmentSliceMillis"]) {
      const v = merged[k];
      if (v !== null && (!Number.isInteger(v) || v < 0)) err("seat/bad-config", `${k} must be a non-negative integer or null`);
    }
    for (const k of ["commitWindowMs", "revealWindowMs", "challengeWindowMs"]) {
      if (!Number.isInteger(merged[k]) || merged[k] <= 0) err("seat/bad-config", `${k} must be a positive integer`);
    }
    if (!Number.isInteger(merged.panelSize) || merged.panelSize < 1) err("seat/bad-config", "panelSize must be a positive integer");
    if (merged.assignmentSliceMillis > merged.minBondMillis) err("seat/bad-config", "assignmentSliceMillis cannot exceed minBondMillis");
    q.seatPut.run(roomId, JSON.stringify(merged), now());
    return merged;
  }

  function quoteFee(roomId, jobValueMillis) {
    const cfg = getSeat(roomId);
    const floor = cfg.feeFloorMillis ?? DEFAULT_FLOORS[cfg.judgeTier];
    return priceVerdict({ tier: cfg.judgeTier, jobValueMillis, bps: cfg.feeBps, floors: { ...DEFAULT_FLOORS, [cfg.judgeTier]: floor } });
  }

  function bondView(row) {
    if (!row) return null;
    const available = row.posted_millis - row.encumbered_millis - row.forfeited_millis - row.slashed_millis - row.released_millis;
    return {
      bondId: row.bond_id, roomId: row.room_id, evaluator: row.evaluator,
      postedMillis: row.posted_millis, encumberedMillis: row.encumbered_millis,
      forfeitedMillis: row.forfeited_millis, slashedMillis: row.slashed_millis,
      releasedMillis: row.released_millis, availableMillis: available,
      assignmentSliceMillis: row.assignment_slice_millis,
      registryBondId: row.registry_bond_id,
      faceDashaMillis: row.face_dasha_millis, dashaPerCreditRate: row.dasha_per_credit_rate,
      state: row.state,
    };
  }

  function postBond(roomId, { evaluator, amountMillis, registryBondId = null, faceDashaMillis = null, dashaPerCreditRate = null } = {}) {
    if (typeof evaluator !== "string" || !evaluator) err("seat/bad-evaluator", "evaluator required");
    if (!Number.isInteger(amountMillis) || amountMillis <= 0) err("seat/bad-amount", "amountMillis must be a positive integer");
    return tx(() => {
      const cfg = getSeat(roomId);
      if (amountMillis < cfg.minBondMillis) err("seat/bond-too-small", `minimum bond is ${cfg.minBondMillis} millis`);
      if (q.bondByEvaluator.get(roomId, evaluator)) err("seat/bond-exists", "evaluator already bonded in this room");
      const bondId = `bond_${randomUUID()}`;
      const t = now();
      q.bondInsert.run(bondId, roomId, evaluator, amountMillis, cfg.assignmentSliceMillis,
        registryBondId, faceDashaMillis, dashaPerCreditRate, t, t);
      return bondView(q.bondById.get(bondId));
    });
  }

  function getBond(roomId, evaluator) {
    return bondView(q.bondByEvaluator.get(roomId, evaluator));
  }

  // Deterministic, auditable panel shuffle: order candidates by
  // sha256(roomId | jobId | evaluator), take the first n. Anyone can recompute it.
  function shuffledPanel(roomId, jobId, candidates, n) {
    const ranked = [...new Set(candidates)]
      .map(e => ({ e, h: createHash("sha256").update(`${roomId}|${jobId}|${e}`, "utf8").digest("hex") }))
      .sort((a, b) => (a.h < b.h ? -1 : 1))
      .map(r => r.e);
    return ranked.slice(0, n);
  }

  function assignPanel(roomId, jobId, { client, provider, candidates, jobValueMillis, panelSize } = {}) {
    if (typeof jobId !== "string" || !jobId) err("seat/bad-job", "jobId required");
    if (!Number.isInteger(jobValueMillis) || jobValueMillis <= 0) err("seat/bad-job-value", "jobValueMillis must be a positive integer");
    if (!Array.isArray(candidates) || candidates.length === 0) err("seat/bad-candidates", "candidates required");
    return tx(() => {
      const cfg = getSeat(roomId);
      const n = panelSize ?? cfg.panelSize;
      if (!Number.isInteger(n) || n < 1) err("seat/bad-config", "panelSize must be a positive integer");
      if (q.assignGet.get(roomId, jobId)) err("seat/job-exists", "job already has an assignment");
      const eligible = [];
      for (const c of new Set(candidates)) {
        if (c === client || c === provider) continue; // independence: never the client, never the provider
        const bond = bondView(q.bondByEvaluator.get(roomId, c));
        if (!bond || bond.state !== "active") continue;
        if (bond.availableMillis < bond.assignmentSliceMillis) continue;
        eligible.push(c);
      }
      if (eligible.length < n) err("seat/insufficient-eligible", `need ${n} bonded evaluators, found ${eligible.length}`);
      const panel = shuffledPanel(roomId, jobId, eligible, n);
      const fee = quoteFee(roomId, jobValueMillis);
      const t = now();
      const commitEnds = t + cfg.commitWindowMs;
      const revealEnds = commitEnds + cfg.revealWindowMs;
      // Encumber one bond slice per seat, atomically with the assignment.
      for (const e of panel) {
        const bond = q.bondByEvaluator.get(roomId, e);
        q.bondMove.run(bond.encumbered_millis + bond.assignment_slice_millis, bond.forfeited_millis,
          bond.slashed_millis, bond.released_millis, "active", t, bond.bond_id);
      }
      q.assignInsert.run(roomId, jobId, JSON.stringify(panel), client, provider,
        jobValueMillis, fee, commitEnds, revealEnds, t);
      return assignmentView(q.assignGet.get(roomId, jobId), { includeReveals: false });
    });
  }

  function derivedState(row, t) {
    if (row.state === "finalized" || row.state === "deadlocked") return row.state;
    return t < row.commit_window_ends_at ? "committing" : "revealing";
  }

  function assignmentView(row, { includeReveals }) {
    if (!row) return null;
    const t = now();
    const panel = JSON.parse(row.panel_json);
    const commitCount = q.commitCount.get(row.room_id, row.job_id).n;
    const reveals = q.revealAll.all(row.room_id, row.job_id).map(r => ({
      evaluator: r.evaluator, verdict: r.verdict, evidenceHash: r.evidence_hash, revealedAt: r.revealed_at,
    }));
    const view = {
      roomId: row.room_id, jobId: row.job_id, panel,
      client: row.client, provider: row.provider,
      jobValueMillis: row.job_value_millis, feeMillisPerEvaluator: row.fee_millis_per_evaluator,
      state: derivedState(row, t),
      commitWindowEndsAt: row.commit_window_ends_at, revealWindowEndsAt: row.reveal_window_ends_at,
      commitCount, revealCount: reveals.length,
      createdAt: row.created_at, finalizedAt: row.finalized_at,
    };
    // Anti-copycat: verdicts are never readable before the reveal window closes.
    if (includeReveals || t >= row.reveal_window_ends_at || row.finalized_at) view.reveals = reveals;
    if (row.finalized_at) view.verdict = row.verdict; // null on deadlock — never undefined
    if (row.settlement_json) view.settlement = JSON.parse(row.settlement_json);
    return view;
  }

  function getAssignment(roomId, jobId) {
    const row = q.assignGet.get(roomId, jobId);
    if (!row) err("seat/unknown-job", `no assignment for job ${jobId}`);
    return assignmentView(row, { includeReveals: false });
  }

  function commitVerdict(roomId, jobId, evaluator, commitHash) {
    if (!isHex64(commitHash)) err("seat/bad-commit", "commitHash must be 64 hex chars");
    return tx(() => {
      const row = q.assignGet.get(roomId, jobId);
      if (!row) err("seat/unknown-job", `no assignment for job ${jobId}`);
      const panel = JSON.parse(row.panel_json);
      if (!panel.includes(evaluator)) err("seat/not-panel-member", `${evaluator} is not on this panel`);
      const t = now();
      if (t >= row.commit_window_ends_at) err("seat/commit-window-closed", "commit window has closed");
      if (q.commitGet.get(roomId, jobId, evaluator)) err("seat/duplicate-commit", "evaluator already committed");
      q.commitInsert.run(roomId, jobId, evaluator, commitHash, t);
      return { roomId, jobId, evaluator, commitHash, committedAt: t };
    });
  }

  function revealVerdict(roomId, jobId, evaluator, { verdict, evidenceHash, salt } = {}) {
    return tx(() => {
      const row = q.assignGet.get(roomId, jobId);
      if (!row) err("seat/unknown-job", `no assignment for job ${jobId}`);
      const t = now();
      if (t < row.commit_window_ends_at) err("seat/commit-window-open", "reveal window has not opened");
      if (t >= row.reveal_window_ends_at) err("seat/reveal-window-closed", "reveal window has closed");
      const commit = q.commitGet.get(roomId, jobId, evaluator);
      if (!commit) err("seat/unknown-commit", "no commit from this evaluator");
      if (q.revealGet.get(roomId, jobId, evaluator)) err("seat/duplicate-reveal", "evaluator already revealed");
      let expect;
      try {
        expect = commitmentFor({ verdict, evidenceHash, salt });
      } catch (e) {
        if (e instanceof EvaluatorSeatError) throw e;
        err("seat/bad-reveal", "malformed reveal");
      }
      if (expect !== commit.commit_hash) err("seat/hash-mismatch", "reveal does not match the commitment");
      q.revealInsert.run(roomId, jobId, evaluator, verdict, evidenceHash, salt, t);
      return { roomId, jobId, evaluator, verdict, evidenceHash, revealedAt: t };
    });
  }

  function finalizeVerdict(roomId, jobId) {
    return tx(() => {
      const row = q.assignGet.get(roomId, jobId);
      if (!row) err("seat/unknown-job", `no assignment for job ${jobId}`);
      if (row.state === "finalized" || row.state === "deadlocked") err("seat/already-finalized", "assignment already finalized");
      const t = now();
      if (t < row.reveal_window_ends_at) err("seat/reveal-window-open", "reveal window is still open");
      const panel = JSON.parse(row.panel_json);
      const commits = new Map();
      // valid = reveal whose hash matches the stored commitment
      const valid = [];
      for (const r of q.revealAll.all(roomId, jobId)) {
        const c = q.commitGet.get(roomId, jobId, r.evaluator);
        if (c && commitmentFor({ verdict: r.verdict, evidenceHash: r.evidence_hash, salt: r.salt }) === c.commit_hash) {
          valid.push(r);
          commits.set(r.evaluator, true);
        }
      }
      const accepts = valid.filter(r => r.verdict === "accept").length;
      const rejects = valid.filter(r => r.verdict === "reject").length;
      const majority = Math.floor(valid.length / 2) + 1;
      let verdict = null;
      let state = "deadlocked";
      if (valid.length > 0) {
        if (accepts >= majority) { verdict = "accept"; state = "finalized"; }
        else if (rejects >= majority) { verdict = "reject"; state = "finalized"; }
      }
      const fee = row.fee_millis_per_evaluator;
      // Dissent is paid: every valid revealer earns the fee, majority or not.
      const payments = valid.map(r => ({ evaluator: r.evaluator, verdict: r.verdict, feeMillis: fee }));
      const settlement = {
        version: "v1",
        roomId, jobId, verdict, state,
        source: "eval-budget", // fees come from the client's evaluation budget, never the provider's share
        feeMillisPerEvaluator: fee,
        payments,
        totalFeeMillis: fee * payments.length,
        decidedAt: t,
        // Consumed by acp-build-escrow-machine: move totalFeeMillis from the
        // job's locked eval budget to each payment.evaluator.
      };
      // Bond slices: valid reveal -> released; committed-but-silent or silent
      // altogether -> forfeited to the room pool (liveness, never slash).
      for (const e of panel) {
        const bond = q.bondByEvaluator.get(roomId, e);
        const slice = bond.assignment_slice_millis;
        const revealed = commits.has(e);
        q.bondMove.run(
          bond.encumbered_millis - slice,
          bond.forfeited_millis + (revealed ? 0 : slice),
          bond.slashed_millis,
          bond.released_millis + (revealed ? slice : 0),
          "active", t, bond.bond_id);
      }
      q.assignFinalize.run(state, verdict, JSON.stringify(settlement), t, roomId, jobId);
      return {
        roomId, jobId, state, verdict,
        feeMillisPerEvaluator: fee, payments, settlement,
        finalizedAt: t,
      };
    });
  }

  // Fraud proofs arrive as challenger-presented signed artifacts; the module
  // verifies the shape (one evaluator, one job, >= 2 DISTINCT commit hashes).
  // Re-sending the same commit is not fraud.
  function detectDoubleSign(roomId, jobId, evaluator, commits) {
    if (!Array.isArray(commits)) return null;
    const distinct = [...new Set(commits.filter(isHex64))];
    if (distinct.length < 2) return null;
    return { roomId, jobId, evaluator, commits: distinct, detectedAt: now(), kind: "double-sign" };
  }

  function slashBond(roomId, bondId, { reason, proof, decider, amountMillis } = {}) {
    if (!FRAUD_REASONS.includes(reason)) err("seat/not-fraud", `slash requires a fraud reason (${FRAUD_REASONS.join(", ")})`);
    if (typeof decider !== "string" || !decider) err("seat/unsigned-slash", "slash requires a signed decider");
    if (proof === undefined || proof === null) err("seat/no-proof", "slash requires fraud proof");
    return tx(() => {
      const bond = q.bondById.get(bondId);
      if (!bond || bond.room_id !== roomId) err("seat/unknown-bond", `no bond ${bondId} in room ${roomId}`);
      const slashable = bond.posted_millis - bond.forfeited_millis - bond.slashed_millis - bond.released_millis;
      const take = amountMillis === undefined ? slashable : Math.min(amountMillis, slashable);
      if (!Number.isInteger(take) || take <= 0) err("seat/nothing-to-slash", "no slashable balance");
      const fromEncumbered = Math.min(bond.encumbered_millis, take);
      q.bondMove.run(bond.encumbered_millis - fromEncumbered, bond.forfeited_millis,
        bond.slashed_millis + take, bond.released_millis,
        bond.posted_millis - bond.forfeited_millis - (bond.slashed_millis + take) - bond.released_millis <= 0 ? "slashed" : "active",
        now(), bondId);
      return { bondId, evaluator: bond.evaluator, slashedMillis: take, reason, decider, proof };
    });
  }

  function challengeVerdict(roomId, jobId, challenger, { bondMillis, allegation, proof, target } = {}) {
    if (!FRAUD_REASONS.includes(allegation)) err("seat/bad-allegation", `allegation must be one of ${FRAUD_REASONS.join(", ")}`);
    if (!Number.isInteger(bondMillis) || bondMillis <= 0) err("seat/bad-amount", "bondMillis must be a positive integer");
    return tx(() => {
      const row = q.assignGet.get(roomId, jobId);
      if (!row) err("seat/unknown-job", `no assignment for job ${jobId}`);
      if (row.state !== "finalized") err("seat/assignment-not-final", "only finalized verdicts can be challenged");
      const t = now();
      const cfg = getSeat(roomId);
      if (t > row.finalized_at + cfg.challengeWindowMs) err("seat/challenge-window-closed", "challenge window has closed");
      // Griefing has a price: the challenger bonds 2x the verdict fee.
      if (bondMillis < 2 * row.fee_millis_per_evaluator) err("seat/challenge-bond-low", "challenger bond must be >= 2x the verdict fee");
      const panel = JSON.parse(row.panel_json);
      const resolvedTarget = target ?? (panel.length === 1 ? panel[0] : null);
      if (!resolvedTarget || !panel.includes(resolvedTarget)) err("seat/challenge-needs-target", "challenge must name a panel member as target");
      const challengeId = `chal_${randomUUID()}`;
      q.challengeInsert.run(challengeId, roomId, jobId, challenger, resolvedTarget, allegation,
        JSON.stringify(proof ?? {}), bondMillis, t);
      return { challengeId, roomId, jobId, challenger, target: resolvedTarget, allegation, bondMillis, state: "open", createdAt: t };
    });
  }

  function resolveChallenge(roomId, challengeId, { upheld, decider } = {}) {
    if (typeof decider !== "string" || !decider) err("seat/unsigned-slash", "challenge resolution requires a signed decider");
    return tx(() => {
      const ch = q.challengeGet.get(challengeId);
      if (!ch || ch.room_id !== roomId) err("seat/unknown-challenge", `no challenge ${challengeId}`);
      if (ch.state !== "open") err("seat/challenge-closed", "challenge already resolved");
      const t = now();
      if (upheld) {
        // Fraud confirmed: slash the target's bond slice, return the challenger bond.
        const bond = q.bondByEvaluator.get(roomId, ch.target);
        if (bond) {
          const slashable = bond.posted_millis - bond.forfeited_millis - bond.slashed_millis - bond.released_millis;
          const take = Math.min(bond.assignment_slice_millis, slashable);
          if (take > 0) {
            const fromEnc = Math.min(bond.encumbered_millis, take);
            q.bondMove.run(bond.encumbered_millis - fromEnc, bond.forfeited_millis,
              bond.slashed_millis + take, bond.released_millis, "active", t, bond.bond_id);
          }
        }
        q.challengeResolve.run("upheld", "released", t, decider, challengeId);
      } else {
        // Failed challenge: the challenger bond is forfeited to the room pool (pays the panel's time).
        q.challengeResolve.run("rejected", "forfeited", t, decider, challengeId);
      }
      const done = q.challengeGet.get(challengeId);
      return { challengeId, state: done.state, bondState: done.bond_state, decider, resolvedAt: t };
    });
  }

  function getChallenge(challengeId) {
    const ch = q.challengeGet.get(challengeId);
    if (!ch) return null;
    return {
      challengeId: ch.challenge_id, roomId: ch.room_id, jobId: ch.job_id,
      challenger: ch.challenger, target: ch.target, allegation: ch.allegation,
      proof: JSON.parse(ch.proof_json), bondMillis: ch.bond_millis, bondState: ch.bond_state,
      state: ch.state, createdAt: ch.created_at, resolvedAt: ch.resolved_at, decider: ch.decider,
    };
  }

  return {
    configureSeat, getSeat, quoteFee,
    postBond, getBond, slashBond,
    assignPanel, getAssignment, commitVerdict, revealVerdict, finalizeVerdict,
    detectDoubleSign, challengeVerdict, resolveChallenge, getChallenge,
  };
}
