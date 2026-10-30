// The general request-access flow behind the join page's door
// (src/join.js wires #join-request-form; human-map §8.1: the join page
// is the one place a human without a code asks a room owner in). This
// module began as the account-rooms panel door (RC-2026-09-30-3611,
// human-door P0-2); the panel door and its DOM wiring were retired in
// the #3293 consolidation (step 2). It reuses the POST
// account-bound flow for signed-in humans. The unauthenticated agent
// flow keeps its identity proof; these principals must never share a cache.
//
// The pure orchestration (build/submit) is exported for tests; callers
// inject the client + storage.
import { roomIdFromNext, ROOM_ID_PATTERN } from "./room-deep-link.js";
import {
  FALLBACK_REQUEST_PERMISSIONS,
  validateAccessRequestForm,
  newAccessRequestId,
  stashAccessRequest,
  readAccessRequest,
} from "./invite-context.js";

// The open community room (see join.html's enroll example). Used as the
// door's default; the user can paste any other room link or id.
export const GENERAL_REQUEST_DEFAULT_ROOM_ID = "muse-room";
export const GENERAL_REQUEST_ROOM_ID_MAX = 128;

const humanRequestKey = (accountId, roomId) => "pr:human-access-request:" + JSON.stringify([accountId, roomId]);
export function readHumanAccessRequest(storage, accountId, roomId, authEpoch = 0) {
  const stored = storage.getItem(humanRequestKey(accountId, roomId));
  let saved;
  try { saved = JSON.parse(stored); } catch { return null; }
  return saved?.authEpoch === authEpoch && typeof saved?.requestId === "string" && /^ar_[A-Za-z0-9_-]+$/.test(saved.requestId)
    && saved.payload?.roomId === roomId && saved.payload.requestId === saved.requestId ? saved : null;
}

export function retireHumanAccessRequest(storage, session, roomId, requestId) {
  const saved = readHumanAccessRequest(storage, session.account.id, roomId, session.account.authEpoch ?? 0);
  if (saved?.requestId !== requestId) return false;
  storage.removeItem(humanRequestKey(session.account.id, roomId));
  return true;
}

// Pure: validate the door's fields and build the POST /api/access-requests
// body. Throws with the user-facing message on invalid input. identityId is
// filled by submitGeneralAccessRequest after the stash read / mint.
export function buildGeneralAccessRequest({ roomId, displayName, note, referredBy } = {}) {
  // A pasted room link (?room=<id> or #room/<id>) resolves to its room id,
  // so nobody has to dig a raw id out of an address bar.
  const typed = typeof roomId === "string" ? roomId.trim() : "";
  if (!typed) throw new Error("Paste the link of the room you want to join.");
  let room = roomIdFromNext(typed);
  if (!room && typed.length <= 2048) {
    try {
      const url = new URL(typed, "https://room.invalid");
      if (["http:", "https:"].includes(url.protocol)) {
        const match = /^\/(?:room\/)?rooms\/([^/]+)\/?$/.exec(url.pathname);
        if (match) room = decodeURIComponent(match[1]);
      }
    } catch { /* Invalid links are explained before minting an identity. */ }
  }
  if (!room || !ROOM_ID_PATTERN.test(room) || room.length > GENERAL_REQUEST_ROOM_ID_MAX) {
    throw new Error("That doesn't look like a room link. Paste the link someone sent you.");
  }
  const checked = validateAccessRequestForm({ displayName, note, referredBy });
  if (!checked.ok) throw new Error(checked.error);
  return {
    roomId: room,
    identityId: null,
    displayName: checked.displayName,
    requestedPermissions: [...FALLBACK_REQUEST_PERMISSIONS],
    note: checked.note,
    referredBy: checked.referredBy,
    requestId: newAccessRequestId(),
  };
}

// Orchestration: reuse this browser's stashed identity for the room (or mint
// one), submit the request, stash the record. Client + storage are injected;
// the DOM wiring passes a real AccountClient and window.sessionStorage.
export async function submitGeneralAccessRequest({ client, storage, roomId, displayName, note, referredBy, requireHuman = false }) {
  const body = buildGeneralAccessRequest({ roomId, displayName, note, referredBy });
  // Restore before choosing a principal. A failed session read is not
  // permission to silently enroll the human as a new agent.
  const session = await client.restore();
  if (!session) throw new Error("Your account changed. Please try again.");
  if (requireHuman && !session.authenticated) {
    const error = new Error("Sign in to your account before requesting room access.");
    error.code = "account_session_required";
    error.roomId = body.roomId;
    throw error;
  }
  if (session.authenticated) {
    if (!session.account?.id) throw new Error("Sign in again to request access.");
    const key = humanRequestKey(session.account.id, body.roomId);
    const authEpoch = session.account.authEpoch ?? 0;
    const saved = readHumanAccessRequest(storage, session.account.id, body.roomId, authEpoch);
    const request = saved ? { ...saved.payload } : { ...body };
    delete request.identityId;
    // Persist before sending: uncertain responses must retry the same
    // operation, but never reuse another account's or an agent's request.
    storage.setItem(key, JSON.stringify({ requestId: request.requestId, authEpoch, payload: request }));
    const result = await client.submitAccountAccessRequest(request);
    if (!result?.request || result.request.requestId !== request.requestId || result.request.roomId !== body.roomId
      || result.request.principalKind !== "account") throw new Error("Could not confirm this access request. Please try again.");
    return { ...result.request, principalKind: "account" };
  }
  const stashed = readAccessRequest(storage, body.roomId);
  // Reuse the stashed requestId, not just the identity: requestId is the
  // server's idempotency key, so a retry after a lost response must carry
  // the original id or the server files a duplicate request (and spends
  // rate-limit quota) instead of returning the existing row. A fresh id is
  // minted only when this browser has no stashed request for the room.
  if (stashed?.requestId) body.requestId = stashed.requestId;
  let identityId = stashed?.identityId ?? null;
  let secret = stashed?.secret ?? null;
  if (!identityId) {
    const minted = await client.mintAccessIdentity(body.displayName);
    identityId = minted?.identityId;
    secret = minted?.secret ?? null;
    if (!identityId) throw new Error("The identity service did not return an identity.");
  }
  body.identityId = identityId;
  // Stash BEFORE the submit (M-37): a failed submit must not orphan the
  // freshly minted identity — the record stays stashed so the retry reuses
  // it instead of burning another mint.
  stashAccessRequest(storage, body.roomId, {
    identityId,
    secret,
    requestId: body.requestId,
    displayName: body.displayName,
  });
  await client.submitAccessRequest({ ...body, secret });
  return { requestId: body.requestId, roomId: body.roomId, identityId };
}

// Approval alone is insufficient: confirm the membership is discoverable
// under the same account before navigating into the room.
export async function approvedAccountRequestRoom(client, requestId, roomId) {
  let result;
  try { result = await client.accountAccessRequest(requestId); }
  catch (error) {
    if (error.status === 404) return { status: "unavailable", room: null };
    throw error;
  }
  const request = result?.request;
  if (!request || request.requestId !== requestId || request.roomId !== roomId || request.principalKind !== "account") {
    throw new Error("Could not confirm this access request. Please try again.");
  }
  if (request.status !== "approved") return { status: request.status, room: null };
  let cursor = null;
  do {
    const page = await client.rooms(cursor);
    if (!page) throw new Error("Your account changed. Please sign in again.");
    const room = page.rooms.find(room => room.id === roomId && room.memberId === request.memberId);
    if (room) return { status: "approved", room };
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { status: "approved", room: null };
}
