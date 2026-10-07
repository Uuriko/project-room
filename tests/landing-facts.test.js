import test from "node:test";
import assert from "node:assert/strict";
import { landingFacts } from "../scripts/landing-facts.mjs";

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
  assert.equal(facts.pullRequest.ready, true);
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
  assert.equal(facts.pullRequest.ready, false);
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
  assert.equal(facts.pullRequest.ready, false);
});
