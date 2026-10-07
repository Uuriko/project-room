import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hydrateRecordText } from "./projection-at-rest.mjs"; // Phase 1a
import { ServiceError } from "./store.mjs";
import { validId, DEFAULT_CHANNEL_ID } from "../src/events.js";
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
// bounded selected rows. Certified rooms use indexed records; rooms still
// replaying (or changed since certification) retain the projection fallback.
export function readConversation(store, token, roomId, { limit = 50, cursor = null, since = null, messageId = null, channelId = null,
  expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || [cursor, since, messageId].filter(value => value !== null).length > 1
    || messageId !== null && !validId(messageId)
    || channelId !== null && !validId(channelId)) fail(422, "invalid_conversation_selection", "Choose a bounded conversation page or one message");
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    // Channel history is public-room conversation, never an addressed DM.
    // Archived channels retain readable history. Authenticate before lookup.
    if (channelId !== null && !store.db.prepare(`SELECT 1 FROM rooms r, json_each(r.projection, '$.channels') c
      WHERE r.id=? AND c.key=?`).get(roomId, channelId)) fail(404, "channel_not_found", "Channel not found");
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
    const anchor = store.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, head.sequence)?.id ?? null;
    const identity = { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null };
    const scope = digest([identity, auth.credentialHash, limit, channelId]);
    const signed = signer(store), saved = cursor !== null || since !== null ? signed.decode(cursor ?? since) : null;
    const base = { ...identity, conversationVersion: 1, sequence: head.sequence, limit, messageId,
      ...(channelId !== null ? { channelId } : {}) };
    const reset = () => ({ ...base, mode: "reset", messages: [], nextCursor: null, checkpoint: null });
    if ((cursor !== null || since !== null) && (!saved || saved.scope !== scope || saved.kind !== (cursor !== null ? "page" : "checkpoint"))) return reset();
    if (cursor !== null && (saved.sequence !== head.sequence || saved.anchor !== anchor || !Number.isSafeInteger(saved.before) || saved.before < 0)) return reset();
    // Certification covers the full record and query columns at this exact
    // head. Never replay or perform a full parity scan on a read request.
    const indexed = Boolean(store.db.prepare(`SELECT 1 FROM messages_backfill_cursor
      WHERE room_id=? AND applied_seq=? AND parity_at_seq=? AND applied_event_id=?`)
      .get(roomId, head.sequence, head.sequence, anchor ?? ""));
    // Array offsets and posting sequences are distinct opaque cursor domains.
    // Reset when a replay/certification switches the domain without a mutation.
    if (cursor !== null && (Boolean(saved.indexed) !== indexed
      || indexed && typeof saved.beforeId !== "string")) return reset();
    const before = cursor !== null ? saved.before : Number.MAX_SAFE_INTEGER;
    // PRIV-2: a since_join reader pages only messages from their join onward.
    const floor = store.historyFloor(roomId, auth.member.id);
    // One JSON parameter keeps complete same-instant exclusions within Worker
    // SQLite's bind limit even for large imported equal-timestamp histories.
    const exclusions = JSON.stringify([...(floor?.sameInstant ?? [])]);
    const rows = (indexed ? store.db.prepare(`SELECT seq AS position, message_id AS messageId, record_json AS body
      FROM messages WHERE room_id=? AND (seq<? OR (seq=? AND message_id<?))
        AND (((to_member_id IS NULL OR to_member_id='') AND json_extract(record_json,'$.toMemberIds') IS NULL)
          OR author_id=? OR to_member_id=?
          OR EXISTS (SELECT 1 FROM json_each(json_extract(record_json,'$.toMemberIds')) WHERE value=?))
        AND (? IS NULL OR (COALESCE(NULLIF(channel_id,''),?)=?
          AND (to_member_id IS NULL OR to_member_id='') AND json_extract(record_json,'$.toMemberIds') IS NULL))
        AND (? IS NULL OR message_id=?)
        AND (? IS NULL OR created_at>=?)
        AND (? IS NULL OR created_at>? OR message_id NOT IN (SELECT value FROM json_each(?)))
      ORDER BY seq DESC, message_id DESC LIMIT ?`)
      .all(roomId, before, before, cursor !== null ? saved.beforeId : "", auth.member.id, auth.member.id, auth.member.id,
        channelId, DEFAULT_CHANNEL_ID, channelId, messageId, messageId, floor?.at ?? null, floor?.at ?? null,
        floor?.at ?? null, floor?.at ?? null, exclusions, messageId === null ? limit + 1 : 1)
      : store.db.prepare(`SELECT CAST(m.key AS INTEGER) AS position, json_remove(m.value, '$.editHistory') AS body
      FROM rooms r, json_each(r.projection, '$.messages') m
      WHERE r.id=? AND CAST(m.key AS INTEGER)<?
        AND (((json_extract(m.value,'$.toMemberId') IS NULL OR json_extract(m.value,'$.toMemberId')='')
            AND json_extract(m.value,'$.toMemberIds') IS NULL)
          OR json_extract(m.value,'$.authorId')=?
          OR json_extract(m.value,'$.toMemberId')=?
          OR EXISTS (SELECT 1 FROM json_each(json_extract(m.value,'$.toMemberIds')) WHERE value=?))
        AND (? IS NULL OR (
          COALESCE(NULLIF(json_extract(m.value,'$.channelId'),''),?)=?
          AND (json_extract(m.value,'$.toMemberId') IS NULL OR json_extract(m.value,'$.toMemberId')='')
          AND json_extract(m.value,'$.toMemberIds') IS NULL))
        AND (? IS NULL OR json_extract(m.value,'$.id')=?)
        AND (? IS NULL OR json_extract(m.value,'$.createdAt')>=?)
        AND (? IS NULL OR json_extract(m.value,'$.createdAt')>?
          OR json_extract(m.value,'$.id') NOT IN (SELECT value FROM json_each(?)))
      ORDER BY CAST(m.key AS INTEGER) DESC LIMIT ?`)
      .all(roomId, before, auth.member.id, auth.member.id, auth.member.id, channelId, DEFAULT_CHANNEL_ID, channelId,
        messageId, messageId, floor?.at ?? null, floor?.at ?? null,
        floor?.at ?? null, floor?.at ?? null, exclusions, messageId === null ? limit + 1 : 1))
      .map(row => indexed ? row : { ...row, body: hydrateRecordText(store.db, roomId, row.body,
        id => store.room(roomId).state.messages.find(message => message.id === id)?.body) })
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
      before: selected.at(-1).position, indexed, ...(indexed ? { beforeId: selected.at(-1).messageId } : {}) }) : null;
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
