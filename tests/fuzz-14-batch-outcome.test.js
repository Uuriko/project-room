// WAVE-400 fuzz worker: batch claim-outcome fuzz (test-only).
//
// Target: the PR-link "batch" on a work claim, server/claim-coordination.mjs:
//   recordPullOutcome  — apply one outcome op to the batch
//   pullsReadyToSettle — the batch gate (all-or-nothing settlement)
//   batchPullOutcome   — the batch decision (merged-wins)
//   settlePullRequest  — atomic settlement of the whole claim
//
// Documented contract pinned here (module comments +
// tests/work-claim-batch-outcome.test.js):
//   1. merged-wins: ANY "merged" link => batch outcome "merged"; a stale
//      "closed" link can never veto it.
//   2. all-or-nothing settlement: the claim settles only when EVERY link is
//      terminal ("merged"|"closed") and the batch is non-empty. A partial batch
//      is persisted per-op but never partially settled: settlePullRequest
//      returns null and the input is unchanged.
//   3. per-op accuracy: recordPullOutcome stamps exactly the link(s) whose url
//      matches the op's url, and nothing else.
//
// What "batch" means here: one claim's pullRequests link list; one "op" is a
// single outcome record (url + outcome). The fuzz builds random batches —
// mixed valid/invalid outcomes, empty batches, 1000-link batches, duplicate
// URLs, and op sequences where op N is skipped when an earlier op already
// settled the URL (the commitPullRequestLookup guard model) — and checks every
// invariant above after every op, plus settlement at the end and an
// order-independence differential.

import test from "node:test";
import assert from "node:assert/strict";
import {
  pullLinks,
  recordPullOutcome,
  pullsReadyToSettle,
  batchPullOutcome,
  settlePullRequest,
} from "../server/claim-coordination.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-14-batch-outcome] seed=${SEED}`);

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED >>> 0);
const ri = (n) => Math.floor(rng() * n);
const rf = () => rng();
const pick = (arr) => arr[ri(arr.length)];
const chance = (p) => rng() < p;

const NOW_BASE = Date.UTC(2026, 9, 8, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const URL_POOL = [];
for (let n = 1500; n < 1510; n++) URL_POOL.push(`https://github.com/Uuriko/project-room/pull/${n}`);
URL_POOL.push("https://github.com/Uuriko/dg-bus/pull/42");
URL_POOL.push("https://github.com/Uuriko/project-room/pull/9999999999");
// Small pool on purpose: duplicates inside a batch are common.
const UNKNOWN_URLS = [
  "https://github.com/Uuriko/project-room/pull/123456789",
  "https://github.com/other/repo/pull/1",
  "not-a-url",
  "",
];

const VALID_OUTCOMES = ["merged", "closed"];
const INVALID_OUTCOMES = ["open", "draft", "MERGED", " merged", "merged ", "", null, undefined, 0, 42, "squashed"];
const isTerminal = (o) => o === "merged" || o === "closed";
const LIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);

function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}

function makeLink(url, outcome, nowMs) {
  const link = { url, repo: "Uuriko/project-room", number: Number(url.split("/").pop()) || 0 };
  if (outcome !== undefined) {
    link.outcome = outcome;
    link.syncedAt = iso(nowMs);
    link.nextPollAt = null;
    link.rateLimitedUntil = null;
  }
  return link;
}

function randomPreOutcome() {
  const r = rf();
  if (r < 0.45) return undefined; // still open
  if (r < 0.65) return "merged";
  if (r < 0.85) return "closed";
  return pick(INVALID_OUTCOMES); // hostile pre-existing outcome
}

function makeItem(id, linkCount, nowMs, opts = {}) {
  const links = [];
  for (let i = 0; i < linkCount; i++) {
    links.push(makeLink(opts.dupUrl ?? pick(URL_POOL), randomPreOutcome(), nowMs));
  }
  const sr = rf();
  const state = sr < 0.85
    ? pick(["claimed", "in_progress", "blocked"])
    : pick(["done", "unclaimed", "archived", ""]);
  const lr = rf();
  const leaseExpiresAt = lr < 0.1 ? iso(nowMs - 60_000) : lr < 0.2 ? iso(nowMs + 3_600_000) : undefined;
  // Singular pointer: usually consistent with the module's rule (first open
  // link, else last link), sometimes hostile (missing or stale).
  const open = links.find((l) => !l.outcome);
  let pullRequest;
  const pr = rf();
  if (links.length === 0) {
    pullRequest = undefined;
  } else if (pr < 0.8) {
    pullRequest = { ...(open ?? links[links.length - 1]) };
  } else if (pr < 0.9) {
    pullRequest = undefined; // hostile: missing pointer
  } else {
    pullRequest = { ...links[links.length - 1], outcome: "closed", syncedAt: iso(nowMs) }; // hostile: stale pointer
  }
  const item = {
    id,
    state,
    owner: "fuzz-agent",
    leaseStartAt: iso(nowMs - 1000),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    files: ["a.mjs"],
    history: [],
    pullRequests: links,
    ...(pullRequest ? { pullRequest } : {}),
  };
  return deepFreeze(item);
}

function randomOp() {
  return {
    url: chance(0.2) ? pick(UNKNOWN_URLS) : pick(URL_POOL),
    outcome: chance(0.8) ? pick(VALID_OUTCOMES) : pick(INVALID_OUTCOMES),
  };
}

// Apply one op and check the per-op invariants. Returns the new item.
function applyOp(item, url, outcome, nowMs, label) {
  const prevLinks = pullLinks(item);
  const next = recordPullOutcome(item, url, outcome, nowMs);
  const nextLinks = pullLinks(next);

  // Invariant: the batch length never changes; links are never added/removed.
  assert.equal(nextLinks.length, prevLinks.length, `${label}: recordPullOutcome must never add/remove links`);

  // Invariant: per-op accuracy — exactly the matching url(s) are stamped.
  for (let i = 0; i < prevLinks.length; i++) {
    const before = prevLinks[i];
    const after = nextLinks[i];
    if (before.url === url) {
      assert.equal(after.outcome, outcome, `${label}: link ${before.url} must carry the recorded outcome`);
      assert.equal(after.url, before.url, `${label}: stamped link url must not change`);
      assert.equal(after.repo, before.repo, `${label}: stamped link repo must not change`);
      assert.equal(after.syncedAt, iso(nowMs), `${label}: stamped link syncedAt must be the op time`);
      assert.equal(after.nextPollAt, null, `${label}: stamped link nextPollAt must reset`);
      assert.equal(after.rateLimitedUntil, null, `${label}: stamped link rateLimitedUntil must reset`);
    } else {
      assert.ok(after === before, `${label}: non-target link ${before.url} must be untouched (same reference)`);
    }
  }

  // Invariant: the singular pointer never invents a link.
  if (nextLinks.length === 0) {
    // Pinned current behavior: an empty batch gets an empty pointer object.
    // Unreachable in production — commitPullRequestLookup guards on `linked`
    // before calling recordPullOutcome — so this is a pinned observation.
    assert.deepStrictEqual(next.pullRequest, {}, `${label}: empty batch pointer must stay the empty object`);
  } else {
    const cands = nextLinks.filter((l) => l.url === next.pullRequest?.url);
    assert.ok(cands.length > 0, `${label}: pointer url must come from the batch`);
    const byValue = cands.some((l) => {
      try { assert.deepStrictEqual(next.pullRequest, l); return true; } catch { return false; }
    });
    assert.ok(byValue, `${label}: pointer must equal one of the batch links by value`);
    if (nextLinks.some((l) => !l.outcome)) {
      assert.ok(!next.pullRequest.outcome, `${label}: pointer must sit on an open link while any link is open`);
    } else {
      assert.deepStrictEqual(
        next.pullRequest, nextLinks[nextLinks.length - 1],
        `${label}: all links settled, pointer must be the last link`,
      );
    }
  }
  return next;
}

// Independent recomputation of the documented batch contract.
function checkBatchContract(item, label) {
  const links = pullLinks(item);
  const expectReady = links.length > 0 && links.every((l) => isTerminal(l.outcome));
  assert.equal(
    pullsReadyToSettle(item), expectReady,
    `${label}: pullsReadyToSettle must be true exactly when every link is terminal (merged|closed)`,
  );
  // merged-wins: ANY merged link => "merged". (Empty batch currently reads
  // "closed"; pinned here, unreachable in production since settlement gates
  // on pullsReadyToSettle.)
  const expectOutcome = links.some((l) => l.outcome === "merged") ? "merged" : "closed";
  assert.equal(
    batchPullOutcome(item), expectOutcome,
    `${label}: merged-wins — any merged link must yield "merged", never vetoed by closed links`,
  );
  return { expectReady, expectOutcome };
}

function checkSettlement(item, nowMs, label) {
  const links = pullLinks(item);
  const { expectReady, expectOutcome } = checkBatchContract(item, label);
  const live = LIVE_STATES.has(item.state);
  const lapsed = typeof item.leaseExpiresAt === "string"
    && Number.isFinite(Date.parse(item.leaseExpiresAt))
    && Date.parse(item.leaseExpiresAt) <= nowMs;
  const expectNull = !live || lapsed || !expectReady;

  const before = JSON.stringify(item);
  const settled = settlePullRequest(item, batchPullOutcome(item), nowMs);
  // Differential: a refused settlement leaves state identical.
  assert.equal(JSON.stringify(item), before, `${label}: settlePullRequest must never mutate its input`);

  if (expectNull) {
    assert.equal(settled, null, `${label}: non-live, lapsed-lease, or partial batch must not settle`);
    return;
  }
  assert.ok(settled && typeof settled === "object", `${label}: ready live batch must settle`);

  // The batch settles atomically: one action, link outcomes untouched.
  assert.deepStrictEqual(
    pullLinks(settled.item), links,
    `${label}: settlement must not alter the batch links`,
  );

  if (expectOutcome === "merged") {
    assert.equal(settled.action, "pr_merged", `${label}: merged batch settles pr_merged`);
    assert.equal(settled.item.state, "done", `${label}: merged batch completes the claim`);
    assert.equal(settled.item.deliveryMode, "merged", `${label}: merged settlement sets deliveryMode`);
    const firstMerged = links.find((l) => l.outcome === "merged");
    assert.equal(
      settled.item.pullRequest.url, firstMerged.url,
      `${label}: settled record must name the PR that merged (merged-first)`,
    );
    assert.equal(settled.item.pullRequest.outcome, "merged", `${label}: settled record must not contradict pr_merged`);
    assert.ok(
      settled.item.history.at(-1).note.includes(firstMerged.url),
      `${label}: settlement note must name the merged PR`,
    );
  } else {
    assert.equal(settled.action, "pr_closed", `${label}: closed batch settles pr_closed`);
    assert.equal(settled.item.state, "unclaimed", `${label}: closed batch releases the claim`);
    assert.equal(settled.item.owner, null, `${label}: closed batch clears the owner`);
    assert.equal(settled.item.leaseStartAt, null, `${label}: closed batch clears the lease`);
    assert.equal(settled.item.leaseExpiresAt, null, `${label}: closed batch clears the lease expiry`);
    assert.deepStrictEqual(settled.item.files, [], `${label}: closed batch clears files`);
    const note = settled.item.history.at(-1).note;
    assert.ok(
      note.startsWith("pull request closed: ") && links.some((l) => note.includes(l.url)),
      `${label}: closed settlement note must name a batch link`,
    );
  }
}

function runStandard(item0, nowBase, opCount, label) {
  let item = item0;
  for (let i = 0; i < opCount; i++) {
    const { url, outcome } = randomOp();
    item = applyOp(item, url, outcome, nowBase + (i + 1) * 1000, `${label} op#${i}`);
  }
  return item;
}

// Guarded pipeline: models commitPullRequestLookup's `linked` guard — op N is
// skipped when no open link with its url remains (i.e. op N depends on the
// batch state left by earlier ops).
//
// Independent model: a guarded op stamps EVERY link with its url, and applies
// only while some link with that url is open (`!outcome`). In the production
// domain outcomes are always truthy ("merged"|"closed"), so the first applied
// op wins and later ops skip. The fuzz also records falsy outcomes ("", null,
// 0, undefined), which leave the links open, so a later op may re-apply: the
// module consistently converges to the LAST applied outcome per url.
function runGuarded(item0, nowBase, opCount, label) {
  const lastApplied = new Map(); // url -> outcome of the most recent applied guarded op
  const firstApplied = new Map(); // url -> outcome of the first applied guarded op
  let item = item0;
  for (let i = 0; i < opCount; i++) {
    const { url, outcome } = randomOp();
    const linked = pullLinks(item).some((l) => l.url === url && !l.outcome);
    if (!linked) continue; // guarded skip: op fails, state must be identical
    item = applyOp(item, url, outcome, nowBase + (i + 1) * 1000, `${label} op#${i}`);
    lastApplied.set(url, outcome);
    if (!firstApplied.has(url)) firstApplied.set(url, outcome);
  }
  // Independent model: a url touched by a guarded op carries the last applied
  // outcome on every one of its links; untouched urls are byte-identical.
  const finalLinks = pullLinks(item);
  const initialLinks = pullLinks(item0);
  for (let i = 0; i < finalLinks.length; i++) {
    const u = finalLinks[i].url;
    if (lastApplied.has(u)) {
      assert.equal(
        finalLinks[i].outcome, lastApplied.get(u),
        `${label}: guarded pipeline must converge to the last applied outcome per url (link #${i})`,
      );
      // Production domain (truthy outcomes only): the guard must make the
      // first applied op win — a second op on the same url must skip.
      if (firstApplied.get(u) && lastApplied.get(u)) {
        assert.equal(
          firstApplied.get(u), lastApplied.get(u),
          `${label}: truthy outcomes must be first-wins per url (link #${i})`,
        );
      }
    } else {
      assert.deepStrictEqual(finalLinks[i], initialLinks[i], `${label}: unrecorded link #${i} must be identical`);
    }
  }
  return item;
}

// Order-independence differential: the same multiset of outcome records,
// applied in two different orders, must converge to the identical batch.
function runDifferential(item0, nowBase, label) {
  const urls = [...new Set(pullLinks(item0).map((l) => l.url))];
  const ops = urls.map((url) => ({ url, outcome: pick(VALID_OUTCOMES) }));
  const sub = mulberry32((SEED ^ 0x9e3779b9 ^ (urls.length + 1)) >>> 0);
  const shuffled = [...ops];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(sub() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const t = nowBase + 5000; // fixed op time so timestamps cannot differ by order
  let a = item0;
  let b = item0;
  for (const op of ops) a = applyOp(a, op.url, op.outcome, t, `${label} fwd`);
  for (const op of shuffled) b = applyOp(b, op.url, op.outcome, t, `${label} rev`);
  assert.deepStrictEqual(a.pullRequests, b.pullRequests, `${label}: batch links must be order-independent`);
  assert.deepStrictEqual(a.pullRequest, b.pullRequest, `${label}: batch pointer must be order-independent`);
  assert.deepStrictEqual(
    checkBatchContract(a, `${label} fwd`),
    checkBatchContract(b, `${label} rev`),
    `${label}: batch decision must be order-independent`,
  );
  return a;
}

test("fuzz: 3200 random batches — per-op accuracy, merged-wins, all-or-nothing settlement", () => {
  const violations = [];
  const counts = {};
  let done = 0;

  const plan = [
    // [kind, count, linkCount(), opCount(), runner]
    ["standard", 2000, () => 1 + ri(12), () => 1 + ri(20), runStandard],
    ["empty", 200, () => 0, () => 1 + ri(8), runStandard],
    ["big", 200, () => 100 + ri(901), () => (chance(0.9) ? 1 + ri(5) : 500 + ri(501)), runStandard],
    ["dup-url", 200, () => 2 + ri(10), () => 1 + ri(15), runStandard],
    ["guarded", 300, () => 1 + ri(12), () => 1 + ri(20), runGuarded],
    ["differential", 300, () => 2 + ri(8), () => 0, runDifferential],
  ];

  for (const [kind, count, linkCountFn, opCountFn, runner] of plan) {
    counts[kind] = 0;
    for (let b = 0; b < count; b++) {
      const label = `batch#${done} ${kind}#${b}`;
      try {
        const nowBase = NOW_BASE + done * 1000;
        const item0 = kind === "dup-url"
          ? makeItem(`fuzz-${kind}-${b}`, linkCountFn(), nowBase, { dupUrl: pick(URL_POOL) })
          : makeItem(`fuzz-${kind}-${b}`, linkCountFn(), nowBase);
        const finalItem = runner(item0, nowBase, opCountFn(), label);
        checkSettlement(finalItem, nowBase + 900_000, label);
        counts[kind]++;
      } catch (err) {
        violations.push({
          label,
          kind,
          message: err.message,
          stack: String(err.stack).split("\n").slice(0, 5).join("\n"),
        });
        if (violations.length <= 3) {
          console.error(`[fuzz-14] VIOLATION ${label}: ${err.message}\n${err.stack}`);
        }
      }
      done++;
      if (done % 500 === 0) console.log(`[fuzz-14] ${done} batches done`);
    }
  }

  console.log(`[fuzz-14] done: batches=${done} counts=${JSON.stringify(counts)} violations=${violations.length} seed=${SEED}`);
  if (violations.length > 0) {
    console.error(`[fuzz-14] first violations:\n${JSON.stringify(violations.slice(0, 10), null, 2)}`);
  }
  assert.equal(violations.length, 0, `${violations.length} contract violations (seed=${SEED}); first: ${violations[0]?.label}: ${violations[0]?.message}`);
  assert.equal(done, 3200, "must run at least 3000 batches");
});

test("fuzz: hostile item shapes pin current behavior (documentation, not contract)", () => {
  // Non-array pullRequests falls back to the singular pullRequest link.
  const weird = deepFreeze({
    id: "weird", state: "in_progress", owner: "x", files: [], history: [],
    pullRequests: "nope",
    pullRequest: { url: URL_POOL[0], repo: "Uuriko/project-room", number: 1500 },
  });
  const out = recordPullOutcome(weird, URL_POOL[0], "merged", NOW_BASE);
  assert.equal(pullLinks(out).length, 1);
  assert.equal(batchPullOutcome(out), "merged");

  // A null entry in the link list is garbage-in: the module throws.
  const nullLink = deepFreeze({
    id: "nulllink", state: "in_progress", owner: "x", files: [], history: [],
    pullRequests: [null],
  });
  assert.throws(() => recordPullOutcome(nullLink, URL_POOL[0], "merged", NOW_BASE), TypeError);
  assert.throws(() => pullsReadyToSettle(nullLink), TypeError);
  assert.throws(() => batchPullOutcome(nullLink), TypeError);
});
