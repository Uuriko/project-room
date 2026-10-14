// The general request-access flow behind the join page's door
// (src/join.js wires #join-request-form; human-map §8.1: the join page
// is the one place a human without a code asks a room owner in). This
// module began as the account-rooms panel door (RC-2026-09-30-3611,
// human-door P0-2); the panel door and its DOM wiring were retired in
// the #3293 consolidation (step 2). It reuses the POST
// /api/access-requests flow: mint a self-serve identity (an identity
// alone grants nothing), file the request with the minted identity's
// secret as proof, and let the room owner approve/deny.
//
// The pure orchestration (build/submit) is exported for tests; callers
// inject the client + storage.
import { roomIdFromNext } from "./room-deep-link.js";
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

// Pure: validate the door's fields and build the POST /api/access-requests
// body. Throws with the user-facing message on invalid input. identityId is
// filled by submitGeneralAccessRequest after the stash read / mint.
export function buildGeneralAccessRequest({ roomId, displayName, note, referredBy } = {}) {
  // A pasted room link (?room=<id> or #room/<id>) resolves to its room id,
  // so nobody has to dig a raw id out of an address bar.
  const typed = typeof roomId === "string" ? roomId.trim() : "";
  const room = (typed && roomIdFromNext(typed)) || typed;
  if (!room) throw new Error("Paste the link of the room you want to join.");
  if (room.length > GENERAL_REQUEST_ROOM_ID_MAX) {
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
export async function submitGeneralAccessRequest({ client, storage, roomId, displayName, note, referredBy }) {
  const body = buildGeneralAccessRequest({ roomId, displayName, note, referredBy });
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
