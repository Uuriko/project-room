// Native WebMCP only. Definitions are deliberately independent of room/session data.
const text = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength });
const page = { cursor: text(4096), limit: { type: "integer", minimum: 1, maximum: 5 } };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const read = { readOnlyHint: true, untrustedContentHint: true };
export const ROOM_TOOLS = Object.freeze([
  { name: "room_read", description: "Read recent messages in the open room. Use to catch up, then follow the cursor for older messages.", inputSchema: schema(page), annotations: read },
  { name: "room_post", description: "Post a message as the signed-in user after they confirm the exact text. Use to contribute to the open room.", inputSchema: schema({ body: text(4000) }, ["body"]), annotations: { consequentialHint: true } },
  { name: "room_list_work", description: "List open work or Board claims in the open room. Use to find available work or its current owner.", inputSchema: schema({ ...page, kind: { type: "string", enum: ["claims", "work"] } }), annotations: read },
  { name: "room_claim", description: "Claim a Board item as the signed-in user after confirmation. Use when the user wants to take that work.", inputSchema: schema({ id: text() }, ["id"]) },
  { name: "room_release", description: "Release the user's current Board claim after confirmation. Use when they want to hand work back.", inputSchema: schema({ id: text() }, ["id"]) },
  { name: "room_search", description: "Search messages in the open room. Use to find earlier discussion, following the cursor for more matches.", inputSchema: schema({ query: text(80), ...page }, ["query"]), annotations: read },
  { name: "room_read_many", description: "Read message or text-file excerpts together. Use after finding their IDs; follow each text offset for more content.", inputSchema: schema({ items: { type: "array", minItems: 1, maxItems: 2, items: schema({ kind: { type: "string", enum: ["message", "file"] }, id: text(), offset: { type: "integer", minimum: 0 } }, ["kind", "id"]) } }, ["items"]), annotations: read }
]);
const errorResult = (code, error, retryable = false) => ({ code, error, retryable });
function validate(value, spec) {
  if (spec.type === "object") return value && typeof value === "object" && !Array.isArray(value)
    && spec.required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => Object.hasOwn(spec.properties, key) && validate(value[key], spec.properties[key]));
  if (spec.type === "array") return Array.isArray(value) && value.length >= spec.minItems && value.length <= spec.maxItems && value.every(item => validate(item, spec.items));
  if (spec.type === "integer") return Number.isSafeInteger(value) && value >= spec.minimum && (spec.maximum === undefined || value <= spec.maximum);
  return typeof value === "string" && (spec.enum ? spec.enum.includes(value) : value.trim().length >= spec.minLength && value.length <= spec.maxLength);
}
const excerpt = (body, offset = 0, size = 160) => {
  const value = typeof body === "string" ? body : "";
  return { text: value.slice(offset, offset + size), nextOffset: offset + size < value.length ? offset + size : null };
};
const message = row => ({ id: row.id, authorId: row.authorId, ...excerpt(row.body) });

export function confirmRoomAction(document, { title, detail, signal }) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "share-dialog"; dialog.id = "webmcp-confirm";
    dialog.setAttribute("aria-labelledby", "webmcp-confirm-title");
    const heading = document.createElement("h2"); heading.id = "webmcp-confirm-title"; heading.textContent = title;
    const content = document.createElement("p"); content.textContent = detail;
    const preview = document.createElement("div"); preview.className = "message-content"; preview.append(content);
    const actions = document.createElement("div"); actions.className = "form-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button secondary"; cancel.textContent = "Cancel";
    const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "button"; confirm.textContent = "Confirm";
    const finish = accepted => {
      signal.removeEventListener("abort", abort);
      dialog.close(); dialog.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(accepted);
    };
    const abort = () => finish(false);
    cancel.addEventListener("click", () => finish(false), { once: true });
    confirm.addEventListener("click", () => finish(true), { once: true });
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); }, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    actions.append(cancel, confirm); dialog.append(heading, preview, actions); document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}

export function installRoomWebMCP({ document, client, getState, getSession, fetcher = globalThis.fetch,
  confirm = options => confirmRoomAction(document, options) }) {
  const context = document.modelContext;
  if (typeof context?.registerTool !== "function") return { sync() {}, stop() {} };
  let controller = null, identity = null, busy = false;
  const currentKey = () => {
    const session = getSession(), state = getState();
    return session && state?.room?.id === session.roomId && state.members?.[session.member?.id] && state.members[session.member.id].active !== false && client.ownsAccountSession()
      ? JSON.stringify([session.roomId, session.member.id, session.sessionBinding, client.generation]) : null;
  };
  const stop = () => { controller?.abort(); controller = null; identity = null; };
  async function execute(definition, args, options, registration, capturedKey) {
    const mutation = ["room_post", "room_claim", "room_release"].includes(definition.name);
    let locked = false, dispatched = false, recorded = false;
    const signal = AbortSignal.any([registration.signal, ...(options?.signal ? [options.signal] : []), AbortSignal.timeout(120000)]);
    const session = getSession();
    const check = () => { if (signal.aborted || currentKey() !== capturedKey) throw new Error("context_changed"); };
    const request = async (suffix, data) => {
      check();
      const response = await fetcher(`/api/rooms/${encodeURIComponent(session.roomId)}${suffix}`, {
        method: data === undefined ? "GET" : "POST", credentials: "same-origin", signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
          ...(session.authMode === "account" ? { "X-Project-Room-Auth": "account", "X-Session-Binding": session.sessionBinding } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
      if (!response.ok) { const error = new Error("request_failed"); error.status = response.status; throw error; }
      const body = await response.json(); check(); return body;
    };
    try {
      check();
      if (!validate(args, definition.inputSchema)) return errorResult("invalid_input", "Use the tool's declared fields and limits.");
      if (mutation) {
        if (busy) return errorResult("confirmation_pending", "Finish the current confirmation first.");
        busy = true; locked = true;
        const claim = definition.name === "room_post" ? null : await request(`/work-claims/${encodeURIComponent(args.id)}`);
        const item = claim?.claim ?? claim;
        const title = definition.name === "room_post" ? "Post message" : definition.name === "room_claim" ? "Claim work" : "Release claim";
        const detail = `${getState().room.title ?? getState().room.name ?? session.roomId}\n${definition.name === "room_post" ? args.body : `${item.title ?? args.id} (${args.id})`}`;
        if (!await confirm({ title, detail, signal })) return { status: "cancelled" };
        check();
        let suffix, data;
        if (definition.name === "room_post") {
          const id = crypto.randomUUID(); suffix = "/commands"; data = { id, type: "message.posted", data: { messageId: id, body: args.body } };
        } else {
          suffix = `/work-claims/${encodeURIComponent(args.id)}/${definition.name === "room_claim" ? "claim" : "release"}`;
          data = definition.name === "room_claim" ? {} : { expectedClaimedAt: item.claimedAt, expectedHistoryLength: (item.history?.length ?? 0) + (Number(item.historyOmitted) || 0) };
        }
        dispatched = true;
        await request(suffix, data); recorded = true;
        await client.refresh(); check();
        return { status: "recorded" };
      }
      const params = new URLSearchParams({ limit: String(args.limit ?? 5) });
      if (args.cursor) params.set(definition.name === "room_search" ? "before" : "cursor", args.cursor);
      if (definition.name === "room_read" || definition.name === "room_search") {
        if (definition.name === "room_search") { params.set("kind", "messages"); params.set("q", args.query); }
        const page = await request(`/${definition.name === "room_read" ? "conversation" : "search"}?${params}`);
        return { messages: (page.messages ?? []).map(message), nextCursor: page.nextCursor ?? null, ...(page.total !== undefined ? { total: page.total } : {}) };
      }
      if (definition.name === "room_list_work") {
        if (args.kind === "work") {
          const snapshot = await request("?view=work");
          const items = Object.values(snapshot.state?.workItems ?? {}).filter(item => !["completed", "superseded"].includes(item.state)).sort((a,b) => a.id.localeCompare(b.id));
          const anchor = args.cursor ? items.findIndex(item => item.id === args.cursor) : -1;
          if (args.cursor && anchor < 0) return errorResult("invalid_cursor", "Read the first work page again.");
          const selected = items.slice(anchor + 1, anchor + 1 + (args.limit ?? 5));
          return { work: selected.map(item => ({ id: item.id, title: String(item.title ?? "").slice(0,100), state: item.state, owner: item.claim?.holderId ?? item.accountableMemberId })),
            nextCursor: anchor + 1 + selected.length < items.length ? selected.at(-1).id : null };
        }
        const page = await request(`/work-claims?${params}`);
        return { claims: (page.claims ?? []).filter(row => !["done", "closed"].includes(row.state)).map(row => ({ id: row.id, title: String(row.title ?? "").slice(0,100), state: row.state, owner: row.owner })), nextCursor: page.nextCursor ?? null };
      }
      return { items: await Promise.all(args.items.map(async item => {
        try {
          if (item.kind === "message") {
            const page = await request(`/conversation?${new URLSearchParams({ messageId: item.id, limit: "1" })}`);
            const row = page.messages?.find(row => row.id === item.id);
            return row ? { id: item.id, ...excerpt(row.body, item.offset, 400) } : { id: item.id, code: "not_found" };
          }
          const page = await request(`/files/${encodeURIComponent(item.id)}`), file = page.attachment;
          if (!file || file.id !== item.id || file.state !== "committed") return { id: item.id, code: "not_found" };
          if (!/^text\//.test(file.mimeType ?? file.mediaType ?? "")) return { id: item.id, code: "text_file_required" };
          const body = new TextDecoder().decode(Uint8Array.from(atob(file.data), char => char.charCodeAt(0)));
          return { id: item.id, ...excerpt(body, item.offset, 400) };
        } catch { check(); return { id: item.id, code: "read_failed" }; }
      })) };
    } catch (error) {
      if (recorded) return { status: "recorded", refresh: "pending" };
      if (dispatched && !error.status) return errorResult("outcome_unconfirmed", "Read the room before trying the action again.");
      if (signal.aborted || currentKey() !== capturedKey) return errorResult("context_changed", "Use the tools for the currently open room.");
      if ([401,403].includes(error.status)) return errorResult("access_denied", "Check your room access before continuing.");
      return errorResult("request_failed", "Read the current room state before continuing.", !mutation);
    } finally { if (locked) busy = false; }
  }
  const sync = () => {
    const key = currentKey(); if (identity === key) return;
    stop(); if (!key) return;
    const registration = new AbortController(); controller = registration; identity = key;
    for (const definition of ROOM_TOOLS) {
      try {
        Promise.resolve(context.registerTool({ ...definition, execute: async (args, options) => {
          const result = await execute(definition, args, options, registration, key);
          return JSON.stringify(result).length <= 1500 ? result : errorResult("result_too_large", "Request fewer items or a smaller page.");
        } }, { signal: registration.signal }))
          .catch(() => { registration.abort(); if (controller === registration) stop(); });
      } catch { stop(); break; }
    }
  };
  return { sync, stop };
}
