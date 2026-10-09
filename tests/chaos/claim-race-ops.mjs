// claim-race-ops.mjs — op-generator + race harness for claim-lifecycle chaos
// properties (PRODUCT-200 reliability, slice C2/50: CHAOS PROPERTIES — CLAIM
// LIFECYCLE RACES).
//
// OP-GENERATOR CONTRACT (for C1's harness frame, or any future chaos front):
//   * An "op" is one ATOMIC transaction: read the latest committed item from
//     the store, apply a pure function from server/work-claims.mjs, write the
//     result back in a single store.set. This mirrors the production wiring in
//     server/work-claim-routes.mjs: "The read, state transition and write then
//     share one transaction" — concurrent HTTP requests serialize into some
//     total order of such transactions, which is exactly what the chaos
//     properties randomize over (200+ interleavings each).
//   * Ops are built by `opXxx(...)` factories and return
//     `{ name, exec(store, clock, claims, track, rng) }`. `track(item)` must
//     wrap every item an op reads; the runner uses it to prove the op never
//     mutated its input (purity) and to detect partial writes on conflict.
//   * `runOpList({ claims, store, clock, ops, rng })` executes the ops in
//     order, records per-op outcomes, and — after EVERY op — asserts the
//     legal-state invariant and history coherence for every stored item.
//   * The `claims` module is injected (real server/work-claims.mjs, or a
//     guard-weakened copy from loadWeakenedClaimModule for fail-first runs),
//     so the same properties run against both.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — every interleaving is reproducible from its seed.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (rng, list) => list[Math.floor(rng() * list.length)];
export const shuffle = (rng, list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// ---------------------------------------------------------------------------
// Race store: a Map registry with production-shaped conflict semantics.
// insert() is create-if-absent (mirrors the route's `registry.has -> 409
// work_claim_exists`); set() is the blind upsert the durable registry does.
// ---------------------------------------------------------------------------
export function conflictError(code, message, status = 409) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createRaceStore() {
  const map = new Map();
  return {
    has: id => map.has(id),
    get(id) {
      const item = map.get(id);
      if (!item) throw conflictError("unknown_claim", `No work claim "${id}"`, 404);
      return item;
    },
    insert(item) {
      if (map.has(item.id)) {
        throw conflictError("work_claim_exists", `Work claim "${item.id}" already exists`, 409);
      }
      map.set(item.id, item);
      return item;
    },
    set(item) {
      map.set(item.id, item);
      return item;
    },
    setAll(items) {
      for (const item of items) map.set(item.id, item);
      return items;
    },
    list: () => [...map.values()],
    ids: () => [...map.keys()],
  };
}

export function createClock(startMs) {
  return { now: startMs };
}

// ---------------------------------------------------------------------------
// Oracles.
// ---------------------------------------------------------------------------
// A claim item is LEGAL when it could be a committed state of the pure
// machine: a known state; owner exactly on active claims AND done (done keeps
// its deliverer; only unclaimed/closed are ownerless); lease fields always
// paired, and set only where the machine keeps them (active claims, plus done
// which freezes the round's lease — it never expires there); history opening
// with "created".
export function checkLegalItem(claims, item) {
  const { STATES, ACTIVE_CLAIM_STATES } = claims;
  if (!STATES.includes(item.state)) return { ok: false, reason: `unknown state ${item.state}` };
  const active = ACTIVE_CLAIM_STATES.includes(item.state);
  const mayHoldOwner = active || item.state === "done";
  if ((item.owner !== null) !== mayHoldOwner) {
    return { ok: false, reason: `torn owner/state: state=${item.state} owner=${item.owner}` };
  }
  if ((item.leaseStartAt !== null) !== (item.leaseExpiresAt !== null)) {
    return { ok: false, reason: "torn lease pair: leaseStartAt/leaseExpiresAt disagree" };
  }
  if (item.leaseExpiresAt !== null && !mayHoldOwner) {
    return { ok: false, reason: `lease on ownerless claim (state=${item.state})` };
  }
  if (!Array.isArray(item.history) || item.history.length === 0 || item.history[0].action !== "created") {
    return { ok: false, reason: "history does not open with created" };
  }
  return { ok: true };
}

export function assertLegalItem(claims, item) {
  const check = checkLegalItem(claims, item);
  assert.ok(check.ok, `illegal claim state for "${item?.id}": ${check.reason}`);
}

// History coherence: every "renewed" stamp must sit inside an open claim
// round — i.e. after the latest round opener ("claimed", or "reassigned:*"
// which opens a round when it claims an unclaimed item) there is no
// round-ending stamp ("lease_expired", "state:unclaimed", "state:done",
// "closed", "cancelled"). A "renewed" after a round ended is the signature of
// a stale-read blind commit (renew computed from a pre-release snapshot,
// clobbering the release).
const ROUND_ENDERS = new Set(["lease_expired", "state:unclaimed", "state:done", "closed", "cancelled"]);

export function checkHistoryCoherent(item) {
  const history = item.history ?? [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].action !== "renewed") continue;
    let j = i - 1;
    let openerSeen = false;
    while (j >= 0) {
      const action = history[j].action;
      if (ROUND_ENDERS.has(action)) {
        return { ok: false, reason: `"renewed" at index ${i} follows round-ender "${action}" at index ${j} (stale-read signature)` };
      }
      if (action === "claimed" || String(action).startsWith("reassigned:")) { openerSeen = true; break; }
      j--;
    }
    if (!openerSeen) return { ok: false, reason: `"renewed" at index ${i} has no round opener` };
  }
  return { ok: true };
}

export function assertHistoryCoherent(item) {
  const check = checkHistoryCoherent(item);
  assert.ok(check.ok, `incoherent history for "${item?.id}": ${check.reason}`);
}

export function isCleanConflict(claims, err) {
  if (err instanceof claims.ClaimError) return true;
  return ["work_claim_exists", "work_claim_conflict", "unknown_claim"].includes(err?.code);
}

export function assertCleanConflict(claims, err) {
  assert.ok(isCleanConflict(claims, err),
    `expected a clean conflict (ClaimError or 409), got: ${err?.code ?? err?.name}: ${err?.message}`);
}

// ---------------------------------------------------------------------------
// Op builders. Each op computes its full next state with pure functions and
// performs exactly one store write (or none, on conflict). Route-shaped
// pre-checks (claim on unclaimed only; release as pause-then-release) mirror
// server/work-claim-routes.mjs.
// ---------------------------------------------------------------------------
const BLOB = `sha256:${"ab".repeat(32)}`;

export const opCreate = (id, agent, opts = {}) => ({
  name: `create(${id},${agent})`,
  exec(store, clock, claims) {
    if (store.has(id)) throw conflictError("work_claim_exists", `Work claim "${id}" already exists`, 409);
    const item = claims.createWork({ id, title: opts.title ?? id }, { now: clock.now, agentId: agent });
    store.insert(item);
    return { readState: null, wrote: true };
  },
});

export const opClaim = (id, agent, opts = {}) => ({
  name: `claim(${id},${agent})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    if (item.state !== "unclaimed") {
      throw conflictError("work_claim_conflict", `Work "${id}" is already ${item.state} — release it first`, 409);
    }
    const claimed = claims.claimWork(item, agent, {
      leaseHours: opts.leaseHours === undefined ? 1 : opts.leaseHours,
      now: clock.now,
    });
    store.set(claimed);
    return { readState: item.state, wrote: true };
  },
});

export const opUpdateSmart = (id, agent, rng) => ({
  name: `updateSmart(${id},${agent})`,
  exec(store, clock, claims, track, inner = rng) {
    const item = track(store.get(id));
    const targets = claims.TRANSITIONS[item.state] ?? [];
    if (targets.length === 0 || inner() < 0.25) {
      const noted = claims.updateWork(item, agent, { note: `chaos-note-${Math.floor(inner() * 1e6)}`, now: clock.now });
      store.set(noted);
      return { readState: item.state, wrote: true };
    }
    const target = pick(inner, targets);
    const extra = target === "done"
      ? { deliveryMode: pick(inner, ["result", "merged", "production"]), tags: ["chaos"], blobs: [BLOB] }
      : {};
    const updated = claims.updateWork(item, agent, { state: target, note: `go-${target}`, now: clock.now, ...extra });
    store.set(updated);
    return { readState: item.state, wrote: true, target };
  },
});

export const opUpdateBlind = (id, agent, target) => ({
  name: `updateBlind(${id},${agent}->${target})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    const updated = claims.updateWork(item, agent, { state: target, note: "blind", now: clock.now });
    store.set(updated);
    return { readState: item.state, wrote: true };
  },
});

// Route-shaped release: pause (in_progress/blocked -> claimed) then release
// (claimed -> unclaimed), computed before the single commit.
export const opRelease = (id, agent, { authority = false } = {}) => ({
  name: `release(${id},${agent}${authority ? ",auth" : ""})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    let next = item;
    if (next.state === "in_progress" || next.state === "blocked") {
      next = claims.updateWork(next, agent, { state: "claimed", note: "paused for release", now: clock.now, authority });
    }
    next = claims.updateWork(next, agent, { state: "unclaimed", note: "chaos release", now: clock.now, authority });
    store.set(next);
    return { readState: item.state, wrote: true };
  },
});

export const opRenew = (id, agent, { leaseHours } = {}) => ({
  name: `renew(${id},${agent})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    const renewed = claims.renewWork(item, agent, { now: clock.now, ...(leaseHours === undefined ? {} : { leaseHours }) });
    store.set(renewed);
    return { readState: item.state, readOwner: item.owner, wrote: true };
  },
});

export const opSweep = () => ({
  name: "sweep()",
  exec(store, clock, claims, track) {
    const items = store.list().map(track);
    const beforeStates = new Map(items.map(i => [i.id, i.state]));
    const next = claims.releaseExpired(items, clock.now);
    store.setAll(next);
    // releaseExpired only ever transitions active -> unclaimed; compare states,
    // not JSON (workOf normalization reorders keys, so JSON differs spuriously).
    const released = next.filter(n => n.state !== beforeStates.get(n.id)).map(i => i.id);
    return { readState: null, wrote: released.length > 0, released };
  },
});

export const opTick = ms => ({
  name: `tick(+${ms}ms)`,
  exec(store, clock) {
    clock.now += ms;
    return { readState: null, wrote: false };
  },
});

export const opReassign = (id, agent, target) => ({
  name: `reassign(${id},${agent}->${target})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    const reassigned = claims.reassignWork(item, agent, target, { now: clock.now });
    store.set(reassigned);
    return { readState: item.state, wrote: true };
  },
});

export const opClose = (id, agent, verb, { authority = false } = {}) => ({
  name: `${verb}(${id},${agent}${authority ? ",auth" : ""})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    const retired = claims.closeWork(item, agent, { verb, reason: "chaos retire", now: clock.now, authority });
    store.set(retired);
    return { readState: item.state, wrote: true };
  },
});

export const opAttest = (id, agent, note) => ({
  name: `attest(${id},${agent})`,
  exec(store, clock, claims, track) {
    const item = track(store.get(id));
    const attested = claims.attestWork(item, agent, { note, now: clock.now });
    store.set(attested);
    return { readState: item.state, wrote: true };
  },
});

export const opReview = (id, agent, verdict, rng) => ({
  name: `review(${id},${agent},${verdict})`,
  exec(store, clock, claims, track, inner = rng) {
    const item = track(store.get(id));
    const reviewed = claims.recordReview(item, agent,
      { verdict, summary: `chaos review ${Math.floor(inner() * 1e6)}`, now: clock.now });
    store.set(reviewed);
    return { readState: item.state, wrote: true };
  },
});

// ---------------------------------------------------------------------------
// Op-list runner: executes ops in order; after every op asserts purity of
// inputs, no-partial-write on conflict, and the oracles on every item.
// ---------------------------------------------------------------------------
export function runOpList({ claims, store, clock, ops, rng, afterEach = true }) {
  const outcomes = [];
  for (const op of ops) {
    const beforeJson = new Map(store.list().map(i => [i.id, JSON.stringify(i)]));
    const reads = [];
    const track = item => { reads.push({ ref: item, json: JSON.stringify(item) }); return item; };
    let outcome;
    try {
      outcome = { ok: true, ...(op.exec(store, clock, claims, track, rng) ?? {}) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    for (const { ref, json } of reads) {
      assert.equal(JSON.stringify(ref), json, `${op.name}: op mutated its input item (torn read)`);
    }
    if (!outcome.ok) {
      for (const item of store.list()) {
        assert.equal(JSON.stringify(item), beforeJson.get(item.id),
          `${op.name}: failed op left a partial write on "${item.id}"`);
      }
    }
    if (afterEach) {
      for (const item of store.list()) {
        assertLegalItem(claims, item);
        assertHistoryCoherent(item);
      }
    }
    outcomes.push({ name: op.name, ...outcome });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Fail-first: load a guard-weakened copy of server/work-claims.mjs.
// The weakened module is generated at test time into tests/chaos/.weak/ (a
// gitignored scratch dir) and imported dynamically. Each weakening disables
// exactly one guard so the matching property must fail.
// ---------------------------------------------------------------------------
const WEAKENINGS = {
  // P1: disable claimWork's anti-collision check (concurrent claims both win).
  // The anchor is the guard's condition only — not the message text — so
  // message refactors don't silently disarm the weakening (the
  // exactly-once check below still fails loudly on real drift).
  p1: [
    [`check(item.state === "unclaimed",`,
     `void(item.state === "unclaimed",`],
  ],
  // P2: release stops clearing the owner (unclaimed item keeps an owner: torn).
  p2: [
    [`owner: released ? null : item.owner,`, `owner: item.owner,`],
  ],
  // P3: release stops clearing the lease (one guard, two lines): a renew that
  // raced the release leaves its extended lease silently surviving on the
  // unclaimed item — the double effect P3 forbids.
  p3: [
    [`leaseStartAt: released ? null : item.leaseStartAt,`, `leaseStartAt: item.leaseStartAt,`],
    [`leaseExpiresAt: released ? null : item.leaseExpiresAt,`, `leaseExpiresAt: item.leaseExpiresAt,`],
  ],
};

export async function loadWeakenedClaimModule(kind) {
  const spec = WEAKENINGS[kind];
  if (!spec) throw new Error(`unknown weakening kind: ${kind}`);
  const srcPath = join(HERE, "..", "..", "server", "work-claims.mjs");
  let source = await readFile(srcPath, "utf8");
  for (const [from, to] of spec) {
    const occurrences = source.split(from).length - 1;
    if (occurrences !== 1) {
      throw new Error(`weakening ${kind}: expected exactly 1 occurrence of ${JSON.stringify(from)}, found ${occurrences} — source drifted, refusing`);
    }
    source = source.replace(from, to);
  }
  // The copy lives in tests/chaos/.weak/, so re-point the relative import.
  source = source.replace(
    `from "./claim-coordination.mjs"`,
    `from "../../../server/claim-coordination.mjs"`,
  );
  const weakDir = join(HERE, ".weak");
  await mkdir(weakDir, { recursive: true });
  const weakPath = join(weakDir, `work-claims-${kind}.weak.mjs`);
  await writeFile(weakPath, source);
  return import(weakPath);
}

export async function cleanWeakenedClaimModules() {
  await rm(join(HERE, ".weak"), { recursive: true, force: true });
}
