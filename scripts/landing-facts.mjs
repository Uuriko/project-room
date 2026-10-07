// One read for the landing path. Prints four identities and does not post,
// claim, merge, or deploy. A chat line is not one of these facts.
import { spawnSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;

export function defaultExec(args, input) {
  const result = spawnSync("git", args, { input, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function textOf(execImpl, args, input) {
  const result = execImpl(args, input);
  if (result.status !== 0) {
    const error = new Error("git_failed");
    error.code = "git_failed";
    throw error;
  }
  return String(result.stdout).trim();
}

function patchIdOf(execImpl, base, head) {
  const diff = execImpl(["diff", `${base}...${head}`]);
  if (diff.status !== 0) return null;
  if (!String(diff.stdout)) return "empty";
  const id = execImpl(["patch-id", "--stable"], diff.stdout);
  if (id.status !== 0) return null;
  return String(id.stdout).trim().split(/\s+/)[0] || null;
}

function reviewBind(pr, localHead, localPatchId, execImpl, mainSha) {
  const author = pr.author?.login ?? null;
  const latest = new Map();
  for (const review of pr.reviews ?? []) {
    const login = review.author?.login;
    if (!login || !review.state) continue;
    latest.set(login, review);
  }
  const changesRequested = [];
  const nonAuthorApprovals = [];
  const approvalPatchIds = [];
  for (const [login, review] of latest) {
    if (review.state === "CHANGES_REQUESTED") changesRequested.push(login);
    if (review.state === "APPROVED" && login !== author) {
      nonAuthorApprovals.push(login);
      if (review.commit_id && SHA.test(review.commit_id) && SHA.test(mainSha)) {
        approvalPatchIds.push({
          login,
          commit: review.commit_id,
          patchId: patchIdOf(execImpl, mainSha, review.commit_id),
        });
      }
    }
  }
  const carried = localPatchId && localPatchId !== "empty"
    ? approvalPatchIds.filter(row => row.patchId && row.patchId === localPatchId).map(row => row.login)
    : [];
  return {
    number: pr.number ?? null,
    head: pr.headRefOid ?? null,
    headMatchesLocal: pr.headRefOid === localHead,
    reviewDecision: pr.reviewDecision ?? null,
    changesRequested,
    nonAuthorApprovals,
    approvalPatchMatches: carried,
    ready: pr.headRefOid === localHead && changesRequested.length === 0 && (nonAuthorApprovals.length > 0) && (carried.length > 0 || approvalPatchIds.length === 0 && nonAuthorApprovals.length > 0),
  };
}

export async function landingFacts({
  fetchImpl = fetch,
  execImpl = defaultExec,
  origin = "https://room.trydemigod.com",
  pr = null,
  ghImpl = null,
} = {}) {
  const localHead = textOf(execImpl, ["rev-parse", "HEAD"]);
  const mainSha = textOf(execImpl, ["rev-parse", "origin/main"]);
  if (!SHA.test(localHead) || !SHA.test(mainSha)) {
    const error = new Error("git_failed");
    error.code = "git_failed";
    throw error;
  }
  const behind = Number(textOf(execImpl, ["rev-list", "--count", `${localHead}..${mainSha}`]));
  const ahead = Number(textOf(execImpl, ["rev-list", "--count", `${mainSha}..${localHead}`]));
  let production = null;
  let versionError = null;
  try {
    const response = await fetchImpl(new URL("/api/version", origin));
    if (!response.ok) versionError = "version_unreadable";
    else {
      const body = await response.json();
      production = {
        sourceRevision: typeof body.sourceRevision === "string" ? body.sourceRevision : null,
        buildId: typeof body.buildId === "string" ? body.buildId : null,
        deployment: typeof body.deployment === "string" ? body.deployment : null,
      };
    }
  } catch {
    versionError = "version_unreadable";
  }
  let productionIsAncestor = null;
  if (production?.sourceRevision && SHA.test(production.sourceRevision)) {
    productionIsAncestor = execImpl(["merge-base", "--is-ancestor", production.sourceRevision, mainSha]).status === 0;
  }
  const patchId = patchIdOf(execImpl, mainSha, localHead);
  const facts = {
    ok: true,
    localHead,
    mainSha,
    behind,
    ahead,
    sameTip: localHead === mainSha,
    production,
    productionIsAncestor,
    mainDeployed: production?.sourceRevision === mainSha,
    versionError,
    patchId,
  };
  if (pr != null) {
    if (!ghImpl) facts.pullRequest = { unavailable: true };
    else facts.pullRequest = reviewBind(await ghImpl(pr), localHead, patchId, execImpl, mainSha);
  }
  if (JSON.stringify(facts).includes("pri_")) {
    const error = new Error("secret_in_plan");
    error.code = "secret_in_plan";
    throw error;
  }
  return facts;
}

function argPr(argv) {
  const args = argv.slice(2);
  if (args[0] !== "facts" && args.length !== 0 && args[0] !== "--pr") return null;
  const rest = args[0] === "facts" ? args.slice(1) : args;
  if (rest.length === 0) return { pr: null };
  if (rest[0] === "--pr" && /^[0-9]+$/.test(rest[1] ?? "") && rest.length === 2) return { pr: Number(rest[1]) };
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = argPr(process.argv);
  if (!parsed) {
    console.error("Usage: node scripts/landing-facts.mjs [facts] [--pr N]");
    process.exitCode = 2;
  } else {
    landingFacts({ pr: parsed.pr, ghImpl: parsed.pr == null ? null : async (number) => {
      const result = spawnSync("gh", ["pr", "view", String(number), "--json", "number,headRefOid,reviewDecision,author,reviews"], { encoding: "utf8" });
      if (result.status !== 0) {
        const error = new Error("gh_failed");
        error.code = "gh_failed";
        throw error;
      }
      return JSON.parse(result.stdout);
    } }).then(facts => console.log(JSON.stringify(facts))).catch(error => {
      console.error(error.code || "facts_failed");
      process.exitCode = 1;
    });
  }
}
