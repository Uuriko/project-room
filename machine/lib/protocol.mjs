// Wire constants shared with RELAY-0. See machine/PROTOCOL.md.
export const PROTOCOL_VERSION = 1;

export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const ROOM_FILE_MAX_BYTES = 1024 * 1024;
export const RECEIPT_BLOB_MAX = 10;
export const KEYFRAME_MAX = 9;
export const SHELL_OUTPUT_MAX_BYTES = 64 * 1024;
export const SHELL_TIMEOUT_MS = 30_000;
export const FILE_MAX_BYTES = 8 * 1024 * 1024;
export const EXPORT_LARGE_BYTES = 1024 * 1024;
export const DEADMAN_DEFAULT_SECONDS = 120;
export const MAX_MACOS_GUESTS = 2;
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const FRAME_INTERVAL_MS = 1000;
export const RETENTION_DAYS_DEFAULT = 14;
export const ENROLL_TTL_MS = 15 * 60 * 1000;
export const TAG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const ERROR = Object.freeze({
  LEASE_REQUIRED: "lease_required",
  SLOT_HELD: "slot_held",
  TOOL_DENIED: "tool_denied",
  DEADMAN: "deadman",
  HALTED: "halted",
  PAUSED: "paused",
  DISABLED: "disabled",
  TOO_LARGE: "too_large",
  TIMEOUT: "timeout",
  OUTPUT_CAPPED: "output_capped",
  GUEST_LIMIT: "guest_limit",
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_DENIED: "approval_denied",
  UNAVAILABLE: "unavailable",
  INVALID: "invalid_message",
  NOT_GRANTED: "not_granted",
});

export const DEFAULT_ALLOW = Object.freeze([
  "machine.status",
  "machine.release",
  "desktop.screenshot",
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.scroll",
  "desktop.list_apps",
  "shell.vm",
  "files.put",
  "files.get",
  "inference.chat",
]);

export const APPROVAL_CLASSES = Object.freeze([
  "egress.new_domain",
  "desk.restore",
  "credential.use",
  "files.export_large",
  "shell.desk",
]);

export const SLOTS = Object.freeze(["desk", "scratch"]);

export const MUTATING_DESKTOP = new Set([
  "desktop.click",
  "desktop.type",
  "desktop.key",
  "desktop.scroll",
]);

export const DRIVER_TOOL = Object.freeze({
  "desktop.screenshot": "screenshot",
  "desktop.click": "click",
  "desktop.type": "type",
  "desktop.key": "key",
  "desktop.scroll": "scroll",
  "desktop.list_apps": "list_apps",
});

export function errorResult(id, code, message) {
  return { type: "result", id: id ?? null, ok: false, error: { code, message } };
}

export function okResult(id, result) {
  return { type: "result", id, ok: true, result };
}
