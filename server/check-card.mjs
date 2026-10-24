// PR and CI check cards for the feed. Turns a pull request plus its check
// runs into one compact card the conversation can show inline, e.g.
//   #4316 Keep the secret off the keychain command line
//   Checks: 42 of 42 pass   mergeable
// Neutral and skipped runs are not counted, matching land-queue rollupChecks.
// Pure module: no I/O, no emoji.
const IGNORED = new Set(["neutral", "skipped"]);
const RED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

export function summarizeChecks(checkRuns = []) {
  const runs = (Array.isArray(checkRuns) ? checkRuns : []).filter(r => r && !IGNORED.has(r.conclusion));
  const failed = runs.filter(r => RED.has(r.conclusion)).map(r => String(r.name ?? "unnamed")).sort();
  const passed = runs.filter(r => r.conclusion === "success").length;
  const pending = runs.length - passed - failed.length;
  const state = failed.length ? "red" : pending || runs.length === 0 ? "pending" : "green";
  let line = runs.length === 0 ? "Checks: none reported" : `Checks: ${passed} of ${runs.length} pass`;
  if (failed.length) line += `, ${failed.length} failing (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", ..." : ""})`;
  if (pending) line += `, ${pending} running`;
  return Object.freeze({ total: runs.length, passed, pending, failed: Object.freeze(failed), state, line });
}

export function checkCard(pr, checkRuns = []) {
  if (!pr || !Number.isInteger(pr.number)) throw new TypeError("pr.number must be an integer");
  const checks = summarizeChecks(checkRuns);
  const status = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft"
    : pr.mergeable === false ? "conflict" : "open";
  const title = String(pr.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const head = typeof pr.headSha === "string" ? pr.headSha.slice(0, 8) : null;
  return Object.freeze({
    kind: "pr_check_card", number: pr.number, title, url: pr.url ?? null, head, status, checks,
    text: `#${pr.number} ${title}\n${checks.line}   ${status}${head ? `   head ${head}` : ""}`,
  });
}
