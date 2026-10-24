import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachRestCommitIds, checkSummary, landingFacts, mergeSlot, pathLeases } from "../scripts/landing-facts.mjs";

const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const PROD = "c".repeat(40);
const REVIEWED = "d".repeat(40);

function execOf(map) {
  return (args, input) => {
    const key = args.join(" ");
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff --git a/x b/x\n", stderr: "" };
    if (key.startsWith("patch-id")) {
      const commit = input?.includes("reviewed") ? REVIEWED : HEAD;
      return { status: 0, stdout: `${commit} extra\n`, stderr: "" };
    }
    if (key in map) return map[key];
    return { status: 1, stdout: "", stderr: key };
  };
}

test("facts name main, production, head, and patch-id without a secret", async () => {
  const execImpl = execOf({
    "rev-parse HEAD": { status: 0, stdout: `${HEAD}\n`, stderr: "" },
    "rev-parse origin/main": { status: 0, stdout: `${MAIN}\n`, stderr: "" },
    [`rev-list --count ${HEAD}..${MAIN}`]: { status: 0, stdout: "4\n", stderr: "" },
    [`rev-list --count ${MAIN}..${HEAD}`]: { status: 0, stdout: "1\n", stderr: "" },
    [`merge-base --is-ancestor ${PROD} ${MAIN}`]: { status: 0, stdout: "", stderr: "" },
  });
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ sourceRevision: PROD, buildId: "2026-10-07T01:56:37.668Z", deployment: "production" }),
  });
  const facts = await landingFacts({ fetchImpl, execImpl, origin: "https://room.example" });
  assert.equal(facts.localHead, HEAD);
  assert.equal(facts.mainSha, MAIN);
  assert.equal(facts.behind, 4);
  assert.equal(facts.production.sourceRevision, PROD);
  assert.equal(facts.mainDeployed, false);
  assert.equal(facts.productionIsAncestor, true);
  assert.equal(facts.patchId, HEAD);
  assert.equal(JSON.stringify(facts).includes("pri_"), false);
});

test("a non-author approval carries only when its patch-id matches", async () => {
  const execImpl = (args, input) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    if (key.startsWith("diff ") && key.endsWith(HEAD)) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("diff ") && key.endsWith(REVIEWED)) return { status: 0, stdout: "diff reviewed\n", stderr: "" };
    if (key.startsWith("patch-id")) {
      const id = String(input).includes("reviewed") ? "samepatch" : "samepatch";
      return { status: 0, stdout: `${id} x\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: MAIN, buildId: "t", deployment: "production" }) });
  const ghImpl = async () => ({
    number: 1632,
    headRefOid: HEAD,
    reviewDecision: "APPROVED",
    author: { login: "author" },
    reviews: [
      { author: { login: "author" }, state: "APPROVED", commit_id: HEAD },
      { author: { login: "Instinct-3" }, state: "APPROVED", commit_id: REVIEWED },
    ],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, pr: 1632, ghImpl });
  assert.deepEqual(facts.pullRequest.nonAuthorApprovals, ["Instinct-3"]);
  assert.deepEqual(facts.pullRequest.approvalPatchMatches, ["Instinct-3"]);
  assert.equal(facts.pullRequest.status, "patch_id_matches");
  assert.equal(facts.pullRequest.notMergeAuthorization, true);
  assert.equal("ready" in facts.pullRequest, false);
  assert.equal(facts.mainDeployed, true);
});

test("a non-author approval does not carry across a different patch-id", async () => {
  const execImpl = (args, input) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "1\n", stderr: "" };
    if (key.startsWith("diff ") && key.endsWith(REVIEWED)) return { status: 0, stdout: "diff reviewed\n", stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) {
      return { status: 0, stdout: `${String(input).includes("reviewed") ? "oldpatch" : "newpatch"} x\n`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const ghImpl = async () => ({
    number: 1708,
    headRefOid: HEAD,
    author: { login: "grok" },
    reviews: [{ author: { login: "Instinct-3" }, state: "APPROVED", commit_id: REVIEWED }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, pr: 1708, ghImpl });
  assert.deepEqual(facts.pullRequest.approvalPatchMatches, []);
  assert.equal(facts.pullRequest.status, "patch_id_differs");
  assert.equal(facts.notMergeAuthorization, true);
});

test("changes requested keeps the pull request not ready", async () => {
  const execImpl = execOf({
    "rev-parse HEAD": { status: 0, stdout: `${HEAD}\n`, stderr: "" },
    "rev-parse origin/main": { status: 0, stdout: `${MAIN}\n`, stderr: "" },
    [`rev-list --count ${HEAD}..${MAIN}`]: { status: 0, stdout: "0\n", stderr: "" },
    [`rev-list --count ${MAIN}..${HEAD}`]: { status: 0, stdout: "2\n", stderr: "" },
  });
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const ghImpl = async () => ({
    number: 1708,
    headRefOid: HEAD,
    author: { login: "grok" },
    reviews: [{ author: { login: "Instinct-3" }, state: "CHANGES_REQUESTED", commit_id: HEAD }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, pr: 1708, ghImpl });
  assert.equal(facts.versionError, "version_unreadable");
  assert.deepEqual(facts.pullRequest.changesRequested, ["Instinct-3"]);
  assert.equal(facts.pullRequest.status, "changes_requested");
  assert.equal(facts.pullRequest.notMergeAuthorization, true);
});

test("a GraphQL review commit oid is the same proof as commit_id", async () => {
  const execImpl = (args, input) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    if (key.startsWith("diff ") && key.endsWith(REVIEWED)) return { status: 0, stdout: "diff reviewed\n", stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) return { status: 0, stdout: "samepatch x\n", stderr: "" };
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const ghImpl = async () => ({
    number: 1734,
    headRefOid: HEAD,
    author: { login: "grok" },
    reviews: [{ author: { login: "Instinct-3" }, state: "APPROVED", commit: { oid: REVIEWED } }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, pr: 1734, ghImpl });
  assert.equal(facts.pullRequest.status, "patch_id_matches");
  assert.equal(facts.pullRequest.notMergeAuthorization, true);
});

test("a REST review commit id fills a GraphQL review that omitted it", async () => {
  const bound = attachRestCommitIds({
    number: 1734,
    reviews: [{ author: { login: "Instinct-3" }, state: "APPROVED" }],
  }, [{ user: { login: "Instinct-3" }, state: "APPROVED", commit_id: REVIEWED }]);
  assert.equal(bound.reviews[0].commit_id, REVIEWED);
});

test("a live lease on a touched path names the holder and expiry", async () => {
  const now = Date.parse("2026-10-07T04:00:00.000Z");
  const leases = pathLeases({
    truncated: false,
    claims: [
      { id: "land-johnstab-phase1a-draft", state: "in_progress", owner: "holder", leaseExpiresAt: "2026-10-07T08:00:00.000Z", files: ["server/store.mjs"] },
      { id: "done-claim", state: "done", owner: "old", leaseExpiresAt: "2026-10-07T08:00:00.000Z", files: ["server/store.mjs"] },
    ],
  }, ["server/store.mjs", "scripts/landing-facts.mjs"], now);
  assert.equal(leases.unavailable, false);
  assert.equal(leases.paths[1].path, "server/store.mjs");
  assert.deepEqual(leases.paths[1].holders, [{
    claimId: "land-johnstab-phase1a-draft",
    owner: "holder",
    leaseExpiresAt: "2026-10-07T08:00:00.000Z",
    expired: false,
  }]);
  assert.deepEqual(leases.paths[0].holders, []);
});

test("a truncated claim list is unavailable rather than an empty lease", () => {
  const leases = pathLeases({ truncated: true, claims: [] }, ["server/store.mjs"]);
  assert.equal(leases.unavailable, "claims_truncated");
  assert.deepEqual(leases.paths, []);
});

test("facts include path leases only when a claim read is supplied", async () => {
  const execImpl = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    if (key.startsWith("diff --name-only")) return { status: 0, stdout: "server/store.mjs\n", stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) return { status: 0, stdout: `${HEAD} x\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const claimsImpl = async () => ({
    truncated: false,
    claims: [{ id: "plan-pr-autolink", state: "claimed", owner: "fo", leaseExpiresAt: "2026-10-07T08:00:00.000Z", files: [{ path: "server/store.mjs" }] }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, claimsImpl, nowMs: Date.parse("2026-10-07T04:00:00.000Z") });
  assert.deepEqual(facts.touchedPaths, ["server/store.mjs"]);
  assert.equal(facts.pathLeases.paths[0].holders[0].claimId, "plan-pr-autolink");
  assert.equal(facts.notMergeAuthorization, true);
});

test("an approval with no commit id is unverifiable and is not a carry", async () => {
  const execImpl = execOf({
    "rev-parse HEAD": { status: 0, stdout: `${HEAD}\n`, stderr: "" },
    "rev-parse origin/main": { status: 0, stdout: `${MAIN}\n`, stderr: "" },
    [`rev-list --count ${HEAD}..${MAIN}`]: { status: 0, stdout: "0\n", stderr: "" },
    [`rev-list --count ${MAIN}..${HEAD}`]: { status: 0, stdout: "1\n", stderr: "" },
  });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const ghImpl = async () => ({
    number: 1734,
    headRefOid: HEAD,
    author: { login: "grok" },
    reviews: [{ author: { login: "Instinct-3" }, state: "APPROVED" }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, pr: 1734, ghImpl });
  assert.deepEqual(facts.pullRequest.nonAuthorApprovals, ["Instinct-3"]);
  assert.deepEqual(facts.pullRequest.approvalPatchMatches, []);
  assert.equal(facts.pullRequest.status, "unverifiable");
  assert.equal("ready" in facts.pullRequest, false);
});

test("a git-quoted name-only path still names the leased file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "landing-facts-quote-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-C", dir, "-c", "core.quotePath=true", "-c", "user.email=facts@example.com", "-c", "user.name=Facts", ...args], { encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", "café.mjs"), "a\n");
  git(["add", "server/café.mjs"]);
  git(["commit", "-q", "-m", "base"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(join(dir, "server", "café.mjs"), "b\n");
  git(["add", "server/café.mjs"]);
  git(["commit", "-q", "-m", "edit"]);
  const execImpl = (args, input) => {
    const result = spawnSync("git", ["-C", dir, "-c", "core.quotePath=true", ...args], { input, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: null, buildId: "t", deployment: "production" }) });
  const claimsImpl = async () => ({
    truncated: false,
    claims: [{ id: "held", state: "claimed", owner: "other", leaseExpiresAt: "2026-10-10T12:00:00.000Z", files: ["server/café.mjs"] }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, claimsImpl, nowMs: Date.parse("2026-10-10T03:50:00.000Z") });
  assert.deepEqual(facts.touchedPaths, ["server/café.mjs"]);
  assert.equal(facts.pathLeases.unavailable, false);
  assert.equal(facts.pathLeases.paths[0].holders[0].claimId, "held");
  assert.equal(facts.notMergeAuthorization, true);
});

test("a quoted tab in a name-only path still matches the lease", async () => {
  const execImpl = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "1\n", stderr: "" };
    if (key.startsWith("diff --name-only")) return { status: 0, stdout: '"server/tab\\tname.mjs"\n', stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) return { status: 0, stdout: `${HEAD} x\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const claimsImpl = async () => ({
    truncated: false,
    claims: [{ id: "held-tab", state: "claimed", owner: "other", leaseExpiresAt: "2026-10-10T12:00:00.000Z", files: ["server/tab\tname.mjs"] }],
  });
  const facts = await landingFacts({ fetchImpl, execImpl, claimsImpl, nowMs: Date.parse("2026-10-10T03:50:00.000Z") });
  assert.deepEqual(facts.touchedPaths, ["server/tab\tname.mjs"]);
  assert.equal(facts.pathLeases.paths[0].holders[0].claimId, "held-tab");
});

test("mergeSlot names the live holder and treats an expired lease as not held", () => {
  const now = Date.parse("2026-10-22T03:00:00.000Z");
  const live = mergeSlot({ truncated: false, claims: [{ id: "MERGE-SLOT", state: "claimed", owner: "codex", leaseExpiresAt: "2026-10-22T04:00:00.000Z" }] }, now);
  assert.deepEqual(live, { unavailable: false, held: true, owner: "codex", state: "claimed", leaseExpiresAt: "2026-10-22T04:00:00.000Z", expired: false });
  const stale = mergeSlot({ truncated: false, claims: [{ id: "MERGE-SLOT", state: "claimed", owner: "codex", leaseExpiresAt: "2026-10-22T02:00:00.000Z" }] }, now);
  assert.equal(stale.held, false);
  assert.equal(stale.expired, true);
  assert.equal(mergeSlot({ truncated: false, claims: [{ id: "MERGE-SLOT", state: "released", owner: "codex" }] }, now).held, false);
  assert.deepEqual(mergeSlot({ truncated: false, claims: [] }, now), { unavailable: false, held: false });
  assert.deepEqual(mergeSlot({ truncated: true, claims: [] }, now), { unavailable: "claims_truncated" });
  assert.deepEqual(mergeSlot(null, now), { unavailable: "claims_unreadable" });
});

test("checkSummary reports exact-head status with pending and failed names", () => {
  const head = "a".repeat(40);
  const runs = (list, total) => ({ total_count: total ?? list.length, check_runs: list });
  const ok = { status: "completed", conclusion: "success", name: "unit" };
  const st = (rows, over = {}) => ({ sha: head, total_count: rows.length, statuses: rows, ...over });
  const leaseOk = { context: "room/release-lease", state: "success" };
  const none = st([leaseOk]);
  assert.equal(checkSummary(head, runs([ok, { status: "completed", conclusion: "skipped", name: "s" }, { status: "completed", conclusion: "neutral", name: "n" }]), none).status, "green");
  assert.equal(checkSummary(head, runs([ok])).status, "incomplete");
  assert.equal(checkSummary(head, runs([ok]), st([leaseOk])).status, "green");
  const lease = checkSummary(head, runs([ok]), st([{ context: "room/release-lease", state: "pending" }]));
  assert.equal(lease.status, "pending");
  assert.deepEqual(lease.pending, ["room/release-lease"]);
  assert.equal(checkSummary(head, runs([ok]), st([leaseOk, { context: "x", state: "error" }])).status, "failing");
  const pend = checkSummary(head, runs([ok, { status: "queued", conclusion: null, name: "browser 3/6" }]));
  assert.equal(pend.status, "pending");
  assert.deepEqual(pend.pending, ["browser 3/6"]);
  const fail = checkSummary(head, runs([{ status: "queued", name: "b" }, { status: "completed", conclusion: "failure", name: "a" }]));
  assert.equal(fail.status, "failing");
  assert.deepEqual(fail.failed, ["a"]);
  assert.equal(checkSummary(head, runs([ok], 120)).status, "incomplete");
  for (const conclusion of ["stale", null, "something_new"]) {
    const odd = checkSummary(head, runs([ok, { status: "completed", conclusion, name: "odd" }]), none);
    assert.equal(odd.status, "incomplete");
    assert.deepEqual(odd.unknown, ["odd"]);
  }
  assert.equal(checkSummary(head, runs([]), st([]), []).status, "none");
  // 17513 probes: missing required context, truncated status page, wrong sha.
  const missing = checkSummary(head, runs([ok]), st([], { state: "pending" }));
  assert.equal(missing.status, "incomplete");
  assert.deepEqual(missing.missingRequired, ["room/release-lease"]);
  assert.equal(checkSummary(head, runs([ok]), st([leaseOk], { total_count: 2, state: "failure" })).status, "incomplete");
  assert.equal(checkSummary(head, runs([ok]), st([leaseOk], { sha: "f".repeat(40) })).status, "incomplete");
  assert.deepEqual(checkSummary(head, {}), { head, unavailable: "checks_unreadable" });
});

test("facts carry mergeSlot with claims and checks at the PR head", async () => {
  const PRHEAD = "c".repeat(40);
  const execImpl = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    if (key.startsWith("diff --name-only")) return { status: 0, stdout: "server/store.mjs\n", stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) return { status: 0, stdout: `${HEAD} x\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: key };
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ sourceRevision: PROD, buildId: "t", deployment: "production" }) });
  const claimsImpl = async () => ({ truncated: false, claims: [{ id: "MERGE-SLOT", state: "in_progress", owner: "codex", leaseExpiresAt: "2026-10-22T05:00:00.000Z" }] });
  const ghImpl = async () => ({ number: 4490, headRefOid: PRHEAD, author: { login: "grok" }, reviews: [] });
  const seen = [];
  const checksImpl = async (sha) => { seen.push(sha); return { runs: { total_count: 1, check_runs: [{ status: "in_progress", name: "browser" }] }, statuses: { sha: PRHEAD, total_count: 0, statuses: [] } }; };
  const facts = await landingFacts({ fetchImpl, execImpl, claimsImpl, ghImpl, checksImpl, pr: 4490, nowMs: Date.parse("2026-10-22T03:00:00.000Z") });
  assert.equal(facts.mergeSlot.owner, "codex");
  assert.equal(facts.mergeSlot.held, true);
  assert.deepEqual(seen, [PRHEAD]);
  assert.equal(facts.checks.head, PRHEAD);
  assert.equal(facts.checks.status, "pending");
  const broken = await landingFacts({ fetchImpl, execImpl, ghImpl, pr: 4490, checksImpl: async () => { throw new Error("x"); } });
  assert.deepEqual(broken.checks, { head: PRHEAD, unavailable: "checks_unreadable" });
  assert.equal(broken.notMergeAuthorization, true);
});
