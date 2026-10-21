// Merge train: agents enqueue ready PRs with room_land. Room stacks the
// queued PRs of one repo on a single branch (room-train/<batchId>) built
// from main, dispatches the repo's existing `test` workflow on that branch
// once, and fast-forwards main to the stacked head when it is green. The
// final stacked commit carries the [deploy-production] title, so the
// existing deploy-prod workflow_run path deploys it.
//
// Red batch: bisect by building probe branches from the same base until each
// breaking PR is isolated. Breakers go back to the claimant (land queue item
// turns red with a note, which surfaces in their needs-me and wakes them).
// The rest go back to the queue and land as the next batch, one more run.
//
// Risk: each PR's touched paths are classified with server/merge-train-
// paths.mjs. "person" PRs are held and appear only in the room owner's
// needs-me until the owner approves them. "safe" PRs land without review.
//
// After landing: once deploy-prod succeeds after the landing, the train
// dispatches live-smoke and reads its conclusion (POST .../merge_train/smoke
// records an external result instead). Red smoke rolls main back to the
// batch base with a forward commit (tree of the base, parent the landed
// head) when main has not moved, and marks the batch rolled_back. A moved
// main is never rewritten: the batch is marked failed for the owner.
//
// The GitHub token comes from the environment (GITHUB_TOKEN or GH_TOKEN,
// same as the land queue); it is never logged or stored.

import { randomBytes, createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { ownMember } from "../src/events.js";
import { githubAccessToken, parseRepo, parsePrNumber } from "./land-queue.mjs";
import { githubAppCredentials, installationToken } from "./github-app/auth.mjs";
import { MERGE_TRAIN_PATH_RULES } from "./merge-train-paths.mjs";
import { appendRoomEvent, ROOM_GUIDE_ID } from "./receipt-cards.mjs";

export const MAX_BATCH = 8;
export const TEST_WORKFLOW = "test.yml";
export const DEPLOY_WORKFLOW = "deploy-prod.yml";
export const SMOKE_WORKFLOW = "live-smoke.yml";
const BASE_BRANCH = "main";
const NOTE_MAX = 300;

function fail(status, code, message) { throw new ServiceError(status, code, message); }
const clip = (text) => String(text ?? "").slice(0, NOTE_MAX);

// ---------- risk classifier ----------

export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (ch === "*") out += "[^/]*";
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

const compiled = new WeakMap();
function compile(rules) {
  if (!compiled.has(rules)) {
    const map = (list) => list.map(rule => ({ reason: rule.reason, res: rule.globs.map(globToRegExp) }));
    compiled.set(rules, { person: map(rules.person), safe: map(rules.safe ?? []) });
  }
  return compiled.get(rules);
}

// paths: list of touched file paths. Unknown (empty or missing) file lists
// are "person": Room cannot prove the PR is safe.
export function classifyRisk(paths, rules = MERGE_TRAIN_PATH_RULES) {
  if (!Array.isArray(paths) || paths.length === 0) return { risk: "person", reasons: ["unknown_files"] };
  const { person, safe } = compile(rules);
  const reasons = new Set();
  const safeReasons = new Set();
  for (const path of paths) {
    for (const rule of person) if (rule.res.some(re => re.test(path))) reasons.add(rule.reason);
    for (const rule of safe) if (rule.res.some(re => re.test(path))) safeReasons.add(rule.reason);
  }
  if (reasons.size) return { risk: "person", reasons: [...reasons].sort() };
  return { risk: "safe", reasons: [...safeReasons].sort() };
}

// ---------- bisect ----------
// The stack holds groups still to test, top last. A red group of one is a
// breaker; a red group of more splits into halves, left tested first. Works
// for several breakers. The starting batch is already known red.

export function newBisect(ids) {
  if (!Array.isArray(ids) || ids.length < 2) fail(422, "invalid_request", "bisect needs at least two entries");
  const mid = Math.ceil(ids.length / 2);
  return { stack: [ids.slice(mid), ids.slice(0, mid)], good: [], bad: [], probes: 0 };
}

export function bisectNext(state) {
  return state.stack.length ? state.stack[state.stack.length - 1] : null;
}

export function bisectApply(state, green) {
  const group = state.stack.pop();
  if (!group) fail(409, "invalid_state", "nothing left to test");
  const next = { stack: [...state.stack], good: [...state.good], bad: [...state.bad], probes: state.probes + 1 };
  if (green) next.good.push(...group);
  else if (group.length === 1) next.bad.push(group[0]);
  else {
    const mid = Math.ceil(group.length / 2);
    next.stack.push(group.slice(mid), group.slice(0, mid));
  }
  return next;
}

export const bisectDone = (state) => state.stack.length === 0;

// ---------- state machines ----------

export const BATCH_TRANSITIONS = Object.freeze({
  testing: ["landing", "bisecting", "failed"],
  landing: ["smoke", "failed"],
  bisecting: ["done", "failed"],
  smoke: ["confirmed", "rolled_back", "failed"],
  confirmed: [], rolled_back: [], failed: [], done: []
});
export const ENTRY_TRANSITIONS = Object.freeze({
  held: ["queued", "removed"],
  queued: ["in_batch", "removed"],
  in_batch: ["queued", "landed", "returned"],
  landed: ["confirmed", "rolled_back"],
  returned: ["queued", "removed"],
  confirmed: [], rolled_back: ["queued", "removed"], removed: []
});
export const ACTIVE_BATCH_STATES = Object.freeze(["testing", "landing", "bisecting", "smoke"]);

export function transition(table, from, to) {
  if (!(table[from] ?? []).includes(to)) fail(409, "invalid_transition", `cannot move from ${from} to ${to}`);
  return to;
}

// ---------- GitHub adapter ----------

export function githubClient({ token, fetchImpl = fetch }) {
  const api = async (method, path, body) => {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "project-room-merge-train",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    if (res.status !== 204) { try { data = await res.json(); } catch { data = null; } }
    return { status: res.status, data };
  };
  const ok = (r, what) => {
    if (r.status >= 200 && r.status < 300) return r.data;
    if (r.status === 401 || r.status === 403) fail(503, "github_unconfigured", `GitHub refused ${what}`);
    fail(502, "github_unavailable", `GitHub ${what} answered ${r.status}`);
  };
  return {
    async pr(repo, n) { return ok(await api("GET", `/repos/${repo}/pulls/${n}`), "pull read"); },
    async prFiles(repo, n) {
      const files = [];
      for (let page = 1; page <= 3; page += 1) {
        const list = ok(await api("GET", `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`), "pull files read");
        files.push(...list.map(f => f.filename));
        if (list.length < 100) return files;
      }
      return null; // over 300 files: unknown, treated as needs-a-person
    },
    async refSha(repo, branch) { return ok(await api("GET", `/repos/${repo}/git/ref/heads/${branch}`), "ref read").object.sha; },
    async createRef(repo, branch, sha) { ok(await api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }), "branch create"); },
    async deleteRef(repo, branch) { await api("DELETE", `/repos/${repo}/git/refs/heads/${branch}`); },
    async merge(repo, branch, head, message) {
      const r = await api("POST", `/repos/${repo}/merges`, { base: branch, head, commit_message: message });
      if (r.status === 409) return { conflict: true };
      if (r.status === 204) return { sha: null, noop: true };
      return { sha: ok(r, "merge").sha };
    },
    async fastForward(repo, branch, sha) {
      const r = await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha, force: false });
      if (r.status === 422) return false;
      ok(r, "fast-forward");
      return true;
    },
    async commitTree(repo, sha) { return ok(await api("GET", `/repos/${repo}/git/commits/${sha}`), "commit read").tree.sha; },
    async createCommit(repo, message, tree, parents) {
      return ok(await api("POST", `/repos/${repo}/git/commits`, { message, tree, parents }), "commit create").sha;
    },
    async dispatch(repo, workflow, ref, inputs) {
      ok(await api("POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref, ...(inputs ? { inputs } : {}) }), "workflow dispatch");
    },
    // Newest run of a workflow created at or after `after` (ms), optionally
    // on one branch and event. Returns { status, conclusion } or null.
    async latestRun(repo, workflow, { branch = null, event = null, after = 0 } = {}) {
      const q = new URLSearchParams({ per_page: "20" });
      if (branch) q.set("branch", branch);
      if (event) q.set("event", event);
      const data = ok(await api("GET", `/repos/${repo}/actions/workflows/${workflow}/runs?${q}`), "run list");
      const runs = (data.workflow_runs ?? []).filter(run => Date.parse(run.created_at) >= after - 60_000);
      runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return runs[0] ? { id: runs[0].id ?? null, url: runs[0].html_url ?? null, status: runs[0].status, conclusion: runs[0].conclusion ?? null } : null;
    },
    // Names of failed jobs of one run (flaky tracking). Best effort.
    async failedJobs(repo, runId) {
      if (!runId) return [];
      const r = await api("GET", `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
      if (r.status !== 200) return [];
      return (r.data?.jobs ?? []).filter(job => job.conclusion === "failure").map(job => String(job.name).slice(0, 120));
    }
  };
}

export function runOutcome(run) {
  if (!run || run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "green" : "red";
}

// ---------- schema ----------

export const mergeTrainSchema = `
  CREATE TABLE IF NOT EXISTS merge_train_entries (
    room_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    item_id TEXT,
    claimant_member_id TEXT NOT NULL,
    head_sha TEXT,
    risk TEXT NOT NULL,
    risk_reasons TEXT NOT NULL,
    state TEXT NOT NULL,
    batch_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, entry_id)
  );
  CREATE INDEX IF NOT EXISTS merge_train_entries_state ON merge_train_entries(room_id, repo, state);
  CREATE TABLE IF NOT EXISTS merge_train_batches (
    room_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    state TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    head_sha TEXT,
    entry_ids TEXT NOT NULL,
    bisect TEXT,
    probe_ids TEXT,
    probe_branch TEXT,
    dispatched_at INTEGER,
    landed_at INTEGER,
    smoke_dispatched_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, batch_id)
  );
  CREATE TABLE IF NOT EXISTS merge_train_control (
    room_id TEXT NOT NULL PRIMARY KEY,
    paused INTEGER NOT NULL,
    by_member_id TEXT,
    reason TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS merge_train_flaky (
    room_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    name TEXT NOT NULL,
    flips INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, repo, name)
  );
`;

// Columns added after the first cut of the batch table.
export function migrateMergeTrainColumns(db) {
  const have = new Set(db.prepare("PRAGMA table_info(merge_train_batches)").all().map(c => c.name));
  for (const [name, type] of [["reruns", "INTEGER NOT NULL DEFAULT 0"], ["first_failures", "TEXT"], ["run_url", "TEXT"], ["smoke", "TEXT"]]) {
    if (!have.has(name)) db.exec(`ALTER TABLE merge_train_batches ADD COLUMN ${name} ${type}`);
  }
}

function entryView(row) {
  return {
    entryId: row.entry_id, repo: row.repo, prNumber: row.pr_number, itemId: row.item_id,
    claimantMemberId: row.claimant_member_id, headSha: row.head_sha, risk: row.risk,
    riskReasons: JSON.parse(row.risk_reasons), state: row.state, batchId: row.batch_id,
    note: row.note, updatedAt: row.updated_at
  };
}
function batchView(row) {
  return {
    batchId: row.batch_id, repo: row.repo, state: row.state, baseSha: row.base_sha, branch: row.branch,
    headSha: row.head_sha, entryIds: JSON.parse(row.entry_ids), note: row.note, runUrl: row.run_url ?? null,
    smoke: row.smoke ?? null, reruns: row.reruns ?? 0, updatedAt: row.updated_at
  };
}

// ---------- service ----------

export class MergeTrain {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.token = null;
    this.fetchImpl = (...args) => fetch(...args);
    this.rules = MERGE_TRAIN_PATH_RULES;
    this.busy = new Set();
    this.baseBranch = BASE_BRANCH;
    this.appEnv = null;
  }

  configure({ env = null, token = undefined, fetchImpl = undefined, rules = undefined, baseBranch = undefined } = {}) {
    if (typeof baseBranch === "string" && /^[A-Za-z0-9._\/-]{1,100}$/.test(baseBranch)) this.baseBranch = baseBranch;
    if (token !== undefined) this.token = token || null;
    else if (env) {
      this.token = githubAccessToken(env);
      // No static token: mint short-lived GitHub App installation tokens
      // (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_WEBHOOK_SECRET +
      // MERGE_TRAIN_INSTALLATION_ID) before each tick instead of a PAT.
      const installationId = typeof env.MERGE_TRAIN_INSTALLATION_ID === "string" ? env.MERGE_TRAIN_INSTALLATION_ID.trim() : "";
      this.appEnv = !this.token && /^\d{1,20}$/.test(installationId) && githubAppCredentials(env) ? { env, installationId } : null;
    }
    if (fetchImpl) this.fetchImpl = fetchImpl;
    if (rules) this.rules = rules;
    return this;
  }

  async refreshToken() {
    if (!this.appEnv) return this.token;
    const minted = await installationToken(this.appEnv.installationId, { env: this.appEnv.env, fetchFn: this.fetchImpl });
    this.token = typeof minted === "string" ? minted : (minted?.token ?? null);
    return this.token;
  }

  get gh() { return githubClient({ token: this.token, fetchImpl: this.fetchImpl }); }

  #member(roomId, memberId) {
    const member = ownMember(this.store.room(roomId).state.members, memberId);
    if (!member || member.active === false) fail(403, "not_member", "caller must be an active room member");
    return member;
  }
  #owner(roomId) { return this.store.room(roomId).state.room.ownerId; }
  #entry(roomId, entryId) {
    const row = this.db.prepare("SELECT * FROM merge_train_entries WHERE room_id=? AND entry_id=?").get(roomId, entryId);
    if (!row) fail(404, "not_found", "no merge train entry with that id");
    return row;
  }
  #setEntry(row, to, { batchId, note } = {}) {
    transition(ENTRY_TRANSITIONS, row.state, to);
    this.db.prepare("UPDATE merge_train_entries SET state=?, batch_id=?, note=?, updated_at=? WHERE room_id=? AND entry_id=?")
      .run(to, batchId === undefined ? row.batch_id : batchId, note === undefined ? row.note : clip(note), this.store.now(), row.room_id, row.entry_id);
  }
  #setBatch(row, to, fields = {}) {
    if (to !== row.state) transition(BATCH_TRANSITIONS, row.state, to);
    const merged = { ...row, ...fields, state: to, updated_at: this.store.now() };
    this.db.prepare(`UPDATE merge_train_batches SET state=?, head_sha=?, bisect=?, probe_ids=?, probe_branch=?,
      dispatched_at=?, landed_at=?, smoke_dispatched_at=?, note=?, reruns=?, first_failures=?, run_url=?, smoke=?, updated_at=?
      WHERE room_id=? AND batch_id=?`)
      .run(merged.state, merged.head_sha, merged.bisect, merged.probe_ids, merged.probe_branch, merged.dispatched_at,
        merged.landed_at, merged.smoke_dispatched_at, merged.note == null ? null : clip(merged.note), merged.reruns ?? 0,
        merged.first_failures ?? null, merged.run_url ?? null, merged.smoke ?? null, merged.updated_at,
        row.room_id, row.batch_id);
    return merged;
  }

  // ---- kill switch ----
  isPaused(roomId) {
    return Boolean(this.db.prepare("SELECT paused FROM merge_train_control WHERE room_id=?").get(roomId)?.paused);
  }

  setPaused(roomId, memberId, paused, reason = null) {
    this.#member(roomId, memberId);
    if (memberId !== this.#owner(roomId)) fail(403, "owner_only", "only the room owner pauses or resumes the merge train");
    this.db.prepare(`INSERT INTO merge_train_control (room_id, paused, by_member_id, reason, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET paused=excluded.paused, by_member_id=excluded.by_member_id, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(roomId, paused ? 1 : 0, memberId, reason == null ? null : clip(reason), this.store.now());
    this.post(roomId, paused
      ? `Merge train paused by the owner. No batch lands or deploys until it is resumed.${reason ? ` Reason: ${clip(reason)}` : ""}`
      : "Merge train resumed. Queued PRs will land on the next tick.", `ctl:${this.store.now()}`);
    return { paused: Boolean(paused) };
  }

  // Room card: a plain message from the room guide (system member) or, when
  // the room has none, the owner. Best effort; never blocks the train.
  post(roomId, body, key) {
    try {
      const members = this.store.room(roomId).state.members ?? {};
      const guide = members[ROOM_GUIDE_ID];
      const author = guide?.system === true && guide.active !== false ? guide.id : this.#owner(roomId);
      const messageId = `mt${createHash("sha256").update(`${roomId}\0${key}`).digest("hex").slice(0, 40)}`;
      return appendRoomEvent(this.store, roomId, { id: messageId, type: "message.posted", actorId: author, data: { messageId, body: clip(body) } });
    } catch (error) {
      console.error("merge train card failed:", error?.code ?? "error");
      return null;
    }
  }

  #receipt(batch, rows, extra) {
    const prs = rows.map(r => `#${r.pr_number}`).join(" ");
    const lines = [
      `Merge train ${batch.batch_id} (${batch.repo}): ${extra}`,
      `PRs: ${prs || "none"}`,
      `Merged SHA: ${batch.head_sha ?? "none"}`,
      `Test run: ${batch.run_url ?? "not recorded"}`,
      `Smoke: ${batch.smoke ?? "pending"}`,
      `Rollback target: ${batch.base_sha}`
    ];
    this.post(batch.room_id, lines.join("\n"), `rcpt:${batch.batch_id}:${extra}`);
  }

  // ---- metrics ----
  metrics(roomId, memberId, { days = 14 } = {}) {
    this.#member(roomId, memberId);
    const since = this.store.now() - days * 86_400_000;
    const batches = this.db.prepare("SELECT * FROM merge_train_batches WHERE room_id=? AND created_at>=?").all(roomId, since);
    const perDay = {};
    let merges = 0;
    for (const b of batches) {
      if (!b.landed_at) continue;
      const n = JSON.parse(b.entry_ids).length;
      const day = new Date(b.landed_at).toISOString().slice(0, 10);
      perDay[day] = (perDay[day] ?? 0) + n;
      merges += n;
    }
    const smokeRed = batches.filter(b => b.smoke === "red");
    const flaky = this.db.prepare("SELECT repo, name, flips, last_at AS lastAt FROM merge_train_flaky WHERE room_id=? ORDER BY flips DESC LIMIT 20").all(roomId);
    return {
      days,
      merges,
      mergesPerDay: Number((merges / days).toFixed(2)),
      perDay,
      batches: batches.length,
      mainBreaks: smokeRed.length,
      prodRollbacks: batches.filter(b => b.state === "rolled_back").length,
      redBatches: batches.filter(b => b.bisect || (b.state === "done")).length,
      flaky,
      paused: this.isPaused(roomId)
    };
  }

  async enqueue(roomId, memberId, { repo, prNumber, claimantMemberId = null } = {}) {
    this.#member(roomId, memberId);
    const parsedRepo = parseRepo(repo);
    const parsedPr = parsePrNumber(prNumber);
    const claimant = claimantMemberId ?? memberId;
    this.#member(roomId, claimant);
    const live = this.db.prepare(`SELECT * FROM merge_train_entries WHERE room_id=? AND repo=? AND pr_number=?
      AND state IN ('held','queued','in_batch')`).get(roomId, parsedRepo, parsedPr);
    if (live) return { entry: entryView(live), duplicate: true };
    let itemId = null;
    try {
      const item = await this.store.landQueue?.add(roomId, memberId, { repo: parsedRepo, prNumber: parsedPr, claimantMemberId: claimant });
      itemId = item?.item?.itemId ?? item?.itemId ?? null;
    } catch (error) {
      if (error?.code === "pr_not_found") throw error;
    }
    const pr = await this.gh.pr(parsedRepo, parsedPr);
    if (pr.state !== "open") fail(409, "invalid_state", "only open pull requests can ride the merge train");
    const files = await this.gh.prFiles(parsedRepo, parsedPr);
    const { risk, reasons } = classifyRisk(files, this.rules);
    const now = this.store.now();
    const entryId = `mt_${randomBytes(9).toString("base64url")}`;
    const state = risk === "person" ? "held" : "queued";
    this.db.prepare(`INSERT INTO merge_train_entries (room_id, entry_id, repo, pr_number, item_id, claimant_member_id,
      head_sha, risk, risk_reasons, state, batch_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`)
      .run(roomId, entryId, parsedRepo, parsedPr, itemId, claimant, pr.head?.sha ?? null, risk, JSON.stringify(reasons),
        state, risk === "person" ? `needs a person: ${reasons.join(", ")}` : null, now, now);
    return { entry: entryView(this.#entry(roomId, entryId)), duplicate: false };
  }

  approve(roomId, memberId, { entryId } = {}) {
    this.#member(roomId, memberId);
    if (memberId !== this.#owner(roomId)) fail(403, "owner_only", "only the room owner approves needs-a-person PRs");
    const row = this.#entry(roomId, entryId);
    if (row.state !== "held") fail(409, "invalid_state", "this entry is not waiting for approval");
    this.#setEntry(row, "queued", { note: `approved by owner` });
    return { entry: entryView(this.#entry(roomId, entryId)) };
  }

  remove(roomId, memberId, { entryId } = {}) {
    this.#member(roomId, memberId);
    const row = this.#entry(roomId, entryId);
    if (memberId !== row.claimant_member_id && memberId !== this.#owner(roomId)) fail(403, "forbidden", "only the claimant or owner removes an entry");
    this.#setEntry(row, "removed");
    return { entry: entryView(this.#entry(roomId, entryId)) };
  }

  list(roomId, memberId) {
    this.#member(roomId, memberId);
    const entries = this.db.prepare(`SELECT * FROM merge_train_entries WHERE room_id=? AND state NOT IN ('removed','confirmed')
      ORDER BY created_at ASC LIMIT 100`).all(roomId).map(entryView);
    const batches = this.db.prepare(`SELECT * FROM merge_train_batches WHERE room_id=? ORDER BY created_at DESC LIMIT 10`)
      .all(roomId).map(batchView);
    return { entries, batches, paused: this.isPaused(roomId) };
  }

  // needs-me rows: held PRs for the room owner only.
  heldFor(roomId, memberId) {
    try {
      if (memberId !== this.#owner(roomId)) return [];
      return this.db.prepare("SELECT * FROM merge_train_entries WHERE room_id=? AND state='held' ORDER BY updated_at ASC LIMIT 20")
        .all(roomId).map(entryView);
    } catch (error) {
      if (/no such table/i.test(error?.message ?? "")) return [];
      throw error;
    }
  }

  #returnEntry(row, note) {
    this.#setEntry(row, "returned", { note });
    if (row.item_id) this.store.landQueue?.markReturned?.(row.room_id, row.item_id, note);
  }

  async #build(roomId, repo, baseSha, branch, rows, deployTitle) {
    const gh = this.gh;
    await gh.createRef(repo, branch, baseSha);
    let head = baseSha;
    const merged = [];
    const conflicts = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const last = i === rows.length - 1;
      const title = `${deployTitle && last ? "[deploy-production] " : ""}Merge train ${branch}: #${row.pr_number}`;
      const result = await gh.merge(repo, branch, row.head_sha, title);
      if (result.conflict) { conflicts.push(row); continue; }
      if (result.sha) head = result.sha;
      merged.push(row);
    }
    return { head, merged, conflicts };
  }

  // One step for every repo of a room. Safe to call every minute.
  async tick(roomId) {
    if (this.busy.has(roomId)) return { skipped: "busy" };
    this.busy.add(roomId);
    try {
      await this.refreshToken();
      const repos = this.db.prepare(`SELECT DISTINCT repo FROM merge_train_entries WHERE room_id=? AND state IN ('queued','in_batch','landed')
        UNION SELECT repo FROM merge_train_batches WHERE room_id=? AND state IN (${ACTIVE_BATCH_STATES.map(() => "?").join(",")})`)
        .all(roomId, roomId, ...ACTIVE_BATCH_STATES).map(r => r.repo);
      const out = [];
      for (const repo of repos) out.push(await this.#step(roomId, repo));
      return { steps: out };
    } finally { this.busy.delete(roomId); }
  }

  async tickAll() {
    let rooms = [];
    try {
      rooms = this.db.prepare(`SELECT DISTINCT room_id AS roomId FROM merge_train_entries WHERE state IN ('queued','in_batch','landed')`).all().map(r => r.roomId);
    } catch { return { rooms: 0 }; }
    for (const roomId of rooms) {
      try { await this.tick(roomId); } catch (error) { console.error("merge train tick failed:", error?.code ?? "error"); }
    }
    return { rooms: rooms.length };
  }

  #activeBatch(roomId, repo) {
    return this.db.prepare(`SELECT * FROM merge_train_batches WHERE room_id=? AND repo=? AND state IN (${ACTIVE_BATCH_STATES.map(() => "?").join(",")})
      ORDER BY created_at DESC LIMIT 1`).get(roomId, repo, ...ACTIVE_BATCH_STATES);
  }
  #batchEntries(batch) {
    const ids = JSON.parse(batch.entry_ids);
    return ids.map(id => this.#entry(batch.room_id, id));
  }

  async #step(roomId, repo) {
    const batch = this.#activeBatch(roomId, repo);
    if (!batch) return this.#startBatch(roomId, repo);
    if (batch.state === "testing") return this.#pollTest(batch);
    if (batch.state === "bisecting") return this.#pollProbe(batch);
    if (batch.state === "smoke") return this.#pollSmoke(batch);
    return { batchId: batch.batch_id, state: batch.state };
  }

  async #startBatch(roomId, repo) {
    if (this.isPaused(roomId)) return { paused: true, idle: true };
    const queued = this.db.prepare(`SELECT * FROM merge_train_entries WHERE room_id=? AND repo=? AND state='queued'
      ORDER BY created_at ASC LIMIT ?`).all(roomId, repo, MAX_BATCH);
    if (!queued.length) return { idle: true };
    const gh = this.gh;
    const batchId = `mtb_${randomBytes(6).toString("hex")}`;
    const branch = `room-train/${batchId}`;
    const baseSha = await gh.refSha(repo, this.baseBranch);
    const { head, merged, conflicts } = await this.#build(roomId, repo, baseSha, branch, queued, true);
    const now = this.store.now();
    for (const row of conflicts) { this.#setEntry(row, "in_batch", { batchId }); this.#returnEntry(this.#entry(roomId, row.entry_id), "merge conflict with the train; rebase on main and enqueue again"); }
    this.db.prepare(`INSERT INTO merge_train_batches (room_id, batch_id, repo, state, base_sha, branch, head_sha, entry_ids,
      bisect, probe_ids, probe_branch, dispatched_at, landed_at, smoke_dispatched_at, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,NULL,?,?,?)`)
      .run(roomId, batchId, repo, merged.length ? "testing" : "failed", baseSha, branch, head,
        JSON.stringify(merged.map(r => r.entry_id)), merged.length ? now : null, merged.length ? null : "every PR conflicted", now, now);
    if (!merged.length) { await gh.deleteRef(repo, branch); return { batchId, state: "failed" }; }
    for (const row of merged) this.#setEntry(row, "in_batch", { batchId });
    await gh.dispatch(repo, TEST_WORKFLOW, branch);
    return { batchId, state: "testing", size: merged.length };
  }

  async #pollTest(batch) {
    const gh = this.gh;
    const run = await gh.latestRun(batch.repo, TEST_WORKFLOW, { branch: batch.branch, event: "workflow_dispatch", after: batch.dispatched_at });
    const outcome = runOutcome(run);
    if (outcome === "pending") return { batchId: batch.batch_id, state: "testing" };
    if (run?.url) batch = this.#setBatch(batch, "testing", { run_url: run.url });
    const rows = this.#batchEntries(batch);
    // Flaky guard: a red batch runs once more before bisecting. A pass on
    // the re-run records the first run's failed jobs as flaky.
    if (outcome === "red" && !(batch.reruns > 0)) {
      const failures = await gh.failedJobs(batch.repo, run?.id);
      await gh.dispatch(batch.repo, TEST_WORKFLOW, batch.branch);
      this.#setBatch(batch, "testing", { reruns: 1, first_failures: JSON.stringify(failures), dispatched_at: this.store.now() });
      return { batchId: batch.batch_id, state: "testing", rerun: true };
    }
    if (outcome === "green" && batch.reruns > 0) this.#recordFlaky(batch);
    if (outcome === "green" && this.isPaused(batch.room_id)) return { batchId: batch.batch_id, state: "testing", paused: true };
    if (outcome === "green") {
      const landing = this.#setBatch(batch, "landing");
      const moved = !(await gh.fastForward(batch.repo, this.baseBranch, batch.head_sha));
      await gh.deleteRef(batch.repo, batch.branch);
      if (moved) {
        this.#setBatch(landing, "failed", { note: "main moved during the run; requeued" });
        for (const row of rows) this.#setEntry(row, "queued", { batchId: null });
        return { batchId: batch.batch_id, state: "failed", requeued: rows.length };
      }
      const smoke = this.#setBatch(landing, "smoke", { landed_at: this.store.now() });
      for (const row of rows) this.#setEntry(row, "landed");
      this.#receipt(smoke, rows, "landed on main");
      return { batchId: batch.batch_id, state: "smoke", landed: rows.length };
    }
    await gh.deleteRef(batch.repo, batch.branch);
    if (rows.length === 1) {
      this.#setBatch(batch, "bisecting");
      this.#returnEntry(rows[0], "tests failed on the merge train");
      this.#setBatch({ ...batch, state: "bisecting" }, "done", { note: "single PR red" });
      return { batchId: batch.batch_id, state: "done", returned: 1 };
    }
    const bisect = newBisect(rows.map(r => r.entry_id));
    return this.#startProbe(this.#setBatch(batch, "bisecting", { bisect: JSON.stringify(bisect) }), bisect);
  }

  #recordFlaky(batch) {
    const names = JSON.parse(batch.first_failures ?? "[]");
    const list = names.length ? names : [`${TEST_WORKFLOW} (job names unavailable)`];
    for (const name of list) {
      this.db.prepare(`INSERT INTO merge_train_flaky (room_id, repo, name, flips, last_at) VALUES (?,?,?,1,?)
        ON CONFLICT(room_id, repo, name) DO UPDATE SET flips=flips+1, last_at=excluded.last_at`)
        .run(batch.room_id, batch.repo, name, this.store.now());
    }
  }

  async #startProbe(batch, bisect) {
    const ids = bisectNext(bisect);
    const branch = `${batch.branch}-p${bisect.probes + 1}`;
    const rows = ids.map(id => this.#entry(batch.room_id, id));
    const { head, conflicts } = await this.#build(batch.room_id, batch.repo, batch.base_sha, branch, rows, false);
    if (conflicts.length) {
      // A PR that merges alone into the base but not with its group is
      // treated as red for this group; the split isolates it.
      await this.gh.deleteRef(batch.repo, branch);
      return this.#applyProbe(this.#setBatch(batch, "bisecting", { probe_branch: null }), bisect, false);
    }
    await this.gh.dispatch(batch.repo, TEST_WORKFLOW, branch);
    this.#setBatch(batch, "bisecting", { probe_ids: JSON.stringify(ids), probe_branch: branch, dispatched_at: this.store.now(), head_sha: head });
    return { batchId: batch.batch_id, state: "bisecting", probe: ids.length };
  }

  async #pollProbe(batch) {
    const outcome = runOutcome(await this.gh.latestRun(batch.repo, TEST_WORKFLOW, { branch: batch.probe_branch, event: "workflow_dispatch", after: batch.dispatched_at }));
    if (outcome === "pending") return { batchId: batch.batch_id, state: "bisecting" };
    await this.gh.deleteRef(batch.repo, batch.probe_branch);
    return this.#applyProbe(batch, JSON.parse(batch.bisect), outcome === "green");
  }

  async #applyProbe(batch, bisect, green) {
    const next = bisectApply(bisect, green);
    const saved = this.#setBatch(batch, "bisecting", { bisect: JSON.stringify(next), probe_ids: null, probe_branch: null });
    if (!bisectDone(next)) return this.#startProbe(saved, next);
    for (const id of next.bad) this.#returnEntry(this.#entry(batch.room_id, id), "this PR breaks the test suite on the merge train (bisected)");
    for (const id of next.good) this.#setEntry(this.#entry(batch.room_id, id), "queued", { batchId: null });
    this.#setBatch(saved, "done", { note: `bisect: ${next.bad.length} returned, ${next.good.length} requeued` });
    return { batchId: batch.batch_id, state: "done", returned: next.bad.length, requeued: next.good.length };
  }

  async #pollSmoke(batch) {
    const gh = this.gh;
    if (!batch.smoke_dispatched_at) {
      if (this.isPaused(batch.room_id)) return { batchId: batch.batch_id, state: "smoke", paused: true };
      const deploy = await gh.latestRun(batch.repo, DEPLOY_WORKFLOW, { after: batch.landed_at });
      if (runOutcome(deploy) !== "green") return { batchId: batch.batch_id, state: "smoke", waiting: "deploy" };
      await gh.dispatch(batch.repo, SMOKE_WORKFLOW, this.baseBranch);
      this.#setBatch(batch, "smoke", { smoke_dispatched_at: this.store.now() });
      return { batchId: batch.batch_id, state: "smoke", waiting: "smoke" };
    }
    const outcome = runOutcome(await gh.latestRun(batch.repo, SMOKE_WORKFLOW, { event: "workflow_dispatch", after: batch.smoke_dispatched_at }));
    if (outcome === "pending") return { batchId: batch.batch_id, state: "smoke", waiting: "smoke" };
    return this.#settleSmoke(batch, outcome === "green");
  }

  // External smoke hook (REST): the room owner or the deploy job reports.
  async recordSmoke(roomId, memberId, { batchId, ok } = {}) {
    this.#member(roomId, memberId);
    if (memberId !== this.#owner(roomId)) fail(403, "owner_only", "only the room owner reports a smoke result");
    const batch = this.db.prepare("SELECT * FROM merge_train_batches WHERE room_id=? AND batch_id=?").get(roomId, batchId);
    if (!batch) fail(404, "not_found", "no merge train batch with that id");
    if (batch.state !== "smoke") fail(409, "invalid_state", "this batch is not waiting for a smoke result");
    if (typeof ok !== "boolean") fail(422, "invalid_request", "ok must be true or false");
    return this.#settleSmoke(batch, ok);
  }

  async #settleSmoke(batch, ok) {
    const rows = this.#batchEntries(batch);
    if (ok) {
      const done = this.#setBatch(batch, "confirmed", { smoke: "green" });
      for (const row of rows) this.#setEntry(row, "confirmed");
      this.#receipt(done, rows, "prod smoke passed");
      return { batchId: batch.batch_id, state: "confirmed" };
    }
    const gh = this.gh;
    const main = await gh.refSha(batch.repo, this.baseBranch);
    if (main !== batch.head_sha) {
      const failed = this.#setBatch(batch, "failed", { smoke: "red", note: "prod smoke failed and main moved; roll back by hand" });
      this.#receipt(failed, rows, "prod smoke failed; main moved, roll back by hand");
      for (const row of rows) { this.#setEntry(row, "rolled_back", { note: "prod smoke failed" }); }
      return { batchId: batch.batch_id, state: "failed" };
    }
    const tree = await gh.commitTree(batch.repo, batch.base_sha);
    const revert = await gh.createCommit(batch.repo, `[deploy-production] Roll back merge train ${batch.batch_id}: prod smoke failed`, tree, [batch.head_sha]);
    const done = await gh.fastForward(batch.repo, this.baseBranch, revert);
    const settled = this.#setBatch(batch, done ? "rolled_back" : "failed", { smoke: "red", note: done ? "prod smoke failed; main rolled back" : "rollback could not fast-forward main" });
    this.#receipt(settled, rows, done ? `prod smoke failed; main rolled back to ${batch.base_sha}` : "prod smoke failed; rollback could not fast-forward main");
    for (const row of rows) {
      this.#setEntry(row, "rolled_back", { note: "prod smoke failed after landing; batch rolled back" });
      if (row.item_id) this.store.landQueue?.markReturned?.(row.room_id, row.item_id, "prod smoke failed after landing; batch rolled back");
    }
    return { batchId: batch.batch_id, state: done ? "rolled_back" : "failed" };
  }
}
