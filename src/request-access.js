// RC-2026-09-30-3611 (human-door P0-2): a general request-access door for
// signed-in users with no rooms. The dead-invite dialog owns the same flow
// for strangers with dead links (src/app.js wires #invitation-request-form);
// this module serves the account-rooms panel (#account-request-form) and
// needs no invitation at all. It reuses the public, unauthenticated
// POST /api/access-requests flow: mint a self-serve identity (an identity
// alone grants nothing), file the request, let the room owner approve/deny.
//
// The pure orchestration (build/submit) is exported for tests; the DOM
// wiring at the bottom only runs in a browser.
import { AccountClient } from "./client.js";
import {
  FALLBACK_REQUEST_PERMISSIONS,
  validateAccessRequestForm,
  newAccessRequestId,
  stashAccessRequest,
  readAccessRequest,
} from "./invite-context.js";

// The open community room (see join.html's enroll example). Used as the
// door's default; the user can paste any other room ID.
export const GENERAL_REQUEST_DEFAULT_ROOM_ID = "muse-room";
export const GENERAL_REQUEST_ROOM_ID_MAX = 128;

// Pure: validate the door's fields and build the POST /api/access-requests
// body. Throws with the user-facing message on invalid input. identityId is
// filled by submitGeneralAccessRequest after the stash read / mint.
export function buildGeneralAccessRequest({ roomId, displayName, note, referredBy } = {}) {
  const room = typeof roomId === "string" ? roomId.trim() : "";
  if (!room) throw new Error("Enter the room ID you want to join.");
  if (room.length > GENERAL_REQUEST_ROOM_ID_MAX) {
    throw new Error(`Room ID must be at most ${GENERAL_REQUEST_ROOM_ID_MAX} characters.`);
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
  await client.submitAccessRequest(body);
  return { requestId: body.requestId, roomId: body.roomId, identityId };
}

function setDoorStatus(node, text, error = false) {
  node.textContent = text;
  node.classList.toggle("visible", Boolean(text));
  node.classList.toggle("error", Boolean(text) && error);
}

function wireGeneralRequestAccessDoor() {
  const form = document.getElementById("account-request-form");
  if (!form) return;
  const roomInput = document.getElementById("account-request-room");
  const nameInput = document.getElementById("account-request-name");
  const noteInput = document.getElementById("account-request-note");
  const referredInput = document.getElementById("account-request-referred");
  const submit = document.getElementById("account-request-submit");
  const status = document.getElementById("account-request-status");
  if (!roomInput || !nameInput || !noteInput || !referredInput || !submit || !status) return;
  const client = new AccountClient();
  // Prefill the name from an earlier request on this browser, if any.
  const stashed = readAccessRequest(window.sessionStorage, roomInput.value.trim() || GENERAL_REQUEST_DEFAULT_ROOM_ID);
  if (stashed?.displayName) nameInput.value = stashed.displayName;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setDoorStatus(status, "Sending your request…");
    try {
      const { requestId, roomId } = await submitGeneralAccessRequest({
        client,
        storage: window.sessionStorage,
        roomId: roomInput.value,
        displayName: nameInput.value,
        note: noteInput.value,
        referredBy: referredInput.value,
      });
      form.hidden = true;
      setDoorStatus(status, `Request sent — the owner of “${roomId}” has been notified and will review it. Your request ID is ${requestId}.`);
    } catch (error) {
      submit.disabled = false;
      const message = error?.code === "rate_limited" || error?.status === 429
        ? "Too many requests from this browser — wait a little and try again."
        : error?.code === "already_member"
          ? "This identity is already in the room — ask the owner directly if you need anything."
          : typeof error?.message === "string" && error.message
            ? error.message
            : "Could not send the request. Check your connection and try again.";
      setDoorStatus(status, message, true);
      nameInput.focus({ preventScroll: true });
    }
  });
}

if (typeof document !== "undefined") wireGeneralRequestAccessDoor();
