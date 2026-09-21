import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomAgentClient, assertServiceOrigin, createAgentIdentity, previewAgentInvite, redeemAgentInvite, previewSharedInvite, joinSharedInvite, requestAccess, listAgentRooms } from "./room-agent.mjs";
import { readAgentConnection } from "./agent-connection.mjs";
import { openSetupJournal, privateDirectory, atomicPrivateJson } from "./setup-journal.mjs";
import { edgeDoorApiPath, ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";
import { parseShareInviteCode } from "../src/share-invite-code.js";
import { validId } from "../src/events.js";

const canonicalOrigin = value => {
  const origin = assertServiceOrigin(value);
  return ["https://getdasha.com", "https://www.getdasha.com"].includes(origin) ? ROOM_ORIGIN : origin;
};
export function setupTarget(value, origin) {
  if (typeof value !== "string") throw new Error("Choose an invite or Room URL");
  if (/^RM-[a-z0-9]+$/i.test(value)) return { origin: canonicalOrigin(origin), code: value.toUpperCase() };
  const shortCode = parseShareInviteCode(value);
  if (shortCode) return { origin: canonicalOrigin(origin), sharedToken: shortCode };
  const url = new URL(value); assertServiceOrigin(url.origin);
  if (url.username || url.password || url.search || !["", "/", "/room", "/room/"].includes(url.pathname)) throw new Error("Use the Room entry URL");
  if (origin && canonicalOrigin(origin) !== canonicalOrigin(url.origin)) throw new Error("URL and configured origin disagree");
  if (!url.hash) return { origin: canonicalOrigin(url.origin) };
  const [kind, id, extra, focus, trailing] = url.hash.slice(1).split("/");
  if (["join", "code"].includes(kind) && (/^[A-Za-z0-9_-]{43}$/.test(id ?? "") || parseShareInviteCode(id)) && !trailing
    && (!extra || ["work", "message"].includes(extra) && validId(focus))) return { origin: canonicalOrigin(url.origin), sharedToken: parseShareInviteCode(id) || id };
  if (!extra && kind === "agent-invite" && /^RM-[a-z0-9]+$/i.test(id ?? "")) return { origin: canonicalOrigin(url.origin), code: id.toUpperCase() };
  if (!extra && kind === "room" && validId(id)) return { origin: canonicalOrigin(url.origin), roomId: id };
  throw new Error("Use a shared invitation, agent invite or room link; an account sign-in link is not agent access");
}
const signature = preview => JSON.stringify({ roomId: preview.roomId, permissions: [...preview.permissions].sort(), expiresAt: preview.expiresAt });

// All mutation inputs are saved before the first request. Repeating this operation
// resumes the same identity and admission; it never silently replaces a connection.
export async function connectRoom({ target, directory, origin, name = "Room agent", accept = false, identityFrom, fetchImpl = globalThis.fetch }) {
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Choose an agent name of 1–80 characters");
  const destination = setupTarget(target, origin), journal = openSetupJournal(directory);
  try {
    let saved = journal.read();
    if (!saved) {
      const imported = identityFrom ? readAgentConnection(identityFrom) : null;
      if (imported && (canonicalOrigin(imported.origin) !== destination.origin || !/^pri_[A-Za-z0-9_-]{43}$/.test(imported.token))) throw new Error("Choose an identity connection on the same service");
      const importedIdentity = imported ? await listAgentRooms(imported.origin, imported.token, { fetchImpl }) : null;
      saved = { version: 1, origin: destination.origin, name, secret: imported?.token ?? "pri_" + randomBytes(32).toString("base64url"),
        identityId: importedIdentity?.identityId ?? null, targets: {} };
      journal.save(saved); // A crash before registration cannot lose the only credential.
    }
    if (saved.version !== 1 || canonicalOrigin(saved.origin) !== destination.origin || !/^pri_[A-Za-z0-9_-]{43}$/.test(saved.secret)
      || typeof saved.name !== "string" || !saved.name.trim() || saved.name.length > 80 || /[\u0000-\u001f\u007f]/.test(saved.name) || !saved.targets || typeof saved.targets !== "object" || Array.isArray(saved.targets)
      || saved.identityId !== null && !validId(saved.identityId)) throw new Error("Saved setup does not match this service or identity");
    if (identityFrom && (readAgentConnection(identityFrom).token !== saved.secret || canonicalOrigin(readAgentConnection(identityFrom).origin) !== canonicalOrigin(saved.origin))) throw new Error("Setup already belongs to another identity");
    destination.origin = saved.origin; // Existing verified alias connections keep their journal/config paths.
    const options = { identitySecret: saved.secret, fetchImpl };
    const key = createHash("sha256").update(JSON.stringify(destination)).digest("hex");
    let step = saved.targets[key];
    if (!step) {
      if (Object.keys(saved.targets).length >= 100) throw new Error("Setup destination limit reached");
      step = saved.targets[key] = { ...destination, requestId: randomUUID(), approved: null, roomId: destination.roomId ?? null };
      journal.save(saved);
    }
    if (step.origin !== destination.origin || step.code !== destination.code || step.sharedToken !== destination.sharedToken || !validId(step.requestId)
      || step.roomId !== null && !validId(step.roomId) || destination.roomId && step.roomId !== destination.roomId
      || step.approved !== null && typeof step.approved !== "string") throw new Error("Saved destination is invalid; no connection changed");
    if (step.approved) {
      const approved = JSON.parse(step.approved);
      if (approved.roomId !== step.roomId || !Array.isArray(approved.permissions)) throw new Error("Saved approval is invalid");
    }
    if ((destination.code || destination.sharedToken) && !step.approved) {
      const preview = destination.sharedToken ? await previewSharedInvite(saved.origin, destination.sharedToken, options)
        : await previewAgentInvite(saved.origin, destination.code, options);
      if (!accept) return { status: "approval_required", preview, next: "Repeat with --accept to accept this invite's room and permissions" };
      step.approved = signature(preview); step.roomId = preview.roomId; journal.save(saved);
    }
    if (!saved.identityId) {
      const identity = await createAgentIdentity(saved.origin, saved.name, options);
      saved.identityId = identity.identityId; journal.save(saved);
    }
    // This authenticated discovery also verifies imported/recovered credentials.
    const memberships = [], cursors = new Set(); let cursor;
    do {
      const page = await listAgentRooms(saved.origin, saved.secret, cursor ? { ...options, after: cursor } : options);
      if (page.identityId !== saved.identityId) throw new Error("Room list returned a different identity");
      if (page.nextCursor && cursors.has(page.nextCursor) || cursors.size >= 100 || memberships.length + page.rooms.length > 5000) throw new Error("Room list exceeds the setup limit");
      memberships.push(...page.rooms); cursor = page.nextCursor; if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!step.roomId) {
      const response = await fetchImpl(saved.origin + edgeDoorApiPath(saved.origin, "/api/public/rooms/directory"), {
        redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Public room discovery unavailable; saved identity retained");
      const publicRooms = await response.json();
      return { status: "choose_room", identityId: saved.identityId, memberships, directory: publicRooms,
        next: "Run join again with an invited or public room URL and the same private directory" };
    }
    let membership = memberships.find(room => room.roomId === step.roomId);
    if (!membership && (destination.code || destination.sharedToken)) {
      const joined = destination.sharedToken ? await joinSharedInvite(saved.origin, destination.sharedToken, saved.name, options)
        : await redeemAgentInvite(saved.origin, destination.code, saved.name, options);
      const expected = JSON.parse(step.approved);
      if (joined.roomId !== expected.roomId || joined.identityId !== saved.identityId
        || !joined.duplicate && JSON.stringify([...joined.permissions].sort()) !== JSON.stringify(expected.permissions))
        throw new Error("Redemption did not match the approved room and identity");
      membership = joined; step.joined = true; journal.save(saved);
    }
    if (!membership) {
      const result = await requestAccess(saved.origin, { roomId: step.roomId, identityId: saved.identityId,
        displayName: saved.name, requestedPermissions: [], note: "I would like to join this room and collaborate.", requestId: step.requestId }, options);
      step.admission = result.status; journal.save(saved);
      return { status: result.status, identityId: saved.identityId, roomId: step.roomId, requestId: step.requestId,
        next: "Repeat this command to check admission; no new identity or request will be created" };
    }
    const config = { version: 1, origin: saved.origin, roomId: step.roomId, memberId: membership.memberId, token: saved.secret };
    const client = new RoomAgentClient({ ...config, fetchImpl });
    const access = await client.checkConnection(), orientation = await client.activationPack();
    const rooms = privateDirectory(join(journal.root, "rooms")), configDirectory = privateDirectory(join(rooms, step.roomId));
    try {
      const existing = readAgentConnection(configDirectory);
      if (JSON.stringify(existing) !== JSON.stringify(config)) throw new Error("Existing connection differs; nothing was replaced");
    } catch (error) {
      if (error.code !== "config_not_found") throw error;
      atomicPrivateJson(join(configDirectory, "connection.json"), config);
    }
    step.joined = true; journal.save(saved);
    return { status: "connected", origin: saved.origin, identityId: saved.identityId, roomId: step.roomId, memberId: access.memberId,
      configDirectory, permissions: access.permissions, orientation,
      host: { transport: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../scripts/agent-mcp.mjs", import.meta.url))],
        env: { ROOM_AGENT_CONFIG: configDirectory }, installed: false },
      readiness: { access: "verified", read: "verified", listening: "not_tested", execution: "not_tested" },
      next: "Import host into your MCP client; it contains no secret. Run room_check_access, then room_list_work. Listening and execution require a running host" };
  } finally { journal.close(); }
}
