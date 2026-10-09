// WAVE-500 W8: per-namespace event budget allocator (prototype).
//
// Pure functions only — no DB, no store coupling. A sibling worker designs
// docs/wave500/EVENT-BUDGET-DESIGN.md; this prototype is deliberately
// conservative and mirrors the existing 409 pattern in
// server/work-claim-integrity.mjs (assertBoardEventBudget: 409 with code
// room_event_budget_low when <10% of PILOT_LIMITS.eventsPerRoom=1M remains).
//
// Model:
// - total: the room's lifetime event budget (e.g. PILOT_LIMITS.eventsPerRoom).
// - reserve: total * reserveRatio, never spendable. Protects the room from
//   ever hitting absolute zero, same spirit as the 10% board-write guard.
// - allocatable: total - reserve, split across namespaces by weight. Integer
//   floor allocations; the floor remainder sits in the unallocated pool.
// - borrowing: a namespace that exhausted its allocation may borrow from the
//   UNALLOCATED pool only — up to borrowRatio of the pool per consume call.
//   Borrowing NEVER touches another namespace's allocation and NEVER touches
//   the reserve.
// - refusals are honest: { ok: false, code, retryAfterSec, message }. Nothing
//   is ever consumed silently.

const DEFAULT_RESERVE_RATIO = 0.1;
const DEFAULT_BORROW_RATIO = 0.5;
// Conservative: the room lives for many sessions, so an exhausted namespace
// should back off rather than hammer the allocator.
const DEFAULT_RETRY_AFTER_SEC = 60;

// Rejects unknown namespaces with their own honest code.
export const CODE_EXHAUSTED = "namespace_event_budget_exhausted";
export const CODE_UNKNOWN = "namespace_event_budget_unknown";

function checkArgs(total, namespaces) {
  if (!Number.isInteger(total) || total <= 0) {
    throw new TypeError("createBudget: total must be a positive integer");
  }
  if (!namespaces || typeof namespaces !== "object" || Array.isArray(namespaces)) {
    throw new TypeError("createBudget: namespaces must be an object mapping name -> weight");
  }
  const names = Object.keys(namespaces);
  if (names.length === 0) throw new TypeError("createBudget: at least one namespace is required");
  for (const name of names) {
    const w = namespaces[name];
    if (typeof w !== "number" || !(w > 0)) {
      throw new TypeError(`createBudget: weight for namespace "${name}" must be a positive number`);
    }
  }
  return names;
}

export function createBudget({ total, namespaces, reserveRatio = DEFAULT_RESERVE_RATIO, borrowRatio = DEFAULT_BORROW_RATIO }) {
  const names = checkArgs(total, namespaces);
  if (typeof reserveRatio !== "number" || reserveRatio < 0 || reserveRatio >= 1) {
    throw new TypeError("createBudget: reserveRatio must be in [0, 1)");
  }
  if (typeof borrowRatio !== "number" || borrowRatio < 0 || borrowRatio > 1) {
    throw new TypeError("createBudget: borrowRatio must be in [0, 1]");
  }
  const reserve = Math.floor(total * reserveRatio);
  const allocatable = total - reserve;
  const totalWeight = names.reduce((sum, name) => sum + namespaces[name], 0);
  const ns = {};
  let allocatedSum = 0;
  for (const name of names) {
    const allocated = Math.floor((allocatable * namespaces[name]) / totalWeight);
    ns[name] = { weight: namespaces[name], allocated, used: 0, borrowed: 0 };
    allocatedSum += allocated;
  }
  return {
    total,
    reserve,
    borrowRatio,
    unallocatedPool: allocatable - allocatedSum,
    ns,
  };
}

function refuse(state, code, namespace, message, retryAfterSec = DEFAULT_RETRY_AFTER_SEC) {
  return { ok: false, state, code, namespace, retryAfterSec, message };
}

export function tryConsume(state, namespace, n = 1) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("tryConsume: n must be a positive integer");
  }
  const entry = state.ns[namespace];
  if (!entry) {
    return refuse(state, CODE_UNKNOWN, namespace, `Unknown event namespace "${namespace}"; no budget allocated and nothing was consumed.`);
  }
  if (entry.used + n <= entry.allocated) {
    return {
      ok: true,
      state: {
        ...state,
        ns: { ...state.ns, [namespace]: { ...entry, used: entry.used + n } },
      },
    };
  }
  // Allocation exhausted. Borrow only from the unallocated pool, capped at
  // borrowRatio of the pool per consume call. Never from another namespace's
  // allocation, never from the reserve.
  const shortfall = entry.used + n - entry.allocated;
  const maxBorrow = Math.floor(state.unallocatedPool * state.borrowRatio);
  if (shortfall <= maxBorrow && shortfall <= state.unallocatedPool) {
    return {
      ok: true,
      state: {
        ...state,
        unallocatedPool: state.unallocatedPool - shortfall,
        ns: {
          ...state.ns,
          [namespace]: { ...entry, used: entry.used + n, borrowed: entry.borrowed + shortfall },
        },
      },
    };
  }
  const remaining = entry.allocated - entry.used;
  return refuse(
    state,
    CODE_EXHAUSTED,
    namespace,
    `Event budget exhausted for namespace "${namespace}" (used ${entry.used} of ${entry.allocated} allocated, ${remaining} left, unallocated pool has ${state.unallocatedPool}); nothing was consumed.`,
  );
}

// Per-namespace { used, allocated, pct }. pct is raw (used / allocated) and
// may exceed 1 when the namespace borrowed from the unallocated pool —
// borrowed consumption is reported honestly, not clamped.
export function usage(state) {
  const out = {};
  for (const [name, entry] of Object.entries(state.ns)) {
    out[name] = {
      used: entry.used,
      allocated: entry.allocated,
      pct: entry.allocated === 0 ? 1 : entry.used / entry.allocated,
    };
  }
  return out;
}
