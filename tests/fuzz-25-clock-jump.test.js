// WAVE-400 fuzz worker 25: clock-jump chaos on lease logic (test-only).
// Targets server/work-claims.mjs: renewWork, isLeaseExpired, releaseExpired,
// and the `now` plumbing (claimWork / updateWork / appendWorkPullRequest).
//
// Invariants under test:
//  1. A backward clock jump NEVER resurrects an expired lease into valid
//     (expiry is sticky once observed at the max `now` seen).
//  2. A forward jump expires exactly the leases past their deadline: no
//     premature release of valid leases, no lease surviving past deadline.
//  3. claimedAt / leaseStartAt never land in the future of the max `now` seen.
//  4. releaseExpired is idempotent under repeated calls with the same now.
//  5. Poisoned `now` (NaN, Infinity, garbage) is rejected.
//
// node:test + node:assert/strict, hand-rolled mulberry32, deterministic per seed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimWork, renewWork, updateWork, isLeaseExpired, releaseExpired,
  appendWorkPullRequest, claimHistoryLength, ClaimError, ACTIVE_CLAIM_STATES,
} from "../server/work-claims.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-25] clock-jump lease fuzz seed=${SEED}`);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = arr => arr[Math.floor(rng() * arr.length)];

const BASE = 1790000000000; // fixed base (~2026-09-21T15:13:20Z), deterministic
const SEC = 1000, HOUR = 3600 * SEC, DAY = 24 * HOUR;
const msOf = iso => Date.parse(iso);
const throwsClaimError = fn => assert.throws(fn, e => e instanceof ClaimError);

// ---------------------------------------------------------------------------
// Targeted: poisoned `now` values are rejected everywhere a `now` is taken.
// ---------------------------------------------------------------------------
test("poisoned now values are rejected (NaN must be rejected)", () => {
  const item = claimWork({ id: "fz25-poison" }, "jill", { now: BASE, leaseHours: 1 });
  const poisoned = [NaN, Infinity, -Infinity, "not-a-date", "", null, true, {}];
  for (const bad of poisoned) {
    assert.throws(() => isLeaseExpired(item, bad), /./, `isLeaseExpired accepted ${String(bad)}`);
    assert.throws(() => releaseExpired([item], bad), /./, `releaseExpired accepted ${String(bad)}`);
    assert.throws(() => claimWork({ id: "x" }, "jill", { now: bad }), /./, `claimWork accepted ${String(bad)}`);
    assert.throws(() => renewWork(item, "jill", { now: bad }), /./, `renewWork accepted ${String(bad)}`);
    assert.throws(() => updateWork(item, "jill", { note: "n", now: bad }), /./, `updateWork accepted ${String(bad)}`);
  }
  // now=undefined means "real clock" by design; now=0 is a valid epoch.
  const atZero = claimWork({ id: "fz25-zero" }, "jill", { now: 0, leaseHours: 1 });
  assert.equal(atZero.claimedAt, new Date(0).toISOString());
  assert.equal(isLeaseExpired(atZero, 0), false);
  assert.equal(isLeaseExpired(atZero, HOUR + 1), true);
});

test("deadline boundary semantics are exact and consistent", () => {
  const owner = "jill";
  const mk = id => claimWork({ id }, owner, { now: BASE, leaseHours: 1 });
  const deadline = msOf(mk("fz25-b0").leaseExpiresAt);
  // At the exact deadline the lease has lapsed (<= semantics), one ms before it has not.
  assert.equal(isLeaseExpired(mk("fz25-b1"), deadline), true);
  assert.equal(isLeaseExpired(mk("fz25-b2"), deadline - 1), false);
  // Sweep releases exactly at/past the deadline, never before.
  assert.equal(releaseExpired([mk("fz25-b3")], deadline)[0].state, "unclaimed");
  assert.equal(releaseExpired([mk("fz25-b4")], deadline + 1)[0].state, "unclaimed");
  assert.equal(releaseExpired([mk("fz25-b5")], deadline - 1)[0].state, "claimed");
  // Renew is refused exactly at the deadline (consistent with the lapsed read)...
  throwsClaimError(() => renewWork(mk("fz25-b6"), owner, { now: deadline }));
  // ...and succeeds one ms before, extending the window by the room default (24h).
  const early = renewWork(mk("fz25-b7"), owner, { now: deadline - 1 });
  assert.equal(msOf(early.leaseExpiresAt), deadline - 1 + 24 * HOUR);
  assert.equal(early.claimedAt, new Date(BASE).toISOString()); // renew never moves claimedAt
});

// ---------------------------------------------------------------------------
// The fuzz core: random clock-jump sequences against the lease state machine.
// ---------------------------------------------------------------------------
const LEASE_POOL = [0.001, 0.25, 1, 24, 168, null]; // null = opted out, never expires
const OWNER = "fuzz-owner";

function runSequence(seqNo) {
  const violations = [];
  const log = [];
  const note = (kind, detail) => {
    const hit = violations.find(v => v.kind === kind);
    if (hit) { hit.count += 1; return; }
    violations.push({ kind, detail, count: 1, log: [...log] });
  };

  let nowMs = BASE + Math.floor(rng() * 1e6);
  let maxNow = nowMs;
  const setNow = (v, why) => { nowMs = v; if (v > maxNow) maxNow = v; log.push(`${why} now=${v}`); };
  // Exercise the `now` plumbing across all accepted representations.
  const nowArg = () => {
    const s = rng();
    if (s < 0.8) return nowMs;
    if (s < 0.9) return new Date(nowMs).toISOString();
    return new Date(nowMs);
  };

  let item;
  try {
    item = claimWork({ id: `fz25-${seqNo}`, title: `fz25-${seqNo}` }, OWNER, { now: nowArg(), leaseHours: pick(LEASE_POOL) });
  } catch (e) {
    note("claim-threw", `claimWork threw: ${e}`);
    return violations;
  }
  log.push(`claim leaseHours=${item.leaseExpiresAt === null ? "null" : (msOf(item.leaseExpiresAt) - msOf(item.claimedAt)) / HOUR + "h"}`);

  // Sticky-expiry tracking: once isLeaseExpired(item, maxNow) is observed
  // true for the current leaseExpiresAt, the lease must never become valid
  // again under that same expiry (forward-only maxNow keeps the read stable).
  let sticky = false, stickyExpiry = null;
  const refreshSticky = () => {
    if (item.leaseExpiresAt !== stickyExpiry) { sticky = false; stickyExpiry = item.leaseExpiresAt; }
    if (!sticky && item.leaseExpiresAt !== null && isLeaseExpired(item, maxNow)) sticky = true;
  };
  const checkTimeBounds = where => {
    if (item.claimedAt !== null && msOf(item.claimedAt) > maxNow)
      note("future-claimedAt", `${where}: claimedAt ${item.claimedAt} > maxNow ${maxNow}`);
    if (item.leaseStartAt !== null && msOf(item.leaseStartAt) > maxNow)
      note("future-leaseStart", `${where}: leaseStartAt ${item.leaseStartAt} > maxNow ${maxNow}`);
    for (const h of item.history) {
      const t = msOf(h.at);
      if (!Number.isFinite(t) || t > maxNow) note("future-history-stamp", `${where}: history stamp ${h.at} invalid or > maxNow ${maxNow}`);
    }
  };
  refreshSticky();
  checkTimeBounds("claim");

  const nOps = 3 + Math.floor(rng() * 9);
  for (let i = 0; i < nOps; i++) {
    const op = Math.floor(rng() * 8);
    try {
      if (op === 0) {
        // --- clock jump -------------------------------------------------
        const exp = item.leaseExpiresAt === null ? null : msOf(item.leaseExpiresAt);
        const claimed = item.claimedAt === null ? null : msOf(item.claimedAt);
        const jumps = [
          ["+1s", nowMs + SEC], ["+1h", nowMs + HOUR], ["+24h", nowMs + DAY],
          ["+30d", nowMs + 30 * DAY], ["+1y", nowMs + 365 * DAY],
          ["-1s", nowMs - SEC], ["-1h", nowMs - HOUR], ["-24h", nowMs - DAY],
          ["-30d", nowMs - 30 * DAY], ["to-0", 0],
        ];
        if (exp !== null) jumps.push(["to-exact-deadline", exp], ["to-deadline-1", exp - 1], ["to-deadline+1", exp + 1]);
        if (claimed !== null) jumps.push(["back-past-claimedAt", claimed - SEC]);
        const [label, target] = pick(jumps);
        setNow(target, `jump ${label}`);
      } else if (op === 1) {
        // --- expiry probe ----------------------------------------------
        const na = nowArg();
        const got = isLeaseExpired(item, na);
        assert.equal(typeof got, "boolean");
        const exp = item.leaseExpiresAt;
        const want = ACTIVE_CLAIM_STATES.includes(item.state) && exp !== null && msOf(exp) <= nowMs;
        if (got !== want) note("probe-mismatch", `isLeaseExpired=${got} but deadline math says ${want} at now=${nowMs}`);
      } else if (op === 2) {
        // --- sweep ------------------------------------------------------
        const before = JSON.parse(JSON.stringify(item));
        const out = releaseExpired([item], nowArg())[0];
        log.push(`sweep -> ${out.state}`);
        const exp = before.leaseExpiresAt;
        const shouldRelease = ACTIVE_CLAIM_STATES.includes(before.state) && exp !== null && msOf(exp) <= nowMs;
        if (shouldRelease) {
          if (!(out.state === "unclaimed" && out.owner === null && out.leaseExpiresAt === null && out.leaseStartAt === null))
            note("sweep-survival", `lease past deadline survived sweep at now=${nowMs} (deadline ${exp})`);
          if (out.history.length !== before.history.length + 1)
            note("sweep-history", `release did not stamp exactly one history entry`);
        } else if (out.state !== before.state || out.owner !== before.owner || out.leaseExpiresAt !== before.leaseExpiresAt) {
          note("premature-release", `valid lease released early at now=${nowMs} (deadline ${exp}, state ${before.state})`);
        }
        // Idempotency: a second sweep with the same now must change nothing.
        const out2 = releaseExpired([out], nowArg())[0];
        const fp = x => JSON.stringify([x.state, x.owner, x.claimedAt, x.leaseStartAt, x.leaseExpiresAt,
          x.history.length, x.historyOmitted ?? 0, x.history.map(h => h.action).join(",")]);
        if (fp(out2) !== fp(out)) note("double-release", `second sweep with same now changed claim state`);
        const outKeys = Object.keys(out);
        const missing = outKeys.filter(k => !(k in out2));
        const extra = Object.keys(out2).filter(k => !(k in out));
        if (missing.length || extra.length || JSON.stringify(out) !== JSON.stringify(out2))
          note("sweep-not-byte-idempotent", `second sweep altered item shape: dropped=[${missing}] added=[${extra}]`);
        item = out;
      } else if (op === 3) {
        // --- renew ------------------------------------------------------
        const wasSticky = sticky;
        const r = rng();
        const opts = r < 0.7 ? {} : r < 0.85 ? { leaseHours: pick([0.5, 1, 24]) } : { leaseHours: null, note: "dropping lease" };
        const na = nowArg();
        try {
          const renewed = renewWork(item, OWNER, { ...opts, now: na });
          log.push(`renew ok -> expiry=${renewed.leaseExpiresAt}`);
          if (wasSticky) {
            note("resurrect-renew",
              `renewWork SUCCEEDED at now=${nowMs} after lease expiry was observed at maxNow=${maxNow} — backward clock resurrected a lapsed lease (new expiry ${renewed.leaseExpiresAt})`);
          } else {
            const eff = opts.leaseHours === null ? null : (opts.leaseHours ?? 24);
            const wantExp = eff === null ? null : nowMs + eff * HOUR;
            if ((renewed.leaseExpiresAt === null) !== (wantExp === null) ||
                (wantExp !== null && msOf(renewed.leaseExpiresAt) !== wantExp))
              note("renew-expiry-math", `renewed expiry ${renewed.leaseExpiresAt} != now+${eff}h`);
            if (renewed.claimedAt !== item.claimedAt || renewed.owner !== OWNER)
              note("renew-mutated-identity", `renew changed claimedAt/owner`);
            if (renewed.history.length !== item.history.length + 1)
              note("renew-history", `renew did not stamp exactly one history entry`);
          }
          item = renewed;
        } catch (e) {
          if (!(e instanceof ClaimError)) note("renew-foreign-throw", `renewWork threw non-ClaimError: ${e && e.stack || e}`);
          else log.push(`renew refused (${e.code})`);
        }
      } else if (op === 4) {
        // --- PR link (exercises the lapsed-lease guard) ------------------
        const wasSticky = sticky;
        const url = `https://github.com/Uuriko/project-room/pull/${1 + Math.floor(rng() * 5000)}`;
        try {
          const linked = appendWorkPullRequest(item, OWNER, {
            pullRequest: url,
            expectedClaimedAt: item.claimedAt,
            expectedHistoryLength: claimHistoryLength(item),
            now: nowArg(),
          });
          log.push(`link ok`);
          if (wasSticky) note("resurrect-link",
            `appendWorkPullRequest SUCCEEDED at now=${nowMs} after lease expiry was observed at maxNow=${maxNow} — lapsed-lease guard bypassed by backward clock`);
          item = linked;
        } catch (e) {
          if (!(e instanceof ClaimError)) note("link-foreign-throw", `appendWorkPullRequest threw non-ClaimError: ${e && e.stack || e}`);
          else log.push(`link refused (${e.code})`);
        }
      } else if (op === 5 || op === 6) {
        // --- state transitions / re-claim --------------------------------
        const na = nowArg();
        try {
          if (item.state === "unclaimed") {
            item = claimWork(item, OWNER, { now: na, leaseHours: pick(LEASE_POOL) });
            log.push(`re-claim -> expiry=${item.leaseExpiresAt}`);
          } else {
            const verb = pick(["start", "block", "pause", "release", "finish"]);
            const target = verb === "release" ? "unclaimed" : verb === "finish" ? "done"
              : verb === "start" ? "in_progress" : verb === "block" ? "blocked" : "claimed";
            item = updateWork(item, OWNER, { state: target, now: na });
            log.push(`${verb} -> ${item.state}`);
          }
        } catch (e) {
          if (!(e instanceof ClaimError)) note("update-foreign-throw", `updateWork/claimWork threw non-ClaimError: ${e && e.stack || e}`);
          else log.push(`transition refused (${e.code})`);
        }
      } else {
        // --- maxNow probe: refresh the sticky-expiry observation ---------
        const got = isLeaseExpired(item, maxNow);
        log.push(`probe@maxNow expired=${got}`);
      }
    } catch (e) {
      note("op-foreign-throw", `op ${op} threw outside handler: ${e && e.stack || e}`);
    }
    refreshSticky();
    checkTimeBounds(`op${op}`);
  }

  // Deterministic resurrection probe: forward past the deadline (observe the
  // lapse), jump the clock back before the deadline, then renew. The lapsed
  // lease must NOT come back — expiry is sticky once observed.
  if (item.leaseExpiresAt !== null && ACTIVE_CLAIM_STATES.includes(item.state) && item.owner === OWNER) {
    const exp = msOf(item.leaseExpiresAt);
    setNow(exp + 1, "probe fwd past deadline");
    if (!isLeaseExpired(item, nowMs)) {
      note("probe-not-expired", `lease not reported expired 1ms past deadline`);
    } else {
      refreshSticky();
      setNow(msOf(item.claimedAt) + 1, "probe back before deadline");
      const wasSticky = sticky;
      try {
        const renewed = renewWork(item, OWNER, { now: nowMs });
        if (wasSticky) note("resurrect-renew",
          `deterministic probe: renewWork SUCCEEDED at now=${nowMs} (claimedAt+1) after expiry observed at maxNow=${maxNow}; lapsed lease resurrected, new expiry ${renewed.leaseExpiresAt}`);
        item = renewed;
      } catch (e) {
        if (!(e instanceof ClaimError)) note("renew-foreign-throw", `probe renew threw non-ClaimError: ${e && e.stack || e}`);
        log.push(`probe renew refused (${e.code})`);
      }
      refreshSticky();
      checkTimeBounds("probe");
    }
  }
  return violations;
}

test("5000 clock-jump sequences: lease invariants hold", () => {
  const N = 5000;
  const all = [];
  for (let s = 0; s < N; s++) all.push(...runSequence(s));
  console.log(`[fuzz-25] ran ${N} sequences, seed=${SEED}, violation kinds: ${all.length === 0 ? "none" : all.map(v => `${v.kind}x${v.count}`).join(", ")}`);
  if (all.length > 0) {
    const detail = all.map(v =>
      `--- ${v.kind} (x${v.count})\n    ${v.detail}\n    ops: ${v.log.join(" | ").slice(0, 1200)}`
    ).join("\n");
    assert.fail(`clock-jump invariant violations across ${N} sequences (seed=${SEED}):\n${detail}`);
  }
});
