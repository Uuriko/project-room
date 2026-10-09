// Claim checkpoints (FIX-21, WAVE-300 rank 54): a ≤4KB resume record stamped
// onto the claim field at every claim transition (tier 1, authoritative),
// carried on the work_claim.updated room event (tier 2), and recording the
// worker's last_good branch sha (tier 3, push-before-checkpoint convention).
//
// Resume contract: a successor reads item.checkpoint and can resume the work
// in under 5 minutes — state, owner, files, fileBlocks, a last-progress
// pointer into the claim's history, and the timestamps are all present.
// FIX-17 (successor election) consumes this field shape: keep it backward
// compatible — bump CHECKPOINT_VERSION on any breaking change, never rename
// a field in place.
//
// Write path is push-before-checkpoint: the durable claim row lands first
// (registry.set), then the room event carries a copy. Plain file writes go
// partial 9/10 of the time, so any file-backed checkpoint write goes
// through writeCheckpointFile: temp + fsync + rename.
import { writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_MAX_BYTES = 4096; // 4KB hard cap, enforced on write and on read

const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
const isoOf = ms => new Date(ms).toISOString();

// last_good: the worker's last pushed branch sha, recorded BEFORE the
// checkpoint so a successor can check out exactly what the previous worker
// had pushed. { branch, sha } or null. Malformed input throws (plain Error;
// work-claims.mjs converts it to invalid_claim_input).
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{1,64}$/i;
export function lastGoodOf(value) {
  if (value === undefined || value === null) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("last_good must be { branch, sha } or null");
  if (typeof value.branch !== "string" || !BRANCH_PATTERN.test(value.branch)) throw new Error("last_good.branch must be 1..200 letters, numbers, or . _ / -");
  if (typeof value.sha !== "string" || !SHA_PATTERN.test(value.sha)) throw new Error("last_good.sha must be 1..64 hex characters");
  return Object.freeze({ branch: value.branch, sha: value.sha.toLowerCase() });
}

// Build the checkpoint for a post-transition claim item. Call AFTER
// withHistory so lastProgress names the transition's own history stamp.
// The 4KB cap is enforced with a deliberate truncation order:
//   1. the free-text summary truncates first (it is the least structural),
//   2. then the file list shrinks from the tail, marked with filesTruncated
//      and the original fileCount so the reader knows the list is partial,
//   3. identity fields (state, owner, timestamps, lastGood, lastProgress)
//      are never dropped.
export function buildCheckpoint(item, { atMs, lastGood = null, summary = null } = {}) {
  if (!item || typeof item !== "object") throw new Error("buildCheckpoint: a claim item is required");
  if (!Number.isFinite(atMs)) throw new Error("buildCheckpoint: atMs is required");
  const history = Array.isArray(item.history) ? item.history : [];
  const last = history.length > 0 ? history[history.length - 1] : null;
  const files = Array.isArray(item.files) ? [...item.files] : [];
  const fileBlocks = item.fileBlocks && typeof item.fileBlocks === "object" && !Array.isArray(item.fileBlocks)
    ? { ...item.fileBlocks } : {};
  const cp = {
    version: CHECKPOINT_VERSION,
    claimId: item.id,
    title: typeof item.title === "string" ? item.title : item.id,
    kind: typeof item.kind === "string" ? item.kind : "work",
    at: isoOf(atMs),
    state: item.state ?? "unclaimed",
    owner: item.owner ?? null,
    claimedAt: item.claimedAt ?? null,
    leaseStartAt: item.leaseStartAt ?? null,
    leaseExpiresAt: item.leaseExpiresAt ?? null,
    updatedAt: item.updatedAt ?? isoOf(atMs),
    files,
    fileBlocks,
    filesTruncated: false,
    fileBlocksTruncated: false,
    fileCount: files.length,
    lastProgress: last ? Object.freeze({
      at: last.at ?? null,
      agentId: last.agentId ?? null,
      action: last.action ?? null,
      historyIndex: history.length - 1,
    }) : null,
    lastGood: lastGoodOf(lastGood),
    summary: null,
    summaryTruncated: false,
  };
  // 1. Summary takes whatever budget the structural fields leave.
  let text = typeof summary === "string" && summary.length > 0 ? summary : null;
  if (text !== null) {
    while (text.length > 0 && bytesOf({ ...cp, summary: text }) > CHECKPOINT_MAX_BYTES) {
      text = text.slice(0, Math.max(0, text.length - 64)).replace(/\s+$/, "");
    }
    cp.summary = text.length > 0 ? text : null;
    cp.summaryTruncated = summary !== cp.summary;
  }
  // 2. Last resort: shrink the file list from the tail. The file list is
  // sorted at claim time, so this drops alphabetically-last paths first;
  // fileCount keeps the original size and filesTruncated marks the loss.
  while (bytesOf(cp) > CHECKPOINT_MAX_BYTES && cp.files.length > 0) {
    const dropped = cp.files.pop();
    delete cp.fileBlocks[dropped];
    cp.filesTruncated = true;
  }
  // 3. Pathological blocks alone (without their file entries) still over —
  // drop block labels from the tail too. Identity fields are never touched.
  while (bytesOf(cp) > CHECKPOINT_MAX_BYTES && Object.keys(cp.fileBlocks).length > 0) {
    delete cp.fileBlocks[Object.keys(cp.fileBlocks).pop()];
    cp.fileBlocksTruncated = true;
  }
  return Object.freeze({ ...cp, files: Object.freeze(cp.files), fileBlocks: Object.freeze(cp.fileBlocks) });
}

// Normalize a stored checkpoint (workOf round-trip, durable-row decode).
// Unknown shapes throw; the caller maps that to invalid_claim_input.
export function checkpointOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("checkpoint must be an object or null");
  if (value.version !== CHECKPOINT_VERSION) throw new Error(`unsupported checkpoint version ${JSON.stringify(value.version)}`);
  if (typeof value.claimId !== "string" || value.claimId.length === 0) throw new Error("checkpoint needs a claimId");
  if (typeof value.state !== "string" || value.state.length === 0) throw new Error("checkpoint needs a state");
  const files = Array.isArray(value.files) ? value.files.filter(path => typeof path === "string") : [];
  const fileBlocks = value.fileBlocks && typeof value.fileBlocks === "object" && !Array.isArray(value.fileBlocks)
    ? { ...value.fileBlocks } : {};
  const progress = value.lastProgress;
  const lastProgress = progress === undefined || progress === null ? null : Object.freeze({
    at: typeof progress.at === "string" ? progress.at : null,
    agentId: typeof progress.agentId === "string" ? progress.agentId : null,
    action: typeof progress.action === "string" ? progress.action : null,
    historyIndex: Number.isSafeInteger(progress.historyIndex) ? progress.historyIndex : null,
  });
  let cp = Object.freeze({
    version: CHECKPOINT_VERSION,
    claimId: value.claimId,
    title: typeof value.title === "string" ? value.title : value.claimId,
    kind: typeof value.kind === "string" ? value.kind : "work",
    at: typeof value.at === "string" ? value.at : null,
    state: value.state,
    owner: typeof value.owner === "string" ? value.owner : null,
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt : null,
    leaseStartAt: typeof value.leaseStartAt === "string" ? value.leaseStartAt : null,
    leaseExpiresAt: typeof value.leaseExpiresAt === "string" ? value.leaseExpiresAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    files: Object.freeze(files),
    fileBlocks: Object.freeze(fileBlocks),
    filesTruncated: value.filesTruncated === true,
    fileBlocksTruncated: value.fileBlocksTruncated === true,
    fileCount: Number.isSafeInteger(value.fileCount) ? value.fileCount : files.length,
    lastProgress,
    lastGood: lastGoodOf(value.lastGood),
    summary: typeof value.summary === "string" ? value.summary : null,
    summaryTruncated: value.summaryTruncated === true,
  });
  // A stored checkpoint that somehow exceeds the cap is re-capped by
  // dropping the summary — structural fields are never touched here.
  if (bytesOf(cp) > CHECKPOINT_MAX_BYTES) cp = Object.freeze({ ...cp, summary: null, summaryTruncated: true });
  return cp;
}

// Stamp a fresh checkpoint onto a post-transition item. Pass the item AFTER
// its history stamp was appended. Carries the previous lastGood forward
// unless the transition records a new one.
export function stampClaimCheckpoint(item, { atMs, lastGood = null, summary = null } = {}) {
  if (!item || typeof item !== "object") throw new Error("stampClaimCheckpoint: a claim item is required");
  const carried = lastGood === null || lastGood === undefined
    ? (item.checkpoint && typeof item.checkpoint === "object" ? item.checkpoint.lastGood ?? null : null)
    : lastGood;
  return Object.freeze({ ...item, checkpoint: buildCheckpoint(item, { atMs, lastGood: carried, summary }) });
}

// File-backed checkpoint write: temp + fsync + rename. Plain writes go
// partial 9/10 of the time; the rename is the atomic commit — readers of
// `path` see the old file or the complete new one, never a half write.
export function writeCheckpointFile(path, checkpoint) {
  if (typeof path !== "string" || path.length === 0) throw new Error("writeCheckpointFile: path is required");
  if (!checkpoint || typeof checkpoint !== "object") throw new Error("writeCheckpointFile: a checkpoint is required");
  const data = JSON.stringify(checkpoint);
  if (Buffer.byteLength(data) > CHECKPOINT_MAX_BYTES) throw new Error("writeCheckpointFile: checkpoint exceeds the 4KB cap");
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Fsync the directory so the rename itself survives a crash. Best effort:
  // some platforms refuse directory fsyncs.
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* directory fsync is a durability bonus, not the contract */ }
  return path;
}
