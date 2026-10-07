// tests/lander-gate.test.js — the lander rule as a required check.
//
// Contract guarded: the lander rule says a PR merges only after a reviewer's
// explicit APPROVE on the EXACT head SHA. scripts/lander-gate.mjs enforces
// it as a check run named exactly `lander-gate`, on pull_request (early
// signal) and on merge_group (re-verified at land time). These tests pin:
//   1. landerVerdict passes only for an APPROVE whose reviewed head SHA
//      equals the current PR head SHA — never for a stale approval.
//   2. targetsFromEvent resolves PR targets from pull_request and merge_group
//      events (fallback: parsing PR numbers out of the temp branch ref).
//   3. the CLI posts one completed check run named exactly `lander-gate` on
//      the target SHA with the verdict as its conclusion, using no live API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { landerVerdict, targetsFromEvent } from "../scripts/lander-gate.mjs";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OLD = "0000111122223333444455556666777788889999";

const review = (over = {}) => ({
  id: 1,
  user: { login: "rev-a" },
  author_association: "MEMBER",
  state: "APPROVED",
  commit_id: HEAD,
  submitted_at: "2026-10-06T20:00:00Z",
  ...over,
});

test("pass: APPROVE whose reviewed head equals the current head", () => {
  const v = landerVerdict({ reviews: [review()], headSha: HEAD });
  assert.equal(v.pass, true);
  assert.match(v.reason, /exact head/);
});

test("fail: APPROVE on a stale head does not satisfy the gate", () => {
  const v = landerVerdict({ reviews: [review({ commit_id: OLD })], headSha: HEAD });
  assert.equal(v.pass, false);
  assert.match(v.reason, /stale/i);
});

test("fail: no reviews at all", () => {
  const v = landerVerdict({ reviews: [], headSha: HEAD });
  assert.equal(v.pass, false);
  assert.match(v.reason, /no.*approve/i);
});

test("fail: APPROVE from an author without write access does not count", () => {
  const v = landerVerdict({
    reviews: [review({ author_association: "CONTRIBUTOR" })],
    headSha: HEAD,
  });
  assert.equal(v.pass, false);
});

test("fail: the approver's latest review wins — dismissed approval is gone", () => {
  const v = landerVerdict({
    reviews: [
      review({ id: 1, submitted_at: "2026-10-06T20:00:00Z" }),
      review({ id: 2, state: "DISMISSED", submitted_at: "2026-10-06T21:00:00Z" }),
    ],
    headSha: HEAD,
  });
  assert.equal(v.pass, false);
});

test("pass: re-approve after changes-requested on the same head", () => {
  const v = landerVerdict({
    reviews: [
      review({ id: 1, state: "CHANGES_REQUESTED", commit_id: OLD, submitted_at: "2026-10-06T19:00:00Z" }),
      review({ id: 2, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-06T21:00:00Z" }),
    ],
    headSha: HEAD,
  });
  assert.equal(v.pass, true);
});

test("fail: one stale approval among many — only the exact head counts", () => {
  const v = landerVerdict({
    reviews: [
      review({ id: 1, user: { login: "rev-a" }, commit_id: OLD }),
      review({ id: 2, user: { login: "rev-b" }, commit_id: OLD }),
    ],
    headSha: HEAD,
  });
  assert.equal(v.pass, false);
  assert.match(v.reason, /rev-a|rev-b/);
});

test("pull_request event resolves to the PR number and head SHA", () => {
  const targets = targetsFromEvent("pull_request", {
    pull_request: { number: 1739, head: { sha: HEAD } },
  });
  assert.deepEqual(targets, [{ pr: 1739, headSha: HEAD }]);
});

test("merge_group event resolves every queued PR from the payload", () => {
  const targets = targetsFromEvent("merge_group", {
    merge_group: { head_sha: "deadbeef", head_ref: "gh-readonly-queue/main/pr-1739-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    pull_requests: [{ number: 1739 }, { number: 1740 }],
  });
  assert.deepEqual(targets.map((t) => t.pr), [1739, 1740]);
  assert.equal(targets[0].groupHeadSha, "deadbeef");
});

test("merge_group without a pull_requests payload falls back to the temp ref", () => {
  const targets = targetsFromEvent("merge_group", {
    merge_group: { head_sha: "deadbeef", head_ref: "gh-readonly-queue/main/pr-1741-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  });
  assert.deepEqual(targets, [{ pr: 1741, headSha: null, groupHeadSha: "deadbeef" }]);
});

// --- CLI: posts a check run named exactly `lander-gate` ---------------------
// Stubs globalThis.fetch (the --import preload pattern from merge-hold's
// tests): reviews endpoint returns fixtures, PR endpoint returns the head,
// check-runs POST records its body for assertion. No live API is touched.
function runGate(eventName, event, reviewFixtures) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lander-gate-"));
  const preload = join(dir, "github.mjs");
  const evFile = join(dir, "event.json");
  writeFileSync(evFile, JSON.stringify(event));
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
     const posted=[];
     globalThis.fetch = async (input, init={}) => {
       const url = new URL(input);
       if (url.origin !== 'https://api.github.com') throw new Error('unexpected origin '+url.origin);
       if (url.pathname === '/repos/Uuriko/project-room/check-runs') {
         posted.push(JSON.parse(init.body));
         return new Response(JSON.stringify({ id: 4242 }), { status: 201 });
       }
       if (url.pathname.startsWith('/repos/Uuriko/project-room/pulls/1741/reviews')) {
         return new Response(JSON.stringify(${JSON.stringify(reviewFixtures)}));
       }
       if (url.pathname === '/repos/Uuriko/project-room/pulls/1741') {
         return new Response(JSON.stringify({ number: 1741, head: { sha: ${JSON.stringify(HEAD)} } }));
       }
       throw new Error('unexpected path '+url.pathname);
     };
     process.on('exit',()=>{writeFileSync(${JSON.stringify(join(dir, "posted.json"))},JSON.stringify(posted));});`
  );
  const script = fileURLToPath(new URL("../scripts/lander-gate.mjs", import.meta.url));
  let status = 0;
  try {
    execFileSync(
      process.execPath,
      ["--import", preload, script],
      {
        stdio: "pipe",
        timeout: 8000,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: evFile,
          GITHUB_TOKEN: "fake-token",
          GITHUB_REPOSITORY: "Uuriko/project-room",
        },
      }
    );
  } catch (error) {
    status = error.status;
  }
  return { status, posted: JSON.parse(readFileSync(join(dir, "posted.json"), "utf8")) };
}

test("CLI posts exactly one `lander-gate` check run with success on pass", () => {
  const { status, posted } = runGate(
    "pull_request",
    { pull_request: { number: 1741, head: { sha: HEAD } } },
    [review()]
  );
  assert.equal(status, 0);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].name, "lander-gate");
  assert.equal(posted[0].head_sha, HEAD);
  assert.equal(posted[0].conclusion, "success");
});

test("CLI posts a failing `lander-gate` check run on stale approval", () => {
  const { status, posted } = runGate(
    "pull_request",
    { pull_request: { number: 1741, head: { sha: HEAD } } },
    [review({ commit_id: OLD })]
  );
  assert.equal(status, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].name, "lander-gate");
  assert.equal(posted[0].conclusion, "failure");
  assert.match(posted[0].output.summary, /stale/i);
});
