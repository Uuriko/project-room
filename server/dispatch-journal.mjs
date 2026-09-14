// W4-39 G3: dispatch reconciliation. Intent is persisted to an append-only
// journal BEFORE any provider call, so a lost response leaves a recoverable
// "unknown" attempt instead of a reason to execute twice. Reconciliation
// always targets the original submission identity; a retry never re-submits.
// Real provider wiring stays gated on the hosted service's verified
// server-side idempotency contract (docs/AGENT-BRIDGE-ACCEPTANCE-2026-09-07
// AC-02); the journal and the guard are provider-agnostic.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const STATES = Object.freeze(["intended", "dispatched", "unknown", "done", "failed"]);
const TERMINAL = new Set(["done", "failed"]);

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
export const payloadDigest = payload => createHash("sha256").update(canonical(payload)).digest("hex");

function checkKey(key) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key)) throw new Error("A submission key is 1-128 id characters");
}
function checkState(state) {
  if (!STATES.includes(state)) throw new Error(`Unknown dispatch state: ${state}`);
}

// Append-only JSONL journal. One record per submission key; later lines for
// the same key are state transitions, never new intents.
export class DispatchJournal {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    if (typeof path !== "string" || !path.trim()) throw new Error("A journal path is required");
    this.path = path;
    this.now = now;
    this.records = new Map();
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        this.apply(entry);
      }
    }
  }
  apply(entry) {
    checkKey(entry.key);
    checkState(entry.state);
    const existing = this.records.get(entry.key);
    if (!existing) {
      if (entry.state !== "intended") throw new Error(`First journal entry for ${entry.key} must be the intent`);
      this.records.set(entry.key, { key: entry.key, roomId: entry.roomId, workItemId: entry.workItemId,
        payloadDigest: entry.payloadDigest, state: "intended", jobId: null, at: entry.at, history: [{ state: "intended", at: entry.at }] });
      return;
    }
    if (entry.state === "intended") throw new Error(`Duplicate intent for ${entry.key}`);
    if (TERMINAL.has(existing.state)) throw new Error(`Dispatch ${entry.key} is already ${existing.state}`);
    existing.state = entry.state;
    if (entry.jobId) existing.jobId = entry.jobId;
    existing.at = entry.at;
    existing.history.push({ state: entry.state, at: entry.at, ...(entry.note ? { note: entry.note } : {}) });
  }
  append(entry) {
    const full = { ...entry, at: this.now() };
    this.apply(full); // validate before touching disk
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }
  // Persist the intent BEFORE the provider is contacted. Same key + same
  // payload = the same attempt (returned, not duplicated); same key + altered
  // payload is refused outright.
  intend({ key, roomId, workItemId, payload }) {
    checkKey(key);
    const digest = payloadDigest(payload);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.payloadDigest !== digest) throw new Error(`Payload altered under submission key ${key}`);
      return { record: { ...existing, history: [...existing.history] }, duplicate: true };
    }
    this.append({ key, roomId, workItemId, payloadDigest: digest, state: "intended" });
    return { record: { ...this.records.get(key) }, duplicate: false };
  }
  transition(key, state, { jobId, note } = {}) {
    return this.append({ key, state, ...(jobId ? { jobId } : {}), ...(note ? { note } : {}) });
  }
  get(key) {
    const record = this.records.get(key);
    return record ? { ...record, history: [...record.history] } : null;
  }
}

// The guarded dispatch path. Persist intent, submit once, and on a lost
// response mark the attempt unknown - never resubmit. Reconciliation asks the
// provider about the ORIGINAL job and resolves that same attempt.
export function dispatchOnce({ journal, provider, key, roomId, workItemId, payload }) {
  const { record, duplicate } = journal.intend({ key, roomId, workItemId, payload });
  if (duplicate && record.state !== "intended") return { record, submitted: false };
  if (duplicate) {
    // Intended but never marked dispatched/unknown: a prior attempt crashed
    // between intend and submit. The provider may or may not have seen it -
    // reconcile instead of risking a second execution.
    return { record: reconcile({ journal, provider, key }), submitted: false };
  }
  try {
    const job = provider.submit({ key, payload });
    journal.transition(key, "dispatched", { jobId: job?.jobId });
    return { record: journal.get(key), submitted: true };
  } catch (error) {
    journal.transition(key, "unknown", { note: "response lost" });
    return { record: journal.get(key), submitted: false, lost: true };
  }
}

export function reconcile({ journal, provider, key }) {
  const record = journal.get(key);
  if (!record) throw new Error(`No dispatch recorded for ${key}`);
  if (TERMINAL.has(record.state)) return record;
  const status = provider.status({ key, jobId: record.jobId });
  if (!status || status.state === "unknown") return record; // stays unknown; still no resubmission
  journal.transition(key, status.state === "done" ? "done" : "failed", { jobId: status.jobId, note: status.note });
  return journal.get(key);
}

// Test/demo double for a provider with a server-side idempotency contract:
// one job per submission key, stable lookup, and a mode that processes the
// submit but drops the response (the lost-response fault G3 exists for).
export function createFakeProvider() {
  const jobs = new Map();
  return {
    dropResponses: false,
    jobs,
    submit({ key, payload }) {
      checkKey(key);
      const digest = payloadDigest(payload);
      const existing = jobs.get(key);
      if (existing) {
        if (existing.payloadDigest !== digest) throw new Error(`Payload altered under submission key ${key}`);
        return { jobId: existing.jobId };
      }
      const jobId = `job-${jobs.size + 1}`;
      jobs.set(key, { jobId, payloadDigest: digest, state: "done" });
      if (this.dropResponses) throw new Error("response lost");
      return { jobId };
    },
    status({ key, jobId }) {
      const job = jobs.get(key);
      if (!job || (jobId && job.jobId !== jobId)) return { state: "unknown" };
      return { state: job.state, jobId: job.jobId };
    }
  };
}
