import { createHash } from "node:crypto";

const FILE_BYTES = 16 * 1024, TOTAL_BYTES = 64 * 1024, FILE_COUNT = 64;
const textType = type => typeof type === "string" && (type.startsWith("text/") || ["application/json", "application/xml"].includes(type));

// Only files committed onto selected inputs enter the request. Stable ordering
// keeps polling/digest comparison independent of the server's list order.
export function withAttachmentReferences(inputs, files) {
  let remaining = FILE_COUNT;
  return inputs.map(input => {
    const matches = files.filter(file => file.state === "committed" && file.messageId === input.messageId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!matches.length) return input;
    const selected = matches.slice(0, remaining); remaining -= selected.length;
    return { ...input, attachments: selected.map(file => Object.fromEntries(
      ["id", "filename", "mediaType", "byteLength", "sha256", "messageId"].map(key => [key, file[key]]))),
    ...(matches.length > selected.length ? { omittedAttachmentCount: matches.length - selected.length } : {}) };
  });
}

// This adapter has no dynamic file-tool bridge yet. Supply small UTF-8 text
// through the existing authorized API, and explicitly mark everything unread.
// Never send credentials, arbitrary server fields or silently truncated text.
export async function withAttachmentText(inputs, readFile) {
  let remaining = TOTAL_BYTES;
  const result = [];
  for (const input of inputs) {
    if (!input.attachments?.length) { result.push(input); continue; }
    const attachments = [];
    for (const file of input.attachments) {
      const item = { ...file, contentStatus: "not_read", reason: "unsupported_format" };
      attachments.push(item);
      if (!textType(file.mediaType)) continue;
      if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > FILE_BYTES) { item.reason = "file_size_limit"; continue; }
      if (file.byteLength > remaining) { item.reason = "context_budget"; continue; }
      // Reserve even on failure so a broken source cannot induce unbounded reads.
      remaining -= file.byteLength;
      let actual;
      try { actual = await readFile(file.id); }
      catch (error) {
        if (![403, 404, 410].includes(error.status)) throw error;
        item.reason = "unavailable"; continue;
      }
      if (actual?.id !== file.id || actual.messageId !== input.messageId || actual.state !== "committed"
        || actual.sha256 !== file.sha256 || actual.byteLength !== file.byteLength
        || actual.mediaType !== file.mediaType || actual.encoding !== "base64"
        || typeof actual.data !== "string" || actual.data.length > 4 * Math.ceil(FILE_BYTES / 3)) {
        item.reason = "changed_or_invalid"; continue;
      }
      const bytes = Buffer.from(actual.data, "base64");
      if (bytes.length !== file.byteLength || bytes.toString("base64") !== actual.data
        || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        item.reason = "changed_or_invalid"; continue;
      }
      try { item.text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { item.reason = "unsupported_encoding"; continue; }
      item.contentStatus = "read"; delete item.reason;
    }
    result.push({ ...input, attachments });
  }
  return result;
}
