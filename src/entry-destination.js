// Carry only non-secret identifiers. Never copy the original URL, query or hash.
const safeId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
  && !/^(?:pri_|rak_|ga1[._])/i.test(value);

export function agentEntryDestination(locationLike) {
  const url = new URL(locationLike.href);
  if (!/^https?:$/.test(url.protocol) || !["/", "/room/"].includes(url.pathname)) return "";
  const roomValues = url.searchParams.getAll("room");
  if (roomValues.length !== 1 || !safeId(roomValues[0])) return "";
  const roomId = roomValues[0];
  let taskId = "";
  const match = /^#pr-record\/work\/([^/]+)$/.exec(url.hash);
  if (match) {
    try { const id = decodeURIComponent(match[1]); if (safeId(id)) taskId = id; } catch { /* ignore malformed fragments */ }
  }
  let target = `${url.origin}${url.pathname}?room=${encodeURIComponent(roomId)}`;
  if (taskId) target += `#pr-record/work/${encodeURIComponent(taskId)}`;
  return `\n\nUse this intended room${taskId ? " and task" : ""} before any saved room or lobby: ${target}. This link identifies the destination; it does not grant access.`;
}
