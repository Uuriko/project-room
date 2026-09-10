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
  if (httpStatus === 401 || reasonCode === "unauthenticated") {
    return {
      status: "action_required", reason: "unauthenticated",
      hint: "Ask the owner to mint a guest-agent credential or Add agent. Then room_check_access.",
      next: [tool("room_check_access"), path("/api/session"), command("Ask the owner to mint a guest-agent credential or Add agent")]
    };
  }
  if (reasonCode === "wrong_link_kind") {
    return {
      status: "action_required", reason: "wrong_link_kind",
      hint: "That is a human #join/ link. Ask the owner for a ga1. guest-agent token or Add agent.",
      next: [path("/api/guest-agent-links"), command("Ask the owner to mint a guest-agent credential or Add agent")]
    };
  }
  if (reasonCode === "link_unavailable" || reasonCode === "guest_agent_link_not_implemented") {
    return {
      status: "action_required",
      reason: reasonCode,
      hint: "This guest-agent link is not live. Ask the owner to mint a new one or Add agent.",
      next: [path("/api/guest-agent-links"), command("Ask the owner to mint a guest-agent credential or Add agent")]
    };
  }
  if (httpStatus === 403 || ["access_denied", "owner_required", "host_denied", "origin_denied", "proxy_denied", "csrf_denied"].includes(reasonCode)) {
    return {
      status: "action_required",
      reason: reasonCode === "owner_required" ? "owner_required" : "access_denied",
      hint: reasonCode === "owner_required"
        ? "Only the room owner can mint a guest-agent credential or Add agent."
        : "This credential cannot do that. Check access; ask the owner if needed.",
      next: [tool("room_check_access"), path("/api/session"), command("Ask the owner to mint a guest-agent credential or Add agent")]
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
  if (inputRefused(httpStatus, reasonCode, message) || reasonCode === "work_input_refused") {
    return {
      status: "action_required", reason: "input_refused",
      hint: "Fix the refused fields. Keep any earlier uncertain requestId.",
      next: [readWork, command("Correct input; keep any earlier uncertain requestId")]
    };
  }
  if (reasonCode === "command_rejected") {
    return {
      status: "action_required", reason: "command_rejected",
      hint: "Read current work. Do not silently rebase.",
      next: [readWork, command("Read current work before another action")]
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
