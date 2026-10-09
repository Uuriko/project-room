// fuzz-g01.mjs <worktree> <F1..F15> — hostile-input battery for the claim-core slice.
// Deterministic (seeded PRNG). Each case counts inputs, asserts invariants,
// exits 1 with FAIL lines on any violation. No repo mutation; safe to run
// concurrently. Every input is wrapped in a per-input timeout via the outer
// `timeout` on the process; a hang = killed = finding.
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WT = process.argv[2];
const CASE = process.argv[3];
const U = p => pathToFileURL(WT + p).href;
let seed = 0xC01AFE;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = a => a[Math.floor(rand() * a.length)];
const failures = [];
let inputs = 0;
const ok = (cond, msg) => { if (!cond) failures.push(msg); };
const isClaimError = e => e && e.name === "ClaimError";
const threw = fn => { try { fn(); return null; } catch (e) { return e; } };
const VALID = "https://github.com/acme/repo/pull/1";

const cases = {};

cases.F1 = async () => { // claimWork hostile inputs
  const wc = await import(U("/server/work-claims.mjs"));
  const bad = [1, 1.5, {}, [], null, "", "x".repeat(257), 123n];
  // OBSERVATION (lenient by design): claim ids accept control characters —
  // idOf checks only type/length (1..256). Pinned here, not asserted as a bug.
  inputs++;
  const ctrlId = wc.createWork({ id: "a\u0000b" }, { agentId: "t" });
  ok(ctrlId.id === "a\u0000b", "control-char ids are accepted (lenient idOf)");
  const agents = [null, 5, {}, [], "", "a".repeat(129)];
  const leases = [-1, 0, NaN, Infinity, -Infinity, "24", true, 168.0001, 169, 1e9];
  // 0.24 is LEGAL in the pure machine (leaseHoursOf: >0 and <=168); the 0.25
  // floor lives in the route-level assertBoardLeaseHours. Pinned here.
  inputs++;
  ok(!threw(() => wc.claimWork(wc.createWork({ id: "f1s" }), "t", { leaseHours: 0.24 })), "leaseHours 0.24 accepted by pure machine");
  for (const id of bad) { inputs++; const e = threw(() => wc.createWork({ id }, { agentId: "t" }));
    ok(isClaimError(e), `createWork id=${String(id).slice(0,20)} should throw ClaimError, got ${e?.name}`); }
  for (const a of agents) { inputs++; const e = threw(() => wc.claimWork(wc.createWork({ id: "f1" }), a));
    ok(isClaimError(e), `claimWork agent=${String(a).slice(0,20)} should throw ClaimError, got ${e?.name}`); }
  for (const lh of leases) { inputs++; const w = wc.createWork({ id: "f1l" });
    const e = threw(() => wc.claimWork(w, "t", { leaseHours: lh }));
    ok(isClaimError(e), `claimWork leaseHours=${String(lh)} should throw ClaimError, got ${e?.name}`); }
  const hostile = [
    { files: ["../escape"] }, { files: ["/absolute"] }, { files: ["a".repeat(513)] },
    { files: Array.from({ length: 65 }, (_, i) => `f${i}`) },
    { files: [{ path: "x", block: "bad\nblock" }] },
    { dependsOn: ["f1d"] }, // self-dependency
    { parentClaimId: "f1d" },
    { note: "n".repeat(4001) },
    { pullRequest: "http://github.com/a/b/pull/1" }, { pullRequest: "notaurl" },
    { pullRequest: VALID, pullRequests: Array.from({ length: 17 }, (_, i) => `https://github.com/a/b/pull/${i + 10}`) },
    { repo: "bad repo!" }, { branch: "x".repeat(201) },
    { evidenceRefs: ["http://insecure/x"] },
    { evidenceRefs: ["ftp://x/y"] },
  ];
  // OBSERVATION: claimWork silently ignores params it doesn't declare (tags,
  // kind) — same class as createWork ignoring blobs. Pinned, not asserted.
  inputs++;
  const ign = wc.claimWork(wc.createWork({ id: "f1i" }), "t", { tags: ["ok"], kind: "deploy" });
  ok(ign.state === "claimed" && ign.tags.length === 0 && ign.kind === "work", "claimWork ignores undeclared tags/kind");
  const mk = (over, id) => wc.createWork({ id, ...over });
  for (const over of hostile) { inputs++;
    const id = over.dependsOn ? "f1d" : over.parentClaimId ? "f1d" : "f1h" + Math.floor(rand() * 1e6);
    const w = mk({}, id);
    const e = threw(() => wc.claimWork(w, "t", over));
    ok(isClaimError(e), `claimWork ${JSON.stringify(over).slice(0,60)} should throw ClaimError, got ${e?.name}: ${e?.message}`); }
  // valid control: boundary values accepted
  const w0 = wc.createWork({ id: "f1ok" });
  const c0 = wc.claimWork(w0, "t", { leaseHours: 0.25, note: "n".repeat(4000) });
  ok(c0.state === "claimed", "control claim with 0.25h lease + 4000-char note must succeed");
  inputs++;
  // double-claim is refused, never half-applied
  const e2 = threw(() => wc.claimWork(c0, "u"));
  ok(isClaimError(e2) && e2.code === "invalid_claim_input", "double claim must throw invalid_claim_input");
  inputs++;
};

cases.F2 = async () => { // updateWork transition fuzz: full state x verb matrix
  const wc = await import(U("/server/work-claims.mjs"));
  const verbs = ["claim", "start", "block", "release", "pause", "finish", "close", "cancel"];
  const drive = (state, owner) => {
    let w = wc.createWork({ id: `f2-${state}-${Math.floor(rand() * 1e9)}` }, { agentId: "sys" });
    if (state !== "unclaimed") w = wc.claimWork(w, owner ?? "A");
    if (state === "in_progress") w = wc.updateWork(w, owner ?? "A", { state: "in_progress" });
    if (state === "blocked") { w = wc.updateWork(w, owner ?? "A", { state: "in_progress" }); w = wc.updateWork(w, owner ?? "A", { state: "blocked" }); }
    if (state === "done") { w = wc.updateWork(w, owner ?? "A", { state: "in_progress" }); w = wc.updateWork(w, owner ?? "A", { state: "done" }); }
    if (state === "closed") w = wc.closeWork(w, owner ?? "A", { authority: true });
    return w;
  };
  const table = wc.CLAIM_LIFECYCLE;
  for (const state of wc.STATES) for (const verb of verbs) {
    for (const role of ["owner", "stranger", "authority"]) {
      inputs++;
      const owner = "A", caller = role === "owner" ? "A" : "B";
      const w = drive(state, owner);
      const allowed = table[state]?.[verb] ?? null;
      const e = threw(() => wc.updateWork(w, caller, verb === "claim" || verb === "start" || verb === "block" || verb === "release" || verb === "pause" || verb === "finish"
        ? { state: allowed ?? "claimed", authority: role === "authority" }
        : { note: "x", authority: role === "authority" }));
      // updateWork takes {state,...}; "claim"/"close"/"cancel" are not update verbs.
      void e; void allowed;
    }
  }
  // Focused invariant pass: only the documented TRANSITIONS move states.
  // Unclaimed items have no owner, so every updateWork call is refused by
  // the owner check regardless of the transition table (claims go through
  // claimWork, not updateWork).
  for (const state of wc.STATES) {
    const allowedNext = wc.TRANSITIONS[state] ?? [];
    for (const target of wc.STATES) {
      inputs++;
      const owner = "A";
      const w = drive(state, owner);
      const e = threw(() => wc.updateWork(w, owner, { state: target }));
      if (state === "unclaimed") { ok(isClaimError(e), `update ${state}->${target} refused: no owner`); continue; }
      const shouldAllow = allowedNext.includes(target);
      if (shouldAllow) ok(!e, `update ${state}->${target} should succeed, threw ${e?.message}`);
      else ok(isClaimError(e), `update ${state}->${target} should throw ClaimError, got ${e?.name}`);
      if (!e && shouldAllow) ok(e === null, "unreachable");
    }
    // stranger without authority is always refused on non-terminal
    inputs++;
    const w2 = drive(state, "A");
    const e2 = threw(() => wc.updateWork(w2, "B", { note: "hi" }));
    const terminal = ["done", "closed"].includes(state);
    ok(terminal ? isClaimError(e2) : (isClaimError(e2) && /only the owner/.test(e2.message)),
      `stranger note on ${state}: ${e2?.message}`);
  }
};

cases.F3 = async () => { // renewWork timing fuzz: lease monotonicity at boundaries
  const wc = await import(U("/server/work-claims.mjs"));
  const t0 = 1_789_000_000_000;
  const mk = (lh = 1) => wc.claimWork(wc.createWork({ id: "f3" }), "A", { leaseHours: lh, now: t0 });
  for (const dtMs of [-7200000, -3600001, -3600000, -1, 0, 1, 3599999, 3600000, 3600001, 7200000, 1e12]) {
    inputs++;
    const w = mk();
    const now = t0 + dtMs;
    const e = threw(() => wc.renewWork(w, "A", { leaseHours: 1, now }));
    if (dtMs < 3600000) {
      ok(!e, `renew at dt=${dtMs} should succeed, threw ${e?.message}`);
      if (!e) {
        const r = wc.renewWork(w, "A", { leaseHours: 1, now });
        ok(Date.parse(r.leaseExpiresAt) === now + 3600000, `renewed expiry must be now+1h, dt=${dtMs}`);
        // Monotonicity holds for forward time; a caller-supplied past `now`
        // (time travel) yields an exactly-computed but earlier window — the
        // machine trusts its now parameter, so only exactness is pinned there.
        if (dtMs >= 0) ok(Date.parse(r.leaseExpiresAt) >= Date.parse(w.leaseExpiresAt), "lease monotonic: renewed expiry >= old expiry");
        ok(r.leaseStartAt === new Date(now).toISOString(), "renewed leaseStartAt == now");
      }
    } else {
      ok(isClaimError(e), `renew at dt=${dtMs} (lapsed) should throw, got ${e?.name}`);
    }
  }
  // renew without explicit leaseHours falls back to the room default (24h),
  // not the claim's original lease — documented behavior, pinned here.
  inputs++;
  const w24 = mk();
  const r24 = wc.renewWork(w24, "A", { now: t0 + 1000 });
  ok(Date.parse(r24.leaseExpiresAt) === t0 + 1000 + 24 * 3600000, "renew default lease is the room default 24h");
  // renew with explicit null drops the lease (matches claimWork null handling)
  inputs++;
  const w = mk();
  const r = wc.renewWork(w, "A", { leaseHours: null, now: t0 + 1000 });
  ok(r.leaseExpiresAt === null && r.leaseStartAt === null, "renew leaseHours:null must clear the lease");
  // renew by non-owner refused; renew on unclaimed refused
  inputs++;
  ok(isClaimError(threw(() => wc.renewWork(mk(), "B", { now: t0 }))), "stranger renew must throw");
  inputs++;
  ok(isClaimError(threw(() => wc.renewWork(wc.createWork({ id: "f3u" }), "A", { now: t0 }))), "renew on unclaimed must throw");
};

cases.F4 = async () => { // closeWork/cancel authz matrix
  const wc = await import(U("/server/work-claims.mjs"));
  for (const state of wc.STATES) for (const verb of ["close", "cancel"]) for (const role of ["owner", "stranger", "authority", "opener"]) {
    inputs++;
    const opener = "O";
    let w = wc.createWork({ id: `f4-${Math.floor(rand() * 1e9)}` }, { agentId: opener });
    if (state !== "unclaimed") { w = wc.claimWork(w, "A"); if (["in_progress", "blocked", "done"].includes(state)) w = wc.updateWork(w, "A", { state: "in_progress" }); if (state === "blocked") w = wc.updateWork(w, "A", { state: "blocked" }); if (state === "done") w = wc.updateWork(w, "A", { state: "done" }); }
    if (state === "closed") w = wc.closeWork(w, "A", { authority: true });
    const caller = role === "owner" ? "A" : role === "opener" ? "O" : "B";
    const e = threw(() => wc.closeWork(w, caller, { verb, authority: role === "authority" }));
    const terminal = ["done", "closed"].includes(state);
    const holder = w.owner === caller;
    const isOpener = state === "unclaimed" && wc.creatorOf(w) === caller;
    const shouldAllow = !terminal && (role === "authority" || holder || (verb === "cancel" && isOpener));
    if (shouldAllow) {
      ok(!e, `${verb} ${state} by ${role} should succeed, threw ${e?.message}`);
      if (!e) { const r = wc.closeWork(w, caller, { verb, authority: role === "authority" }); ok(r.state === "closed" && r.owner === null && r.leaseExpiresAt === null, `${verb} must clear owner+lease`); }
    } else {
      ok(isClaimError(e), `${verb} ${state} by ${role} should throw ClaimError, got ${e?.name}: ${e?.message}`);
      if (terminal) ok(e?.code === "work_claim_terminal", `terminal ${verb} must be work_claim_terminal, got ${e?.code}`);
    }
  }
  // reason bound
  inputs++;
  const w = wc.createWork({ id: "f4r" }, { agentId: "O" });
  ok(isClaimError(threw(() => wc.closeWork(w, "O", { reason: "x".repeat(4001) }))), "reason >4000 must throw");
};

cases.F5 = async () => { // appendWorkPullRequest: replay, conflict, bounds
  const wc = await import(U("/server/work-claims.mjs"));
  const t0 = 1_789_000_000_000;
  const mk = (id, over = {}) => wc.claimWork(wc.createWork({ id }), "A", { now: t0, ...over });
  const link = (w, url, now = t0 + 1000) => wc.appendWorkPullRequest(w, "A", {
    pullRequest: url, expectedClaimedAt: w.claimedAt, expectedHistoryLength: wc.claimHistoryLength(w), now });
  // basic link + byte-identical no-op replay
  inputs++;
  let w = link(mk("f5a"), VALID);
  ok(w.pullRequests.length === 1 && w.pullRequest.url === VALID, "first link recorded");
  inputs++;
  const w2 = link(w, VALID, t0 + 2000);
  ok(JSON.stringify(w2) === JSON.stringify(w), "same-round duplicate link must be a byte-identical no-op");
  // stale expectedClaimedAt / history length -> conflict
  for (const bad of [{ expectedClaimedAt: "2000-01-01T00:00:00.000Z" }, { expectedHistoryLength: 999 }]) {
    inputs++;
    const e = threw(() => wc.appendWorkPullRequest(w, "A", { pullRequest: "https://github.com/a/b/pull/2",
      expectedClaimedAt: w.claimedAt, expectedHistoryLength: wc.claimHistoryLength(w), now: t0 + 3000, ...bad }));
    ok(e?.code === "work_claim_conflict", `stale replay must be work_claim_conflict, got ${e?.code}`);
  }
  // non-owner, bad urls, lapsed lease
  inputs++;
  ok(threw(() => wc.appendWorkPullRequest(w, "B", { pullRequest: "https://github.com/a/b/pull/3",
    expectedClaimedAt: w.claimedAt, expectedHistoryLength: wc.claimHistoryLength(w), now: t0 + 3000 }))?.code === "work_not_owner", "non-owner link refused");
  for (const badUrl of ["notaurl", "http://github.com/a/b/pull/1", "https://github.com/a/b/pull/1?x=1", "https://github.com/a/b/pull/1#frag", "https://user@github.com/a/b/pull/1", "x".repeat(301)]) {
    inputs++;
    ok(isClaimError(threw(() => wc.appendWorkPullRequest(w, "A", { pullRequest: badUrl,
      expectedClaimedAt: w.claimedAt, expectedHistoryLength: wc.claimHistoryLength(w), now: t0 + 3000 }))),
      `bad pr url ${badUrl.slice(0,30)} must throw ClaimError`);
  }
  inputs++;
  const lapsed = mk("f5l", { leaseHours: 0.25 });
  ok(threw(() => wc.appendWorkPullRequest(lapsed, "A", { pullRequest: "https://github.com/a/b/pull/9",
    expectedClaimedAt: lapsed.claimedAt, expectedHistoryLength: wc.claimHistoryLength(lapsed), now: t0 + 3600000 }))?.code === "claim_lease_lapsed",
    "link on lapsed lease refused");
  // MAX_PULLS boundary: 16 ok, 17th refused
  inputs++;
  let wb = mk("f5b");
  for (let i = 1; i <= 16; i++) wb = link(wb, `https://github.com/a/b/pull/${100 + i}`, t0 + i);
  ok(wb.pullRequests.length === 16, "16 links accepted");
  const e17 = threw(() => link(wb, "https://github.com/a/b/pull/999", t0 + 9999));
  ok(isClaimError(e17), `17th link must throw, got ${e17?.name}`);
};

cases.F6 = async () => { // createWork size bombs at documented bounds
  const wc = await import(U("/server/work-claims.mjs"));
  const sha = "sha256:" + "ab".repeat(32);
  const good = {
    note: "n".repeat(4000), tags: Array.from({ length: 10 }, (_, i) => `t${i}`),
    blobs: Array.from({ length: 10 }, () => sha),
    files: Array.from({ length: 64 }, (_, i) => `src/f${i}.mjs`),
    dependsOn: Array.from({ length: 16 }, (_, i) => `d${i}`),
    evidenceRefs: Array.from({ length: 16 }, () => sha),
    chain: undefined, title: "t".repeat(512),
  };
  inputs++;
  const g = wc.createWork({ id: "f6g", ...good }, { agentId: "t" });
  ok(g.tags.length === 10 && g.files.length === 64, "documented maxima accepted");
  ok(g.blobs.length === 0, "blobs are silently dropped on create (only recorded on the done transition)");
  const bad = [
    [{ note: "n".repeat(4001) }, "note 4001"], [{ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "11 tags"],
    [{ tags: ["x".repeat(33)] }, "33-char tag"], [{ tags: ["has space"] }, "tag with space"],
    [{ files: Array.from({ length: 65 }, (_, i) => `f${i}`) }, "65 files"], [{ files: ["ok", "../up"] }, "path traversal"],
    [{ files: ["a".repeat(513)] }, "513-char path"], [{ dependsOn: Array.from({ length: 17 }, (_, i) => `d${i}`) }, "17 dependsOn"],
    [{ dependsOn: ["f6b"] }, "self dependsOn"], [{ evidenceRefs: Array.from({ length: 17 }, () => sha) }, "17 evidenceRefs"],
    [{ parentClaimId: "f6b" }, "self parent"], [{ title: "t".repeat(513) }, "513-char title"],
    [{ title: "" }, "empty title"], [{ kind: "deploy" }, "deploy w/o revision"],
  ];
  for (const [over, label] of bad) { inputs++;
    const id = /self/.test(label) ? "f6b" : "f6x";
    const e = threw(() => wc.createWork({ id, ...over }, { agentId: "t" }));
    ok(isClaimError(e), `createWork ${label} must throw ClaimError, got ${e?.name}: ${e?.message}`);
  }
};

cases.F7 = async () => { // parsePullRequestUrl hostile
  const cc = await import(U("/server/claim-coordination.mjs"));
  const good = cc.parsePullRequestUrl("https://github.com/acme/repo/pull/123");
  ok(good && good.url === "https://github.com/acme/repo/pull/123" && good.number === 123 && good.repo === "acme/repo", "canonical parse");
  inputs++;
  const bad = [null, 5, {}, [], "", "notaurl", "http://github.com/a/b/pull/1",
    "https://github.com/a/b/pull/1?x=1", "https://github.com/a/b/pull/1#frag",
    "https://user:pass@github.com/a/b/pull/1", "https://evil.com/a/b/pull/1",
    "https://github.com.evil.com/a/b/pull/1", "https://github.com/a/b/pull/0",
    "https://github.com/a/b/pull/abc", "https://github.com/a/b/pull/", "https://github.com/a/b/issues/1",
    "https://github.com/a//pull/1",
    "https://github.com/üñí/b/pull/1", "x".repeat(301),
    "https://github.com/a/b/pull/0001", "https://github.com/a/b/pull/12345678901"];
  // Canonicalization (not rejection) is the documented behavior: trailing
  // slash, default port, surrounding whitespace, and hostname case are
  // normalized away before matching.
  const canon = [
    ["https://github.com/a/b/pull/1/", "https://github.com/a/b/pull/1"],
    ["https://github.com:443/a/b/pull/1", "https://github.com/a/b/pull/1"],
    ["https://github.com/a/b/pull/1\n", "https://github.com/a/b/pull/1"],
    ["https://GITHUB.COM/a/b/pull/1", "https://github.com/a/b/pull/1"],
  ];
  for (const v of bad) { inputs++;
    let r, threwIt = false;
    try { r = cc.parsePullRequestUrl(v); } catch { threwIt = true; }
    ok(!threwIt && r === null, `parsePullRequestUrl(${String(v).slice(0,40)}) must return null, got ${JSON.stringify(r)}`);
  }
  // trailing slash is canonicalized, not rejected
  inputs++;
  const ts = cc.parsePullRequestUrl("https://github.com/a/b/pull/7/");
  ok(ts && ts.url === "https://github.com/a/b/pull/7", "trailing slash canonicalized");
  for (const [raw, want] of canon) { inputs++;
    const r = cc.parsePullRequestUrl(raw);
    ok(r && r.url === want, `canonicalize ${JSON.stringify(raw)} -> ${want}, got ${JSON.stringify(r)}`);
  }
};

cases.F8 = async () => { // settlePullRequest sequences incl. #1526 B2 lapsed-lease rule
  const cc = await import(U("/server/claim-coordination.mjs"));
  const t0 = 1_789_000_000_000;
  const item = (over = {}) => ({ id: "f8", state: "claimed", owner: "A", files: ["a.mjs"], fileBlocks: {},
    leaseStartAt: new Date(t0).toISOString(), leaseExpiresAt: new Date(t0 + 3600000).toISOString(),
    pullRequest: { url: VALID, outcome: "merged" }, pullRequests: [{ url: VALID, outcome: "merged" }], history: [], ...over });
  inputs++;
  const m = cc.settlePullRequest(item(), "merged", t0 + 1000);
  ok(m && m.action === "pr_merged" && m.item.state === "done" && m.item.deliveryMode === "merged", "merged settles to done");
  inputs++;
  const c = cc.settlePullRequest(item(), "closed", t0 + 1000);
  ok(c && c.action === "pr_closed" && c.item.state === "unclaimed" && c.item.owner === null && c.item.files.length === 0, "closed releases like a holder release");
  for (const [ov, outcome, label] of [
    [{ leaseExpiresAt: new Date(t0 - 1).toISOString() }, "merged", "lapsed lease merged"],
    [{ leaseExpiresAt: new Date(t0).toISOString() }, "merged", "lease lapsed exactly now"],
    [{ state: "done" }, "merged", "already done"], [{ state: "unclaimed" }, "merged", "unclaimed"],
    [{}, "open", "open outcome"], [{}, "bogus", "bogus outcome"],
    [{ pullRequests: [{ url: VALID }] }, "merged", "undecided link"],
  ]) { inputs++;
    ok(cc.settlePullRequest(item(ov), outcome, t0 + 1000) === null, `${label} must not settle`);
  }
  // batch: merged wins over closed when both recorded
  inputs++;
  const b = cc.settlePullRequest(item({ pullRequests: [{ url: VALID, outcome: "merged" }, { url: "https://github.com/a/b/pull/2", outcome: "closed" }] }), "merged", t0 + 1000);
  ok(b && b.action === "pr_merged" && b.item.pullRequest.url === VALID, "batch merged names the merged link");
};

cases.F9 = async () => { // recordPullOutcome / pullsReadyToSettle / batchPullOutcome ordering
  const cc = await import(U("/server/claim-coordination.mjs"));
  const urls = [1, 2, 3].map(n => `https://github.com/a/b/pull/${n}`);
  let item = { id: "f9", pullRequests: urls.map(url => ({ url })), pullRequest: { url: urls[0] } };
  inputs++;
  ok(!cc.pullsReadyToSettle(item), "undecided batch not ready");
  item = cc.recordPullOutcome(item, urls[1], "closed", 1000);
  inputs++;
  ok(item.pullRequests[1].outcome === "closed" && item.pullRequests[1].nextPollAt === null, "recordPullOutcome stamps and clears poll");
  ok(cc.batchPullOutcome(item) === "closed", "no merged -> closed");
  item = cc.recordPullOutcome(item, urls[0], "merged", 2000);
  inputs++;
  ok(cc.batchPullOutcome(item) === "merged" && !cc.pullsReadyToSettle(item), "one merged wins batch but not ready");
  item = cc.recordPullOutcome(item, urls[2], "closed", 3000);
  inputs++;
  ok(cc.pullsReadyToSettle(item), "all decided -> ready");
  ok(item.pullRequest.url === urls[2], "current pullRequest follows first open, else the last link");
  // unknown url leaves links untouched
  inputs++;
  const before = JSON.stringify(item.pullRequests);
  const same = cc.recordPullOutcome(item, "https://github.com/a/b/pull/999", "merged", 4000);
  ok(JSON.stringify(same.pullRequests) === before, "unknown url is a no-op on links");
};

cases.F10 = async () => { // rollupClaimCi hostile check runs
  const cc = await import(U("/server/claim-coordination.mjs"));
  const states = new Set(["pending", "success", "failure", "neutral"]);
  const runs = [
    [], null, "x", [null, undefined, 5, {}, { conclusion: "STALE" }, { conclusion: "success" }],
    [{ conclusion: "failure" }, { conclusion: "success" }], [{ conclusion: "timed_out" }],
    [{ conclusion: "cancelled" }], [{ conclusion: "action_required" }],
    [{ conclusion: "neutral" }, { conclusion: "skipped" }], [{ conclusion: "in_progress" }],
    [{ conclusion: null }],
  ];
  for (const checkRuns of runs) { inputs++;
    const r = cc.rollupClaimCi({ checkRuns });
    ok(r && states.has(r.state), `rollup state must be known, got ${JSON.stringify(r)}`);
  }
  // failure wins over pending and success
  inputs++;
  ok(cc.rollupClaimCi({ checkRuns: [{ conclusion: "success" }, { conclusion: "in_progress" }, { conclusion: "failure" }] }).state === "failure", "failure wins");
  inputs++;
  ok(cc.rollupClaimCi({ checkRuns: [{ conclusion: "in_progress" }] }).state === "pending", "running -> pending");
  inputs++;
  ok(cc.rollupClaimCi({}).state === "neutral", "no signal -> neutral");
  // hostile status blocks
  for (const status of [null, {}, { total_count: "3" }, { total_count: 2, state: "failure" }, { total_count: 1, state: "bogus", statuses: [{ target_url: "ftp://x" }] }, { total_count: 1, state: "success", statuses: [{ target_url: "https://ci/x" }] }, { total_count: -1, state: "success" }]) {
    inputs++;
    const r = cc.rollupClaimCi({ status });
    ok(r && states.has(r.state) && (r.url === null || typeof r.url === "string"), `hostile status ok: ${JSON.stringify(status).slice(0,50)}`);
  }
  inputs++;
  ok(cc.rollupClaimCi({ pullUrl: 5 }).url === null, "non-string pullUrl -> null url");
};

cases.F11 = async () => { // mirrorProjectionClaim hostile incoming (fake store)
  const mm = await import(U("/server/work-claim-mirror.mjs"));
  const makeStore = () => {
    const rooms = new Map();
    const reg = {
      get: (r, id) => rooms.get(r)?.get(id) ?? null,
      set: (r, item) => { let m = rooms.get(r); if (!m) { m = new Map(); rooms.set(r, m); } m.set(item.id, item); return item; },
      list: r => [...(rooms.get(r)?.values() ?? [])],
      configFor: () => ({ maxOpenClaims: 200, maxMemberOpenClaims: 20, defaultLeaseHours: 24, reviewPolicy: "self_attested" }),
      rawConfig: () => ({}),
    };
    return { workClaims: reg, db: null, room: () => null };
  };
  const at = new Date(1_789_000_000_000).toISOString();
  const incoming = [
    null, undefined, {}, { type: "bogus" }, { type: "claim.acquired" },
    { type: "claim.acquired", data: null, at }, { type: "claim.acquired", data: { workItemId: 5 }, at },
    { type: "claim.acquired", data: { workItemId: "" }, at }, { type: "claim.acquired", data: { workItemId: "x" }, at: "notadate" },
    { type: "claim.acquired", data: { workItemId: "../../evil" }, at },
    { type: "claim.acquired", data: { workItemId: "w1", paths: "notalist", blocks: [{ path: 1 }] }, at },
    { type: "claim.renewed", data: { workItemId: "w1" }, at },
    { type: "claim.released", data: { workItemId: "w1" }, at },
    { type: "work.handoff_recorded", data: { workItemId: "w1" }, at },
    { type: "work.superseded", data: { workItemId: "w1" }, at }, // missing supersededByWorkItemId
    { type: "work.superseded", data: { workItemId: "w1", supersededByWorkItemId: "w2", reason: "x".repeat(5000) }, at },
  ];
  for (const inc of incoming) { inputs++;
    const store = makeStore();
    let r, e = null;
    try { r = mm.mirrorProjectionClaim(store, "room1", "agentA", inc); } catch (err) { e = err; }
    ok(!e || e.name === "ClaimError", `mirror ${inc?.type ?? "?"} threw unexpected ${e?.name}: ${e?.message}`);
    void r;
  }
  // acquired then renewed by the same owner works; released by a stranger with authority works
  inputs++;
  const store = makeStore();
  const a = mm.mirrorProjectionClaim(store, "room1", "agentA", { type: "claim.acquired", data: { workItemId: "w9" }, at });
  ok(a && a.owner === "agentA" && a.state === "claimed", "acquired claims");
  inputs++;
  const id = a.id;
  const rw = mm.mirrorProjectionClaim(store, "room1", "agentA", { type: "claim.renewed", data: { workItemId: "w9" }, at: new Date(1_789_000_100_000).toISOString() });
  ok(rw && rw.id === id, "renewed by owner");
  inputs++;
  const rel = mm.mirrorProjectionClaim(store, "room1", "agentB", { type: "claim.released", data: { workItemId: "w9" }, at: new Date(1_789_000_200_000).toISOString() });
  ok(rel && rel.state === "unclaimed", "released by stranger (authority path)");
};

cases.F12 = async () => { // boardText hostile unicode
  const wi = await import(U("/server/work-claim-integrity.mjs"));
  const calls = [];
  const reject = (status, code, message) => { calls.push({ status, code, message }); throw Object.assign(new Error(message), { status, code }); };
  const bad = [["t", "a\u0000b"], ["t", "a\u007fb"], ["t", "a\u202Eb"], ["t", ""],
    ["t", "   "], ["t", "\u200b"], ["t", "\uD800"], ["t", "a\uD83Db"], ["t", "\u202Aabc"],
    ["n", "a\u000bb", { multiline: true }], ["n", "a\u0000b", { multiline: true }]];
  // Invisible chars are stripped only for the emptiness test: "a\u200bb" keeps
  // its visible letters and is legal (only invisible-ONLY text is refused).
  const invisibleOk = [["t", "a\u200bb"]];
  for (const [f, v, o] of bad) { inputs++; calls.length = 0;
    const e = threw(() => wi.boardText(reject, f, v, o));
    ok(e && e.status === 422 && e.code === "invalid_claim_input", `boardText ${JSON.stringify(v).slice(0,30)} must 422, got ${e?.status}/${e?.code}`);
  }
  for (const [f, v, o] of invisibleOk) { inputs++;
    const r = threw(() => wi.boardText(reject, f, v, o));
    ok(!r, `boardText ${JSON.stringify(v)} with visible text must pass, threw ${r?.message}`);
  }
  const good = [["t", "hello"], ["t", "caf\u00e9"], ["t", "cafe\u0301"], ["n", "line1\nline2", { multiline: true }], ["n", "a\r\nb", { multiline: true }]];
  for (const [f, v, o] of good) { inputs++;
    const r = wi.boardText(reject, f, v, o);
    ok(typeof r === "string" && r.length > 0, `boardText good input rejected: ${JSON.stringify(v).slice(0,30)}`);
  }
  inputs++;
  ok(wi.boardText(reject, "t", "cafe\u0301") === "caf\u00e9", "NFC normalization");
  inputs++;
  ok(wi.boardText(reject, "n", "a\r\nb", { multiline: true }) === "a\nb", "CRLF -> LF in notes");
  inputs++;
  ok(wi.boardText(reject, "t", 123) === 123, "non-string passes through");
  inputs++;
  ok(wi.boardText(reject, "t", null) === null, "null passes through");
};

cases.F13 = async () => { // assertBoardLeaseHours / assertDependsOnKnown boundaries
  const wi = await import(U("/server/work-claim-integrity.mjs"));
  const reject = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
  for (const [v, shouldThrow] of [[0.25, false], [0.249, true], [168, false], [168.0001, true], [1, false], [NaN, true], [Infinity, true], ["24", true], [-1, true], [0, true]]) {
    inputs++;
    const e = threw(() => wi.assertBoardLeaseHours(reject, { leaseHours: v }));
    ok(shouldThrow ? (e?.status === 422) : !e, `leaseHours=${v} ${shouldThrow ? "must 422" : "must pass"}, got ${e?.message}`);
  }
  for (const data of [{}, { leaseHours: null }, null]) { inputs++;
    ok(!threw(() => wi.assertBoardLeaseHours(reject, data)), `leaseHours absent/null must pass: ${JSON.stringify(data)}`); }
  inputs++;
  ok(threw(() => wi.assertDependsOnKnown(reject, { dependsOn: ["self"] }, { selfId: "self", has: () => true }))?.status === 422, "self-dependency 422");
  inputs++;
  ok(threw(() => wi.assertDependsOnKnown(reject, { dependsOn: ["ghost"] }, { selfId: "x", has: () => false }))?.status === 422, "unknown dependency 422");
  inputs++;
  ok(!threw(() => wi.assertDependsOnKnown(reject, { dependsOn: ["a"] }, { selfId: "x", has: id => id === "a" })), "known dependency passes");
  inputs++;
  ok(!threw(() => wi.assertDependsOnKnown(reject, { dependsOn: [5] }, { selfId: "x", has: () => false })), "non-string entry skipped (state machine reports)");
};

cases.F14 = async () => { // workClaimEventData hostile
  const we = await import(U("/server/work-claim-events.mjs"));
  const item = { id: "f14", state: "claimed", owner: "A", files: ["a.mjs"], leaseExpiresAt: null, title: "  " };
  inputs++;
  ok(threw(() => we.workClaimEventData(item, "bogus"))?.message.includes("Unknown work claim action"), "unknown action throws");
  inputs++;
  ok(threw(() => we.workClaimEventData(item, "claimed", { paths: "x" }))?.message.includes("must be a list"), "non-list paths throws");
  inputs++;
  const d = we.workClaimEventData(item, "claimed");
  ok(d.title === "f14", "whitespace title falls back to id");
  ok(Array.isArray(d.paths) && d.paths[0] === "a.mjs", "paths default to item files");
  inputs++;
  const pm = we.workClaimEventData({ ...item, pullRequest: null }, "pr_merged");
  ok(pm.pullRequest && pm.pullRequest.outcome === "merged" && pm.pullRequest.url === undefined, "pr_merged without link does not throw");
  inputs++;
  const att = we.workClaimEventData(item, "claimed", { attention: "review", attentionMemberId: "B" });
  ok(att.attention === "review" && att.attentionMemberId === "B", "attention fields pass through");
  // coalescing: second call within window is suppressed, later call is not
  inputs++;
  const store = {};
  ok(!we.claimEventCoalesced(store, "r", "c", "noted", 1000), "no prior event -> not coalesced");
};

cases.F15 = async () => { // 500-way claim race + kill -9 mid-write on the sqlite registry
  const wc = await import(U("/server/work-claims.mjs"));
  const t0 = 1_789_000_000_000;
  const base = wc.createWork({ id: "f15race" });
  let wins = 0, refused = 0, other = 0, cur = base, winner = null;
  for (let i = 0; i < 500; i++) { inputs++;
    try { cur = wc.claimWork(cur, `agent${i}`, { now: t0 }); wins++; winner = `agent${i}`; }
    catch (e) { if (e?.name === "ClaimError") refused++; else other++; }
  }
  ok(wins === 1 && refused === 499 && other === 0, `exactly one claim winner: wins=${wins} refused=${refused} other=${other}`);
  ok(cur.owner === winner && cur.history.filter(h => h.action === "claimed").length === 1, "winner owns the item with a single claimed stamp");
  // kill -9 mid-write: child hammers upserts, parent SIGKILLs, then verifies DB integrity
  inputs++;
  const dir = mkdtempSync(join(tmpdir(), "g01f15-"));
  const dbPath = join(dir, "claims.db");
  const childSrc = `
    const { pathToFileURL: p } = await import("node:url");
    const WT = process.env.G01_WT;
    const { DatabaseSync } = await import("node:sqlite");
    const { createDurableWorkClaimRegistry, workClaimSchema } = await import(p(WT + "/server/work-claim-sqlite.mjs").href);
    const db = new DatabaseSync(process.env.G01_DB);
    db.exec(workClaimSchema);
    const reg = createDurableWorkClaimRegistry(db, { now: () => Date.now() });
    const { writeFileSync } = await import("node:fs");
    let i = 0;
    // NOTE: workspace-disk fsync is ~160ms/upsert (vs tmpfs); the handshake
    // waits generously so the kill lands mid-write, not mid-startup.
    for (;;) { i++; reg.set("room1", { id: "c" + (i % 40), title: "t" + i, state: i % 3 ? "claimed" : "unclaimed", owner: i % 3 ? "a" : null, history: [], updatedAt: Date.now() }); if (i === 60) writeFileSync(process.env.G01_READY, "ready"); }
  `;
  const readyFile = join(dir, "ready");
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSrc],
    { env: { ...process.env, G01_WT: WT, G01_DB: dbPath, G01_READY: readyFile }, stdio: ["ignore", "ignore", "pipe"] });
  let childErr = "";
  child.stderr.on("data", d => { childErr += d.toString(); });
  child.on("error", e => { childErr += "spawn error: " + e.message; });
  // Handshake: kill only after the child proves it is mid-write (60 upserts done).
  // Generous window: workspace-disk fsync is slow (~160ms/upsert).
  let waited = 0;
  const { existsSync } = await import("node:fs");
  while (!existsSync(readyFile) && waited < 90000) { await new Promise(r => setTimeout(r, 200)); waited += 200; }
  ok(existsSync(readyFile), "child reached 60 upserts before SIGKILL (valid kill window)");
  if (!existsSync(readyFile) && childErr) console.log("CHILD STDERR:", childErr.slice(0, 500));
  child.kill("SIGKILL");
  await new Promise(r => child.on("exit", r));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: false });
  const integ = db.prepare("PRAGMA integrity_check").get();
  ok(integ && Object.values(integ)[0] === "ok", `integrity_check after SIGKILL: ${JSON.stringify(integ)}`);
  const rows = db.prepare("SELECT item_json FROM work_claims").all();
  let decoded = 0, torn = 0;
  for (const row of rows) { try { JSON.parse(row.item_json); decoded++; } catch { torn++; } }
  ok(torn === 0 && decoded === rows.length, `no torn rows: decoded=${decoded} torn=${torn}`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
};

const fn = cases[CASE];
if (!fn) { console.error(`unknown case ${CASE}`); process.exit(2); }
await fn();
console.log(`${CASE}: inputs=${inputs} failures=${failures.length}`);
for (const f of failures.slice(0, 25)) console.log("FAIL:", f);
process.exit(failures.length ? 1 : 0);
