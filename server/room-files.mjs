// Shared files (K015). A pure file-metadata manager for room files:
// register uploads (metadata only), list by room, and get preview info
// (mime type, size, previewable). File bytes are caller-owned; this module
// tracks only metadata. All state is caller-owned (a Map); the module is
// pure and dependency-free. Frozen outputs; malformed inputs throw
// FileError. Storage/upload wiring is a later slice.
class FileError extends Error { constructor(code, message) { super(message); this.name = "FileError"; this.code = code; } }
const fail = (code, message) => { throw new FileError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_file", message); };
const PREVIEWABLE = ["image/png", "image/jpeg", "image/gif", "image/webp",
  "text/plain", "text/markdown", "application/pdf"];
// Create a file manager. store is a caller-owned Map (fileId -> file).
export function createFiles({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const files = store ?? new Map();
  let fileCounter = 0;
  // Register an uploaded file (metadata only).
  const register = ({ roomId, filename, mimeType, sizeBytes, uploaderId }) => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    check(typeof filename === "string" && filename.trim().length > 0, "filename must be non-empty");
    check(typeof mimeType === "string" && mimeType.includes("/"), "mimeType must be a valid MIME type");
    check(Number.isInteger(sizeBytes) && sizeBytes >= 0, "sizeBytes must be a non-negative integer");
    check(typeof uploaderId === "string" && uploaderId.length > 0, "uploaderId must be a non-empty string");
    const fileId = `file-${++fileCounter}`;
    const file = Object.freeze({ fileId, roomId, filename: filename.trim(),
      mimeType, sizeBytes, uploaderId,
      previewable: PREVIEWABLE.includes(mimeType) });
    files.set(fileId, file);
    return file;
  };
  // List files in a room (newest first).
  const listByRoom = roomId => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    return Object.freeze([...files.values()].filter(f => f.roomId === roomId).reverse());
  };
  // Get a file by id.
  const get = fileId => {
    check(typeof fileId === "string" && fileId.length > 0, "fileId must be a non-empty string");
    check(files.has(fileId), `unknown file "${fileId}"`);
    return files.get(fileId);
  };
  return Object.freeze({ register, listByRoom, get });
}
export { FileError, PREVIEWABLE };
