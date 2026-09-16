/**
 * gmail-send-gate.mjs — Pure approval-gate state machine for the Gmail send path.
 *
 * Implements John's exact-approval semantics: an approval is valid ONLY for the
 * exact draft content that was approved. Nothing here touches the network, the
 * DOM, localStorage, or any secret — it is a pure state machine.
 *
 * States:
 *   draft → pending-approval → approved → sending → sent
 *   Side states: rejected, expired, failed
 *
 * Dependency injection (all via the `deps` parameter of createGmailSendGate):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - id:             () => string  (draft id generator; default: per-gate counter)
 *   - hash:           (content: string) => string  (content hash; default: FNV-1a hex)
 *   - approvalTtlMs:  number        (pending-approval TTL; default: 15 minutes)
 *
 * The injected `hash` is the identity of the content for approval purposes, so
 * production wiring MUST inject a cryptographic hash (e.g. sha256 hex). The
 * default FNV-1a is deterministic but NOT collision-resistant; it exists only so
 * the machine is usable/testable without any dependency.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   GATE_NOT_FOUND          — unknown draft id
 *   GATE_INVALID_TRANSITION — operation not allowed from the current state
 *   GATE_HASH_MISMATCH      — presented hash !== current contentHash
 *   GATE_APPROVAL_EXPIRED   — pending approval lived longer than approvalTtlMs
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'draft',
  'pending-approval',
  'approved',
  'sending',
  'sent',
  'rejected',
  'expired',
  'failed',
]);

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

const TERMINAL_STATES = new Set(['sent', 'rejected', 'expired', 'failed', 'sending']);

/** Throw a coded gate error (never silent failures). */
function gateError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default content hash: FNV-1a (32-bit), hex. Deterministic, non-crypto. */
function fnv1aHex(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Canonical serialization of draft content — fixed field order, hash identity. */
function canonicalContent(content) {
  return JSON.stringify({
    to: content?.to ?? '',
    subject: content?.subject ?? '',
    body: content?.body ?? '',
  });
}

/**
 * Create a new Gmail send approval gate.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(content: string) => string} [deps.hash]
 * @param {number} [deps.approvalTtlMs]
 */
export function createGmailSendGate(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const hash = deps.hash ?? fnv1aHex;
  const approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `draft-${(idCounter += 1)}`);

  /** Internal draft records, keyed by id. */
  const drafts = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  function record({ at, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function getDraftOrThrow(id) {
    const draft = drafts.get(id);
    if (!draft) {
      throw gateError('GATE_NOT_FOUND', `Unknown draft id: ${id}`, { draftId: id });
    }
    return draft;
  }

  function snapshot(draft) {
    return Object.freeze({
      id: draft.id,
      state: draft.state,
      content: Object.freeze({ ...draft.content }),
      contentHash: draft.contentHash,
      approvalRequestedAt: draft.approvalRequestedAt,
      approvedAt: draft.approvedAt,
      approvedHash: draft.approvedHash,
      approvalConsumed: draft.approvalConsumed,
      rejectReason: draft.rejectReason,
    });
  }

  function transition(draft, to, actor, detail) {
    const from = draft.state;
    draft.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { draftId: draft.id, ...(detail ?? {}) },
    });
    return snapshot(draft);
  }

  /** True when a pending approval has lived past its TTL (uses injected clock). */
  function isApprovalExpired(draft) {
    return (
      draft.state === 'pending-approval' &&
      draft.approvalRequestedAt != null &&
      clock() - draft.approvalRequestedAt > approvalTtlMs
    );
  }

  /**
   * If a pending approval has expired, move the draft to `expired` and throw.
   * Called at the top of approve() and by sweep() so expiry is never silent.
   */
  function expireIfStale(draft, actor) {
    if (isApprovalExpired(draft)) {
      transition(draft, 'expired', actor, {
        reason: 'approval TTL elapsed',
        approvalTtlMs,
      });
      throw gateError(
        'GATE_APPROVAL_EXPIRED',
        `Approval for draft ${draft.id} expired (TTL ${approvalTtlMs}ms)`,
        { draftId: draft.id, approvalTtlMs },
      );
    }
  }

  function assertState(draft, allowed, op) {
    if (!allowed.includes(draft.state)) {
      throw gateError(
        'GATE_INVALID_TRANSITION',
        `Cannot ${op} draft ${draft.id} from state '${draft.state}'`,
        { draftId: draft.id, state: draft.state, op },
      );
    }
  }

  const gate = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get approvalTtlMs() {
      return approvalTtlMs;
    },

    /** Create a new draft in `draft` state with its initial contentHash. */
    createDraft(content, actor = 'agent') {
      const id = newId();
      const canonical = {
        to: content?.to ?? '',
        subject: content?.subject ?? '',
        body: content?.body ?? '',
      };
      const draft = {
        id,
        state: 'draft',
        content: canonical,
        contentHash: hash(canonicalContent(canonical)),
        approvalRequestedAt: null,
        approvedAt: null,
        approvedHash: null,
        approvalConsumed: false,
        rejectReason: null,
      };
      drafts.set(id, draft);
      record({
        at: clock(),
        from: null,
        to: 'draft',
        actor,
        detail: { draftId: id, contentHash: draft.contentHash },
      });
      return snapshot(draft);
    },

    /**
     * Edit a draft. Re-hashes content; any pending/approved approval is voided
     * and the draft falls back to `draft` — the old approval can never cover
     * the new content (exact-approval semantics).
     */
    editDraft(id, patch, actor = 'agent') {
      const draft = getDraftOrThrow(id);
      assertState(draft, ['draft', 'pending-approval', 'approved', 'rejected', 'expired'], 'edit');
      const hadApproval = draft.state === 'pending-approval' || draft.state === 'approved';
      const from = draft.state;
      draft.content = {
        to: patch?.to ?? draft.content.to,
        subject: patch?.subject ?? draft.content.subject,
        body: patch?.body ?? draft.content.body,
      };
      const newHash = hash(canonicalContent(draft.content));
      draft.contentHash = newHash;
      draft.approvalRequestedAt = null;
      draft.approvedAt = null;
      draft.approvedHash = null;
      draft.approvalConsumed = false;
      draft.rejectReason = null;
      record({
        at: clock(),
        from,
        to: 'draft',
        actor,
        detail: {
          draftId: id,
          contentHash: newHash,
          ...(hadApproval ? { approvalVoided: true, reason: 'content edited after approval' } : {}),
        },
      });
      draft.state = 'draft';
      return snapshot(draft);
    },

    /**
     * Move a draft to `pending-approval`, recording the exact contentHash the
     * approval will be bound to.
     */
    requestApproval(id, actor = 'john') {
      const draft = getDraftOrThrow(id);
      assertState(draft, ['draft', 'rejected', 'expired'], 'request approval for');
      draft.approvalRequestedAt = clock();
      draft.approvedAt = null;
      draft.approvedHash = null;
      draft.approvalConsumed = false;
      return transition(draft, 'pending-approval', actor, {
        contentHash: draft.contentHash,
        approvalTtlMs,
      });
    },

    /**
     * Approve ONLY if presentedHash === current contentHash. Expired pending
     * approvals transition to `expired` and throw GATE_APPROVAL_EXPIRED.
     */
    approve(id, presentedHash, actor = 'john') {
      const draft = getDraftOrThrow(id);
      assertState(draft, ['pending-approval'], 'approve');
      expireIfStale(draft, actor);
      if (presentedHash !== draft.contentHash) {
        throw gateError(
          'GATE_HASH_MISMATCH',
          `Approval hash mismatch for draft ${id}: presented content does not match the draft John is seeing`,
          { draftId: id, presentedHash },
        );
      }
      draft.approvedAt = clock();
      draft.approvedHash = presentedHash;
      return transition(draft, 'approved', actor, {
        contentHash: draft.contentHash,
      });
    },

    /** Reject a pending (or not-yet-requested) draft with a recorded reason. */
    reject(id, reason, actor = 'john') {
      const draft = getDraftOrThrow(id);
      assertState(draft, ['draft', 'pending-approval'], 'reject');
      draft.rejectReason = reason ?? '';
      return transition(draft, 'rejected', actor, {
        reason: draft.rejectReason,
      });
    },

    /**
     * Send the draft. Allowed only from `approved`; re-verifies the contentHash
     * one last time (exact-approval semantics) and consumes the approval
     * single-use. Transitions approved → sending → sent.
     */
    send(id, actor = 'agent') {
      const draft = getDraftOrThrow(id);
      assertState(draft, ['approved'], 'send');
      if (draft.approvalConsumed) {
        throw gateError(
          'GATE_INVALID_TRANSITION',
          `Approval for draft ${id} was already consumed (single-use)`,
          { draftId: id },
        );
      }
      if (draft.approvedHash !== draft.contentHash) {
        // Unreachable via the public API (editDraft voids approvals), but the
        // gate must never send content that was not exactly approved.
        transition(draft, 'failed', actor, {
          reason: 'content hash changed after approval',
        });
        throw gateError(
          'GATE_HASH_MISMATCH',
          `Send blocked for draft ${id}: content no longer matches the approved hash`,
          { draftId: id },
        );
      }
      draft.approvalConsumed = true;
      transition(draft, 'sending', actor, {
        contentHash: draft.contentHash,
        approvalConsumed: true,
      });
      return transition(draft, 'sent', actor, {
        contentHash: draft.contentHash,
      });
    },

    /**
     * Transition every stale pending-approval to `expired`. Returns the ids
     * that expired in this sweep.
     */
    sweep(actor = 'system') {
      const expired = [];
      for (const draft of drafts.values()) {
        if (isApprovalExpired(draft)) {
          transition(draft, 'expired', actor, {
            reason: 'approval TTL elapsed',
            approvalTtlMs,
          });
          expired.push(draft.id);
        }
      }
      return expired;
    },

    /** Read-only snapshot of a draft (null if unknown). */
    get(id) {
      const draft = drafts.get(id);
      return draft ? snapshot(draft) : null;
    },
  };

  return Object.freeze(gate);
}
