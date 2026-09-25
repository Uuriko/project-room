// Composer file chips. Bytes go to the room file routes, which call the same
// room_attachments store the MCP file tools use (stage, then commit onto the
// message the member just posted). The password and the file bytes never
// land in localStorage or sessionStorage.

export const COMPOSER_FILE_BYTES = 1048576;

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function attachmentFromBytes({ id, filename, mediaType, bytes }) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (view.byteLength > COMPOSER_FILE_BYTES) {
    const error = new Error("That file is larger than 1 MB.");
    error.code = "file_too_large";
    throw error;
  }
  const name = typeof filename === "string" && filename.trim() ? filename.trim() : "file";
  const type = typeof mediaType === "string" && mediaType.trim() ? mediaType.trim() : "application/octet-stream";
  return { id, filename: name, mediaType: type, data: bytesToBase64(view) };
}

export function fileChipLabel(filename) {
  const name = typeof filename === "string" && filename.trim() ? filename.trim() : "file";
  return name;
}
