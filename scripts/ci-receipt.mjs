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
import { gradeJobs, jobIdOfName, loadManifest, worstConclusion } from "./ci-verdict.mjs";

const JOB_NAME = /^[\w .()/:+-]{1,60}$/;

export function receiptId(repo, prNumber, headSha, verdict) {
  const h = createHash("sha256").update(`ci-receipt:${repo}:${prNumber}:${headSha}:${verdict}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// jobs: [{ name, conclusion }] from the run. Returns null when nothing should be posted.
// The verdict is the manifest-bound grade from ci-verdict.mjs — the same
// grading the ci-verdict workflow job reports — never the run's own
// conclusion: a skipped required or substantive job is NOT-RUN and fails the
// verdict even when GitHub rolls the run up as success.
export function verdictOf(run, jobs, manifest) {
  if (run?.event !== "pull_request") return null;
  if (!["success", "failure", "timed_out"].includes(run.conclusion)) return null;
  if (!manifest) throw new Error("ci-receipt: verdict requires the ci-substantive manifest");
  const results = {};
  for (const job of jobs ?? []) {
    const jobId = jobIdOfName(job.name);
    results[jobId] = worstConclusion(results[jobId], job.conclusion ?? null);
  }
  const grade = gradeJobs(manifest, results);
  const gating = grade.table.filter(row => row.required || row.substantive);
  const ran = gating.filter(row => row.verdict === "PASSED" || row.verdict === "FAILED");
  // `changes` runs first and gates every suite; with nothing else run the green
  // check is not a test result (see ci-verdict), so say nothing.
  if (run.conclusion === "success" && !ran.some(row => row.job_id !== "changes")) return null;
  const failed = [...grade.failed, ...grade.notRun, ...grade.unmanifested].filter(name => JOB_NAME.test(name));
  return { verdict: grade.verdict, failed, ran: ran.length, total: gating.length };
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
  // The manifest ships in this checkout (default branch; workflow_run never
  // checks out pull-request code). A missing or malformed manifest fails
  // loud here rather than posting a verdict graded by a weaker standard.
  const result = verdictOf(run, jobs, loadManifest());
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
