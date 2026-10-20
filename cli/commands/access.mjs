// room access: decide agent access requests from one line.
//   room access                         list pending requests
//   room access approve <requestId> [--perm <permission>]... [--note <text>]
//   room access deny <requestId> [--note <text>]
// Same store path as the room's access-request card. The caller must be the
// room owner or a membership-administration delegate.
import { connection } from "./code.mjs";
import { callTool } from "../mcp-tool.mjs";

export function parseAccessArgs(argv) {
  const [verb = "list", requestId, ...rest] = argv;
  if (!["list", "approve", "deny"].includes(verb)) throw new Error("Use room access [list|approve <requestId>|deny <requestId>]");
  if (verb !== "list" && (!requestId || requestId.startsWith("--"))) throw new Error(`room access ${verb} needs a requestId (run room access to list them)`);
  const permissions = [];
  let note = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--perm" && rest[i + 1]) { permissions.push(rest[++i]); continue; }
    if (rest[i] === "--note" && rest[i + 1] !== undefined) { note = rest[++i]; continue; }
    throw new Error(`Unknown option ${rest[i]}`);
  }
  if (verb === "deny" && permissions.length) throw new Error("--perm only applies to approve");
  return { verb, requestId: verb === "list" ? null : requestId, permissions, note };
}

export async function accessCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, out = console.log } = {}) {
  const { verb, requestId, permissions, note } = parseAccessArgs(argv);
  const conn = await connection({ env, cwd });
  if (verb === "list") {
    const listed = await callTool(conn, "room_list_access_requests", { roomId: conn.roomId }, fetchImpl);
    const requests = listed.requests ?? [];
    if (!requests.length) { out("No pending access requests."); return 0; }
    for (const r of requests) {
      const perms = (r.requestedPermissions ?? []).join(", ") || "default";
      out(`${r.requestId}  ${r.displayName ?? r.identityId}  wants: ${perms}${r.note ? `  note: ${r.note}` : ""}`);
    }
    out("Approve: room access approve <requestId>   Deny: room access deny <requestId>");
    return 0;
  }
  const args = { roomId: conn.roomId, requestId, decision: verb };
  if (note !== null) args.note = note;
  if (permissions.length) args.permissions = permissions;
  const result = await callTool(conn, "room_decide_access_request", args, fetchImpl);
  const name = result.request?.displayName ?? result.displayName ?? requestId;
  out(verb === "approve" ? `Approved ${name}.` : `Denied ${name}.`);
  return 0;
}
