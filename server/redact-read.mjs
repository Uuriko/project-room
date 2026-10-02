// Read-time redaction for message text.
//
// Deletes and edits already update the room projection. The event log still
// holds every earlier body. These helpers copy response values so a read
// returns the same text the projection shows: a deleted message's body is
// null (the tombstone), and an edited message returns only its current body.
// Prior edit-history text is omitted. Nothing here writes the log.

const MESSAGE_BODY_TYPES = new Set(["message.posted", "message.edited"]);

function indexMessages(messages) {
  const byId = new Map();
  for (const message of messages ?? []) {
    if (message && typeof message.id === "string") byId.set(message.id, message);
  }
  return byId;
}

function messageIdOf(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  if (typeof data.messageId === "string") return data.messageId;
  if (event.type === "message.posted" && typeof event.id === "string") return event.id;
  return null;
}

// Null body is the projection tombstone. A live message keeps its current text.
function currentBody(message) {
  if (!message || message.deletedAt || message.body == null) return null;
  return message.body;
}

function redactEvent(event, byId) {
  if (!event || typeof event !== "object" || !MESSAGE_BODY_TYPES.has(event.type)) return event;
  const data = event.data;
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "body")) return event;
  const message = byId.get(messageIdOf(event));
  if (!message) return event;
  const body = currentBody(message);
  if (data.body === body) return event;
  return { ...event, data: { ...data, body } };
}

function redactEntries(entries, messages) {
  if (!Array.isArray(entries)) return entries;
  const byId = indexMessages(messages);
  let changed = false;
  const next = entries.map(entry => {
    if (!entry || typeof entry !== "object" || !entry.event) return entry;
    const event = redactEvent(entry.event, byId);
    if (event === entry.event) return entry;
    changed = true;
    return { ...entry, event };
  });
  return changed ? next : entries;
}

export function redactEventPage(page, messages) {
  if (!page || typeof page !== "object" || !Array.isArray(page.events)) return page;
  const events = redactEntries(page.events, messages);
  if (events === page.events) return page;
  return { ...page, events };
}

export function redactEventRows(rows, messages) {
  return redactEntries(rows, messages);
}

function stripEditHistory(message) {
  if (!message || typeof message !== "object" || !Array.isArray(message.editHistory)) return message;
  let changed = false;
  const editHistory = message.editHistory.map(entry => {
    if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "body")) return entry;
    changed = true;
    const rest = { ...entry };
    delete rest.body;
    return rest;
  });
  if (!changed) return message;
  return { ...message, editHistory };
}

function redactMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map(message => {
    const stripped = stripEditHistory(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? next : messages;
}

export function redactMessageTree(message) {
  if (!message || typeof message !== "object") return message;
  const stripped = stripEditHistory(message);
  if (!Array.isArray(message.replies)) return stripped;
  let changed = stripped !== message;
  const replies = message.replies.map(reply => {
    const next = redactMessageTree(reply);
    if (next !== reply) changed = true;
    return next;
  });
  if (!changed) return message;
  return { ...(stripped === message ? message : stripped), replies };
}

export function redactSnapshotState(state) {
  if (!state || typeof state !== "object") return state;
  const messages = redactMessages(state.messages);
  const byId = indexMessages(state.messages);
  let eventLog = state.eventLog;
  let logChanged = false;
  if (Array.isArray(eventLog)) {
    const nextLog = eventLog.map(event => {
      const next = redactEvent(event, byId);
      if (next !== event) logChanged = true;
      return next;
    });
    if (logChanged) eventLog = nextLog;
  }
  if (messages === state.messages && eventLog === state.eventLog) return state;
  return { ...state, messages, eventLog };
}
