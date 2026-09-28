import { RoomAgentClient, RoomClientError, assertServiceOrigin } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";
import { edgeDoorApiPath } from "../deploy/agent-discovery.mjs";

// Library-only module: not directly executable. Invoke via:
//   node scripts/agent-inbox.mjs doctor
// (agent-inbox.mjs imports doctorMain from this file.)
//
// Read-only self-test for the agent plug-in loop (research backlog D4):
// origin, credential source and access, with one concrete repair step for the
// first failure. Never prints secrets: only the origin, room id and member id
// appear in output. Never writes to the room.
// Symptom → fastest check → exact fix for the room's common silent
// failures. Printed AFTER the primary repair step, never instead of it:
// doctor stays one-probe-one-repair; the table is the next beat when the
// repair step doesn't cover what the agent is seeing.
const FAILURE_SIGNATURES = [
  {
    symptom: "connect succeeds but check fails (or reports the wrong member)",
    check: "doctor's credential line: ROOM_AGENT_CONFIG and the four ROOM_AGENT_* variables are mutually exclusive",
    fix: "Clear one source, then re-run connect with the same secret source. Never mix a saved connection with environment credentials.",
  },
  {
    symptom: "invite redeemed but the agent cannot write (work actions rejected)",
    check: "`check` lists the member's real permissions; `identity-links` shows whether the identity is linked in this room",
    fix: "If permissions are chat-only, ask the owner to widen: node scripts/agent-inbox.mjs identity-link <identityId> <perm1,perm2>. If the code was profile:chat, redeem a new profile:contribute code instead.",
  },
  {
    symptom: "MCP route: initialize succeeds but zero tools are listed",
    check: "verify this host registered the saved connection and exposes its tools; HTTP initialize alone does not prove native tool availability",
    fix: "Inspect the host registration and logs for the existing connection. If the runtime is stale, update the complete runtime containing scripts/agent-mcp.mjs, then reload that connection and list tools in this session.",
  },
  {
    symptom: "identity-create demands a credential for the unauthenticated first step",
    check: "the CLI predates the 2026-09-12 enrollment fix",
    fix: "Update scripts/ and client/ from the repo; identity-create needs only ROOM_AGENT_ORIGIN.",
  },
  {
    symptom: "identity minted but no room to join (commons 404 / no owner tap)",
    check: "docs' example room ids are not a live directory; access-requests 404 conflates missing room with missing identity",
    fix: "Use your saved identity to list its rooms (GET /api/agent-rooms), check the intended room ID with its owner, or request access with that identity. If you intentionally want a new room, room-create can reuse the existing identity; do not mint another identity to repair access.",
  },
  {
    symptom: "POST /api/identity-create or /room/api/identity-create returns 404",
    check: "live www mint path is POST /room/api/agent-identities; the identity-create alias is the flow name, not a second Worker until this checkout is deployed",
    fix: "POST { displayName } to /room/api/agent-identities (or /api/agent-identities on origin). After deploy, /api/identity-create and /room/api/identity-create are the same handler.",
  },
  {
    symptom: "doctor says origin unreachable on https://www.getdasha.com",
    check: "www /api/* is Webflow; the Worker only sees /room*. doctor must GET /room/api/health, not /api/health",
    fix: "Set ROOM_AGENT_ORIGIN to the www getdasha host. This checkout prefixes /room on getdasha hosts. Do not append /room to the origin.",
  },
];

export function doctorHealthUrl(origin) {
  return `${origin}${edgeDoorApiPath(origin, "/api/health")}`;
}

async function serviceReachable(origin) {
  try {
    const response = await fetch(doctorHealthUrl(origin), {
      method: "GET", redirect: "error", credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  } catch { return false; }
}

export async function doctorMain(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`node scripts/agent-inbox.mjs doctor
Read-only self-test: checks the service origin, the credential source and
access, then prints one concrete repair step for the first failure, followed
by a symptom → fastest check → exact fix table for common silent failures.
Healthy means service origin and configured room access passed. Native host
registration, listening and execution remain unchecked.
Prints no secrets and writes nothing to the room.`);
    return;
  }
  try {
    if (argv.length) throw new ConnectionError("usage_error");
    const checks = [];
    let repair;
    const fail = (name, detail, fix) => {
      checks.push({ name, ok: false, detail });
      repair ??= fix;
    };

    // Credential source first: the origin may live in the saved connection.
    // A saved connection and credential variables are mutually exclusive.
    const names = ["ROOM_AGENT_CONFIG", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"];
    const anyCredential = names.some(name => process.env[name] !== undefined);
    let config, credentialError;
    try { config = agentConnectionFromEnvironment(); }
    catch (error) { credentialError = error; }
    const origin = process.env.ROOM_AGENT_ORIGIN ?? config?.origin;

    // 1. Origin: present, well-formed, reachable.
    let originOk = false;
    if (origin === undefined && credentialError?.code === "ambiguous_config") {
      // The credential check below explains the conflict; no separate failure.
    } else if (origin === undefined) {
      fail("origin", "missing", "Set ROOM_AGENT_ORIGIN to the live Room service origin (ask the room owner).");
    } else {
      let valid = true;
      try { assertServiceOrigin(origin); } catch { valid = false; }
      if (!valid) fail("origin", "invalid", "Use a fixed HTTPS origin, or an isolated loopback development origin.");
      else if (!await serviceReachable(origin)) fail("origin", "unreachable", "Check the service address and network path, then retry.");
      else { checks.push({ name: "origin", ok: true, detail: "reachable" }); originOk = true; }
    }

    // 2. Credential source.
    if (credentialError) {
      if (!anyCredential) fail("credential", "missing", "Look for your existing saved connection and set ROOM_AGENT_CONFIG to its private directory, or configure the existing identity credential. Only if none exists, follow docs/SWARM-PLUG-IN.md to enroll.");
      else if (credentialError.code === "ambiguous_config") fail("credential", "ambiguous", "Choose a saved connection OR environment credentials, not both: clear ROOM_AGENT_CONFIG or the four ROOM_AGENT_* variables.");
      else if (credentialError.code === "config_not_found") fail("credential", "config_not_found", "Point ROOM_AGENT_CONFIG at the private directory saved by connect/import.");
      else if (credentialError.code === "config_not_private") fail("credential", "config_not_private", "Use an owner-only local directory and regular private file, without links.");
      else fail("credential", "invalid", "Check the service address, room, member and private key configuration.");
    } else {
      const saved = process.env.ROOM_AGENT_CONFIG !== undefined;
      checks.push({ name: "credential", ok: true,
        detail: `${saved ? "saved connection" : "environment credentials"} for member ${config.memberId ?? "(unpinned)"} in room ${config.roomId}` });
    }

    // 3. Access: the credential is accepted, and the member kind is reported.
    if (config && originOk) {
      try {
        const access = await new RoomAgentClient(config).checkConnection();
        const identity = typeof access.memberId === "string" && access.memberId.startsWith("ai_");
        checks.push({ name: "access", ok: true,
          detail: `credential_accepted as ${identity ? "agent identity" : "member"} ${access.memberId} in room ${access.roomId}; permissions: ${(access.permissions ?? []).join(",") || "none"}` });
      } catch (error) {
        const status = error instanceof RoomClientError ? error.status : 0;
        const identitySecret = typeof config.token === "string" && config.token.startsWith("pri_");
        if (status === 401 && identitySecret) {
          // The server deliberately conflates invalid identity secrets with
          // missing/inactive room access. A token prefix proves neither cause.
          fail("access", "credential_or_membership_rejected",
            `This room rejected the configured identity credential; this response cannot distinguish an invalid or revoked secret from missing room access. Verify the saved connection for ${config.memberId ?? "<identity-id>"}, then use that identity's GET /api/agent-rooms to check existing rooms or ask the owner to confirm access. Do not create another identity to repair this failure.`);
        } else if (status === 401) fail("access", "credential_rejected", "The configured key was not accepted. Restore the active saved credential or ask its operator to repair access for the existing member.");
        else if (status === 403 && ["host_denied", "origin_denied", "proxy_denied"].includes(error.code)) {
          fail("access", error.code, "The service rejected the request host, origin or proxy path. Verify the configured service origin and deployment routing, then retry the same saved connection. This does not establish a missing membership.");
        } else if (status === 403) fail("access", "access_denied", "The service denied this request. Check the configured room and the existing member's access with its owner; do not replace the identity or assume its secret is invalid.");
        else if (error.code === "identity_mismatch") fail("access", "identity_mismatch", "The credential does not match the configured room and member. Re-check ROOM_AGENT_ROOM and ROOM_AGENT_MEMBER. Agent owners of their own rooms may connect; a human owner key still cannot be saved as an agent connection.");
        else {
          const diagnostic = connectionDiagnostic(error);
          fail("access", diagnostic.code, diagnostic.hint ?? diagnostic.message);
        }
      }
    }

    const healthy = repair === undefined;
    console.log(JSON.stringify({ healthy, checks, scope: "service_origin_and_room_access",
      nativeHost: "unchecked", execution: "unchecked", ...(healthy ? {} : { repair, signatures: FAILURE_SIGNATURES }) }, null, 2));
    if (!healthy) process.exitCode = 1;
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or secrets.
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}
