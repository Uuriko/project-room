import { createHash } from "node:crypto";

const stable = (...parts) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export function createRoomClient({ origin, roomId, token, fetchImpl = fetch }) {
  const base = `${origin.replace(/\/$/, "")}/api/rooms/${encodeURIComponent(roomId)}`;
  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, origin, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let value = null; try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text.slice(0, 200) }; }
    if (!response.ok) throw Object.assign(new Error(value?.error?.message || `HTTP ${response.status}`), { status: response.status, code: value?.error?.code, value });
    return value;
  }
  async function selectedFiles(messageIds) {
    const ids = [...new Set(messageIds)].sort();
    const selected = new Set(ids);
    const files = [];
    // The selected-message endpoint accepts at most eight IDs per cursor.
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = ids.slice(offset, offset + 8);
      const query = new URLSearchParams(batch.map(id => ["messageId", id]));
      const cursors = new Set();
      while (true) {
        const result = await call("GET", `/files?${query}`);
        if (!Array.isArray(result?.files)) throw new Error("Invalid attachment list");
        if (result.contractVersion === undefined && !result.page && !result.coverage) {
          // Legacy storage returns the whole visible list regardless of selection.
          return result.files.filter(file => selected.has(file.messageId));
        }
        const { coverage, page } = result;
        if (result.contractVersion !== 2 || coverage?.kind !== "selected-messages"
          || JSON.stringify(coverage.messageIds) !== JSON.stringify(batch)
          || typeof page?.hasMore !== "boolean" || coverage.complete !== !page.hasMore
          || Boolean(page.nextCursor) !== page.hasMore
          || result.files.some(file => !batch.includes(file.messageId)))
          throw new Error("Invalid selected attachment page");
        files.push(...result.files);
        if (!page.hasMore) break;
        if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor))
          throw new Error("Invalid attachment continuation");
        cursors.add(page.nextCursor);
        query.set("cursor", page.nextCursor);
      }
    }
    return files;
  }
  return {
    roomId,
    assistant: () => call("GET", "/assistant"),
    act: input => call("POST", "/assistant", input),
    message: async id => (await call("GET", `/conversation?messageId=${encodeURIComponent(id)}`)).messages?.find(m => m.id === id) ?? null,
    async files(messageIds) {
      try { return await selectedFiles(messageIds); }
      catch (error) {
        if (error.status !== 409 || error.code !== "attachment_cursor_reset") throw error;
        // A revision or restart invalidated the read. Drop every partial page.
        return selectedFiles(messageIds);
      }
    },
    file: async id => (await call("GET", `/files/${encodeURIComponent(id)}`)).attachment,
    recent: async (limit = 100) => (await call("GET", `/conversation?limit=${limit}`)).messages ?? [],
    members: async () => (await call("GET", ""))?.state?.members ?? {},
    post: (messageId, body, extra = {}) => call("POST", "/commands", { id: stable("cmd", messageId), type: "message.posted", data: { messageId, body, ...extra } })
  };
}
