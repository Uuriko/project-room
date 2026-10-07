// merge-queue-worker.mjs — automation for the room-coordinated merge queue.
//
// Phase 1 (docs/MERGE-QUEUE-DESIGN.md): lanes claim a merge-slot via
// POST /api/rooms/{roomId}/merge-queue/enqueue; THIS script does the serial
// work — rebase the PR onto current main, run the checks, merge, release the
// slot. Lanes stop fighting HEAD themselves.
//
// Usage:
//   node scripts/merge-queue-worker.mjs status [--room muse-room]
//   node scripts/merge-queue-worker.mjs tick [--room muse-room] [--live] [--authorized-head <40-char SHA>]
//   node scripts/merge-queue-worker.mjs sweep [--room muse-room]
//
// tick processes the active slot once. Dry-run is the default: it verifies
// the PR and prints the plan without pushing, merging, or releasing.
// --live performs the rebase, push, check-wait, merge, and release.
// Scheduling (cron) and --live are John's tap; until then run tick by hand.
//
// Crash safety: the worker adopts the slot and heartbeats the lease between
// long steps. If the worker dies, the lease expires, the sweep releases the
// slot, and the next tick retries — every step is idempotent (rebase of an
// already-rebased branch is a no-op; push uses --force-with-lease).
//
// Auth: $ROOM_IDENTITY_SECRET, else ~/.config/jill-room/identity.json
// (same identity the room plugins use). Needs `gh` authenticated for the
// repo. Worker repo lives at ~/workspace/pr-mergequeue-worker/ (persistent;
// never /tmp).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { approvalGate, patchUnchanged, queueCheckVerdict } from "../server/merge-queue.mjs";

const ORIGIN = "https://room.trydemigod.com";
const REPO = "Uuriko/project-room";
const BASE = "main";
const REQUIRED_CHECKS = ["test", "contract", "lint", "browser", "cloudflare"];
const WORKER_DIR = join(homedir(), "workspace", "pr-mergequeue-worker");
const STATE_FILE = join(WORKER_DIR, ".worker-state.json");
const MAX_CONSECUTIVE_FAILURES = 3;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const ROOM = argValue("--room") || "muse-room";
const LIVE = process.argv.includes("--live");
// Only the operator holding GitHub credentials supplies this exact-head
// release authority. Queue members cannot set it through their Board claim.
const AUTHORIZED_HEAD = argValue("--authorized-head");
if (process.argv.includes("--authorized-head") && !/^[0-9a-f]{40}$/.test(AUTHORIZED_HEAD ?? "")) {
  throw new Error("--authorized-head requires a full lowercase 40-character SHA");
}
const CHECK_TIMEOUT_MS = (Number(argValue("--check-timeout-minutes")) || 60) * 60 * 1000;

function identitySecret() {
  if (process.env.ROOM_IDENTITY_SECRET) return process.env.ROOM_IDENTITY_SECRET;
  const cfg = join(homedir(), ".config", "jill-room", "identity.json");
  return JSON.parse(readFileSync(cfg, "utf8")).secret;
}
const SECRET = identitySecret();

function roomApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        "User-Agent": "merge-queue-worker/1.0",
      },
      timeout: 30000,
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* leave null */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new Error(`room API ${method} ${path} -> ${res.statusCode}: ${(data || "").slice(0, 300)}`));
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("room API timeout")); });
    req.on("error", reject);
    if (payload) req.end(payload); else req.end();
  });
}

async function postRoom(body) {
  await roomApi("POST", `/api/rooms/${ROOM}/commands`, {
    id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body },
  });
}

function gh(args, { encoding = "utf8" } = {}) {
  try {
    const bound = args[0] === "pr" ? [...args, "--repo", REPO] : args;
    return execFileSync("gh", bound, { encoding, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n")[0];
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${msg}`);
  }
}
const ghJson = (args) => JSON.parse(gh(args) || "null");

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n").slice(0, 3).join(" | ");
    throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${msg}`);
  }
}

function loadWorkerState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { failures: {} }; }
}
function saveWorkerState(state) {
  mkdirSync(WORKER_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function cmdStatus() {
  const st = await roomApi("GET", `/api/rooms/${ROOM}/merge-queue/status`);
  console.log(`merge queue: ${ROOM}`);
  if (!st.active) {
    console.log("  slot: free");
  } else {
    const a = st.active;
    console.log(`  slot: HELD by ${a.lane} — PR #${a.pr} ${a.headSha.slice(0, 7)} (claim ${a.claimId})`);
    console.log(`          adopted by ${a.adoptedBy ?? "(none)"}, lease expires ${a.leaseExpiresAt}`);
  }
  console.log(`  depth: ${st.depth}`);
  for (const q of st.queue) {
    console.log(`  #${q.position} PR #${q.pr} ${q.headSha.slice(0, 7)} (claim ${q.claimId}, lane ${q.lane})`);
  }
}

async function cmdSweep() {
  const out = await roomApi("POST", `/api/rooms/${ROOM}/merge-queue/sweep`);
  console.log(`swept: ${(out.swept || []).join(", ") || "(none)"}; promoted: ${out.promoted || "(none)"}`);
}

// Eject the active slot: release it and tell the room why. The lane fixes
// the problem and re-enqueues; the queue keeps moving.
// The Board claim is required even for operator-authorized releases. A missing
// or unreadable claim refuses; caller-provided exact-head authority can make
// independent review advisory without authorizing arbitrary queued PRs.
async function claimGate(claimId, headSha) {
  try {
    const data = await roomApi("GET", `/api/rooms/${ROOM}/work-claims/${encodeURIComponent(claimId)}`);
    return approvalGate({ claim: data?.claim ?? data, headSha, authorizedHeadSha: AUTHORIZED_HEAD });
  } catch (err) {
    return { ok: false, reason: `could not read Board claim ${claimId} to check release authorization: ${err.message}` };
  }
}

async function eject(claimId, reason, pr) {
  await roomApi("POST", `/api/rooms/${ROOM}/merge-queue/release`, { claimId });
  const note = `merge-queue: ejected PR #${pr} (claim ${claimId}) — ${reason}. Lane: fix and re-enqueue; the slot is free.`;
  console.log(note);
  if (LIVE) await postRoom(note);
}

function ensureWorkerRepo() {
  mkdirSync(WORKER_DIR, { recursive: true });
  if (!existsSync(join(WORKER_DIR, ".git"))) {
    console.log(`cloning ${REPO} into ${WORKER_DIR} ...`);
    sh("git", ["clone", `https://github.com/${REPO}.git`, WORKER_DIR]);
  }
  sh("git", ["fetch", "origin"], { cwd: WORKER_DIR });
}

async function waitForChecks(pr, headSha, heartbeat) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let lastBeat = 0;
  for (;;) {
    const runs = ghJson(["api", `repos/${REPO}/commits/${headSha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {id, name, status, conclusion}]"]);
    const legacy = ghJson(["api", `repos/${REPO}/commits/${headSha}/status`, "--jq", "[.statuses[] | {name: .context, state}]"]);
    const verdict = queueCheckVerdict({ runs, legacy, requiredChecks: REQUIRED_CHECKS });
    if (verdict.state === "failure") return { ok: false, reason: verdict.reason };
    if (verdict.state === "success") return { ok: true };
    if (Date.now() > deadline) {
      return { ok: false, reason: `check timeout: still pending/missing after ${CHECK_TIMEOUT_MS / 60000}min (${verdict.pending.join(", ")})` };
    }
    if (Date.now() - lastBeat > 5 * 60 * 1000) { await heartbeat(); lastBeat = Date.now(); }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

async function cmdTick() {
  try { gh(["--version"]); }
  catch { console.error("gh CLI not available/authenticated; aborting tick."); process.exit(2); }

  const st = await roomApi("GET", `/api/rooms/${ROOM}/merge-queue/status`);
  const active = st.active;
  if (!active) { console.log("queue idle: no active slot."); return; }
  if (active.adoptedBy) { console.log(`slot for PR #${active.pr} already adopted by ${active.adoptedBy}; skipping.`); return; }

  const { pr, headSha, claimId } = active;

  if (!LIVE) {
    // Dry-run is strictly read-only: no adopt, no heartbeat, no release.
    // Verify the PR via reads and print the plan.
    const info = ghJson(["pr", "view", String(pr), "--json", "number,state,headRefOid,headRefName,baseRefName,mergeable,url"]);
    console.log(`dry-run: slot for PR #${pr} ${headSha.slice(0, 7)} (claim ${claimId}) is held; verifying (reads only).`);
    console.log(`  PR state=${info.state} base=${info.baseRefName} head=${info.headRefOid.slice(0, 7)} mergeable=${info.mergeable} url=${info.url}`);
    const gate = await claimGate(claimId, headSha);
    console.log(`  release gate: ${gate.ok ? (gate.authorization ?? `approved by ${gate.approvedBy.join(", ")}`) : `REFUSED: ${gate.reason}`}`);
    if (gate.ok && info.state === "OPEN" && info.headRefOid === headSha && info.baseRefName === BASE) {
      console.log(`dry-run plan for PR #${pr}:`);
      console.log(`  1. adopt the slot, heartbeat the lease`);
      console.log(`  2. rebase ${info.headRefName} onto origin/${BASE}`);
      console.log(`  3. push --force-with-lease to ${info.headRefName}`);
      console.log(`  4. wait for required checks (${REQUIRED_CHECKS.join(", ")}) on the new head`);
      console.log(`  5. gh pr merge --squash`);
      console.log(`  6. release the slot, post DONE to the room`);
    } else {
      console.log("dry-run: PR would be ejected (release gate refused / not open / head moved / wrong base).");
    }
    console.log("dry-run: no writes performed. Re-run with --live to execute.");
    return;
  }

  console.log(`adopting slot: PR #${pr} ${headSha.slice(0, 7)} (claim ${claimId})`);
  const adopted = await roomApi("POST", `/api/rooms/${ROOM}/merge-queue/adopt`, { claimId }).catch(e => {
    throw new Error(`adopt failed (another worker may have taken it): ${e.message}`);
  });
  console.log(`adopted by ${adopted.adoptedBy}`);
  const heartbeat = () => roomApi("POST", `/api/rooms/${ROOM}/merge-queue/heartbeat`, { claimId });

  const failCount = (workerState, id) => (workerState.failures[id] || 0) + 1;
  const workerState = loadWorkerState();
  const noteFailure = async err => {
    const n = failCount(workerState, claimId);
    workerState.failures[claimId] = n;
    saveWorkerState(workerState);
    console.error(`tick error (${n}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
    if (n >= MAX_CONSECUTIVE_FAILURES) {
      workerState.failures[claimId] = 0;
      saveWorkerState(workerState);
      await eject(claimId, `worker failed ${MAX_CONSECUTIVE_FAILURES}x consecutively: ${err.message}`, pr);
    } else {
      await heartbeat().catch(() => {});
      console.error("slot kept (lease heartbeated); will retry next tick.");
    }
    process.exit(1);
  };

  try {
    // --- verify the PR -------------------------------------------------
    const info = ghJson(["pr", "view", String(pr), "--json", "number,state,headRefOid,headRefName,baseRefName,mergeable,url"]);
    if (info.state !== "OPEN") { await eject(claimId, `PR is ${info.state}, not open`, pr); return; }
    if (info.baseRefName !== BASE) { await eject(claimId, `PR targets ${info.baseRefName}, not ${BASE}`, pr); return; }
    if (info.headRefOid !== headSha) {
      await eject(claimId, `head moved after enqueue (enqueued ${headSha.slice(0, 7)}, now ${info.headRefOid.slice(0, 7)}): lane pushed — re-verify and re-enqueue`, pr);
      return;
    }
    const reviews = ghJson(["pr", "view", String(pr), "--json", "reviews", "--jq", "[.reviews[] | .state]"]);
    if (reviews.includes("CHANGES_REQUESTED") && AUTHORIZED_HEAD !== headSha) {
      await eject(claimId, "open CHANGES_REQUESTED review (lander rule: merge only after rev-reviewer APPROVE on the exact head)", pr);
      return;
    }
    if (reviews.includes("CHANGES_REQUESTED")) console.log("Review findings present; exact-head operator authorization confirms they were assessed. Review status alone is advisory.");
    const gate = await claimGate(claimId, headSha);
    if (!gate.ok) { await eject(claimId, gate.reason, pr); return; }
    console.log(`release gate on ${headSha.slice(0, 7)}: ${gate.authorization ?? `approved by ${gate.approvedBy.join(", ")}`}`);
    if (info.mergeable === "CONFLICTING") {
      // CONFLICTING at enqueue-time head vs main: the rebase below resolves
      // it; only unresolvable conflicts eject (caught at rebase).
      console.log("note: PR is conflicting with main — the rebase will resolve or eject.");
    }

    // --- live: rebase ---------------------------------------------------
    ensureWorkerRepo();
    await heartbeat();
    const branch = `mq/work-pr-${pr}`;
    sh("git", ["checkout", "-B", branch, `origin/${info.headRefName}`], { cwd: WORKER_DIR });
    const oldBase = sh("git", ["merge-base", `origin/${info.headRefName}`, `origin/${BASE}`], { cwd: WORKER_DIR });
    try {
      sh("git", ["rebase", `origin/${BASE}`], { cwd: WORKER_DIR });
    } catch {
      try { sh("git", ["rebase", "--abort"], { cwd: WORKER_DIR }); } catch { /* already clean */ }
      await eject(claimId, "rebase onto current main conflicted and could not be resolved automatically", pr);
      return;
    }
    const newHead = sh("git", ["rev-parse", "HEAD"], { cwd: WORKER_DIR });
    const runGit = (args, input) => execFileSync("git", args, { cwd: WORKER_DIR, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
    const same = patchUnchanged(runGit, { oldBase, oldHead: headSha, newBase: `origin/${BASE}`, newHead });
    if (!same.ok) {
      await eject(claimId, `the rebase changed the authorized patch (patch-id ${same.before.slice(0, 12) || "empty"} -> ${same.after.slice(0, 12) || "empty"}): inspect and authorize the changed head before merging`, pr);
      return;
    }
    await heartbeat();
    try {
      sh("git", ["push", "--force-with-lease", "origin", `${branch}:${info.headRefName}`], { cwd: WORKER_DIR });
    } catch {
      await eject(claimId, "push --force-with-lease refused: the branch moved during the rebase (lane pushed?) — re-verify and re-enqueue", pr);
      return;
    }
    console.log(`rebased and pushed: ${headSha.slice(0, 7)} -> ${newHead.slice(0, 7)}`);

    // --- live: wait for checks ------------------------------------------
    await heartbeat();
    const checks = await waitForChecks(pr, newHead, heartbeat);
    if (!checks.ok) { await eject(claimId, checks.reason, pr); return; }
    console.log("required checks green on the rebased head.");

    // --- live: merge ----------------------------------------------------
    await heartbeat();
    sh("gh", ["pr", "merge", String(pr), "--repo", REPO, "--squash", "--match-head-commit", newHead]);
    sh("git", ["fetch", "origin"], { cwd: WORKER_DIR });
    const mainSha = sh("git", ["rev-parse", `origin/${BASE}`], { cwd: WORKER_DIR });
    await roomApi("POST", `/api/rooms/${ROOM}/merge-queue/release`, { claimId });
    workerState.failures[claimId] = 0;
    saveWorkerState(workerState);
    const done = `merge-queue: PR #${pr} rebased onto ${BASE}, checks green, merged as ${mainSha.slice(0, 12)} (claim ${claimId}). Slot released.`;
    console.log(done);
    await postRoom(done);
  } catch (err) {
    await noteFailure(err);
  }
}

const cmd = process.argv[2];
if (cmd === "status") await cmdStatus();
else if (cmd === "tick") await cmdTick();
else if (cmd === "sweep") await cmdSweep();
else {
  console.error("usage: node scripts/merge-queue-worker.mjs <status|tick|sweep> [--room muse-room] [--live]");
  process.exit(2);
}
