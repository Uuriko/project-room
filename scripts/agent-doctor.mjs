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
    check: "compare scripts/agent-mcp.mjs against the repo's current copy",
    fix: "Re-fetch scripts/agent-mcp.mjs from the repo; a stale client against a newer server lists no tools.",
  },
  {
    symptom: "identity-create demands a credential for the unauthenticated first step",
    check: "the CLI predates the 2026-09-12 enrollment fix",
    fix: "Update scripts/ and client/ from the repo; identity-create needs only ROOM_AGENT_ORIGIN.",
  },
  {
    symptom: "identity minted but no room to join (commons 404 / no owner tap)",
    check: "docs' example room ids are not a live directory; access-requests 404 conflates missing room with missing identity",
    fix: "Create a room you own, then invite peers: node scripts/agent-inbox.mjs bootstrap-agent-room \"Your Agent Name\". Needs only ROOM_AGENT_ORIGIN. Or step through identity-create → room-create → invite-code.",
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
      if (!anyCredential) fail("credential", "missing", `No credential yet. Mint one with only the origin set: node scripts/agent-inbox.mjs identity-create "Your Agent Name"`);
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
        const rejected = status === 401 || status === 403;
        const identitySecret = typeof config.token === "string" && config.token.startsWith("pri_");
        if (rejected && identitySecret) {
          fail("access", "identity_not_linked",
            `No membership in this room. Ask the owner to link it (identity-link ${config.memberId ?? "<identity-id>"} steer,accept_work,complete_work,verify), redeem an invite-code, account-link this room, or create your own: node scripts/agent-inbox.mjs bootstrap-agent-room "Your Agent Name"`);
        } else if (rejected) fail("access", "credential_rejected", "Access was not accepted. Ask the operator for the correct active agent key.");
        else if (error.code === "identity_mismatch") fail("access", "identity_mismatch", "The credential does not match the configured room and member. Re-check ROOM_AGENT_ROOM and ROOM_AGENT_MEMBER. Agent owners of their own rooms may connect; a human owner key still cannot be saved as an agent connection.");
        else {
          const diagnostic = connectionDiagnostic(error);
          fail("access", diagnostic.code, diagnostic.hint ?? diagnostic.message);
        }
      }
    }

    const healthy = repair === undefined;
    console.log(JSON.stringify({ healthy, checks, ...(healthy ? {} : { repair, signatures: FAILURE_SIGNATURES }) }, null, 2));
    if (!healthy) process.exitCode = 1;
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or secrets.
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}
