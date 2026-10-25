// Append newly posted messages onto a stored room projection without
// re-stringifying the messages already in the row. JSON.stringify of the
// whole document is the hot cost once the projection is a few megabytes.
//
// The stored text is JSON.stringify output: no whitespace, key order
// preserved. Anything else returns null and the caller writes the
// projection the ordinary way.
//
// Walking the messages array in JavaScript to find its end is slower than
// a native stringify of the same bytes. Callers that already know the end
// index (the previous append of this exact document) pass it and only the
// new messages are encoded.

function skipString(text, index) {
  if (text[index] !== '"') return null;
  for (let i = index + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i += 1; if (i >= text.length) return null; continue; }
    if (char === '"') return i + 1;
  }
  return null;
}

function scanEnd(text, index) {
  const char = text[index];
  if (char === '"') return skipString(text, index);
  if (char === "{" || char === "[") {
    const open = char, close = char === "{" ? "}" : "]";
    let depth = 1, i = index + 1;
    while (i < text.length && depth) {
      const next = text[i];
      if (next === '"') {
        i = skipString(text, i);
        if (i == null) return null;
        continue;
      }
      if (next === open) depth += 1;
      else if (next === close) depth -= 1;
      i += 1;
    }
    return depth === 0 ? i : null;
  }
  if (char === "t" || char === "f" || char === "n" || char === "-" || (char >= "0" && char <= "9")) {
    let i = index + 1;
    while (i < text.length && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i += 1;
    return i;
  }
  return null;
}

// Bodies at rest, null-envelope markers, and message-entity refs are not
// byte-identical to the in-memory message. Splicing those documents would
// keep the marker and inline the new body beside it.
export function projectionAllowsAppend(text) {
  return typeof text === "string" && text.length > 1
    && !text.includes('"bodyRef"') && !text.includes('"_nul"') && !text.includes('"_entity"');
}

function compactBookkeeping(state) {
  return { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
}

// JSON of the projection with the messages array removed. Callers cache this
// for the state that produced the stored text. A later read that adds a key
// the row does not contain (the projection-cap fixture does this) must not
// splice, or the size check would see the old row instead of the new state.
export function projectionShapeKey(state) {
  if (!state || typeof state !== "object") return null;
  const book = compactBookkeeping(state);
  if (!Object.hasOwn(book, "messages") || !Array.isArray(book.messages)) return null;
  const { messages: _messages, ...rest } = book;
  try { return JSON.stringify(rest); }
  catch { return null; }
}

// True when two reducer states stringify to the same projection aside from
// the messages array, including top-level key order. Messages themselves
// are not stringified here.
export function sameProjectionShape(previous, next) {
  const beforeKey = projectionShapeKey(previous), afterKey = projectionShapeKey(next);
  if (beforeKey == null || beforeKey !== afterKey) return false;
  const beforeKeys = Object.keys(compactBookkeeping(previous)), afterKeys = Object.keys(compactBookkeeping(next));
  if (beforeKeys.length !== afterKeys.length || !beforeKeys.includes("messages")) return false;
  for (let i = 0; i < beforeKeys.length; i++) if (beforeKeys[i] !== afterKeys[i]) return false;
  return true;
}

function encodeAdded(added) {
  if (!Array.isArray(added) || added.length === 0) return null;
  const parts = [];
  try {
    for (const message of added) {
      const encoded = JSON.stringify(message);
      if (typeof encoded !== "string") return null;
      parts.push(encoded);
    }
  } catch { return null; }
  const piece = parts.join(",");
  if (piece.includes('"bodyRef"') || piece.includes('"_nul"') || piece.includes('"_entity"')) return null;
  return piece;
}

// `end` is the index just after the top-level messages array's closing bracket.
function spliceAt(text, piece, end) {
  if (!Number.isSafeInteger(end) || end < 2 || end > text.length || text[end - 1] !== "]") return null;
  const empty = text[end - 2] === "[";
  return {
    text: text.slice(0, end - 1) + (empty ? "" : ",") + piece + text.slice(end - 1),
    messagesEnd: end + (empty ? 0 : 1) + piece.length
  };
}

// Index just after the top-level "messages" array, or null when the text is
// not a plain projection. Does not search inside nested values.
function findMessagesArrayEnd(text) {
  if (text[0] !== "{") return null;
  let i = 1;
  while (i < text.length) {
    if (text[i] === "}") return null;
    if (text[i] !== '"') return null;
    const keyStart = i;
    const afterKey = skipString(text, i);
    if (afterKey == null || text[afterKey] !== ":") return null;
    const key = text.slice(keyStart, afterKey);
    const valueAt = afterKey + 1;
    if (key === '"messages"') {
      if (text[valueAt] !== "[") return null;
      const end = scanEnd(text, valueAt);
      if (end == null || text[end - 1] !== "]") return null;
      const next = text[valueAt + 1];
      if (next !== "]" && next !== "{" && next !== '"' && next !== "[" && next !== "t" && next !== "f" && next !== "n" && next !== "-" && !(next >= "0" && next <= "9")) return null;
      return end;
    }
    const afterValue = scanEnd(text, valueAt);
    if (afterValue == null) return null;
    i = afterValue;
    if (text[i] === ",") i += 1;
    else if (text[i] === "}") return null;
    else return null;
  }
  return null;
}

// Insert `added` at the end of the top-level "messages" array.
// `messagesEnd`, when passed, is the end index from the previous append of
// this exact document; a matching hint does not walk the earlier messages.
// Returns `{ text, messagesEnd }` or null when the caller must rewrite.
export function projectAppendedMessages(text, added, messagesEnd) {
  if (typeof text !== "string" || text.length < 2 || text[0] !== "{") return null;
  const piece = encodeAdded(added);
  if (piece == null) return null;
  if (Number.isSafeInteger(messagesEnd)) {
    const fast = spliceAt(text, piece, messagesEnd);
    if (fast) return fast;
  }
  if (!projectionAllowsAppend(text)) return null;
  const end = findMessagesArrayEnd(text);
  if (end == null) return null;
  return spliceAt(text, piece, end);
}

// Insert `added` at the end of the top-level "messages" array. Returns the
// new document, or null when the text is not a plain projection we can splice.
export function appendMessagesToProjection(text, added, messagesEnd) {
  return projectAppendedMessages(text, added, messagesEnd)?.text ?? null;
}
