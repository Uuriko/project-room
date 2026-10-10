// hs2-room-in-a-paste (1d): a single cloud setup line (paste) that
// provisions a room.
//
// The line is one paste-able string:
//
//   pr-setup://v1?title=...&purpose=...&kind=personal&roomId=...&wake=https%3A%2F%2F...&device=ABCD-1234
//
// title/purpose/kind/roomId mirror POST /api/agent-rooms (server/agent-rooms.mjs)
// and are validated to the same bounds. `wake` names the agent's wakeUrl:
// provisioning subscribes the identity to the 1c counts-only agent.wake
// webhook there. `device` carries the 1b device-code for the human approval
// — see the TODO below.
//
// Dependency rule (guild B2): the parts that do not depend on 1b (paste
// parsing, the room provisioning path, the 1c wake subscription) are built
// here. The device-code approval wiring is NOT guessed at: guild B1 owns
// 1b (server/device-codes.mjs, branch fixwave/b1, claim hs2-device-code),
// and the remainder is claimed as hs2-room-in-a-paste-device-wiring so the
// two lanes never double-build it.
//
// Pure module except provisionFromPaste's injected collaborators
// (createRoom, subscribeWake) — tests never touch the network or the db.
import { createHash } from "node:crypto";
import { ROOM_KINDS, validId } from "../src/events.js";

export const SETUP_LINE_SCHEME = "pr-setup";
export const SETUP_LINE_VERSION = "v1";

export class SetupLineError extends Error {
  constructor(code, message) { super(message); this.name = "SetupLineError"; this.code = code; }
}
const fail = (code, message) => { throw new SetupLineError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const text = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

// Build one paste-able setup line. Round-trips through parseSetupLine:
// parse(build(x)) deep-equals the normalized params.
export function buildSetupLine({ title, purpose, kind = "personal", roomId = null, wakeUrl = null, deviceCode = null } = {}) {
  const params = normalizeSetupParams({ title, purpose, kind, roomId, wakeUrl, deviceCode });
  const query = new URLSearchParams();
  query.set("title", params.title);
  query.set("purpose", params.purpose);
  if (params.kind !== "personal") query.set("kind", params.kind);
  if (params.roomId !== null) query.set("roomId", params.roomId);
  if (params.wakeUrl !== null) query.set("wake", params.wakeUrl);
  if (params.deviceCode !== null) query.set("device", params.deviceCode);
  return `${SETUP_LINE_SCHEME}://${SETUP_LINE_VERSION}?${query.toString()}`;
}

// Parse and validate a pasted setup line. Unknown query params are
// ignored (forward-compat: B1's device flow may add fields); known
// fields are validated to the same bounds as POST /api/agent-rooms so a
// bad paste fails here, before any side effect.
export function parseSetupLine(line) {
  check(typeof line === "string" && line.trim().length > 0,
    "invalid_setup_line", "setup line must be a non-empty string");
  const trimmed = line.trim();
  check(!/[\r\n]/.test(trimmed), "invalid_setup_line", "setup line must be a single line");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    fail("invalid_setup_line", "setup line is not a valid URL");
  }
  check(url.protocol === `${SETUP_LINE_SCHEME}:`,
    "invalid_setup_line", `setup line must use the ${SETUP_LINE_SCHEME}:// scheme`);
  check(url.host.toLowerCase() === SETUP_LINE_VERSION,
    "unsupported_setup_version", `unsupported setup line version "${url.host}" (expected ${SETUP_LINE_VERSION})`);
  const query = url.searchParams;
  const params = normalizeSetupParams({
    title: query.get("title"),
    purpose: query.get("purpose"),
    kind: query.get("kind") ?? "personal",
    roomId: query.get("roomId"),
    wakeUrl: query.get("wake"),
    deviceCode: query.get("device"),
  });
  return Object.freeze({ version: SETUP_LINE_VERSION, ...params });
}

function normalizeSetupParams({ title, purpose, kind, roomId, wakeUrl, deviceCode }) {
  check(text(title, 120), "invalid_setup_line", "title must be 1 to 120 characters");
  check(text(purpose, 1000), "invalid_setup_line", "purpose must be 1 to 1000 characters");
  check(ROOM_KINDS.includes(kind), "invalid_setup_line",
    `kind must be one of: ${ROOM_KINDS.join(", ")}`);
  let rid = null;
  if (roomId !== null && roomId !== undefined) {
    check(validId(roomId) && roomId.length <= 64, "invalid_setup_line",
      "roomId must be 1 to 64 letters, digits, dots, colons, underscores or hyphens");
    rid = roomId;
  }
  let wake = null;
  if (wakeUrl !== null && wakeUrl !== undefined) {
    // Light gate here; the authoritative SSRF + DNS checks run at
    // subscribe time in the webhook modules. A non-https wake URL is a
    // certain subscribe-time refusal, so fail the paste up front.
    let parsed;
    try { parsed = new URL(wakeUrl); } catch { parsed = null; }
    check(parsed !== null && parsed.protocol === "https:",
      "invalid_setup_line", "wake must be an https URL");
    wake = wakeUrl;
  }
  let device = null;
  if (deviceCode !== null && deviceCode !== undefined) {
    check(DEVICE_CODE_PATTERN.test(deviceCode), "invalid_setup_line",
      "device must be 4 to 64 letters, digits, underscores or hyphens");
    device = deviceCode;
  }
  return Object.freeze({ title, purpose, kind, roomId: rid, wakeUrl: wake, deviceCode: device });
}

// Provision a room from a pasted setup line.
//
// createRoom(identitySecret, request) is the room-creation collaborator
// (server/agent-rooms.mjs AgentRooms.create in production): request
// mirrors its accepted fields { title, purpose, kind, roomId?, requestId }.
// requestId is the SHA-256 of the pasted line, so pasting the same line
// twice is idempotent even when the line omits roomId (the server mints
// one) — a dropped response retried with the same paste returns the
// original room instead of minting a second.
//
// subscribeWake({ identityId, url, events }) is optional: when the line
// names a wake URL the identity is subscribed to the 1c counts-only
// agent.wake webhook there.
//
// TODO(fixwave/b1): device-code approval wiring. When guild B1 lands
// server/device-codes.mjs (branch fixwave/b1, claim hs2-device-code),
// resolve params.deviceCode here into the approving human's identity and
// link it to the provisioned room per the approval grant BEFORE
// returning. Until then the code is carried through untouched and
// reported { approval: "pending" } — never guessed at, never silently
// dropped. Remainder claimed as hs2-room-in-a-paste-device-wiring.
export async function provisionFromPaste({ createRoom, subscribeWake = null, setupLine, identitySecret }) {
  check(typeof createRoom === "function", "invalid_provision", "createRoom must be a function");
  check(subscribeWake === null || subscribeWake === undefined || typeof subscribeWake === "function",
    "invalid_provision", "subscribeWake must be a function if given");
  check(typeof identitySecret === "string" && identitySecret.length > 0,
    "invalid_provision", "identitySecret is required");
  const params = parseSetupLine(setupLine);
  const requestId = createHash("sha256").update(setupLine.trim()).digest("hex").slice(0, 32);
  const request = { title: params.title, purpose: params.purpose, kind: params.kind, requestId };
  if (params.roomId !== null) request.roomId = params.roomId;
  const created = await createRoom(identitySecret, request);
  check(created !== null && typeof created === "object" && typeof created.roomId === "string",
    "invalid_provision", "createRoom must resolve to a room object");
  let wakeSubscribed = false;
  if (params.wakeUrl !== null && typeof subscribeWake === "function") {
    await subscribeWake({ identityId: created.identityId, url: params.wakeUrl, events: ["agent.wake"] });
    wakeSubscribed = true;
  }
  const device = params.deviceCode !== null
    ? Object.freeze({ code: params.deviceCode, approval: "pending" })
    : null;
  return Object.freeze({
    roomId: created.roomId,
    identityId: created.identityId ?? null,
    ownerMemberId: created.ownerMemberId ?? null,
    duplicate: created.duplicate === true,
    wakeSubscribed,
    device,
  });
}
