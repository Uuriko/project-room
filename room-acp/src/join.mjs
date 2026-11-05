// `room-acp <invite link>`: redeem once, save the credential privately.
import { hostname } from "node:os";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { parseInvite } from "./link.mjs";
import { RoomClient, RoomError } from "./room.mjs";
import { configDir, loadConnection, listConnections, saveConnection } from "./credentials.mjs";
import { openJoinJournal } from "./private-state.mjs";
import { registerSecret } from "./redact.mjs";

export function defaultHostId() {
  const host = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "host";
  return `room-acp-${host}-${randomBytes(3).toString("hex")}`;
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const selectionOf = connection => connection ? {
  roomId: connection.roomId, memberId: connection.memberId, identityId: connection.identityId
} : null;

export async function join({ link, displayName, agent = null, permissionApproverId = null, roomId = null, origin, env = process.env, fetchImpl = fetch }) {
  const { apiBase, code, linkToken } = parseInvite(link, origin ? { origin } : {});
  registerSecret(code); registerSecret(linkToken);
  // Keep the existing code journal key so an interrupted pre-upgrade join can
  // recover with its original request ID. Share links use the same primitive.
  const key = code ? digest([apiBase, code]) : digest(["share", apiBase, linkToken]);
  const journal = openJoinJournal(configDir(env), key);
  let destination = null;
  let ownsDestination = false;
  let previousUnresolved = false;
  let mutationStarted = false;
  let authoritativeNoWrite = false;
  let destinationBinding = null;
  const clearDestination = () => {
    if (ownsDestination) destination.save({ ...destinationBinding, operationKey: null });
  };
  try {
    const selected = roomId === null ? null : loadConnection({ roomId }, env);
    if (roomId !== null && (!selected || selected.apiBase !== apiBase || typeof selected.identityId !== "string"
      || typeof selected.memberId !== "string" || typeof selected.identitySecret !== "string" || !selected.identitySecret.startsWith("pri_")))
      throw Error("The selected saved connection has no matching Room identity at this origin; this attempt did not redeem an invitation");
    const selection = selectionOf(selected);
    let pending = journal.read();
    const legacy = pending !== null && !Object.hasOwn(pending, "targetRoomId");
    if (!pending) {
      pending = { version: 1, apiBase, displayName, requestId: randomUUID(), hostId: defaultHostId(), agent, permissionApproverId,
        selectedIdentity: selection, targetRoomId: null, mutationStarted: false };
      journal.save(pending); // Must succeed before even the read-only preflight.
    }
    if (pending.version !== 1 || pending.apiBase !== apiBase || pending.displayName !== displayName
      || pending.agent !== agent || pending.permissionApproverId !== permissionApproverId
      || typeof pending.requestId !== "string" || typeof pending.hostId !== "string")
      throw Error("Saved invitation setup differs; no identity or connection was changed");
    if (JSON.stringify(pending.selectedIdentity ?? null) !== JSON.stringify(selection)) {
      // A preflight refusal has sent no business request. Explicit selection
      // may correct that attempt, but an attempted/legacy mutation never may.
      if (pending.mutationStarted !== false || pending.recovery || pending.joined || pending.completed)
        throw Error("Saved invitation setup differs; no identity or connection was changed");
      pending.selectedIdentity = selection; journal.save(pending);
    }
    const beginMutation = () => {
      pending.mutationStarted = true; journal.save(pending);
      mutationStarted = true;
    };
    if (selected) {
      // Authenticate the identity itself, not just a copied identityId or a
      // room token. The identity must currently resolve to this exact member.
      const identity = new RoomClient({ ...selected, credential: selected.identitySecret, fetchImpl });
      const account = await identity.request("/api/agent-rooms");
      if (account.identityId !== selected.identityId)
        throw Error("The selected saved identity no longer matches its Room member");
      await identity.checkConnection();
    }
    let targetRoomId = pending.targetRoomId ?? pending.completed?.roomId ?? pending.joined?.roomId ?? pending.recovery?.roomId ?? null;
    if (!targetRoomId) {
      const preview = linkToken
        ? await new RoomClient({ apiBase, fetchImpl }).request("/api/share-links/preview", { body: { linkToken }, auth: false })
        : await new RoomClient({ apiBase, fetchImpl }).request("/api/agent-invites/redeem?code=" + encodeURIComponent(code), { auth: false });
      targetRoomId = linkToken ? preview.room?.id : preview.status === "available" ? preview.roomId : null;
      // An old code journal may already have burned its code before losing the
      // response. Only its original saved request can recover that receipt.
      if (!targetRoomId && !(legacy && code && preview.status === "used"))
        throw Error("Invitation is not available; no saved connection was changed");
      if (targetRoomId) { pending.targetRoomId = targetRoomId; journal.save(pending); }
    }
    let existingTarget = null;
    const lockTarget = target => {
      if (typeof target !== "string" || !target || target.length > 128) throw Error("Room returned an invalid destination");
      // Acquisition is always invitation then destination, never two destination
      // locks. Match the actual saved filename, including its sanitization, so
      // two origins or two IDs cannot race the same local file.
      destination = openJoinJournal(configDir(env), "room-" + digest(target.replace(/[^A-Za-z0-9._-]/g, "_")));
      const owner = destination.read();
      destinationBinding = { version: 1, apiBase, roomId: target };
      if (owner && (owner.version !== 1 || typeof owner.apiBase !== "string" || typeof owner.roomId !== "string"
        || owner.operationKey !== null && typeof owner.operationKey !== "string")) throw Error("Saved destination ownership is invalid");
      if (owner?.operationKey && (owner.operationKey !== key || owner.apiBase !== apiBase || owner.roomId !== target))
        throw Error("An earlier invitation for this saved room has an unresolved outcome; retry that original invitation first");
      previousUnresolved = owner?.operationKey === key;
      const filename = target.replace(/[^A-Za-z0-9._-]/g, "_");
      const matching = listConnections(env).filter(entry => typeof entry.roomId === "string" && entry.roomId.replace(/[^A-Za-z0-9._-]/g, "_") === filename);
      if (matching.length > 1 || matching.some(entry => entry.roomId !== target))
        throw Error("Another saved room uses this connection filename; this attempt did not redeem an invitation");
      existingTarget = matching[0] ?? null;
      const ownSaved = pending.joined ?? pending.completed;
      const completingOwnSave = ownSaved && ownSaved.roomId === target && existingTarget?.apiBase === apiBase
        && existingTarget.identityId === ownSaved.identityId && existingTarget.memberId === ownSaved.memberId;
      if (existingTarget && !completingOwnSave && (!selected || existingTarget.apiBase !== apiBase || existingTarget.identityId !== selected.identityId))
        throw Error("A connection is already saved for this room; select its identity with --room before using another invitation");
      destination.save({ ...destinationBinding, operationKey: key });
      ownsDestination = true;
    };
    if (targetRoomId) lockTarget(targetRoomId);
    if (pending.completed) {
      const existing = loadConnection({ roomId: pending.completed.roomId }, env);
      if (pending.completed.roomId !== targetRoomId || selected && pending.completed.identityId !== selected.identityId
        || !existing || existing.memberId !== pending.completed.memberId || existing.identityId !== pending.completed.identityId || existing.apiBase !== apiBase)
        throw Error("This invitation was already saved or forgotten; use the saved connection or request a new invitation");
      await new RoomClient({ ...existing, fetchImpl }).checkConnection();
      clearDestination();
      return existing;
    }

    if (selected && linkToken) {
      // Shared-link admission has no request-bound scoped-issuance receipt.
      // Never rotate another host's existing target token or save this
      // multi-room identity bearer as a room credential to bridge that gap.
      if (!existingTarget || !existingTarget.credential?.startsWith("rak_"))
        throw Error("To connect this existing identity to another room, ask for a single-use agent invitation link (RM code). Shared links cannot safely recover a new scoped connection");
      await new RoomClient({ ...existingTarget, fetchImpl }).checkConnection();
      pending.completed = { roomId: existingTarget.roomId, memberId: existingTarget.memberId, identityId: existingTarget.identityId };
      journal.save(pending); clearDestination();
      return existingTarget;
    }

    const room = new RoomClient({ apiBase, identitySecret: selected?.identitySecret ?? null, fetchImpl });
    let joined = pending.joined;
    if (!joined && linkToken) {
      let identitySecret = selected?.identitySecret ?? pending.identity?.secret;
      if (!identitySecret) {
        const bucket = Math.floor(Date.now() / 600000);
        let proof;
        for (let i = 0; i < 1000000; i++) {
          const nonce = i.toString(36);
          if (createHash("sha256").update(`${bucket}:${displayName.trim()}:${nonce}`).digest("hex").startsWith("000")) { proof = nonce; break; }
        }
        if (!proof) throw Error("identity proof search exhausted");
        beginMutation();
        pending.identity = await room.request("/api/agent-identities", { body: { displayName, proof }, auth: false });
        registerSecret(pending.identity.secret); journal.save(pending);
        identitySecret = pending.identity.secret;
      }
      registerSecret(identitySecret);
      beginMutation();
      const admitted = await new RoomClient({ apiBase, credential: identitySecret, fetchImpl })
        .request("/api/share-links/join-agent", { body: { linkToken, displayName } });
      joined = { ...admitted, displayName, credential: identitySecret, identitySecret };
    } else if (!joined) {
      if (pending.recovery) registerSecret(pending.recovery.identitySecret);
      beginMutation();
      try {
        joined = pending.recovery ? await room.recoverRedemption(pending.recovery)
          : await room.redeem({ code, displayName, requestId: pending.requestId, saveRecovery: recovery => {
            if (targetRoomId && recovery.roomId !== targetRoomId || selected && recovery.identityId !== selected.identityId)
              throw Error("Invitation recovery returned another Room identity or destination");
            registerSecret(recovery.identitySecret); pending.recovery = recovery;
            if (!targetRoomId) { targetRoomId = recovery.roomId; pending.targetRoomId = targetRoomId; }
            journal.save(pending);
            if (!destination) lockTarget(targetRoomId);
          } });
      } catch (error) {
        // A typed first-redemption refusal confirms no new membership write.
        // Once a previous outcome was unknown, or recovery already proved a
        // committed receipt, never clear ownership based on a later refusal.
        authoritativeNoWrite = !previousUnresolved && !pending.recovery && !pending.joined
          && error instanceof RoomError && [400, 401, 403, 404, 409, 410, 422].includes(error.status);
        throw error;
      }
    }
    registerSecret(joined.credential); registerSecret(joined.identitySecret);
    if (targetRoomId && joined.roomId !== targetRoomId || selected && joined.identityId !== selected.identityId)
      throw Error("Invitation returned another Room identity or destination; no saved connection was changed");
    if (!destination) {
      // Compatibility recovery of an old, already-committed code request.
      targetRoomId = joined.roomId; lockTarget(targetRoomId);
      pending.targetRoomId = targetRoomId;
    }
    await new RoomClient({ apiBase, ...joined, fetchImpl }).checkConnection();
    pending.joined = joined; delete pending.recovery; delete pending.identity; journal.save(pending);
    if (existingTarget) {
      // Share-link duplicate membership must not replace a saved scoped token
      // with an identity-wide credential. Codes retain their backend409.
      if (existingTarget.identityId !== joined.identityId || existingTarget.memberId !== joined.memberId)
        throw Error("The saved Room member differs; no connection was replaced");
      await new RoomClient({ ...existingTarget, fetchImpl }).checkConnection();
    } else {
      const connection = { version: 1, apiBase, ...joined, hostId: pending.hostId, agent, permissionApproverId, joinedAt: new Date().toISOString() };
      saveConnection(connection, env);
    }
    pending.completed = { roomId: joined.roomId, memberId: joined.memberId, identityId: joined.identityId };
    delete pending.joined; journal.save(pending);
    clearDestination();
    return existingTarget ?? loadConnection({ roomId: joined.roomId }, env);
  } catch (error) {
    if (ownsDestination && ((!mutationStarted && !previousUnresolved) || authoritativeNoWrite)) clearDestination();
    throw error;
  } finally {
    try { destination?.close(); } finally { journal.close(); }
  }
}
