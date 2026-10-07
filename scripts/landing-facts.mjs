// One read for the landing path. Prints four identities and, when
// ROOM_AGENT_CONFIG is set, lease holder and expiry for touched paths.
// Does not post, claim, merge, deploy, or release a lease. A chat line is not one of these facts.
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

export function reviewCommitId(review) {
  if (typeof review?.commit_id === "string" && SHA.test(review.commit_id)) return review.commit_id;
  if (typeof review?.commit?.oid === "string" && SHA.test(review.commit.oid)) return review.commit.oid;
  return null;
}

export function attachRestCommitIds(pr, restRows) {
  const rows = (Array.isArray(restRows) ? restRows : []).filter(row => row && row.user?.login && row.state);
  const reviews = Array.isArray(pr?.reviews) ? pr.reviews.map(review => ({ ...review })) : [];
  const unused = rows.slice();
  for (const review of reviews) {
    if (reviewCommitId(review)) continue;
    const index = unused.findIndex(row => row.user.login === review.author?.login && row.state === review.state);
    if (index < 0) continue;
    review.commit_id = unused[index].commit_id ?? null;
    unused.splice(index, 1);
  }
  if (reviews.length === 0) {
    return {
      ...pr,
      reviews: rows.map(row => ({
        author: { login: row.user.login },
        state: row.state,
        commit_id: row.commit_id ?? null,
      })),
    };
  }
  return { ...pr, reviews };
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
      const commit = reviewCommitId(review);
      if (commit && SHA.test(mainSha)) {
        approvalPatchIds.push({
          login,
          commit,
          patchId: patchIdOf(execImpl, mainSha, commit),
        });
      }
    }
  }
  const carried = localPatchId && localPatchId !== "empty"
    ? approvalPatchIds.filter(row => row.patchId && row.patchId === localPatchId).map(row => row.login)
    : [];
  const differed = approvalPatchIds.filter(row => row.patchId && row.patchId !== localPatchId).map(row => row.login);
  const missingProof = nonAuthorApprovals.filter(login => !approvalPatchIds.some(row => row.login === login && row.patchId));
  let status = "no_non_author_approval";
  if (pr.headRefOid !== localHead) status = "head_mismatch";
  else if (changesRequested.length > 0) status = "changes_requested";
  else if (nonAuthorApprovals.length === 0) status = "no_non_author_approval";
  else if (missingProof.length > 0) status = "unverifiable";
  else if (differed.length > 0) status = "patch_id_differs";
  else if (carried.length === nonAuthorApprovals.length) status = "patch_id_matches";
  else status = "unverifiable";
  return {
    number: pr.number ?? null,
    head: pr.headRefOid ?? null,
    headMatchesLocal: pr.headRefOid === localHead,
    reviewDecision: pr.reviewDecision ?? null,
    changesRequested,
    nonAuthorApprovals,
    approvalPatchMatches: carried,
    status,
    notMergeAuthorization: true,
  };
}

const LIVE_LEASE = new Set(["claimed", "in_progress", "blocked"]);

function claimFiles(row) {
  if (!Array.isArray(row?.files)) return [];
  return row.files.map(file => typeof file === "string" ? file : file?.path).filter(path => typeof path === "string" && path.length > 0);
}

export function pathLeases(claims, paths, nowMs = Date.now()) {
  if (!claims || claims.truncated === true || !Array.isArray(claims.claims)) {
    return { unavailable: "claims_truncated", paths: [] };
  }
  const wanted = [...new Set(paths.filter(path => typeof path === "string" && path.length > 0))].sort();
  return {
    unavailable: false,
    paths: wanted.map(path => ({
      path,
      holders: claims.claims.filter(row => LIVE_LEASE.has(row?.state) && claimFiles(row).includes(path)).map(row => ({
        claimId: typeof row.id === "string" ? row.id : null,
        owner: typeof row.owner === "string" ? row.owner : null,
        leaseExpiresAt: typeof row.leaseExpiresAt === "string" ? row.leaseExpiresAt : null,
        expired: typeof row.leaseExpiresAt === "string" && Number.isFinite(Date.parse(row.leaseExpiresAt))
          ? Date.parse(row.leaseExpiresAt) <= nowMs
          : null,
      })),
    })),
  };
}

export async function landingFacts({
  fetchImpl = fetch,
  execImpl = defaultExec,
  origin = "https://room.trydemigod.com",
  pr = null,
  ghImpl = null,
  claimsImpl = null,
  nowMs = Date.now(),
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
    notMergeAuthorization: true,
  };
  if (pr != null) {
    if (!ghImpl) facts.pullRequest = { unavailable: true };
    else facts.pullRequest = reviewBind(await ghImpl(pr), localHead, patchId, execImpl, mainSha);
  }
  if (claimsImpl) {
    const names = textOf(execImpl, ["diff", "--name-only", `${mainSha}...${localHead}`]).split("\n").filter(Boolean);
    facts.touchedPaths = names;
    try {
      facts.pathLeases = pathLeases(await claimsImpl(), names, nowMs);
    } catch {
      facts.pathLeases = { unavailable: "claims_unreadable", paths: [] };
    }
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

async function roomClaims() {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const raw = JSON.parse(readFileSync(join(process.env.ROOM_AGENT_CONFIG, "connection.json"), "utf8"));
  if (typeof raw.token !== "string" || typeof raw.origin !== "string" || typeof raw.roomId !== "string") {
    const error = new Error("claims_unreadable");
    error.code = "claims_unreadable";
    throw error;
  }
  const claims = [];
  let cursor = "";
  for (let page = 0; page < 4; page++) {
    const url = new URL(`/api/rooms/${encodeURIComponent(raw.roomId)}/work-claims`, raw.origin);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${raw.token}` } });
    if (!response.ok) {
      const error = new Error("claims_unreadable");
      error.code = "claims_unreadable";
      throw error;
    }
    const body = await response.json();
    if (!Array.isArray(body.claims)) {
      const error = new Error("claims_unreadable");
      error.code = "claims_unreadable";
      throw error;
    }
    claims.push(...body.claims);
    if (!body.hasMore) return { claims, truncated: false };
    if (page === 3 || typeof body.nextCursor !== "string" || !body.nextCursor) return { claims, truncated: true };
    cursor = body.nextCursor;
  }
  return { claims, truncated: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = argPr(process.argv);
  if (!parsed) {
    console.error("Usage: node scripts/landing-facts.mjs [facts] [--pr N]");
    process.exitCode = 2;
  } else {
    landingFacts({
      pr: parsed.pr,
      claimsImpl: process.env.ROOM_AGENT_CONFIG ? roomClaims : null,
      ghImpl: parsed.pr == null ? null : async (number) => {
        const result = spawnSync("gh", ["pr", "view", String(number), "--json", "number,headRefOid,reviewDecision,author,reviews"], { encoding: "utf8" });
        if (result.status !== 0) {
          const error = new Error("gh_failed");
          error.code = "gh_failed";
          throw error;
        }
        const pr = JSON.parse(result.stdout);
        const rest = spawnSync("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`], { encoding: "utf8" });
        if (rest.status !== 0) return pr;
        return attachRestCommitIds(pr, JSON.parse(rest.stdout));
      },
    }).then(facts => console.log(JSON.stringify(facts))).catch(error => {
      console.error(error.code || "facts_failed");
      process.exitCode = 1;
    });
  }
}
