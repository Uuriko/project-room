import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { validId } from "../src/events.js";
import { markIfOther, withContentTrust } from "./content-trust.mjs";
import { messageInHistory } from "./history-visibility.mjs";

const keys = new WeakMap();
const MAX_BYTES = 512 * 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
function signer(store) {
  // Continuations are hints, never authority. A store restart invalidates them
  // explicitly instead of silently mixing pre-recovery and post-recovery pages.
  if (!keys.has(store)) keys.set(store, randomBytes(32));
  return {
    encode(value) {
      // Authenticated encryption also hides array offsets: readable offsets
      // would reveal where filtered private messages occur in the room.
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keys.get(store), nonce);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    },
    decode(token) {
      try {
        if (typeof token !== "string" || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
        const bytes = Buffer.from(token, "base64url");
        if (bytes.length < 29 || bytes.toString("base64url") !== token) return null;
        const decipher = createDecipheriv("aes-256-gcm", keys.get(store), bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      } catch { return null; }
    }
  };
}

// Current records, never raw event replay: edits, reactions and deletion
// tombstones arrive together. SQLite filters DMs before paging; JS only parses
// bounded selected rows. SQLite still scans the room's projection JSON.
export function readConversation(store, token, roomId, { limit = 50, cursor = null, since = null, messageId = null,
  expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || [cursor, since, messageId].filter(value => value !== null).length > 1
    || messageId !== null && !validId(messageId)) fail(422, "invalid_conversation_selection", "Choose a bounded conversation page or one message");
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
    const anchor = store.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, head.sequence)?.id ?? null;
    const identity = { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null };
    const scope = digest([identity, auth.credentialHash, limit]);
    const signed = signer(store), saved = cursor !== null || since !== null ? signed.decode(cursor ?? since) : null;
    const base = { ...identity, conversationVersion: 1, sequence: head.sequence, limit, messageId };
    const reset = () => ({ ...base, mode: "reset", messages: [], nextCursor: null, checkpoint: null });
    if ((cursor !== null || since !== null) && (!saved || saved.scope !== scope || saved.kind !== (cursor !== null ? "page" : "checkpoint"))) return reset();
    if (cursor !== null && (saved.sequence !== head.sequence || saved.anchor !== anchor || !Number.isSafeInteger(saved.before) || saved.before < 0)) return reset();
    const before = cursor !== null ? saved.before : Number.MAX_SAFE_INTEGER;
    // PRIV-2: a since_join reader pages only messages from their join onward.
    const floor = store.historyFloor(roomId, auth.member.id);
    // Phase 1a: a body at rest lives in the messages table; refill it here
    // (missing -> bodyUnavailable, never another room's or member's row).
    const rows = store.db.prepare(`SELECT CAST(m.key AS INTEGER) AS position,
        CASE WHEN json_extract(m.value,'$.bodyAtRest')=1 THEN
          CASE WHEN t.body IS NULL
            THEN json_set(json_remove(m.value, '$.editHistory', '$.bodyAtRest'), '$.bodyUnavailable', json('true'))
            ELSE json_set(json_remove(m.value, '$.editHistory', '$.bodyAtRest'), '$.body', t.body) END
        ELSE json_remove(m.value, '$.editHistory') END AS body
      FROM rooms r JOIN json_each(r.projection, '$.messages') m
        LEFT JOIN messages t ON t.room_id=r.id AND t.message_id=json_extract(m.value,'$.id')
          AND json_extract(m.value,'$.bodyAtRest')=1
      WHERE r.id=? AND CAST(m.key AS INTEGER)<?
        AND (json_extract(m.value,'$.toMemberId') IS NULL OR json_extract(m.value,'$.toMemberId')=''
          OR json_extract(m.value,'$.authorId')=? OR json_extract(m.value,'$.toMemberId')=?)
        AND (? IS NULL OR json_extract(m.value,'$.id')=?)
        AND (? IS NULL OR json_extract(m.value,'$.createdAt')>=?)
      ORDER BY CAST(m.key AS INTEGER) DESC LIMIT ?`)
      .all(roomId, before, auth.member.id, auth.member.id, messageId, messageId, floor?.at ?? null, floor?.at ?? null, messageId === null ? limit + 1 : 1)
      .filter(row => !floor || messageInHistory(JSON.parse(row.body), floor));
    if (messageId !== null && !rows.length) fail(404, "message_not_found", "Message not found");
    const selected = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(row.body);
      if (bytes + size > MAX_BYTES) {
        if (!selected.length) fail(413, "conversation_record_too_large", "This message exceeds the bounded conversation read limit");
        break;
      }
      selected.push(row); bytes += size;
    }
    const messages = selected.map(row => JSON.parse(row.body)).reverse();
    const nextCursor = rows.length > selected.length ? signed.encode({ kind: "page", scope, sequence: head.sequence, anchor,
      before: selected.at(-1).position }) : null;
    // Include sequence/anchor: any intervening room mutation invalidates older
    // cached pages, even if the changed message is outside this latest window.
    const version = digest([head.sequence, anchor, messages]);
    const checkpoint = messageId === null && cursor === null ? signed.encode({ kind: "checkpoint", scope, version }) : null;
    if (since !== null && saved.version === version) return { ...base, mode: "not_modified", nextCursor, checkpoint };
    return withContentTrust({
      ...base, mode: "replace",
      messages: messages.map(message => markIfOther(message, auth.member.id, message.authorId)),
      nextCursor, checkpoint, messageBytes: bytes
    });
  });
}
