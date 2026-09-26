// Lane C inbox collaboration HTTP routes (task RC-2026-09-18-011).
//
// Room-scoped handlers mounted by server/http.mjs inside the authenticated
// room block, after the shared credential, fence and rate-limit checks. All
// nineteen operations live under /api/rooms/{roomId}/collab/* and are
// documented in docs/openapi.yaml (the route-docs gate requires it).
//
// Error contract: the pure Lane C modules throw typed errors (AssignError,
// NoteError, CollisionError, ApprovalError, RoutingError) carrying a stable
// .code but no HTTP status; collabHttpError maps those codes to statuses and
// wraps them in ServiceError so the outer handler returns stable 4xx codes
// instead of 500. The handoff journal already throws ServiceError, which
// passes through untouched. Unknown errors are rethrown for the generic 500
// path — never wrapped, so no internal detail leaks.
//
// Identity: the caller is the authenticated room member
// ({kind, id, label}); agents and humans are gated per endpoint before the
// pure modules see them. Approval verdicts additionally require a human
// caller — an agent can never clear its own draft, enforced both here (403)
// and by the queue itself (approval_not_human).
import { ServiceError } from "./store.mjs";

const STATUS_BY_CODE = new Map(Object.entries({
  assign_invalid: 422, assign_conflict: 409, assign_forbidden: 403, assign_not_assigned: 404,
  note_invalid: 422, note_not_found: 404, note_forbidden: 403,
  collision_invalid: 422, collision_lock_held: 409, collision_lock_not_found: 404,
  collision_lock_expired: 409, collision_forbidden: 403,
  approval_invalid: 422, approval_not_found: 404, approval_not_human: 403, approval_transition: 409,
  routing_invalid: 422, routing_not_found: 404, routing_transition: 409,
  assignment_not_found: 404, lock_not_found: 404,
  handoff_no_account_scope: 409,
  // Typed handoff envelopes (RC-2026-09-19-062): validation is 422, unknown
  // envelopes are 404, recipient/sender actor rules are 403, and illegal
  // lifecycle moves are 409.
  invalid_handoff_envelope: 422, invalid_envelope_status: 422, invalid_envelope_room: 422,
  envelope_checks_required: 422, envelope_unknown_check: 422, envelope_expiry_system_only: 422,
  envelope_not_found: 404,
  envelope_recipient_only: 403, envelope_sender_only: 403, envelope_party_only: 403,
  invalid_envelope_transition: 409, envelope_duplicate_id: 409,
}));

export function collabHttpError(error) {
  if (error instanceof ServiceError) return error;
  const status = error && typeof error.code === "string" ? STATUS_BY_CODE.get(error.code) : undefined;
  if (status === undefined) return null;
  return new ServiceError(status, error.code, error.message);
}

// Strict body shapes: every required key present, no unknown keys (the
// rooms block's exact() idea, with true optional keys).
const shape = (fields, { required = [], optional = [] } = {}) => {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => allowed.has(key));
};

const invalidInput = (reject, expected) => reject(422, "invalid_input", `Expected ${expected}.`);

const callerOf = auth => ({
  kind: auth.member.kind,
  id: auth.member.id,
  label: auth.member.displayName ?? auth.member.id,
});

export async function handleInboxCollab({ req, res, url, store, roomId, auth, collabRoute, collabId, helpers }) {
  const { json, reject, body } = helpers;
  const collab = store.collab;
  const caller = callerOf(auth);
  const asHuman = () => {
    // RC-2026-09-18-023: the human gate is a deliberate trust boundary, not
    // a missing feature — the denial says why and exactly what unlocks it.
    if (caller.kind !== "human") reject(403, "human_required",
      "Approval verdicts are intentionally human-gated: an agent cannot clear its own draft. " +
      "Have a human room member issue the verdict with their own credential: " +
      "POST /api/rooms/{roomId}/collab/approvals/{proposalId}/decide " +
      "with {decision: \"approve\"|\"edit\"|\"reject\", note?, editedBody?}.");
    return { kind: "human", id: caller.id, label: caller.label };
  };
  const asAgent = () => {
    if (caller.kind !== "agent") reject(403, "agent_required", "This action requires an agent identity.");
    return { kind: "agent", id: caller.id, label: caller.label };
  };
  try {
    switch (collabRoute) {
      case "assignments": {
        if (req.method === "POST") {
          const fields = await body(req);
          if (!shape(fields, { required: ["threadId", "assignee"], optional: ["force"] })) {
            invalidInput(reject, "{threadId, assignee, force?}");
          }
          const { assignmentId, record } = collab.assignThread(roomId, fields.threadId,
            fields.assignee, { by: caller, force: fields.force === true });
          // RC-2026-09-24-203: push doorbell when a thread is assigned to an
          // offline agent with a push subscription. Member id resolves to the
          // agent identity via identity_links; pushNotify itself gates on the
          // agent being offline. Never fails the assignment.
          try {
            const assigneeId = record?.assignee?.kind === "agent" && typeof record.assignee.id === "string"
              ? record.assignee.id : null;
            if (assigneeId) {
              const link = store.db.prepare(
                "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?")
                .get(roomId, assigneeId);
              if (link?.identityId) {
                store.agentHeartbeats.pushNotify({ identityId: link.identityId,
                  eventType: "assignment.created", roomId, id: assignmentId, ts: store.now() });
              }
            }
          } catch { /* the push path never fails the assignment */ }
          return json(res, 201, { assignmentId, assignment: record });
        }
        if (req.method === "GET") {
          return json(res, 200, { assignments: collab.listAssignments(roomId) });
        }
        return reject(405, "method_not_allowed", "Method not allowed");
      }
      case "assignment-release": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: [], optional: ["reason"] })) invalidInput(reject, "{reason?}");
        const { assignmentId, record } = collab.releaseAssignment(roomId, collabId,
          { by: caller, reason: fields.reason ?? null });
        return json(res, 200, { assignmentId, assignment: record });
      }
      case "notes": {
        if (req.method === "POST") {
          const fields = await body(req);
          if (!shape(fields, { required: ["threadId", "body"], optional: ["tag"] })) {
            invalidInput(reject, "{threadId, body, tag?}");
          }
          const note = collab.addThreadNote(roomId, fields.threadId,
            { author: caller, body: fields.body, tag: fields.tag ?? null });
          return json(res, 201, { note });
        }
        if (req.method === "GET") {
          const threadId = url.searchParams.get("threadId");
          if (!threadId) return reject(422, "invalid_input", "Query parameter threadId is required.");
          return json(res, 200, { notes: collab.listThreadNotes(roomId, threadId) });
        }
        return reject(405, "method_not_allowed", "Method not allowed");
      }
      case "lock-acquire": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const holder = asAgent();
        const fields = await body(req);
        if (!shape(fields, { required: ["threadId"], optional: ["ttlMs"] })) {
          invalidInput(reject, "{threadId, ttlMs?}");
        }
        const { lock, duplicate } = collab.acquireDraftLock(roomId, fields.threadId, holder,
          { ttlMs: fields.ttlMs ?? null });
        return json(res, duplicate ? 200 : 201, { lock, duplicate });
      }
      case "lock-release": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: ["lockId"] })) invalidInput(reject, "{lockId}");
        const released = collab.releaseDraftLock(roomId, fields.lockId, { by: caller });
        return json(res, 200, released);
      }
      case "lock-detect": {
        if (req.method !== "GET") return reject(405, "method_not_allowed", "Method not allowed");
        const threadId = url.searchParams.get("threadId");
        if (!threadId) return reject(422, "invalid_input", "Query parameter threadId is required.");
        return json(res, 200, collab.detectDraftLock(roomId, threadId, caller));
      }
      case "approvals": {
        if (req.method === "POST") {
          const fields = await body(req);
          if (!shape(fields, { required: ["threadId", "draft", "channel"] })) {
            invalidInput(reject, "{threadId, draft: {subject?, body}, channel}");
          }
          const agent = asAgent();
          const proposal = collab.proposeDraft(roomId, fields.threadId,
            { draft: fields.draft, byAgent: agent, channel: fields.channel });
          return json(res, 201, { proposal });
        }
        if (req.method === "GET") {
          const status = url.searchParams.get("status");
          return json(res, 200, { proposals: collab.listApprovals(roomId, { status }) });
        }
        return reject(405, "method_not_allowed", "Method not allowed");
      }
      case "approval-decide": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const human = asHuman();
        const fields = await body(req);
        if (!shape(fields, { required: ["decision"], optional: ["note", "editedBody"] })
          || !["approve", "edit", "reject"].includes(fields.decision)) {
          invalidInput(reject, '{decision: "approve"|"edit"|"reject", note?, editedBody?}');
        }
        if (fields.decision === "edit" && (fields.editedBody === null || fields.editedBody === undefined)) {
          return reject(422, "invalid_input", 'decision "edit" requires editedBody with the requested changes.');
        }
        if (fields.decision === "reject" && (fields.note === null || fields.note === undefined)) {
          return reject(422, "invalid_input", 'decision "reject" requires note as the rejection reason.');
        }
        const proposal = collab.decideApproval(roomId, collabId, {
          decision: fields.decision,
          by: human,
          note: fields.note ?? null,
          editedBody: fields.editedBody ?? null,
          reason: fields.note ?? null,
        });
        return json(res, 200, { proposal });
      }
      case "approval-resubmit": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const agent = asAgent();
        const fields = await body(req);
        if (!shape(fields, { required: ["draft"] })) invalidInput(reject, "{draft: {subject?, body}}");
        const proposal = collab.resubmitApproval(roomId, collabId, { draft: fields.draft, byAgent: agent });
        return json(res, 200, { proposal });
      }
      case "routing-mentions": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: ["mentionedAgentId"], optional: ["threadId", "context"] })) {
          invalidInput(reject, "{mentionedAgentId, threadId?, context?}");
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(fields.mentionedAgentId)) {
          return reject(422, "invalid_input", "mentionedAgentId must be a 1..64 character agent name.");
        }
        const { records, mentions } = collab.routeMention(roomId, {
          threadId: fields.threadId ?? roomId,
          mentionedAgentId: fields.mentionedAgentId,
          from: caller,
          context: fields.context ?? null,
        });
        return json(res, 201, { records, mentions });
      }
      case "routing": {
        if (req.method !== "GET") return reject(405, "method_not_allowed", "Method not allowed");
        return json(res, 200, collab.listRouting(roomId));
      }
      case "routing-resolve": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        // The resolver is whoever authenticated, like every other actor on
        // these routes. This one used to accept a resolvedBy from the body and
        // only shape-check it, so any member could record the owner, or anyone
        // else, as having resolved a routed mention - in the durable
        // collab_routing_events row and its history, not just the response. An
        // attribution nobody can vouch for is worse than none, so the field is
        // refused rather than quietly ignored.
        if (!shape(fields, { required: ["outcome"] })) invalidInput(reject, "{outcome}");
        const record = collab.resolveRouting(roomId, collabId, {
          by: caller,
          outcome: fields.outcome,
        });
        return json(res, 200, { record });
      }
      case "routing-policy": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: ["agentId", "policy"] })) {
          invalidInput(reject, "{agentId, policy: {mode: direct|escalate, scopes?, escalateTo?, note?}}");
        }
        const policy = collab.setRoutingPolicy(roomId, fields.agentId, fields.policy);
        return json(res, 200, { agentId: fields.agentId, policy });
      }
      case "handoffs": {
        if (req.method === "POST") {
          const fields = await body(req);
          if (!shape(fields, { required: ["threadId", "to"],
            optional: ["summary", "openQuestions", "pendingActions", "excerpt", "subject"] })) {
            invalidInput(reject, "{threadId, to: {kind: agent|human, id}, summary?, openQuestions?, pendingActions?, excerpt?, subject?}");
          }
          if (fields.to === null || typeof fields.to !== "object" || Array.isArray(fields.to)
            || !["agent", "human"].includes(fields.to.kind) || typeof fields.to.id !== "string" || !fields.to.id) {
            return reject(422, "invalid_input", "to must be { kind: agent|human, id }.");
          }
          const scope = collab.resolveHandoffAccount(roomId, caller.id, auth.account?.id ?? null);
          const { duplicate, receipt } = collab.createHandoff(roomId, scope, {
            threadId: fields.threadId,
            to: fields.to,
            summary: fields.summary ?? null,
            openQuestions: fields.openQuestions ?? null,
            pendingActions: fields.pendingActions ?? null,
            excerpt: fields.excerpt ?? null,
            subject: fields.subject ?? null,
          }, { from: caller.id });
          // create() answers 201 on first write; a duplicate open handoff for
          // the thread returns the existing receipt with 200.
          return json(res, duplicate ? 200 : 201, { duplicate, handoff: receipt });
        }
        if (req.method === "GET") {
          const scope = collab.resolveHandoffAccount(roomId, caller.id, auth.account?.id ?? null);
          const status = url.searchParams.get("status");
          return json(res, 200, {
            handoffs: collab.listHandoffs(scope, { status }),
          });
        }
        return reject(405, "method_not_allowed", "Method not allowed");
      }
      case "handoff-transition": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: ["status"], optional: ["note"] })) {
          invalidInput(reject, '{status: "accepted"|"completed"|"released", note?}');
        }
        const scope = collab.resolveHandoffAccount(roomId, caller.id, auth.account?.id ?? null);
        const handoff = collab.transitionHandoff(scope, collabId, fields.status, { note: fields.note ?? null });
        return json(res, 200, { handoff });
      }
      // Typed handoff envelopes (RC-2026-09-19-062): agent-to-agent delegation
      // with objective, inputs, scoped authority, expected output, acceptance
      // test, termination, and provenance. The journal lives on the store
      // (store.handoffEnvelopes); these routes are thin room-scoped adapters.
      case "envelopes": {
        if (req.method === "POST") {
          const fields = await body(req);
          if (!shape(fields, { required: ["to", "objective", "inputs", "authority", "expectedOutput", "acceptanceTest", "termination"],
            optional: ["provenance", "requestId"] })) {
            invalidInput(reject, "{to, objective, inputs, authority, expectedOutput, acceptanceTest, termination, provenance?, requestId?}");
          }
          const { requestId, ...envelopeFields } = fields;
          const receipt = store.handoffEnvelopes.create(roomId, envelopeFields, { from: caller.id, requestId });
          return json(res, receipt.duplicate ? 200 : 201, receipt);
        }
        if (req.method === "GET") {
          const status = url.searchParams.get("status");
          const to = url.searchParams.get("to");
          return json(res, 200, {
            envelopes: store.handoffEnvelopes.list(roomId, { status, to }),
          });
        }
        return reject(405, "method_not_allowed", "Method not allowed");
      }
      case "envelope-transition": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        const fields = await body(req);
        if (!shape(fields, { required: ["status"], optional: ["note", "checksPassed"] })) {
          invalidInput(reject, '{status: "accepted"|"completed"|"rejected"|"escalated"|"cancelled", note?, checksPassed?}');
        }
        const envelope = store.handoffEnvelopes.transition(roomId, collabId, fields.status,
          { by: caller.id, note: fields.note ?? null, checksPassed: fields.checksPassed ?? null });
        return json(res, 200, { envelope });
      }
      case "envelope-sweep": {
        if (req.method !== "POST") return reject(405, "method_not_allowed", "Method not allowed");
        await body(req); // no fields; the sweep is idempotent
        const moved = store.handoffEnvelopes.sweepExpired(roomId);
        return json(res, 200, { swept: moved });
      }
      case "envelope-metrics": {
        if (req.method !== "GET") return reject(405, "method_not_allowed", "Method not allowed");
        return json(res, 200, store.handoffEnvelopes.metrics(roomId));
      }
      default:
        return reject(404, "not_found", "Not found");
    }
  } catch (error) {
    throw collabHttpError(error) ?? error;
  }
}
