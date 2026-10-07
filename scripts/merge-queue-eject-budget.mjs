// merge-queue-eject-budget.mjs — measured flake eject budget for GitHub's
// native merge queue.
//
// GitHub's merge queue is batch-then-eject (NOT batch-then-bisect): when a
// check fails in a merge_group, the failing PR is ejected and the group
// rebuilds. Without a budget, a flaky PR can eject/requeue forever, burning
// 25-75 min of CI per cycle and blocking its whole group each time.
//
// What this does:
//   - On `merge_group` `destroyed` events, classifies the eject. Only
//     explicit check-failure ejects burn budget; lane pushes (design doc
//     MERGE-QUEUE-DESIGN.md §1.3: eject first, push, re-verify, re-enqueue),
//     manual dequeues, dirty-PR ejects, and unknown reasons never count.
//   - Counts failure-ejects per PR in a rolling window (default: 3 ejects /
//     24h) persisted in tests/merge-queue-eject-budget.json (the repo-file
//     ledger, committed back fail-closed like onboarding-probe's results.md).
//   - When a PR trips the budget: posts one FRICTION alert to the room naming
//     the PR (with read-back verification — never silently dropped), appends
//     a quarantine *proposal* to the ledger (auto-proposed, never auto-merged
//     into tests/quarantine.json), and leaves a PR comment for the lane.
//   - On `pull_request` `closed`: drops the PR's ledger entries (loop over).
//
// Budget parameters (reasoning):
//   - max_ejects = 3: eject #1 is signal-neutral (real failure, infra blip);
//     #2 after a fix+requeue shows the failure persists; #3 inside a day is
//     systematic churn. Research lane 2's rule of thumb: >~1 eject-churn/day
//     means shrink groups + quarantine tests — 3/day is unambiguous.
//   - window_hours = 24, rolling (not calendar-day) so a midnight boundary
//     can't reset a churning PR. Old ejects age out; no manual reset needed.
//
// Pure functions are exported for tests/merge-queue-eject-budget.test.js.
// Dependency-free: node builtins only (like scripts/quarantine-check.mjs).
// The workflow (.github/workflows/merge-queue-eject-budget.yml) is inert
// unless the repo variable MERGE_QUEUE_BOT == '1' — same gate as
// merge-queue-receipts.yml.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { resolveConfig } from "./github-door.mjs";

export const LEDGER_VERSION = 1;
// Chosen per the reasoning in the header: 3 failure-ejects in a rolling 24h
// window is systematic churn, not a flake blip.
export const BUDGET_DEFAULTS = Object.freeze({ max_ejects: 3, window_hours: 24 });
const QUARANTINE_MAX_DAYS = 14; // mirrors scripts/quarantine-check.mjs
const HOUR_MS = 3_600_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER = path.join(HERE, "..", "tests", "merge-queue-eject-budget.json");

export function emptyLedger(budget = BUDGET_DEFAULTS) {
  return {
    version: LEDGER_VERSION,
    budget: { max_ejects: budget.max_ejects, window_hours: budget.window_hours },
    ejects: {},            // pr -> [{at, sha, reason, check}]
    over_budget: {},       // pr -> {trip_at, eject_count, alert_message_id}
    quarantine_proposals: [], // proposed entries; a lane merges them into tests/quarantine.json
  };
}

// Classify a merge_group `destroyed` reason. Only "failure" burns budget.
// Reason strings are matched by signal words — GitHub does not publish an
// enum — so anything unrecognized is "unknown" and never counts (fail closed).
export function classifyEject(reason) {
  const r = String(reason ?? "");
  if (/\bhead commit\b.*\b(not the head|changed)\b/i.test(r) || /\bpush(ed)?\b/i.test(r)) return "lane_push";
  if (/\bdequeue\w*\b/i.test(r)) return "manual";
  if (/\bnot mergeable\b|\bdirty\b|\bconflict/i.test(r)) return "dirty";
  if (/((check|status|run)\w*\b.{0,24}\b(fail\w*|error\w*|timed?\s?-?out))|(\b(fail\w*|error\w*|timed?\s?-?out)\b.{0,24}\b(check|status|run)\w*)/i.test(r)) return "failure";
  return "unknown";
}

// Record one eject. Dedupe key is (pr, sha): reprocessing the same
// merge_group event (e.g. a ledger-commit race retry) never double-counts.
export function recordEject(ledger, { pr, at, sha, reason, check = null }) {
  const kind = classifyEject(reason);
  if (kind !== "failure") return { counted: false, kind, duplicate: false };
  const list = (ledger.ejects[pr] ??= []);
  if (list.some((e) => e.sha === sha)) return { counted: false, kind, duplicate: true };
  list.push({ at, sha, reason: String(reason ?? ""), check });
  return { counted: true, kind, duplicate: false };
}

export function ejectsInWindow(list, nowMs, windowMs) {
  return (list ?? []).filter((e) => nowMs - Date.parse(e.at) < windowMs);
}

function windowMsOf(ledger) {
  return (ledger.budget?.window_hours ?? BUDGET_DEFAULTS.window_hours) * HOUR_MS;
}

export function evaluateBudget(ledger, pr, nowMs = Date.now()) {
  const windowMs = windowMsOf(ledger);
  const max = ledger.budget?.max_ejects ?? BUDGET_DEFAULTS.max_ejects;
  const count = ejectsInWindow(ledger.ejects[pr], nowMs, windowMs).length;
  const tripped = count >= max;
  const ob = ledger.over_budget[pr];
  const alreadyAlerted = Boolean(ob) && nowMs - Date.parse(ob.trip_at) < windowMs;
  return { count, tripped, alreadyAlerted, max, windowHours: windowMs / HOUR_MS };
}

export function markAlerted(ledger, pr, nowMs, alertMessageId) {
  const windowMs = windowMsOf(ledger);
  const count = ejectsInWindow(ledger.ejects[pr], nowMs, windowMs).length;
  ledger.over_budget[pr] = {
    trip_at: new Date(nowMs).toISOString(),
    eject_count: count,
    alert_message_id: alertMessageId,
  };
  return ledger.over_budget[pr];
}

// Build a quarantine entry in the exact tests/quarantine.json shape
// (owner/quarantined_at/reason/repair_by/test), with repair_by at the
// 14-day cap so it passes scripts/quarantine-check.mjs. Proposed only —
// the workflow never writes it into quarantine.json itself.
export function proposeQuarantine({ pr, author, failingChecks = [], reason, atISO, ejectCount }) {
  const at = new Date(atISO);
  const quarantined_at = at.toISOString().slice(0, 10);
  const repair_by = new Date(at.getTime() + QUARANTINE_MAX_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const checks = (failingChecks ?? []).filter(Boolean);
  const test = checks.length > 0
    ? `merge queue: check "${checks[0]}" failed on merge_group`
    : `merge queue: PR #${pr} ejected (${ejectCount ?? "repeated"} check-failure ejects)`;
  return {
    test,
    reason:
      `Eject-budget trip for PR #${pr}: "${String(reason ?? "").slice(0, 200)}" — ` +
      `ejected repeatedly from the GitHub merge queue (batch-then-eject). ` +
      `Failing check run(s): ${checks.length > 0 ? checks.join(", ") : "unidentified from the eject reason"}. ` +
      `Auto-proposed by the flake eject-budget workflow; NOT yet quarantined — ` +
      `confirm the flake, then merge this entry into tests/quarantine.json via a PR.`,
    quarantined_at,
    repair_by,
    owner: author || "",
    ticket: "",
  };
}

export function alertCommandId(pr, tripAtISO) {
  const h = createHash("sha256").update(`eject-budget-alert:${pr}:${tripAtISO}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildAlertBody({ pr, count, windowHours, ejects, failingChecks, proposal }) {
  const lines = (ejects ?? []).map(
    (e) => `  - ${e.at} sha ${String(e.sha).slice(0, 7)} — ${String(e.reason).slice(0, 120)}`,
  );
  return [
    `FRICTION merge-queue eject budget tripped: PR #${pr} ejected ${count}x in ${windowHours}h (batch-then-eject churn).`,
    ``,
    `The PR is already out of the queue (GitHub ejects on the failing check). Do NOT silently re-queue it: ` +
      `each cycle burns a full merge_group CI run and rebuilds the group.`,
    ``,
    `Eject history (failure-ejects only; lane pushes / manual dequeues never burn budget):`,
    ...lines,
    ``,
    `Failing check run(s): ${(failingChecks ?? []).filter(Boolean).join(", ") || "unidentified from the eject reason"}.`,
    ``,
    `Quarantine PROPOSAL (auto-proposed, not merged — quarantine owners please review; ` +
      `merge into tests/quarantine.json via PR if the flake is confirmed):`,
    `Proposed test: ${proposal.test}`,
    "```json",
    JSON.stringify(proposal, null, 2),
    "```",
    ``,
    `Next: the lane fixes the flake (or the test), re-verifies at head, then re-queues. ` +
      `The budget window rolls on its own — no manual reset needed.`,
  ].join("\n");
}

// A merged/closed PR's loop is over: drop its counters and trip record.
export function pruneOnClose(ledger, pr) {
  delete ledger.ejects[pr];
  delete ledger.over_budget[pr];
}

// Keep the ledger small: drop ejects far outside 2x the window. Proposals
// are human-actionable and stay until a lane handles them.
export function pruneAged(ledger, nowMs = Date.now()) {
  const keepMs = 2 * windowMsOf(ledger);
  for (const pr of Object.keys(ledger.ejects)) {
    const kept = ejectsInWindow(ledger.ejects[pr], nowMs, keepMs);
    if (kept.length === 0) delete ledger.ejects[pr];
    else ledger.ejects[pr] = kept;
  }
}

// Merge two ledgers from concurrent workflow runs (rebase-conflict resolver).
// Ejects union by (pr, sha) — the same eject counted in both runs lands once.
// over_budget keeps the later trip per PR. Proposals concat, deduped.
export function mergeLedgers(a, b) {
  const out = emptyLedger(a?.budget ?? BUDGET_DEFAULTS);
  for (const src of [a, b]) {
    for (const [pr, list] of Object.entries(src?.ejects ?? {})) {
      const dest = (out.ejects[pr] ??= []);
      for (const e of list ?? []) {
        if (!dest.some((d) => d.sha === e.sha)) dest.push({ ...e });
      }
    }
    for (const [pr, ob] of Object.entries(src?.over_budget ?? {})) {
      const cur = out.over_budget[pr];
      if (!cur || Date.parse(ob.trip_at) > Date.parse(cur.trip_at)) {
        out.over_budget[pr] = { ...ob };
      }
    }
    for (const p of src?.quarantine_proposals ?? []) {
      if (!out.quarantine_proposals.some((q) => q.pr === p.pr && q.proposed_at === p.proposed_at)) {
        out.quarantine_proposals.push({ ...p });
      }
    }
  }
  for (const pr of Object.keys(out.ejects)) {
    out.ejects[pr].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  }
  return out;
}

function prsFromHeadRef(headRef) {
  return [...new Set([...String(headRef ?? "").matchAll(/pr-(\d+)/g)].map((m) => m[1]))];
}

// Best-effort: failing check-run names on the merge_group head SHA, via gh.
// Returns [] when gh is unavailable (sandbox, no auth) — the proposal then
// says "unidentified" rather than guessing.
function failingCheckRuns(repo, headSha) {
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repo}/commits/${headSha}/check-runs`, "--jq",
        "[.check_runs[] | select(.conclusion == \"failure\" or .conclusion == \"timed_out\" or .conclusion == \"cancelled\") | .name]"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const names = JSON.parse(out || "[]");
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

async function verifyPosted({ origin, roomId, token }, messageId, afterSeqGuess = 0) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `${origin}/api/rooms/${encodeURIComponent(roomId)}/events?after=${afterSeqGuess}&limit=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) break;
      const data = await res.json();
      const found = (data.events ?? []).some(
        (w) => w?.event?.data?.messageId === messageId,
      );
      if (found) return true;
      const last = data.events?.at(-1)?.sequence;
      if (last != null) afterSeqGuess = last;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function loadLedger(ledgerPath) {
  try {
    const data = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (data && typeof data === "object" && data.version === LEDGER_VERSION) return data;
  } catch { /* missing or corrupt: start fresh */ }
  return emptyLedger();
}

export async function main(env = process.env) {
  const ledgerPath = env.EJECT_BUDGET_LEDGER ?? DEFAULT_LEDGER;
  const ledger = loadLedger(ledgerPath);
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const repo = env.GITHUB_REPOSITORY ?? "Uuriko/project-room";
  const nowMs = Date.now();
  const result = { ok: true, action: "none" };

  if (event?.merge_group && event.action === "destroyed") {
    const group = event.merge_group;
    const prs = prsFromHeadRef(group.head_ref);
    const reason = event.reason ?? "";
    result.action = "eject_recorded";
    result.prs = prs;
    result.kind = classifyEject(reason);
    for (const pr of prs) {
      const rec = recordEject(ledger, {
        pr, at: new Date(nowMs).toISOString(), sha: group.head_sha, reason,
      });
      if (!rec.counted) continue;
      const v = evaluateBudget(ledger, pr, nowMs);
      result.eject_count = v.count;
      if (!v.tripped || v.alreadyAlerted) continue;
      // --- budget trip: alert the room, propose quarantine, leave a PR comment
      const failingChecks = failingCheckRuns(repo, group.head_sha);
      const proposal = proposeQuarantine({
        pr, author: event?.pull_request?.user?.login ?? "", failingChecks,
        reason, atISO: new Date(nowMs).toISOString(), ejectCount: v.count,
      });
      ledger.quarantine_proposals.push({ ...proposal, pr, proposed_at: new Date(nowMs).toISOString() });
      const tripAt = new Date(nowMs).toISOString();
      const messageId = alertCommandId(pr, tripAt);
      const body = buildAlertBody({
        pr, count: v.count, windowHours: v.windowHours,
        ejects: ejectsInWindow(ledger.ejects[pr], nowMs, windowMsOf(ledger)),
        failingChecks, proposal,
      });
      const config = await resolveConfig(env, { needIssue: false });
      let posted = false, verified = false;
      if (!config.skipped) {
        const client = new RoomAgentClient({
          origin: config.origin, roomId: config.roomId, token: config.doorKey,
          ...(config.memberId ? { memberId: config.memberId } : {}),
        });
        try {
          await client.command({ id: messageId, type: "message.posted", data: { messageId, body } });
          posted = true;
          verified = await verifyPosted(
            { origin: config.origin, roomId: config.roomId, token: config.doorKey }, messageId,
          );
        } catch (err) {
          result.alert_error = String(err?.message ?? err).slice(0, 200);
        }
      } else {
        result.alert_error = config.skipped;
      }
      markAlerted(ledger, pr, nowMs, messageId);
      result.action = "over_budget";
      result.over_budget_pr = pr;
      result.alert_posted = posted;
      result.alert_verified = verified;
      writeFileSync(
        `eject-budget-comment-${pr}.md`,
        `## Merge-queue eject budget tripped\n\n` +
        `This PR was ejected from the merge queue **${v.count} times in ${v.windowHours}h** on failing checks ` +
        `(batch-then-eject churn). It is out of the queue now — please do not re-queue until the underlying ` +
        `flake/failure is fixed and re-verified at head; each cycle burns a full merge_group CI run.\n\n` +
        `Failing check run(s): ${(failingChecks ?? []).filter(Boolean).join(", ") || "unidentified from the eject reason"}.\n\n` +
        `A quarantine entry has been **proposed** (not merged) for the failing test — see the room FRICTION alert. ` +
        `Quarantine owners: confirm the flake and merge the proposal into \`tests/quarantine.json\` via PR if warranted.\n\n` +
        `The budget window rolls on its own; no manual reset is needed.\n`,
      );
      if (env.GITHUB_OUTPUT) {
        appendFileSync(env.GITHUB_OUTPUT, `over_budget_pr=${pr}\n`);
        appendFileSync(env.GITHUB_OUTPUT, `alert_posted=${posted}\n`);
        appendFileSync(env.GITHUB_OUTPUT, `alert_verified=${verified}\n`);
      }
    }
  } else if (event?.pull_request && event.action === "closed") {
    const pr = String(event.pull_request.number);
    pruneOnClose(ledger, pr);
    result.action = "pruned_closed";
    result.prs = [pr];
  } else {
    result.action = "ignored";
  }

  pruneAged(ledger, nowMs);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  console.log(JSON.stringify(result));
  return result;
}

const isMain = (() => {
  try { return pathToFileURL(process.argv[1] ?? "").href === import.meta.url; }
  catch { return false; }
})();
if (isMain) {
  // Ledger union tool for the workflow's rebase-conflict path:
  //   node scripts/merge-queue-eject-budget.mjs --merge-ledgers <a.json> <b.json> <out.json>
  if (process.argv[2] === "--merge-ledgers") {
    const merged = mergeLedgers(
      JSON.parse(readFileSync(process.argv[3], "utf8")),
      JSON.parse(readFileSync(process.argv[4], "utf8")),
    );
    writeFileSync(process.argv[5], JSON.stringify(merged, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, merged: true }));
  } else {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
