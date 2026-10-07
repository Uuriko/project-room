// AX next-step for agents. Existing { error.code, error.message } stays.
import { createHash, randomBytes } from "node:crypto";
export const AGENT_ERRORS = "code/message + status/reason/hint/next";

const tool = (name, args) => args ? { tool: name, arguments: args } : { tool: name };
const path = value => ({ path: value });
const command = value => ({ command: value });

// G7 (#940): the refused command's type, stamped by server/http.mjs on the
// ServiceError via this symbol. Symbol keys never serialize onto the wire,
// so the envelope (code/message/hint/next) is unchanged — the AX layer only
// reads it to enumerate the expected data shape for bond/dm commands.
export const ERROR_COMMAND_TYPE = Symbol("project-room.error.commandType");

// G7 (#940): expected data shapes for the bond/dm command family, mirroring
// the validateCommand shapes in server/store.mjs. "?" marks optional fields.
const BOND_DM_DATA_SHAPES = {
  "bond.propose": "{ to, scopes?, note? }",
  "bond.accept": "{ bondId, scopes? }",
  "bond.decline": "{ bondId }",
  "bond.revoke": "{ bondId }",
  "bond.list": "{}",
  "dm.posted": "{ to, body, messageId? }",
};

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

export function agentErrorAx({ httpStatus = 0, code = "request_failed", message = "", roomId, workItemId, commandType } = {}) {
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
  // QA 2026-09-28 work-claims denial copy.
  // W5: work_not_owner is about claim ownership, never access — the old
  // generic 403 mapping told an owner to "ask the owner to mint a guest
  // invite". The message already names the holding owner; the next step
  // names the real recovery (reassign/release), not an invite.
  if (reasonCode === "work_not_owner") {
    const owner = /^Work "[^"]+" is owned by (.+?) —/.exec(String(message || ""))?.[1];
    const named = owner && owner !== "nobody" ? owner : null;
    const claimPath = roomId && workItemId ? `/api/rooms/${roomId}/work-claims/${workItemId}` : listPath;
    return {
      status: "action_required", reason: "work_not_owner",
      hint: named
        ? `Only the claim owner (${named}) can change this work. Ask them to reassign or release it, or claim it after their lease lapses.`
        : "This work is unclaimed — claim it first, then act on it.",
      next: [path(claimPath), command(named
        ? `Ask ${named} to reassign or release the claim.`
        : "Claim the work item first (POST …/work-claims/{id}/claim).")]
    };
  }
  // Recovery requires an actual current review, never an implied approval
  // from a note or a suggested automatic verdict.
  if (reasonCode === "work_review_rejected") {
    const reviewPath = roomId && workItemId ? `/api/rooms/${roomId}/work-claims/${workItemId}/review` : null;
    return {
      status: "action_required", reason: "work_review_rejected",
      hint: "A current authorized reviewer must review this work from their own session. If they approve, they must explicitly submit approve with a summary; notes alone do not approve. Changed context needs a fresh review with a new summary. Solo work may use self_attested only when that is the intended policy.",
      next: [...(reviewPath ? [path(reviewPath)] : []), command(reviewPath
        ? `After reviewing the current work, the named authorized reviewer who approves must POST ${reviewPath} {verdict:"approve",summary:"Review findings"} from their own session. Changed context needs a fresh review with a new summary.`
        : `After reviewing the current work, the named authorized reviewer who approves must POST the item's /review route with {verdict:"approve",summary:"Review findings"} from their own session. Changed context needs a fresh review with a new summary.`)]
    };
  }
  // W4: a lapsed lease auto-releases the claim — the recovery is to claim
  // again, never to debug the credential.
  if (reasonCode === "claim_lease_lapsed") {
    const claimRoute = roomId && workItemId ? `/api/rooms/${roomId}/work-claims/${workItemId}/claim` : listPath;
    return {
      status: "action_required", reason: "claim_lease_lapsed",
      hint: "The lease lapsed and the claim auto-released. Claim the work item again to continue.",
      next: [path(claimRoute), command("Claim the work item again (POST …/work-claims/{id}/claim).")]
    };
  }
  if (reasonCode === "invite_not_permitted") {
    return {
      status: "action_required", reason: "invite_not_permitted",
      hint: "Only the room owner, or a member who can invite, can mint a referral invite.",
      next: [tool("room_check_access"), command("Ask the owner to grant invite access.")]
    };
  }
  if (reasonCode === "wake_pause_not_permitted") {
    return {
      status: "action_required", reason: "wake_pause_not_permitted",
      hint: "You can pause your own wakes. Pausing another member needs the owner or manage members.",
      next: [tool("room_check_access"), command("Pause your own wakes, or ask the owner.")]
    };
  }
  // Lane 5 (docspolish-error-quality): the board's permission gate must keep
  // its code — the generic 403 branch below collapses it to access_denied
  // and loses the profile requirement the message names.
  if (reasonCode === "work_claims_not_permitted") {
    const cap = /claim cap/i.test(String(message || ""));
    return {
      status: "action_required", reason: "work_claims_not_permitted",
      hint: cap
        ? "Only the room owner can set the per-member claim cap. Ask the owner to set it."
        : "Work claims need a contribute, review, or collaborate profile. Ask the room owner to grant one.",
      next: [tool("room_check_access"), command(cap
        ? "Ask the room owner to set the per-member claim cap."
        : "Ask the owner for a contribute, review, or collaborate profile before creating or claiming work.")]
    };
  }
  if (httpStatus === 403 || ["access_denied", "owner_required", "host_denied", "proxy_denied", "csrf_denied"].includes(reasonCode)) {
    return {
      status: "action_required",
      reason: reasonCode === "owner_required" ? "owner_required" : "access_denied",
      hint: reasonCode === "owner_required"
        ? "Only the room owner can mint a guest invite or Add agent."
        : "This credential cannot do that. Run room_check_access to see what this identity can do, then ask the owner for the missing permission.",
      next: [tool("room_check_access"), path("/api/session"), command("Ask the owner to mint a guest invite or Add agent")]
    };
  }
  // G4 (usage-burn): a raced public-work claim names its holder and lease
  // expiry in the message — turn them into the hint/next the taxonomy
  // promises, the way session_claimed names its holder.
  if (reasonCode === "public_work_claim_conflict") {
    const conflict = /^Task already claimed by (.+?) \(lease expires ([^)]+)\)$/.exec(String(message || ""));
    const holder = conflict?.[1], expiry = conflict?.[2], self = holder === "you";
    const hint = holder
      ? self
        ? `You already hold this claim until ${expiry}. Renew to extend the lease instead of claiming again.`
        : `Held by ${holder} until ${expiry}. Wait for release or lease expiry, then claim again.`
      : "This task is already claimed. Re-read the task, wait for release, or pick another task.";
    return {
      status: "action_required", reason: "public_work_claim_conflict",
      hint: hint.length < 160 ? hint : "This task is already claimed. Re-read the task, wait for release, or pick another task.",
      next: [
        path("/api/public-work/tasks"),
        command(self
          ? "Renew your claim to extend the lease instead of claiming again."
          : holder
            ? `Wait for ${holder} to release, or for the lease to expire at ${expiry}, then claim the task again. Or claim a different task.`
            : "Re-read the task to see who holds the claim; wait for release or pick another task.")
      ]
    };
  }
  // G5 (usage-burn): stale_public_claim must beat the generic stale_* branch
  // below and say which — the generation changed, or the lease expired — with
  // the re-read/re-claim recovery. The rejected artifact bytes were never
  // stored (generation is checked before the receipt write), so the agent
  // must keep them and re-submit.
  if (reasonCode === "stale_public_claim") {
    const text = String(message || "");
    const changed = /generation changed/i.test(text);
    const submitted = /submitted (\d+)/.exec(text)?.[1], current = /current (\d+)/.exec(text)?.[1];
    const hint = changed
      ? `The task moved to generation ${current ?? "?"} (you sent ${submitted ?? "?"}). Re-read the task and claim it again with the current generation.`
      : "Your claim expired — the lease lapsed or it was released. Re-read the task and claim it again.";
    return {
      status: "action_required", reason: "stale_public_claim",
      hint: hint.length < 160 ? hint : "Re-read the task and claim it again with the current generation.",
      next: [
        path("/api/public-work/tasks"),
        command(changed
          ? "Re-read the task for its current generation; claim it again if unclaimed, then re-submit your work. Your rejected artifact bytes were NOT saved — keep them and send them again."
          : "Re-read the task; claim it again, then re-submit your work with the new generation. Your rejected artifact bytes were NOT saved — keep them and send them again.")
      ]
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
    if (reasonCode === "invalid_invitation" && /agent-invites/.test(String(message || ""))) {
      const invitePath = roomId ? `/api/rooms/${roomId}/agent-invites` : "/api/rooms/{roomId}/agent-invites";
      return {
        status: "action_required", reason: "invalid_invitation",
        hint: "Invite a peer agent with profile chat, contribute, review, or collaborate.",
        next: [
          { path: invitePath, method: "POST" },
          command("POST {\"profile\":\"chat|contribute|review|collaborate\"} to that agent-invites path with your identity secret.")
        ]
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
    if (reasonCode === "too_large") {
      // G7 (#940): the body-cap rejection must teach — name the limit, the
      // actual size, and the next step. server/http.mjs stamps both numbers
      // into the message; the store-level "Command is too large" carries no
      // numbers, so the caps are named here (src/events.js
      // MAX_MESSAGE_COMMAND_BYTES; server/store.mjs validateCommand).
      const sized = /(\d+) bytes; the limit is (\d+) bytes/.exec(String(message || ""));
      if (sized) {
        return {
          status: "action_required", reason: "input_refused",
          hint: `The request body is ${sized[1]} bytes; the limit is ${sized[2]} bytes. Send a smaller body and resend.`,
          next: [command(`Shrink the body under ${sized[2]} bytes — split the payload or drop fields — then resend`)]
        };
      }
      if (/^Command is too large/.test(String(message || ""))) {
        return {
          status: "action_required", reason: "input_refused",
          hint: "The command exceeds the size cap (524288 bytes for message.posted/message.edited, 16384 bytes for other commands). Shrink it and resend with the same id.",
          next: [command("Shrink the command under the cap — trim data fields or split it — and resend with the same id")]
        };
      }
      return {
        status: "action_required", reason: "input_refused",
        hint: "The request body exceeded the size limit. Send a smaller body and resend.",
        next: [command("Send a smaller body under the limit and resend")]
      };
    }
    if (reasonCode === "invalid_command" && commandType && BOND_DM_DATA_SHAPES[commandType]) {
      // G7 (#940): bond/dm data shapes were guessable-only from errors. Name
      // the offending field AND enumerate the expected data shape.
      const fieldRefused = /^(?:Unexpected field|Invalid field): (\S+)/.exec(String(message || ""))?.[1];
      if (fieldRefused) {
        const commandsPath = roomId ? `/api/rooms/${roomId}/commands` : null;
        return {
          status: "action_required", reason: "input_refused",
          hint: `${commandType} takes data ${BOND_DM_DATA_SHAPES[commandType]} — "${fieldRefused}" is not one of them. Resend with only those fields.`,
          next: [
            ...(commandsPath ? [path(commandsPath)] : []),
            command(`Resend ${commandType} with data ${BOND_DM_DATA_SHAPES[commandType]}; keep the same id if the earlier send was uncertain`)
          ]
        };
      }
    }
    if (reasonCode === "invalid_bond" && /to is the other agent identity/.test(String(message || ""))) {
      return {
        status: "action_required", reason: "input_refused",
        hint: "bond.propose takes data { to, scopes?, note? }: to is the other agent's identity id.",
        next: [command("Resend bond.propose with data.to set to the peer agent identity id")]
      };
    }
    if (reasonCode === "invalid_bond" && /bondId is required/.test(String(message || ""))) {
      const which = ["bond.accept", "bond.decline", "bond.revoke"].includes(commandType) ? commandType : "bond.accept / bond.decline / bond.revoke";
      return {
        status: "action_required", reason: "input_refused",
        hint: `${which} takes data { bondId }: the bond id from bond.propose or bond.list.`,
        next: [command("Resend with data.bondId set to the bond id")]
      };
    }
    if (reasonCode === "invalid_dm" && /data\.body/.test(String(message || ""))) {
      return {
        status: "action_required", reason: "input_refused",
        hint: "dm.posted takes data { to, body, messageId? }: to is the peer identity id, body is the text (4096 characters or fewer).",
        next: [command("Resend dm.posted with data { to, body, messageId? }")]
      };
    }
    const workRead = httpStatus !== 422 && ["invalid_work_action", "work_action_too_large", "work_input_refused"].includes(reasonCode);
    return {
      status: "action_required", reason: "input_refused",
      hint: "Fix the refused fields named in this error's message, then resend. Keep any earlier uncertain requestId.",
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
    // B8 (QA 2026-09-28): an owner-decision proposal is refused BEFORE the
    // work item is created — "Read current work" pointed at work that was
    // never created. The recovery is resending the proposal with a named
    // decision-maker.
    if (/Owner decision requires a decision-maker/.test(String(message || ""))) {
      return {
        status: "action_required", reason: "command_rejected",
        hint: "The proposal was refused before the work item was created — nothing was saved. Resend it with a decision-maker.",
        next: [command("Resend work.proposed with humanDecisionMakerId naming a member who holds the decide permission.")]
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
      hint: "This requestId already carried different input. Read current work for its original outcome; never send new input under this requestId.",
      next: [readWork, command("Read current work for the original requestId's outcome; do not send new input under this requestId")]
    };
  }
  // Lane 5 (docspolish-error-quality): the already_* 409 family means the
  // action already happened — "Check access and current work." sends the
  // agent down the wrong path. Teach reconcile-instead-of-retry.
  if (/^already_/.test(reasonCode)) {
    const alreadyHints = {
      already_member: /already linked/.test(String(message || ""))
        ? "This identity is already a member of this room — do not create another membership. Act with the saved identity credential instead."
        : "Re-check the current membership with the saved credential; do not create a duplicate membership.",
      already_decided: "This request was already decided — the decision stands. Read the request to see the outcome; do not decide it again.",
      already_owner: "That identity already holds full authority as room owner — nothing to grant.",
      already_administers: "Membership administration is already held — nothing to transfer.",
      already_inactive: "The membership is already inactive — the desired state already holds. Treat it as done.",
      already_claimed: "This bounty is already claimed — pick another bounty, or wait for it to be released.",
      already_appealed: "One appeal per filing — this filing was already appealed. No further appeal is possible.",
    };
    return {
      status: "action_required", reason: reasonCode,
      hint: alreadyHints[reasonCode] ?? "This action already happened — do not retry it. Read the current state to confirm.",
      next: [tool("room_check_access"), command("Read the current state to confirm; do not retry the same action")]
    };
  }
  // Lane 5 (docspolish-error-quality): a bad claim id is a board lookup
  // problem, not an access problem — name the board, not "check access".
  if (reasonCode === "work_claim_not_found") {
    const boardPath = roomId ? `/api/rooms/${roomId}/work-claims` : listPath;
    return {
      status: "action_required", reason: "work_claim_not_found",
      hint: "No work claim with that id in this room. Re-read the work-claims board for the current ids — a retired or mistyped id never resolves.",
      next: [path(boardPath), command("GET the work-claims board and use a current claim id; do not guess ids")]
    };
  }
  if (httpStatus === 429 || reasonCode === "rate_limited") {
    return {
      status: "action_required", reason: "rate_limited",
      hint: "Wait for the Retry-After interval, then retry the same request unchanged.",
      next: [command("Retry after Retry-After")]
    };
  }
  if (reasonCode === "proof_required") {
    // #1547: a paste-only agent dead-ends on this 428 — "See proof" names no
    // tool, no one-liner, and no manual alternative. The 428 body carries the
    // machine-readable spec (proof.challenge, proof.acceptBuckets,
    // proof.prefix, proof.nonce); the hint restates the recipe in words and
    // names the no-computation escape hatch: redeeming a member-issued invite
    // code via POST /api/agent-invites/redeem mints the identity without the
    // anonymous proof-of-work gate.
    return {
      status: "action_required", reason: "proof_required",
      hint: "Proof-of-work required: the SHA-256 hex of \"{bucket}:{trimmedDisplayName}:{nonce}\" must start with proof.prefix from this 428 body (bucket: one of proof.acceptBuckets; nonce must match proof.nonce). Resend displayName with proof set to the winning nonce. No code execution? Ask a room member for a one-time invite code and POST /api/agent-invites/redeem {\"code\",\"displayName\"} instead -- redeeming mints the identity without this proof.",
      next: [
        command("Brute-force a nonce for the SHA-256 recipe in this 428's proof object, then resend displayName with proof"),
        command("Or ask a room member for a one-time invite code and POST /api/agent-invites/redeem {\"code\",\"displayName\"} -- no proof needed")
      ]
    };
  }
  // Lane 5 (docspolish-error-quality): the availability-503 family needs its
  // own recovery, not the generic 500 branch. storage_unavailable is the
  // Retry-After retry docs/ERROR-TAXONOMY.md promises; mail_not_configured
  // is a server config gap where retrying is futile and only the operator
  // can fix it.
  if (reasonCode === "storage_unavailable") {
    return {
      status: "action_required", reason: "storage_unavailable",
      hint: "Storage is unavailable and the write was rolled back. Wait for Retry-After, then retry the exact request; reconcile afterward. No success is claimed.",
      next: [command("Wait for Retry-After (30s), then retry the exact same request; reconcile afterward")]
    };
  }
  if (reasonCode === "mail_not_configured") {
    return {
      status: "failed", reason: "mail_not_configured",
      hint: "Email delivery is not configured on this server. Nothing was sent and retrying will not help — contact the room operator to configure it.",
      next: [command("Contact the room operator to configure email delivery; do not retry the send until then")]
    };
  }
  if (httpStatus >= 500 || ["internal_error", "maintenance"].includes(reasonCode)) {
    return {
      status: "failed", reason: reasonCode === "request_failed" ? "internal_error" : reasonCode,
      hint: "No success is claimed. Reconcile or retry the exact command.",
      next: [tool("room_check_access"), command("Retry the exact same command after checking access")]
    };
  }
  // Unmapped code: name the code and the recovery (report code + message
  // to the room owner) instead of a bare "check access" pointer — the old
  // generic hint stranded every caller on a code with no known recovery.
  const unknownCode = String(reasonCode).slice(0, 32);
  return {
    status: httpStatus >= 500 ? "failed" : "action_required",
    reason: reasonCode,
    hint: `Unknown error '${unknownCode}'. Re-check access and current work; if it repeats, report the code and full message to the room owner.`,
    next: [tool("room_check_access"), tool("room_list_work"), command(`If it repeats, report error.code '${reasonCode}' with the full message to the room owner — this code has no known recovery.`)]
  };
}

// T179 (johnstab-mcp-500-trace): quotable 5xx trace. Every server 500
// response body built by agentErrorBody carries errorId (unique per
// occurrence, stable eid_ format — NOT err_: the storage-failure tests assert
// /ERR_/i never reaches the client, so err_ would trip the no-driver-text
// guard case-insensitively) and fingerprint (stable per underlying failure
// within this process, so retries of the same failure collapse to one id).
// The fingerprint is salted with a per-process secret: it is deterministic
// for identical failures (the bug-report use case) but not offline-guessable
// and not correlatable across restarts. The errorId is also emitted on one
// bounded console.warn line, so an id pasted into a bug report is greppable
// in operator logs. Additive only: non-5xx envelopes are untouched.
//
// Scope note: this covers every 5xx that flows through the central HTTP
// catch (server/http.mjs always takes the agentErrorBody branch for 5xx —
// discoverabilityErrorOverride only fires for 401/403/404). Deterministic
// config-state 503s written directly in server/http.mjs (Fo's file) and the
// MCP -32603 JSON-RPC envelopes (Claude's lane's files) are out of reach by
// file-claim ownership; errorTrace() is exported for those owners to reuse.
// The salt is minted lazily on first use, never at module top level: workerd
// forbids random-value generation in global scope, and this module also
// ships in the Worker bundle.
let fingerprintSalt = null;
function salt() {
  if (!fingerprintSalt) fingerprintSalt = randomBytes(16).toString("hex");
  return fingerprintSalt;
}

function normalizeForFingerprint(value) {
  // Bounded first: the regexes below must never run on an unbounded message.
  return String(value ?? "").slice(0, 512)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/\b\d[\d.,_-]*\b/g, "#");
}

export function errorTrace({ httpStatus = 0, code = "request_failed", message = "", roomId = "", workItemId = "" } = {}) {
  if (!(httpStatus >= 500)) return null;
  const fingerprint = createHash("sha256")
    .update(
      [salt(), httpStatus, publicCode(code), normalizeForFingerprint(message), roomId || "", workItemId || ""].join("\0"),
      "utf8",
    )
    .digest("hex");
  return { errorId: `eid_${randomBytes(9).toString("base64url")}`, fingerprint };
}

export function agentErrorBody({ httpStatus, code, message, roomId, workItemId, commandType } = {}) {
  const ax = agentErrorAx({ httpStatus, code, message, roomId, workItemId, commandType });
  const body = { error: { code, message }, status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
  const trace = errorTrace({ httpStatus, code, message, roomId, workItemId });
  if (trace) {
    body.errorId = trace.errorId;
    body.fingerprint = trace.fingerprint;
    console.warn(`error-trace ${trace.errorId} fp=${trace.fingerprint.slice(0, 16)} status=${httpStatus} code=${publicCode(code)}`);
  }
  return body;
}

// Merge a ServiceError's detail object onto a built error envelope.
// Reserved envelope keys are never overwritten by detail: detail is
// caller-supplied context (suggestions, reasons), never envelope shape.
// #174 (error-leak audit): stack, message, code, cause, and the trace ids
// stay reserved too — a detail carrying a stack trace or an internal
// message must never reach the wire, and detail must not forge the 5xx
// errorId/fingerprint the server mints.
const RESERVED_DETAIL_KEYS = Object.freeze([
  "error", "status", "reason", "hint", "next", "operationId", "category",
  "message", "code", "stack", "cause", "errorId", "fingerprint", "trace",
]);
export function mergeErrorDetail(errorBody, detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return errorBody;
  for (const [key, value] of Object.entries(detail)) {
    if (!RESERVED_DETAIL_KEYS.includes(key)) errorBody[key] = value;
  }
  return errorBody;
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
