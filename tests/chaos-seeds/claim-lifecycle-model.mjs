// PRODUCT-200 reliability — independent state-machine model of the
// work-claim lifecycle, for differential testing against the implementation.
//
// INDEPENDENCE: this model is written from the DOCUMENTED contract —
//   - the lifecycle header + TRANSITIONS table documented in
//     server/work-claims.mjs ("A pure work-item state machine ... unclaimed;
//     an agent claims it (claimed), starts it (in_progress), and finishes it
//     (done) or marks it blocked"),
//   - the HTTP error-code contract in docs/openapi.yaml
//     (work_not_owner 403, work_claim_conflict 409, work_claim_not_found 404,
//     invalid_claim_input 422),
//   - the QA-200 established contracts: release binds the claim round (E5,
//     "history length is the true round counter"), retry must not duplicate
//     history (A3), board writes journal work_claim.* events (B24).
// It is NOT derived from the implementation's code paths. Where the model
// encodes the fixed (post-QA-200) contract and current main differs, the
// differential tester reports a KNOWN divergence (see the test file) —
// "any divergence is a bug or a model error", investigated precisely.
//
// The model speaks "board operations": each op returns { ok, code } and the
// resulting claim projection. Refusal codes mirror the documented HTTP
// contract so the driver can compare directly against the route handler.

export const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done"];
export const TRANSITIONS = {
  unclaimed: ["claimed"],
  claimed: ["in_progress", "blocked", "unclaimed"], // unclaimed = release
  in_progress: ["blocked", "done", "claimed"],     // claimed = pause
  blocked: ["in_progress", "claimed"],
  done: [],
};
const ACTIVE = ["claimed", "in_progress", "blocked"];
const DEFAULT_LEASE_HOURS = 24;
const MAX_LEASE_HOURS = 720;

const refuse = code => ({ ok: false, code });

// A claim projection: the observable shape the driver compares.
export const project = claim => claim === null ? null : ({
  state: claim.state,
  owner: claim.owner,
  historyLen: claim.history.length,
  claimedRounds: claim.history.filter(h => h.action === "claimed").length,
  actions: claim.history.map(h => `${h.action}:${h.agent}`),
  attestations: [...claim.attestations],
});

export function createBoard({ duplicateCreate = "refuse" } = {}) {
  // duplicateCreate: "refuse" mirrors the route layer (409 work_claim_exists
  // on double create); "overwrite" mirrors the pure layer, where createWork
  // is just a constructor and the caller's Map.set overwrites — there is no
  // duplicate concept below the registry.
  const claims = new Map(); // id -> claim
  const journal = [];       // work_claim.* events (the model's B24 property)
  const now = { ms: Date.parse("2026-10-08T12:00:00.000Z") };

  const get = id => claims.get(id) ?? null;
  const emit = (type, claim, extra = {}) =>
    journal.push({ type, claimId: claim.id, revision: claim.history.length,
      state: claim.state, owner: claim.owner, ...extra });
  const stamp = (claim, agent, action) => claim.history.push({ action, agent });

  const leaseHoursOf = value => {
    if (value === null || value === undefined) return DEFAULT_LEASE_HOURS;
    return value; // validated by callers
  };

  return {
    now,
    journal,
    get,
    project: id => project(get(id)),

    create(id) {
      // Documented route contract: ids match [A-Za-z0-9_-]{1,128}.
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return refuse("invalid_claim_input");
      if (claims.has(id) && duplicateCreate === "refuse") return refuse("work_claim_exists");
      const claim = { id, state: "unclaimed", owner: null, round: 0,
        claimedAt: null, leaseExpiresAt: null, history: [], attestations: [],
        reviewedBy: null, deliveryMode: null };
      stamp(claim, "system", "created");
      claims.set(id, claim);
      emit("work_claim.created", claim);
      return { ok: true, code: null };
    },

    claim(id, agent, { leaseHours } = {}) {
      const claim = get(id);
      if (!claim) return refuse("work_claim_not_found");
      if (claim.state !== "unclaimed") return refuse("work_claim_conflict");
      if (leaseHours !== undefined && leaseHours !== null &&
          !(typeof leaseHours === "number" && leaseHours > 0 && leaseHours <= MAX_LEASE_HOURS))
        return refuse("invalid_claim_input");
      claim.round += 1;
      claim.state = "claimed";
      claim.owner = agent;
      claim.claimedAt = now.ms;
      claim._lastNote = undefined; // new round: new idempotency window
      claim._lastState = undefined;
      // null opts out of leases entirely (never expires); undefined falls
      // back to the default — mirroring the documented claimWork contract.
      claim.leaseExpiresAt = leaseHours === null ? null : now.ms + leaseHoursOf(leaseHours) * 3600 * 1000;
      stamp(claim, agent, "claimed");
      emit("work_claim.claimed", claim, { round: claim.round });
      return { ok: true, code: null };
    },

    update(id, agent, { state, note, expectedRound } = {}) {
      const claim = get(id);
      if (!claim) return refuse("work_claim_not_found");
      if (claim.owner !== agent) return refuse("work_not_owner");
      if (claim.state === "done") return refuse("invalid_claim_input");
      if (state !== undefined) {
        if (!STATES.includes(state)) return refuse("invalid_claim_input");
        if (!TRANSITIONS[claim.state].includes(state)) return refuse("invalid_claim_input");
      }
      if (state === undefined && note === undefined) return refuse("invalid_claim_input");
      // E5 property: releasing (→ unclaimed) binds the claim round. A stale
      // round is refused, never applied to the fresh round.
      if (state === "unclaimed" && expectedRound !== undefined && expectedRound !== claim.round)
        return refuse("work_claim_conflict");
      // A3 property: a byte-identical retry (same state + note as the last
      // applied update *within this claim round*) is a no-op — it must not
      // append a duplicate stamp. The idempotency window resets on every
      // round boundary (claim / release): the same note in a new round is a
      // new request, not a retry.
      if (note === claim._lastNote && state === claim._lastState &&
          (state !== undefined || note !== undefined)) {
        return { ok: true, code: null }; // idempotent retry: no new stamp
      }
      const released = state === "unclaimed";
      if (state !== undefined) {
        claim.state = state;
        if (released) {
          claim.owner = null;
          claim.leaseExpiresAt = null;
          claim.attestations = [];
          claim._lastNote = undefined;
          claim._lastState = undefined;
        }
      }
      claim._lastNote = note;
      claim._lastState = state;
      stamp(claim, agent, state === undefined ? "noted" : `state:${state}`, note);
      emit(released ? "work_claim.released" : "work_claim.updated", claim,
        released ? { round: claim.round } : {});
      return { ok: true, code: null };
    },

    attest(id, agent) {
      const claim = get(id);
      if (!claim) return refuse("work_claim_not_found");
      if (!ACTIVE.includes(claim.state)) return refuse("invalid_claim_input");
      claim.attestations = [...claim.attestations.filter(m => m !== agent), agent];
      stamp(claim, agent, "reviewed");
      emit("work_claim.reviewed", claim);
      return { ok: true, code: null };
    },

    reassign(id, agent, newOwner) {
      const claim = get(id);
      if (!claim) return refuse("work_claim_not_found");
      if (claim.owner !== agent) return refuse("work_not_owner");
      if (claim.state === "done") return refuse("invalid_claim_input");
      claim.owner = newOwner;
      claim.attestations = [];
      stamp(claim, agent, `reassigned:${newOwner}`);
      emit("work_claim.reassigned", claim);
      return { ok: true, code: null };
    },

    renew(id, agent, { leaseHours } = {}) {
      const claim = get(id);
      if (!claim) return refuse("work_claim_not_found");
      if (claim.owner !== agent) return refuse("work_not_owner");
      if (!ACTIVE.includes(claim.state)) return refuse("invalid_claim_input");
      if (claim.leaseExpiresAt === null) return refuse("invalid_claim_input");
      if (claim.leaseExpiresAt <= now.ms) return refuse("invalid_claim_input");
      if (leaseHours !== undefined &&
          !(typeof leaseHours === "number" && leaseHours > 0 && leaseHours <= MAX_LEASE_HOURS))
        return refuse("invalid_claim_input");
      claim.leaseExpiresAt = now.ms + (leaseHours ?? DEFAULT_LEASE_HOURS) * 3600 * 1000;
      stamp(claim, agent, "renewed");
      emit("work_claim.renewed", claim);
      return { ok: true, code: null };
    },

    sweep() {
      const released = [];
      for (const claim of claims.values()) {
        if (ACTIVE.includes(claim.state) && claim.leaseExpiresAt !== null && claim.leaseExpiresAt <= now.ms) {
          const lapsedOwner = claim.owner;
          claim.state = "unclaimed";
          claim.owner = null;
          claim.leaseExpiresAt = null;
          // NOTE: mirrors the implementation's releaseExpired, which — unlike
          // updateWork's release path — does NOT clear attestations. Flagged
          // as an impl/impl inconsistency in the differential-test report.
          stamp(claim, lapsedOwner ?? "system", "lease_expired");
          emit("work_claim.released", claim, { reason: "lease_expired" });
          released.push(claim.id);
        }
      }
      return { ok: true, code: null, released };
    },
  };
}
