// CI receipt: when the `test` workflow finishes on a pull request head, post
// one compact system line to the release room so agents stop pasting the
// verdict, SHA and run link by hand. Run from the ci-receipt workflow
// (workflow_run, default-branch code only; nothing from the pull request is
// checked out or executed).
//
//   CI #6162 f5e8e226 PASSED 13/13 jobs · https://github.com/.../actions/runs/1
//   CI #6162 f5e8e226 FAILED unit, browser-shards (2 of 13 jobs) · <run url>
//
// Quiet by design: nothing is posted for a cancelled or superseded run, a run
// where every suite was skipped (no ready-to-land label), a push or schedule
// run, or a verdict already posted for that head. One deterministic command id
// per repo, PR, head and verdict makes a rerun of the same result a no-op.
// Pull request text is never copied into the post (a fork controls it): only
// the number, the head SHA, job names from the workflow itself and the run URL.
// When the PR body carries `Room-Work: <id>` the post is attached to that work
// item. The token is read from ROOM_RECEIPT_TOKEN and is never printed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseRoomWork } from "./github-work-sync.mjs";

const OK = new Set(["success", "skipped", "neutral"]);
const JOB_NAME = /^[\w .()/:+-]{1,60}$/;

export function receiptId(repo, prNumber, headSha, verdict) {
  const h = createHash("sha256").update(`ci-receipt:${repo}:${prNumber}:${headSha}:${verdict}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// jobs: [{ name, conclusion }] from the run. Returns null when nothing should be posted.
export function verdictOf(run, jobs) {
  if (run?.event !== "pull_request") return null;
  if (!["success", "failure", "timed_out"].includes(run.conclusion)) return null;
  const real = (jobs ?? []).filter(job => !/^ci-verdict/.test(job.name));
  const ran = real.filter(job => job.conclusion !== "skipped");
  // `changes` runs first and gates every suite; with nothing else run the green
  // check is not a test result (see ci-verdict), so say nothing.
  if (run.conclusion === "success" && !ran.some(job => job.name !== "changes")) return null;
  const failed = real.filter(job => !OK.has(job.conclusion) && job.conclusion !== "cancelled" && job.conclusion != null)
    .map(job => job.name).filter(name => JOB_NAME.test(name));
  const failedAny = run.conclusion !== "success";
  return { verdict: failedAny ? "FAILED" : "PASSED", failed, ran: ran.length, total: real.length };
}

export function receiptBody({ prNumber, headSha, result, runUrl }) {
  const head = String(headSha).slice(0, 8);
  const detail = result.verdict === "PASSED"
    ? `${result.ran}/${result.total} jobs`
    : `${result.failed.length ? result.failed.slice(0, 6).join(", ") : "see run"} (${result.failed.length || "?"} of ${result.total} jobs)`;
  return `CI #${prNumber} ${head} ${result.verdict} ${detail} · ${runUrl}`;
}

async function gh(path, { token, fetchImpl }) {
  const response = await fetchImpl(`https://api.github.com${path}`, { redirect: "error", headers: {
    accept: "application/vnd.github+json", "user-agent": "project-room-ci-receipt", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path.split("?")[0]}`);
  return response.json();
}

// Posts the receipt. Returns { posted, duplicate?, skipped? }.
export async function runCiReceipt({ event, repo, env = process.env, fetchImpl = globalThis.fetch }) {
  const run = event?.workflow_run;
  if (!run || run.name !== "test") return { skipped: "not the test workflow" };
  if (run.event !== "pull_request") return { skipped: `ignored ${run.event} run` };
  const token = env.GITHUB_TOKEN;
  const jobs = (await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`, { token, fetchImpl })).jobs
    .map(job => ({ name: String(job.name), conclusion: job.conclusion }));
  const result = verdictOf(run, jobs);
  if (!result) return { skipped: `no verdict worth posting (${run.conclusion})` };
  // Resolve the pull request from the head commit; workflow_run.pull_requests is empty for forks.
  const pulls = (await gh(`/repos/${repo}/commits/${run.head_sha}/pulls?per_page=5`, { token, fetchImpl })).filter(pull => pull.state === "open");
  const pull = pulls.find(candidate => candidate.head?.sha === run.head_sha) ?? null;
  if (!pull) return { skipped: "no open pull request at this head" };
  const roomOrigin = env.PROD_ORIGIN || "https://room.trydemigod.com", roomId = env.RECEIPT_ROOM || "room-fafdae79cf8c";
  const receiptToken = env.ROOM_RECEIPT_TOKEN;
  if (!receiptToken) return { skipped: "ROOM_RECEIPT_TOKEN not set" };
  const id = receiptId(repo, pull.number, run.head_sha, result.verdict);
  const body = receiptBody({ prNumber: pull.number, headSha: run.head_sha, result, runUrl: run.html_url });
  const workItemId = parseRoomWork(pull.body).find(ref => !ref.roomId || ref.roomId === roomId)?.workItemId;
  const post = async data => fetchImpl(`${roomOrigin}/api/rooms/${roomId}/commands`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${receiptToken}`, "content-type": "application/json", origin: roomOrigin,
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-ci-receipt" },
    body: JSON.stringify({ id, type: "message.posted", data: { messageId: id, body, ...data } }) });
  let response = await post(workItemId ? { workItemId } : {});
  let attached = Boolean(workItemId);
  // A work item that is closed or unknown must not lose the receipt: repost unattached.
  if (!response.ok && workItemId && response.status >= 400 && response.status < 500) { attached = false; response = await post({}); }
  if (!response.ok) throw new Error(`room receipt failed: HTTP ${response.status}`);
  const receipt = await response.json().catch(() => null);
  return { posted: true, duplicate: Boolean(receipt?.duplicate), attached, body };
}

export async function main(env = process.env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  console.log(JSON.stringify({ ok: true, ...(await runCiReceipt({ event, repo: env.GITHUB_REPOSITORY, env })) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
