// WAVE-400 fuzz-04: lease edge-case fuzz for renewWork / isLeaseExpired / releaseExpired.
// TEST-ONLY. Seeded mulberry32 RNG; full cross-product of hostile inputs x states.
// Invariants under test:
//   I1: renew by a non-owner never succeeds and never changes the item.
//   I2: renew at/after expiry never succeeds (expired leases never become un-expired).
//   I3: invalid leaseHours (0, -1, NaN, +-Infinity, >168, non-numbers) is always rejected;
//       no renew/claim ever stores NaN/Infinity expiry.
//   I4: successful renew sets expiry = now + leaseHours (or null on explicit opt-out);
//       result is always un-expired at `now`.
//   I5: renew on terminal/unclaimed/lease-less work always rejects.
//   I6: releaseExpired releases exactly the items where isLeaseExpired(item, now) is true,
//       and clears owner + lease on release.
//   I7: exact-expiry boundary is deterministic: expired at T (parse <= now), live at T-1ms,
//       across repeated runs.
//   I8: inputs are never mutated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWork, claimWork, updateWork, renewWork, isLeaseExpired, releaseExpired,
} from '../server/work-claims.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-04] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const iso = ms => new Date(ms).toISOString();

const OWNER = 'fuzz-owner';
const OTHER = 'fuzz-intruder';
const T0 = Date.parse('2026-10-08T14:00:00.000Z'); // fixed anchor, no Date.now() anywhere

// leaseHours dimension: hostile set + valid set. Expectation table for renew/claim.
const LEASE_HOURS = [
  { v: 0, ok: false }, { v: -1, ok: false }, { v: -0, ok: false },
  { v: NaN, ok: false }, { v: Infinity, ok: false }, { v: -Infinity, ok: false },
  { v: 1e12, ok: false }, { v: 169, ok: false }, { v: 1000, ok: false },
  { v: '5', ok: false }, { v: '24', ok: false }, { v: null, ok: true }, // null = opt out
  { v: undefined, ok: true }, // undefined = room default (24)
  { v: {}, ok: false }, { v: [], ok: false }, { v: true, ok: false },
  { v: 0.5, ok: true }, { v: 1, ok: true }, { v: 24, ok: true }, { v: 168, ok: true },
  { v: 1e-9, ok: true }, { v: 167.999999, ok: true },
];
// Timing offsets relative to the lease expiry instant, in ms.
const WHEN = [-3_600_000, -60_000, -1_001, -1, 0, 1, 1_001, 60_000, 3_600_000];
const CLAIM_STATES = ['claimed', 'in_progress', 'blocked'];
const TERMINAL_STATES = ['done', 'closed'];
const CLAIM_HOURS = 2; // base lease for generated claims

let cases = 0;
let violations = [];
const record = (label, detail) => violations.push(`${label}: ${detail}`);

const validExpiry = exp => exp === null || (typeof exp === 'string' && Number.isFinite(Date.parse(exp)));

function makeClaimed({ state = 'claimed', leaseHours = CLAIM_HOURS, claimAt = T0, owner = OWNER } = {}) {
  const w = createWork({ id: `w-${cases}-${Math.floor(rand() * 1e9)}`, title: 'fuzz' }, { now: claimAt, agentId: 'system' });
  const c = claimWork(w, owner, { leaseHours, now: claimAt });
  if (state === 'claimed') return c;
  // walk the lifecycle legally: claimed -> in_progress -> (blocked | done).
  // (/update excludes close/cancel — those have their own routes — so a
  // closed item is shaped by hand from a done item; both are terminal for
  // renew/releaseExpired purposes.)
  let item = c;
  if (state !== 'claimed') item = updateWork(item, owner, { state: 'in_progress', now: claimAt + 1000 });
  if (state === 'blocked') item = updateWork(item, owner, { state: 'blocked', now: claimAt + 2000 });
  if (state === 'done' || state === 'closed') {
    item = updateWork(item, owner, { state: 'done', now: claimAt + 2000 });
    if (state === 'closed') item = { ...item, state: 'closed' };
  }
  return item;
}
// Field-wise equality ignoring volatile/normalized fields:
//  - updatedAt: BUG-1 — releaseExpired drops it on pass-through.
//  - readingAcks: workOf adds {} where createWork's raw output lacks it (benign).
const stripVolatile = o => { const { updatedAt, readingAcks, ...rest } = o; return rest; };
let bug1Recorded = false;

// ---------- I3: leaseHours validation on renew (cross-product) ----------
test('fuzz: renewWork hostile leaseHours x states x timing x agent', () => {
  const t0 = cases;
  for (const lh of LEASE_HOURS) {
    for (const state of CLAIM_STATES) {
      for (const dt of WHEN) {
        for (const renewer of [OWNER, OTHER]) {
          const item = makeClaimed({ state, leaseHours: CLAIM_HOURS, claimAt: T0 });
          const expiry = Date.parse(item.leaseExpiresAt);
          const now = expiry + dt;
          const snapshot = JSON.stringify(item);
          let out; let threw = null;
          try {
            out = renewWork(item, renewer, { leaseHours: lh.v, now });
          } catch (e) { threw = e; }
          cases++;
          const expectOwnerOk = renewer === OWNER;
          const expectTimeOk = dt < 0; // renew needs parse(expiry) > now, i.e. strictly before expiry
          const expectOk = expectOwnerOk && expectTimeOk && lh.ok;
          if (expectOk) {
            if (threw) { record('renew-unexpected-throw', `lh=${String(lh.v)} state=${state} dt=${dt} renewer=${renewer} threw=${threw.message}`); continue; }
            // I4: expiry shape
            assert.ok(validExpiry(out.leaseExpiresAt), `expiry must be valid ISO or null, got ${out.leaseExpiresAt}`);
            const expectedExp = lh.v === null ? null
              : lh.v === undefined ? expiry - CLAIM_HOURS * 3600_000 + 24 * 3600_000 // not exact; recompute below
              : null;
            void expectedExp;
            const eff = lh.v === null ? null : (lh.v === undefined ? 24 : lh.v);
            const want = eff === null ? null : now + eff * 3600_000;
            if (want === null) {
              assert.equal(out.leaseExpiresAt, null, 'opt-out must clear expiry');
              assert.equal(out.leaseStartAt, null, 'opt-out must clear lease start');
            } else {
              // allow sub-ms float representation via Date.parse round-trip
              assert.ok(Math.abs(Date.parse(out.leaseExpiresAt) - want) < 2,
                `expiry=${out.leaseExpiresAt} want≈${iso(want)} lh=${String(lh.v)} dt=${dt}`);
              // NOTE: sub-millisecond leaseHours (e.g. 1e-9) truncate to the same
              // ms as `now` via toISOString, so the renewed lease is already
              // lapsed at creation — degenerate but allowed by the >0 rule.
              assert.ok(Date.parse(out.leaseExpiresAt) >= now, 'I4: renewed lease must not predate now');
            }
            assert.equal(out.owner, OWNER, 'owner unchanged');
            assert.equal(out.state, state, 'state unchanged');
            assert.ok(Number.isFinite(Date.parse(out.leaseExpiresAt)) || out.leaseExpiresAt === null,
              'I3: no NaN/Infinity stored');
          } else {
            if (!threw) { record('renew-unexpected-success', `lh=${String(lh.v)} state=${state} dt=${dt} renewer=${renewer} expiry=${out.leaseExpiresAt}`); continue; }
            // failure must leave input untouched
            assert.equal(JSON.stringify(item), snapshot, 'I8: failed renew must not mutate input');
          }
          // I1/I2 cross-check: expired lease never revived via renew regardless of renewer
          if (dt >= 0 && !threw) {
            record('expired-revived', `lh=${String(lh.v)} state=${state} dt=${dt} renewer=${renewer}`);
          }
        }
      }
    }
  }
  console.log(`[fuzz-04] renew cross-product cases=${cases - t0}`);
});

// ---------- I5: renew on terminal / unclaimed / lease-less work ----------
test('fuzz: renewWork on terminal, unclaimed, and lease-less claims', () => {
  const t0 = cases;
  for (const state of [...TERMINAL_STATES, 'unclaimed']) {
    for (const renewer of [OWNER, OTHER]) {
      const w = createWork({ id: `t-${cases}`, title: 'fuzz' }, { now: T0, agentId: 'system' });
      let item = w;
      if (state !== 'unclaimed') {
        const c = claimWork(w, OWNER, { leaseHours: 2, now: T0 });
        const ip = updateWork(c, OWNER, { state: 'in_progress', now: T0 + 500 });
        const done = updateWork(ip, OWNER, { state: 'done', now: T0 + 1000 });
        item = state === 'closed' ? { ...done, state: 'closed' } : done;
      }
      let threw = null;
      try { renewWork(item, renewer, { leaseHours: 2, now: T0 + 1000 }); } catch (e) { threw = e; }
      cases++;
      if (!threw) record('renew-terminal-success', `state=${state} renewer=${renewer}`);
    }
  }
  // lease-less (null opt-out at claim time) then renew must fail
  for (const renewer of [OWNER, OTHER]) {
    const w = createWork({ id: `n-${cases}`, title: 'fuzz' }, { now: T0, agentId: 'system' });
    const c = claimWork(w, OWNER, { leaseHours: null, now: T0 });
    assert.equal(c.leaseExpiresAt, null);
    let threw = null;
    try { renewWork(c, renewer, { leaseHours: 2, now: T0 + 1000 }); } catch (e) { threw = e; }
    cases++;
    if (!threw) record('renew-leaseless-success', `renewer=${renewer}`);
  }
  console.log(`[fuzz-04] terminal/unclaimed/lease-less cases=${cases - t0}`);
});

// ---------- renew twice in a row; second renew with hostile leaseHours ----------
test('fuzz: double renew sequences', () => {
  const t0 = cases;
  for (let i = 0; i < 200; i++) {
    const h1 = pick(LEASE_HOURS.filter(l => l.ok)).v;
    const h2 = pick(LEASE_HOURS).v;
    const gap = Math.floor(rand() * 3_600_000);
    const item = makeClaimed({ leaseHours: 2, claimAt: T0 });
    const expiry = Date.parse(item.leaseExpiresAt);
    const now1 = T0 + gap;
    let r1; let threw1 = null;
    try { r1 = renewWork(item, OWNER, { leaseHours: h1, now: now1 }); } catch (e) { threw1 = e; }
    cases++;
    if (now1 < expiry && !threw1) {
      const exp1 = Date.parse(r1.leaseExpiresAt);
      const now2 = now1 + Math.floor(rand() * 600_000);
      const snap = JSON.stringify(r1);
      let r2; let threw2 = null;
      try { r2 = renewWork(r1, OWNER, { leaseHours: h2, now: now2 }); } catch (e) { threw2 = e; }
      cases++;
      const h2ok = LEASE_HOURS.find(l => Object.is(l.v, h2) || l.v === h2)?.ok ?? false;
      const timeOk = now2 < exp1;
      if (h2ok && timeOk) {
        if (threw2) { record('double-renew-throw', `h1=${String(h1)} h2=${String(h2)} ${threw2.message}`); continue; }
        assert.ok(Date.parse(r2.leaseExpiresAt) >= now2 || r2.leaseExpiresAt === null, 'I4 on second renew');
        assert.ok(validExpiry(r2.leaseExpiresAt), 'I3 on second renew');
      } else if (!threw2) {
        record('double-renew-unexpected-success', `h1=${String(h1)} h2=${String(h2)} now2<exp1=${timeOk}`);
      } else {
        assert.equal(JSON.stringify(r1), snap, 'I8: failed second renew must not mutate');
      }
    } else if (now1 < expiry && threw1) {
      record('first-renew-throw', `h1=${String(h1)} gap=${gap} ${threw1.message}`);
    }
  }
  console.log(`[fuzz-04] double-renew cases=${cases - t0}`);
});

// ---------- I7: boundary determinism for isLeaseExpired + renew + releaseExpired ----------
test('fuzz: exact-boundary behavior is deterministic', () => {
  const t0 = cases;
  for (let i = 0; i < 300; i++) {
    const hours = pick([0.5, 1, 2, 24]);
    const item = makeClaimed({ leaseHours: hours, claimAt: T0 });
    const expiry = Date.parse(item.leaseExpiresAt);
    for (const dt of [-1, 0, 1]) {
      const now = expiry + dt;
      // isLeaseExpired: true iff parse <= now
      const exp = isLeaseExpired(item, now);
      cases++;
      if (exp !== (dt >= 0)) record('boundary-expired-flip', `dt=${dt} hours=${hours}`);
      // renew: succeeds iff dt < 0
      let threw = null;
      try { renewWork(item, OWNER, { leaseHours: 1, now }); } catch (e) { threw = e; }
      cases++;
      if ((threw === null) !== (dt < 0)) record('boundary-renew-flip', `dt=${dt} threw=${threw?.message}`);
      // releaseExpired: releases iff dt >= 0
      const rel = releaseExpired([item], now)[0];
      cases++;
      if ((rel.state === 'unclaimed') !== (dt >= 0)) record('boundary-release-flip', `dt=${dt} state=${rel.state}`);
      if (dt >= 0) {
        assert.equal(rel.owner, null, 'I6: released owner cleared');
        assert.equal(rel.leaseExpiresAt, null, 'I6: released lease cleared');
        assert.equal(rel.state, 'unclaimed', 'I6: released state');
      } else {
        assert.deepEqual(stripVolatile(rel), stripVolatile(item), 'I6: unexpired passes through with all fields intact');
        if (!bug1Recorded && rel.updatedAt !== item.updatedAt) {
          bug1Recorded = true;
          record('BUG-1', `releaseExpired pass-through drops updatedAt (had ${item.updatedAt}, now ${rel.updatedAt}); work-claims.mjs releaseExpired returns workOf(entry) instead of entry`);
        }
      }
    }
  }
  console.log(`[fuzz-04] boundary cases=${cases - t0}`);
});

// ---------- I6: releaseExpired sweeps only expired claims ----------
test('fuzz: releaseExpired cross-product', () => {
  const t0 = cases;
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rand() * 6);
    const items = [];
    const dts = [];
    for (let k = 0; k < n; k++) {
      const kind = rand();
      const dt = pick(WHEN);
      dts.push(dt);
      if (kind < 0.55) {
        items.push(makeClaimed({ state: pick(CLAIM_STATES), leaseHours: pick([0.5, 2, 24]), claimAt: T0 }));
      } else if (kind < 0.7) {
        // terminal: claimed -> in_progress -> done (closed shaped by hand)
        const w = createWork({ id: `r-${cases}-${k}`, title: 'f' }, { now: T0, agentId: 'system' });
        const c = claimWork(w, OWNER, { leaseHours: 2, now: T0 });
        const ip = updateWork(c, OWNER, { state: 'in_progress', now: T0 + 400 });
        const done = updateWork(ip, OWNER, { state: 'done', now: T0 + 500 });
        items.push(pick(TERMINAL_STATES) === 'closed' ? { ...done, state: 'closed' } : done);
      } else if (kind < 0.8) {
        items.push(createWork({ id: `r-${cases}-${k}`, title: 'f' }, { now: T0, agentId: 'system' })); // unclaimed
      } else if (kind < 0.9) {
        // lease-less active claim (never expires)
        const w = createWork({ id: `r-${cases}-${k}`, title: 'f' }, { now: T0, agentId: 'system' });
        items.push(claimWork(w, OWNER, { leaseHours: null, now: T0 }));
      } else {
        // future lease start: claimed with claimAt in the future relative to sweep now
        items.push(makeClaimed({ leaseHours: 2, claimAt: T0 + 3_600_000 }));
      }
    }
    const snaps = items.map(x => JSON.stringify(x));
    const now = T0 + dts[0] + CLAIM_HOURS * 3600_000; // sweep at expiry+dt of a 2h lease
    let out; let threw = null;
    try { out = releaseExpired(items, now); } catch (e) { threw = e; }
    cases += n;
    if (threw) { record('releaseExpired-throw', threw.message); continue; }
    assert.equal(out.length, items.length, 'same length out');
    for (let k = 0; k < n; k++) {
      const before = items[k];
      const after = out[k];
      const shouldRelease = isLeaseExpired(before, now);
      if (shouldRelease) {
        if (!(after.state === 'unclaimed' && after.owner === null)) {
          record('release-mismatch', `kind-state=${before.state} lease=${before.leaseExpiresAt} now=${iso(now)} isExpired=${shouldRelease} outState=${after.state}`);
          continue;
        }
        assert.equal(after.leaseExpiresAt, null);
        assert.equal(after.leaseStartAt, null);
        assert.equal(after.owner, null);
        assert.equal(after.state, 'unclaimed');
        assert.equal(JSON.stringify(before), snaps[k], 'I8: no input mutation on release path');
      } else {
        assert.deepEqual(stripVolatile(after), stripVolatile(before), 'I6: non-expired keeps all fields');
        assert.equal(JSON.stringify(before), snaps[k], 'I8: releaseExpired must not mutate inputs');
      }
    }
  }
  console.log(`[fuzz-04] releaseExpired cases=${cases - t0}`);
});

// ---------- I3 on claimWork: hostile leaseHours at claim time ----------
test('fuzz: claimWork hostile leaseHours', () => {
  const t0 = cases;
  for (const lh of LEASE_HOURS) {
    const w = createWork({ id: `c-${cases}`, title: 'f' }, { now: T0, agentId: 'system' });
    let out; let threw = null;
    try { out = claimWork(w, OWNER, { leaseHours: lh.v, now: T0 }); } catch (e) { threw = e; }
    cases++;
    if (lh.ok) {
      if (threw) { record('claim-unexpected-throw', `lh=${String(lh.v)} ${threw.message}`); continue; }
      assert.ok(validExpiry(out.leaseExpiresAt), `I3: claim expiry valid, lh=${String(lh.v)}`);
      if (lh.v === null) assert.equal(out.leaseExpiresAt, null);
      else {
        const eff = lh.v === undefined ? 24 : lh.v;
        assert.ok(Math.abs(Date.parse(out.leaseExpiresAt) - (T0 + eff * 3600_000)) < 2);
      }
    } else if (!threw) {
      record('claim-invalid-leaseHours-accepted', `lh=${String(lh.v)} expiry=${out.leaseExpiresAt}`);
    }
  }
  console.log(`[fuzz-04] claim leaseHours cases=${cases - t0}`);
});

// ---------- future lease start: renew from a claim whose window starts in the future ----------
test('fuzz: future-dated lease windows', () => {
  const t0 = cases;
  for (let i = 0; i < 200; i++) {
    const futureBy = Math.floor(rand() * 7_200_000);
    const item = makeClaimed({ leaseHours: 2, claimAt: T0 + futureBy });
    const expiry = Date.parse(item.leaseExpiresAt);
    const start = Date.parse(item.leaseStartAt);
    assert.ok(start > T0, 'sanity: lease starts in the future');
    for (const now of [T0, start - 1, start, expiry - 1, expiry, expiry + 1]) {
      let out; let threw = null;
      try { out = renewWork(item, OWNER, { leaseHours: 1, now }); } catch (e) { threw = e; }
      cases++;
      const expectOk = now < expiry;
      if (expectOk) {
        if (threw) { record('future-renew-throw', `now=${iso(now)} expiry=${iso(expiry)} ${threw.message}`); continue; }
        // renewed window is anchored at `now`, even if that predates the old start
        assert.ok(Math.abs(Date.parse(out.leaseExpiresAt) - (now + 3600_000)) < 2);
      } else if (!threw) {
        record('future-renew-unexpected-success', `now=${iso(now)} expiry=${iso(expiry)}`);
      }
      const exp = isLeaseExpired(item, now);
      cases++;
      if (exp !== (now >= expiry)) record('future-expired-flip', `now=${iso(now)}`);
    }
  }
  console.log(`[fuzz-04] future-lease cases=${cases - t0}`);
});

test('fuzz-04 summary', () => {
  console.log(`[fuzz-04] TOTAL cases=${cases} violations=${violations.length}`);
  for (const v of violations.slice(0, 40)) console.log(`[fuzz-04] VIOLATION ${v}`);
  assert.equal(violations.length, 0, `${violations.length} invariant violations (see log)`);
});
