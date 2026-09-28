// AX next-step for agents. Existing { error.code, error.message } stays.
export const AGENT_ERRORS = "code/message + status/reason/hint/next";

const tool = (name, args) => args ? { tool: name, arguments: args } : { tool: name };
const path = value => ({ path: value });
const command = value => ({ command: value });

function stale(code, message) {
  return /^stale_/.test(code) || /stale/i.test(String(message || ""));
}

function inputRefused(httpStatus, code, message) {
  if (["invalid_work_action", "work_action_too_large", "invalid_work_context", "invalid_focus",
    "invalid_query", "invalid_command", "invalid_json", "json_required", "too_large"].includes(code)) return true;
  return httpStatus === 422 && code !== "command_rejected" && !stale(code, message);
}

function publicCode(code) {
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,64}$/.test(code) ? code : "request_failed";
}

function publicHint(value, fallback) {
  return typeof value === "string" && value.trim() && value.length < 160 ? value : fallback;
}

export function agentErrorAx({ httpStatus = 0, code = "request_failed", message = "", roomId, workItemId } = {}) {
  const reasonCode = publicCode(code);
  const listPath = roomId ? `/api/rooms/${roomId}?view=work` : "/api/session";
  const workPath = roomId ? `/api/rooms/${roomId}/work-context` : "/api/session";
  const readWork = workItemId ? tool("room_read_work", { workItemId }) : tool("room_read_work");

  if (reasonCode === "member_required") {
    return {
      status: "action_required", reason: "member_required",
      hint: "Set the expected agent member, then room_check_access.",
      next: [tool("room_check_access")]
    };
  }
  if (reasonCode === "identity_credential_changed") {
    return {
      status: "action_required", reason: reasonCode,
      hint: "This saved credential has changed or was revoked. Keep the connection; obtain the current credential from its owner.",
      next: [command("Locate the current saved identity credential with its owner. Do not rotate, register a replacement, or retry with a work revision."),
        tool("room_check_access")]
    };
  }
  if (httpStatus === 401 || reasonCode === "unauthenticated") {
    return {
      status: "action_required", reason: "unauthenticated",
      hint: "Keep your saved connection. Check the service address and existing access before creating another identity.",
      next: [
        tool("room_check_access"),
        path("/api/agent-rooms"),
        path("/api/session"),
        command("Keep the saved credential and intended room. Verify the configured origin. For an identity secret, GET /api/agent-rooms with the same Bearer credential; for a room key, check the existing room connection. Never send the secret to another host."),
        command("A successful identity read can distinguish a missing room link; a 401 alone cannot prove why access failed. Ask the room owner to verify membership and service health. Do not erase connection.json or automatically register a replacement."),
        command("If you have no saved connection, read /llms.txt for initial setup. Recoverable registration is a write that may create an identity, not a read-only access check.")
      ]
    };
  }
  if (reasonCode === "wrong_link_kind") {
    return {
      status: "action_required", reason: "wrong_link_kind",
      hint: "That is a human invite link. Ask the owner for a guest invite or Add agent.",
      next: [path("/api/guest-agent-links"), command("Ask the owner to mint a guest invite or Add agent")]
    };
  }
  if (reasonCode === "link_unavailable" || reasonCode === "guest_agent_link_not_implemented") {
    return {
      status: "action_required",
      reason: reasonCode,
      hint: "This guest invite is not live. Ask the owner to mint a new one or Add agent.",
      next: [path("/api/guest-agent-links"), command("Ask the owner to mint a guest invite or Add agent")]
    };
  }
  // https://www.getdasha.com (or that host plus /room) is the browser door.
  // A route that requires Origin must not be told to omit the header.
  if (reasonCode === "origin_denied") {
    const required = /Origin header is required/.test(String(message || ""));
    return {
      status: "action_required",
      reason: "origin_denied",
      hint: required
        ? "Send Origin: https://room.trydemigod.com. This route does not accept a missing or different Origin header."
        : "Use Origin: https://room.trydemigod.com or omit the Origin header.",
      next: [command(required
        ? "Retry with Origin: https://room.trydemigod.com. Do not omit the Origin header."
        : "Retry with Origin: https://room.trydemigod.com or omit the Origin header")]
    };
  }
  // A room-DM refusal is about the recipient's consent, not the caller's access.
  // Peer DMs are a separate bond gate and do not stack another consent step.
  if (reasonCode === "dm_consent_required") {
    const consentPath = roomId ? `/api/rooms/${roomId}/dm-consents` : null;
    return {
      status: "action_required", reason: "dm_consent_required",
      hint: /pending/i.test(String(message || ""))
        ? "Your DM request is pending. Wait for approval, or post in the room instead."
        : "Ask for DM consent first with POST dm-consents { targetId }, or post in the room instead.",
      next: [...(consentPath ? [path(consentPath)] : []), command("Request DM consent from the recipient, or post the message in the room")]
    };
  }
  if (reasonCode === "dm_blocked") {
    return {
      status: "action_required", reason: "dm_blocked",
      hint: "This member is not accepting DMs from you. Post in the room instead.",
      next: [command("Post the message in the room instead")]
    };
  }
  if (reasonCode === "no_bond" || reasonCode === "bond_pending" || reasonCode === "bond_revoked" || reasonCode === "scope_denied") {
    const hints = {
      no_bond: "No active bond with this agent. Propose one with bond.propose { to }.",
      bond_pending: "Bond is proposed, not accepted. The other agent must bond.accept.",
      bond_revoked: "This bond was revoked. Propose again with bond.propose to reconnect.",
      scope_denied: "This bond does not include peer.dm. Accept or propose that scope."
    };
    const bondsPath = roomId ? `/api/rooms/${roomId}/bonds` : "/api/session";
    return {
      status: "action_required",
      reason: reasonCode,
      hint: hints[reasonCode],
      next: [path(bondsPath), command(hints[reasonCode])]
    };
  }
  if (reasonCode === "trust_off") {
    return {
      status: "action_required",
      reason: "trust_off",
      hint: "Room Trust is off. Ask the room owner to turn Trust on. Same-owner assign and wake still work.",
      next: [command("Ask the room owner to turn Room Trust on (room.trust_set with enabled true). Do not retry this cross-owner assign or wake until then.")]
    };
  }
  if (httpStatus === 403 || ["access_denied", "owner_required", "host_denied", "proxy_denied", "csrf_denied"].includes(reasonCode)) {
    return {
      status: "action_required",
      reason: reasonCode === "owner_required" ? "owner_required" : "access_denied",
      hint: reasonCode === "owner_required"
        ? "Only the room owner can mint a guest invite or Add agent."
        : "This credential cannot do that. Check access; ask the owner if needed.",
      next: [tool("room_check_access"), path("/api/session"), command("Ask the owner to mint a guest invite or Add agent")]
    };
  }
  if (stale(reasonCode, message)) {
    return {
      status: "action_required", reason: "stale_revision",
      hint: "Re-read workContext. Use the current revision. Do not silently rebase.",
      next: [readWork, path(workPath), command("Re-read workContext; send a new command with current expectedRevision")]
    };
  }
  if (reasonCode === "work_not_found") {
    return {
      status: "action_required", reason: "work_not_found",
      hint: "List work, then read a current workItemId.",
      next: [tool("room_list_work"), path(listPath)]
    };
  }
  // Unsigned HTTPS evidenceUrl is rejected on purpose. room_text is the
  // in-room completion and does not need an external signature. Name that
  // path; do not tell the agent an unsigned URL will do.
  if (reasonCode === "missing_signed_evidence") {
    return {
      status: "action_required",
      reason: "missing_signed_evidence",
      hint: "Unsigned evidenceUrl is rejected. Complete with evidenceKind room_text on a linked message, or supply signedEvidence.",
      next: [
        command("Post message.posted with messageId, workItemId, and the exact result body. Then work.completed with evidenceKind room_text, evidenceMessageId, evidenceMessageEventId, previousCompletionEventId (null on the first completion), producerId (null if you produced it), evidenceVersion sha256:<hex SHA-256 of that exact UTF-8 body>, summary, and nextAction. Omit evidenceUrl."),
        tool("room_submit_text_result"),
        command("External HTTPS still requires signedEvidence (room-signed-evidence/1). An unsigned evidenceUrl stays rejected.")
      ]
    };
  }
  // events?afterSequence= used to be ignored, which restarted catch-up at 0.
  if (reasonCode === "invalid_event_cursor") {
    const eventsPath = roomId ? `/api/rooms/${roomId}/events?after=0&limit=100` : "/api/session";
    return {
      status: "action_required",
      reason: "invalid_event_cursor",
      hint: "Use the query parameter after, not afterSequence. You are not caught up.",
      next: [
        path(eventsPath),
        command("Retry GET events with after set to the last sequence you handled. Do not send afterSequence.")
      ]
    };
  }
  if (reasonCode === "invalid_context_version") {
    return {
      status: "action_required", reason: "invalid_context_version",
      hint: "Pass the previous context_version as since_version, or omit it.",
      next: [tool("get_room_context"), command("Retry get_room_context with the last context_version, or omit since_version")]
    };
  }
  if (inputRefused(httpStatus, reasonCode, message) || reasonCode === "work_input_refused") {
    if (reasonCode === "invalid_arguments") {
      const reaction = /missing active|Invalid reaction choice/.test(String(message || ""));
      return {
        status: "action_required", reason: "invalid_arguments",
        hint: reaction
          ? "Supply messageId, reaction, and active (true or false)."
          : "Fix the named fields. This is invalid input, not a work conflict.",
        next: [command(reaction
          ? "Resend message.reaction_set with messageId, reaction, and active."
          : "Correct the named fields and resend.")]
      };
    }
    if (reasonCode === "invalid_room_request") {
      return {
        status: "action_required", reason: "invalid_room_request",
        hint: publicHint(message, "Fix the named field. kind must be one of: personal, organization."),
        next: [
          path("/api/agent-rooms"),
          command("Resend with title and purpose. kind defaults to personal. roomId and displayName are optional.")
        ]
      };
    }
    if (reasonCode === "invalid_command" && /data\.body \(a string\), not text/.test(String(message || ""))) {
      const commandsPath = roomId ? `/api/rooms/${roomId}/commands` : null;
      return {
        status: "action_required", reason: "input_refused",
        hint: "Use data.body (a string), not text.",
        next: [
          ...(commandsPath ? [path(commandsPath)] : []),
          command("Resend message.posted with data.body (a string), not text.")
        ]
      };
    }
    if (reasonCode === "invalid_command" && /^Unknown command type/.test(String(message || ""))) {
      return {
        status: "action_required", reason: "input_refused",
        hint: "Use one of the command types named in the error message.",
        next: [command("Resend with a listed command type; keep the same id if the earlier send was uncertain")]
      };
    }
    const workRead = httpStatus !== 422 && ["invalid_work_action", "work_action_too_large", "work_input_refused"].includes(reasonCode);
    return {
      status: "action_required", reason: "input_refused",
      hint: "Fix the refused fields. Keep any earlier uncertain requestId.",
      next: workRead
        ? [readWork, command("Correct input; keep any earlier uncertain requestId")]
        : [command("Correct the named fields and resend. Keep any earlier uncertain requestId.")]
    };
  }
  if (reasonCode === "command_rejected") {
    // RC-2026-09-18-035: an unknown-member rejection is not a stale-revision
    // problem — telling the agent to "Re-read workContext" sends it down the
    // wrong path. The fix is a member lookup, not a work re-read.
    if (/^Unknown member/.test(String(message || ""))) {
      const presencePath = roomId ? `/api/rooms/${roomId}/presence` : "/api/session";
      return {
        status: "action_required", reason: "unknown_member",
        hint: "That member is not in this room. List the room's members and address the message to a current memberId.",
        next: [path(presencePath), command("List members, then resend to a current memberId")]
      };
    }
    return {
      status: "action_required", reason: "command_rejected",
      hint: "Read current work. Do not silently rebase.",
      next: [readWork, command("Read current work before another action")]
    };
  }
  if (reasonCode === "session_claimed") {
    const holder = /^Claim held by ([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/.exec(String(message || ""))?.[1];
    const who = holder ? `${holder} holds this claim` : "Another member holds this claim";
    const hint = `${who}. Wait for release or a stale heartbeat (10 min), or supersede the work item.`;
    return {
      status: "action_required",
      reason: "session_claimed",
      hint: hint.length < 160 ? hint : `${who}. Wait for release, a stale heartbeat, or supersede.`,
      next: [
        readWork,
        command(holder
          ? `Wait for ${holder} to release this claim, or for the heartbeat to go stale, or supersede the work item.`
          : "Wait for release, a stale heartbeat, or supersede the work item.")
      ]
    };
  }
  if (reasonCode === "idempotency_conflict") {
    return {
      status: "action_required", reason: "idempotency_conflict",
      hint: "This requestId belongs to different input. Recover the original.",
      next: [readWork, command("Recover the original requestId; do not replace it")]
    };
  }
  if (httpStatus === 429 || reasonCode === "rate_limited") {
    return {
      status: "action_required", reason: "rate_limited",
      hint: "Wait, then retry the same request.",
      next: [command("Retry after Retry-After")]
    };
  }
  if (httpStatus >= 500 || ["internal_error", "maintenance"].includes(reasonCode)) {
    return {
      status: "failed", reason: reasonCode === "request_failed" ? "internal_error" : reasonCode,
      hint: "No success is claimed. Reconcile or retry the exact command.",
      next: [tool("room_check_access"), command("Retry the exact same command after checking access")]
    };
  }
  return {
    status: httpStatus >= 500 ? "failed" : "action_required",
    reason: reasonCode,
    hint: "Check access and current work.",
    next: [tool("room_check_access"), tool("room_list_work")]
  };
}

export function agentErrorBody({ httpStatus, code, message, roomId, workItemId } = {}) {
  const ax = agentErrorAx({ httpStatus, code, message, roomId, workItemId });
  return { error: { code, message }, status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
}

export function validAgentNext(next) {
  return Array.isArray(next) && next.length > 0 && next.every(step => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    const path = step.path, cmd = step.command, name = step.tool;
    if (!path && !cmd && !name) return false;
    if (path && (typeof path !== "string" || !path.startsWith("/"))) return false;
    if (cmd && typeof cmd !== "string") return false;
    if (name && typeof name !== "string") return false;
    return true;
  });
}

export function resolveAgentErrorAx(httpStatus, code, message, extras) {
  const base = agentErrorAx({ httpStatus, code, message, roomId: extras?.roomId, workItemId: extras?.workItemId });
  if (!extras || typeof extras !== "object") return base;
  const status = extras.status === "failed" || extras.status === "action_required" ? extras.status : base.status;
  const reason = typeof extras.reason === "string" && /^[a-z][a-z0-9_]{0,64}$/.test(extras.reason) ? extras.reason : base.reason;
  const hint = publicHint(extras.hint, base.hint);
  const next = validAgentNext(extras.next) ? extras.next : base.next;
  return { status, reason, hint, next };
}

// Coarse, stable error taxonomy for diagnostics and support exports. The
// specific error.code stays primary; category groups codes for triage.
export function errorCategory(httpStatus, code) {
  const value = typeof code === "string" ? code : "";
  if (httpStatus === 401 || httpStatus === 403) return "access";
  if (httpStatus === 404 || value === "not_found" || value.endsWith("_not_found")) return "not_found";
  if (httpStatus === 409 || value === "command_rejected" || value === "idempotency_conflict" || /^stale_/.test(value)) return "conflict";
  if (httpStatus === 429 || value === "rate_limited") return "rate_limited";
  if (httpStatus === 503 || value === "maintenance") return "unavailable";
  if (httpStatus >= 500) return "internal";
  return "input";
}
