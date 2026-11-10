import { CurrentReadBudgetExceeded, isCurrentRoom, readCurrentHead,readCurrentMessage,readCurrentHistoryFloor,chargeCurrentReadBudget, readCurrentRecord, currentConversationRows, currentMessageMayBeVisible, withCurrentReadContext } from './current-room-repository.mjs';
import { hasMessageAuthority } from './message-authority.mjs';
import { messageRepository } from './message-repository.mjs';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hydrateRecordText } from "./projection-at-rest.mjs"; // Phase 1a
import { ServiceError } from "./service-error.mjs";
import { validId, DEFAULT_CHANNEL_ID } from "../src/events.js";
import { markIfOther, withContentTrust, stampThread } from "./content-trust.mjs";
import { messageInHistory } from "./history-visibility.mjs";
import { archiveMarker, THREAD_VISIBILITY_INDEXES } from "./messages-store.mjs";
import { identityNamesForRoom, resolveMentionTargetsInText } from "./mention-lifecycle.mjs";

const keys = new WeakMap();
const MAX_BYTES = 512 * 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export function conversationCursorCodec(store) {
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

// A short, proven public-only append cannot change private records or authority.
// Anything else (including a long gap) keeps the conservative reset contract.
function publicOnlyAppend(store, roomId, saved, sequence) {
  if (!Number.isSafeInteger(saved?.sequence) || sequence <= saved.sequence || sequence - saved.sequence > 100) return false;
  const anchor = store.db.prepare('SELECT id FROM events WHERE room_id=? AND sequence=?').get(roomId, saved.sequence)?.id ?? null;
  if (anchor !== saved.anchor) return false;
  const rows = store.db.prepare(`SELECT json_extract(body,'$.type') AS type,
    json_extract(body,'$.data.toMemberId') AS recipient FROM events
    WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 101`).all(roomId, saved.sequence, sequence);
  return rows.length === sequence - saved.sequence && rows.every(row => row.type === 'message.posted' && !row.recipient);
}

function archivedConversationRows(store,roomId,{viewerId,channelId,peerMemberId,messageId,floor,limit,afterId}) {
  const repository=messageRepository(store,roomId,store.room(roomId,{verifyBodyHashes:true}).state);
  const candidates=messageId===null ? repository.records({descending:true,afterId,visibility:{viewerId,channelId,peerMemberId,floor}}) : [repository.get(messageId)];
  const rows=[];
  for(const message of candidates) {
    if(!message || message.toMemberId && message.authorId!==viewerId && message.toMemberId!==viewerId)continue;
    if(channelId!==null && (message.toMemberId || (message.channelId||DEFAULT_CHANNEL_ID)!==channelId))continue;
    if(peerMemberId!==null && !((message.authorId===viewerId && message.toMemberId===peerMemberId) || (message.authorId===peerMemberId && message.toMemberId===viewerId)))continue;
    if(floor&&!messageInHistory(message,floor))continue;
    const {editHistory:_history,...record}=message;
    rows.push({position:0,messageId:message.id,body:JSON.stringify(record)});
    if(rows.length >= (messageId===null ? limit+1 : 1))break;
  }
  return rows;
}

// Current records, never raw event replay: edits, reactions and deletion
// tombstones arrive together. SQLite filters DMs before paging; JS only parses
// bounded selected rows. Certified rooms use indexed records; rooms still
// replaying (or changed since certification) retain the projection fallback.
export function readConversation(store, token, roomId, { limit = 50, cursor = null, since = null, messageId = null, channelId = null, peerMemberId = null,
  expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || [cursor, since, messageId].filter(value => value !== null).length > 1
    || messageId !== null && !validId(messageId)
    || channelId !== null && !validId(channelId)
    || peerMemberId !== null && (!validId(peerMemberId) || channelId !== null)) fail(422, "invalid_conversation_selection", "Choose a bounded conversation page or one message");
  // A conversation page is a reserved read: each delivered message costs
  // ~5-6 record units of proof load (index refill, witness record + receipt,
  // message row), so a validated page of up to 100 cannot fit the generic
  // 200-record context — it tripped mid-page and returned ~15 messages.
  // Reserve 1024 records like the other wide readers (current-search,
  // snapshot-window); the shared 256 KiB byte ceiling in charge() is
  // unchanged, and a page that still exhausts it returns a partial page
  // with a continuation instead of refusing.
  return store.readTransaction(() => withCurrentReadContext(store.db,roomId,() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const current = isCurrentRoom(store.db,roomId);
    // Channel history is public-room conversation, never an addressed DM.
    // Archived channels retain readable history. Authenticate before lookup.
    if (channelId !== null && !(current ? readCurrentRecord(store.db,roomId,'channels',channelId) : store.db.prepare(`SELECT 1 FROM rooms r, json_each(r.projection, '$.channels') c
      WHERE r.id=? AND c.key=?`).get(roomId, channelId))) fail(404, "channel_not_found", "Channel not found");
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
    const anchor = store.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, head.sequence)?.id ?? null;
    const identity = { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null };
    const scope = digest([identity, auth.credentialHash, limit, channelId, peerMemberId]);
    const signed = conversationCursorCodec(store), saved = cursor !== null || since !== null ? signed.decode(cursor ?? since) : null;
    const base = { ...identity, conversationVersion: 1, sequence: head.sequence, limit, messageId,
      ...(channelId !== null ? { channelId } : {}), ...(peerMemberId !== null ? { peerMemberId } : {}) };
    const reset = () => ({ ...base, mode: "reset", messages: [], nextCursor: null, checkpoint: null });
    if ((cursor !== null || since !== null) && (!saved || saved.scope !== scope || saved.kind !== (cursor !== null ? "page" : "checkpoint"))) return reset();
    const sameHead = saved?.sequence === head.sequence && saved?.anchor === anchor;
    const privateAppend = peerMemberId !== null && !sameHead && publicOnlyAppend(store, roomId, saved, head.sequence);
    if (cursor !== null && ((!sameHead && !privateAppend) || !Number.isSafeInteger(saved.before) || saved.before < 0)) return reset();
    // Certification covers the full record and query columns at this exact
    // head. Never replay or perform a full parity scan on a read request.
    const canonicalMarker = store.db.prepare("SELECT json_extract(projection,'$.messageAuthority') AS marker FROM rooms WHERE id=?").get(roomId)?.marker;
    const canonical = current || canonicalMarker != null && hasMessageAuthority({ messageAuthority: JSON.parse(canonicalMarker) });
    const indexed = canonical || Boolean(store.db.prepare(`SELECT 1 FROM messages_backfill_cursor
      WHERE room_id=? AND applied_seq=? AND parity_at_seq=? AND applied_event_id=?`)
      .get(roomId, head.sequence, head.sequence, anchor ?? ""));
    const marker=indexed ? null : archiveMarker(store.db,roomId);
    const archiveMerged=Boolean(marker?.throughSeq);
    if(cursor!==null && (Boolean(saved.archiveMerged)!==archiveMerged
      || archiveMerged&&typeof saved.beforeMessageId!=='string'))return reset();
    // Array offsets and posting sequences are distinct opaque cursor domains.
    // Reset when a replay/certification switches the domain without a mutation.
    if (cursor !== null && (Boolean(saved.indexed) !== indexed
      || indexed && typeof saved.beforeId !== "string")) return reset();
    const before=cursor!==null ? saved.before : Number.MAX_SAFE_INTEGER;
    // PRIV-2: a since_join reader pages only messages from their join onward.
    const floor = store.historyFloor(roomId, auth.member.id);
    // One JSON parameter keeps complete same-instant exclusions within Worker
    // SQLite's bind limit even for large imported equal-timestamp histories.
    const exclusions = current ? '[]' : JSON.stringify([...(floor?.sameInstant ?? [])]);
    // Only reference-bearing fallback projections consult entity rows. Ordinary
    // uncertified projections must never treat the unqualified mirror as truth.
    const entityRefs = !indexed && !archiveMerged && Boolean(store.db.prepare("SELECT instr(projection, '\"_entity\":1') AS refs FROM rooms WHERE id=?").get(roomId)?.refs);
    const currentPage = current ? currentConversationRows(store,roomId,{viewerId:auth.member.id,limit,before,beforeId:cursor!==null?saved.beforeId:'',messageId,channelId,peerMemberId,floor}) : null;
    const rows = currentPage ? currentPage.rows : (archiveMerged
      ? archivedConversationRows(store,roomId,{viewerId:auth.member.id,channelId,peerMemberId,messageId,floor,limit,afterId:cursor===null?null:saved.beforeMessageId})
      : indexed ? store.db.prepare(`SELECT seq AS position, message_id AS messageId, record_json AS body
      FROM messages WHERE room_id=? AND (seq<? OR (seq=? AND message_id<?))
        AND (to_member_id IS NULL OR to_member_id='' OR author_id=? OR to_member_id=?)
        AND (? IS NULL OR (COALESCE(NULLIF(channel_id,''),?)=? AND (to_member_id IS NULL OR to_member_id='')))
        AND (? IS NULL OR (author_id=? AND to_member_id=?) OR (author_id=? AND to_member_id=?))
        AND (? IS NULL OR message_id=?)
        AND (? IS NULL OR created_at>=?)
        AND (? IS NULL OR created_at>? OR message_id NOT IN (SELECT value FROM json_each(?)))
      ORDER BY seq DESC, message_id DESC LIMIT ?`)
      .all(roomId, before, before, cursor !== null ? saved.beforeId : "", auth.member.id, auth.member.id,
        channelId, DEFAULT_CHANNEL_ID, channelId, peerMemberId, auth.member.id, peerMemberId, peerMemberId, auth.member.id, messageId, messageId, floor?.at ?? null, floor?.at ?? null,
        floor?.at ?? null, floor?.at ?? null, exclusions, messageId === null ? limit + 1 : 1)
      : store.db.prepare(`SELECT CAST(m.key AS INTEGER) AS position, json_remove(m.value, '$.editHistory') AS body
      FROM (
        SELECT r.id AS room_id, m.key AS key,
          ${entityRefs ? `CASE WHEN json_extract(m.value,'$._entity')=1 THEN (
            SELECT record_json FROM messages WHERE room_id=r.id AND message_id=json_extract(m.value,'$.id')
          ) ELSE m.value END` : 'm.value'} AS value
        FROM rooms r, json_each(r.projection,'$.messages') m
      ) m
      WHERE m.room_id=? AND CAST(m.key AS INTEGER)<?
        AND (json_extract(m.value,'$.toMemberId') IS NULL OR json_extract(m.value,'$.toMemberId')=''
          OR json_extract(m.value,'$.authorId')=? OR json_extract(m.value,'$.toMemberId')=?)
        AND (? IS NULL OR (
          COALESCE(NULLIF(json_extract(m.value,'$.channelId'),''),?)=?
          AND (json_extract(m.value,'$.toMemberId') IS NULL OR json_extract(m.value,'$.toMemberId')='')))
        AND (? IS NULL OR (json_extract(m.value,'$.authorId')=? AND json_extract(m.value,'$.toMemberId')=?)
          OR (json_extract(m.value,'$.authorId')=? AND json_extract(m.value,'$.toMemberId')=?))
        AND (? IS NULL OR json_extract(m.value,'$.id')=?)
        AND (? IS NULL OR json_extract(m.value,'$.createdAt')>=?)
        AND (? IS NULL OR json_extract(m.value,'$.createdAt')>?
          OR json_extract(m.value,'$.id') NOT IN (SELECT value FROM json_each(?)))
      ORDER BY CAST(m.key AS INTEGER) DESC LIMIT ?`)
      .all(roomId, before, auth.member.id, auth.member.id, channelId, DEFAULT_CHANNEL_ID, channelId,
        peerMemberId, auth.member.id, peerMemberId, peerMemberId, auth.member.id, messageId, messageId, floor?.at ?? null, floor?.at ?? null,
        floor?.at ?? null, floor?.at ?? null, exclusions, messageId === null ? limit + 1 : 1))
      .map(row => indexed || archiveMerged ? row : { ...row, body: hydrateRecordText(store.db, roomId, row.body,
        // The recovery source must itself verify: a hot-path room() read
        // trusts the content-addressed body key (WRITE-PATH-WINS win 3)
        // and would hand the tampered bytes straight back.
        id => store.room(roomId, { verifyBodyHashes: true }).state.messages.find(message => message.id === id)?.body) })
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
    // Selected-message consumers distinguish an explicit address from a reply
    // notification with the same canonical names/ambiguity rules as delivery.
    // This is observed context, not execution permission; page reads do no
    // extra mention work and an implicit reply needs no roster/alias lookup.
    const addressing = messageId === null ? null : { explicitlyMentioned: false };
    if (addressing && typeof messages[0]?.body === "string" && messages[0].body.includes("@")) {
      // Mention resolution needs fresh membership, not hydrated conversation or work history.
      const message = messages[0], members = store.roomAuthority(roomId).members;
      addressing.explicitlyMentioned = ((!message.toMemberId || message.toMemberId === auth.member.id)
        && resolveMentionTargetsInText(members, identityNamesForRoom(store.db, roomId), message.body, message.authorId).includes(auth.member.id));
    }
    const nextCursor = currentPage ? (currentPage.continuation ? signed.encode({kind:"page",scope,sequence:head.sequence,anchor,
      before:currentPage.continuation.position,beforeId:currentPage.continuation.messageId,indexed:true,archiveMerged:false}) : null) : rows.length > selected.length ? signed.encode({ kind: "page", scope, sequence: head.sequence, anchor,
      before: selected.at(-1).position, indexed, archiveMerged,
      ...(indexed ? { beforeId: selected.at(-1).messageId } : {}),
      ...(archiveMerged ? {beforeMessageId:selected.at(-1).messageId} : {}) }) : null;
    // Private latest-window equality is sufficient only at the same head or
    // after a proven short public-only append. Other changes invalidate older pages.
    const version = peerMemberId !== null ? digest([indexed, archiveMerged, messages]) : digest([head.sequence, anchor, messages]);
    const checkpoint = messageId === null && cursor === null ? signed.encode({ kind: "checkpoint", scope, version, sequence: head.sequence, anchor }) : null;
    if (since !== null && saved.version === version && (peerMemberId === null || sameHead || privateAppend)) return { ...base, mode: "not_modified", nextCursor, checkpoint };
    return withContentTrust({
      ...base, mode: "replace",
      ...(addressing ? { addressing } : {}),
      messages: messages.map(message => markIfOther(message, auth.member.id, message.authorId)),
      nextCursor, checkpoint, messageBytes: bytes,
      ...(currentPage ? {sourceWindow:{examined:currentPage.examined,complete:currentPage.complete}} : {})
    });
  }, {maxRecords: 1024}));
}

// Directory metadata only: never hydrate bodies or infer other people's pairs.
// SQL applies caller visibility and history floors before grouping/pagination.
export function readDirectConversations(store, token, roomId, { limit = 50, cursor = null, expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, 'invalid_conversation_selection', 'Choose a bounded conversation list');
  if(isCurrentRoom(store.db,roomId))return readCurrentDirectDirectory(store,token,roomId,{limit,cursor,expectedSessionBinding});
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const current = isCurrentRoom(store.db,roomId);
    if(current) fail(409,'current_room_context_required','Use the bounded conversation window with an explicit peer');
    const head = store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId);
    const anchor = store.db.prepare('SELECT id FROM events WHERE room_id=? AND sequence=?').get(roomId, head.sequence)?.id ?? '';
    const identity = { roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null, viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null };
    const scope = digest(['direct-directory', identity, auth.credentialHash, limit]);
    const signed = conversationCursorCodec(store), saved = cursor === null ? null : signed.decode(cursor);
    const base = { ...identity, directoryVersion: 1, sequence: head.sequence, limit };
    if (cursor !== null && (!saved || saved.scope !== scope || saved.sequence !== head.sequence || saved.anchor !== anchor || typeof saved.after !== 'string'))
      return { ...base, mode: 'reset', peers: [], nextCursor: null };
    const canonicalMarker = store.db.prepare("SELECT json_extract(projection,'$.messageAuthority') AS marker FROM rooms WHERE id=?").get(roomId)?.marker;
    const canonical = current || canonicalMarker != null && hasMessageAuthority({ messageAuthority: JSON.parse(canonicalMarker) });
    const indexed = canonical || Boolean(store.db.prepare(`SELECT 1 FROM messages_backfill_cursor
      WHERE room_id=? AND applied_seq=? AND parity_at_seq=? AND applied_event_id=?`).get(roomId, head.sequence, head.sequence, anchor));
    const marker = indexed ? null : archiveMarker(store.db, roomId);
    let source, sourceParams;
    if (indexed) {
      source = 'SELECT message_id AS id, author_id AS author, to_member_id AS recipient, created_at AS created FROM messages WHERE room_id=?';
      sourceParams = [roomId];
    } else {
      source = `SELECT json_extract(m.value,'$.id') AS id,
        CASE WHEN json_extract(m.value,'$._entity')=1 THEN json_extract(e.record_json,'$.authorId') ELSE json_extract(m.value,'$.authorId') END AS author,
        CASE WHEN json_extract(m.value,'$._entity')=1 THEN json_extract(e.record_json,'$.toMemberId') ELSE json_extract(m.value,'$.toMemberId') END AS recipient,
        CASE WHEN json_extract(m.value,'$._entity')=1 THEN json_extract(e.record_json,'$.createdAt') ELSE json_extract(m.value,'$.createdAt') END AS created
        FROM rooms r, json_each(r.projection,'$.messages') m
        LEFT JOIN messages e ON json_extract(m.value,'$._entity')=1 AND e.room_id=r.id AND e.message_id=json_extract(m.value,'$.id') WHERE r.id=?`;
      sourceParams = [roomId];
      if (marker?.throughSeq) {
        source += ` UNION ALL SELECT message_id,author_id,to_member_id,created_at FROM messages
          WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))`;
        sourceParams.push(roomId, marker.throughSeq, marker.retainedJson);
      }
    }
    const floor = store.historyFloor(roomId, auth.member.id);
    const rows = store.db.prepare(`WITH visible AS (${source}), pairs AS (
      SELECT CASE WHEN author=? THEN recipient ELSE author END AS memberId, created
      FROM visible WHERE recipient IS NOT NULL AND recipient<>'' AND (author=? OR recipient=?)
      AND (? IS NULL OR created>=?)
      AND (? IS NULL OR created>? OR id NOT IN (SELECT value FROM json_each(?)))
    ) SELECT memberId,MAX(created) AS lastMessageAt FROM pairs WHERE memberId>?
      GROUP BY memberId ORDER BY memberId LIMIT ?`).all(...sourceParams,
      auth.member.id, auth.member.id, auth.member.id, floor?.at ?? null, floor?.at ?? null,
      floor?.at ?? null, floor?.at ?? null, JSON.stringify([...(floor?.sameInstant ?? [])]), saved?.after ?? '', limit + 1);
    const peers = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? signed.encode({ scope, sequence: head.sequence, anchor, after: peers.at(-1).memberId }) : null;
    return { ...base, mode: 'replace', peers, nextCursor };
  });
}

// The directory is a bounded recent source window, not a global GROUP BY.
// Full enumeration is an explicit continuation and can include empty pages.
function readCurrentDirectDirectory(store,token,roomId,{limit,cursor,expectedSessionBinding}){
 return store.readTransaction(()=>withCurrentReadContext(store.db,roomId,b=>{
  const auth=store.authenticate(token,roomId,expectedSessionBinding),head=readCurrentHead(store.db,roomId,b),db=store.db;
  const identity={roomId,viewerId:auth.member.id,viewerAccountId:auth.account?.id??null,viewerAuthEpoch:auth.account?.authEpoch??null,viewerSessionBinding:auth.sessionBinding,viewerSessionRevision:auth.sessionRevision??null};
  const scope=digest(['current-direct-directory-v2',identity,auth.credentialHash,head.head_sha256,limit]),codec=conversationCursorCodec(store),saved=cursor===null?null:codec.decode(cursor);
  const base={...identity,directoryVersion:2,sequence:head.sequence,limit};
  if(cursor!==null&&(!saved||saved.scope!==scope||!Array.isArray(saved.positions)||saved.positions.length!==2||saved.positions.some(p=>!Number.isSafeInteger(p.seq)||p.seq<0||typeof p.id!=='string'||p.id.length>200)))return{...base,mode:'reset',peers:[],nextCursor:null,sourceWindow:{complete:false,examined:0,timestampBasis:'max-encountered-createdAt'}};
  const floor=readCurrentHistoryFloor(db,roomId,auth.member.id,b),size=Math.min(limit,8),streams=[{index:'current_messages_incoming_seq',where:'to_member_id=?'},{index:'current_messages_outgoing_seq',where:"author_id=? AND to_member_id IS NOT NULL AND to_member_id<>''"}];
  for(let i=0;i<2;i++){const stream=streams[i],at=saved?.positions[i]??{seq:head.sequence+1,id:'\uffff'};stream.at={...at};stream.used=0;stream.rows=db.prepare(`SELECT message_id,seq,length(CAST(record_json AS BLOB)) bytes FROM messages INDEXED BY ${stream.index} WHERE room_id=? AND ${stream.where} AND (seq,message_id)<(?,?) ORDER BY seq DESC,message_id DESC LIMIT ?`).all(roomId,auth.member.id,at.seq,at.id,size);chargeCurrentReadBudget(b,stream.rows.reduce((n,r)=>n+Buffer.byteLength(r.message_id)+48,0),stream.rows.length);}
  const peers=new Map();let examined=0;
  while(examined<size){const pending=streams.filter(s=>s.used<s.rows.length).sort((a,z)=>z.rows[z.used].seq-a.rows[a.used].seq||Buffer.compare(Buffer.from(z.rows[z.used].message_id),Buffer.from(a.rows[a.used].message_id)));if(!pending.length)break;
   const stream=pending[0],row=stream.rows[stream.used];if(examined&&b.bytes+row.bytes+65536>262144)break;
   const source=readCurrentMessage(db,roomId,row.message_id,b);if(!source||source.row.seq!==row.seq)fail(409,'current_directory_integrity','Conversation source differs');
   stream.used++;stream.at={seq:row.seq,id:row.message_id};examined++;const m=source.value;
   if(!m.toMemberId||![m.authorId,m.toMemberId].includes(auth.member.id)||!messageInHistory(m,floor))continue;
   const peer=m.authorId===auth.member.id?m.toMemberId:m.authorId,old=peers.get(peer);if(!old||m.createdAt>old.lastMessageAt)peers.set(peer,{memberId:peer,lastMessageAt:m.createdAt});
  }
  const hasMore=streams.some(s=>s.used<s.rows.length||s.rows.length===size),positions=streams.map(s=>s.at);
  return{...base,mode:'replace',peers:[...peers.values()],nextCursor:hasMore?codec.encode({scope,positions}):null,sourceWindow:{complete:!hasMore,examined,order:'message-sequence-desc',timestampBasis:'max-encountered-createdAt'}};
 }));
}


// The listener needs one addressed message and request hint for routing and
// authorization, not its whole reply family. Execution still reads the complete
// paged request or the existing bounded ordinary thread, as appropriate.
export function readMessageContext(store, token, roomId, messageId, expectedSessionBinding = null) {
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const selected = readConversation(store, token, roomId, {messageId, expectedSessionBinding});
    const message = selected.messages[0];
    if (!message) fail(404, 'message_not_found', 'Message not found');
    const request = isCurrentRoom(store.db, roomId)
      ? readCurrentRecord(store.db, roomId, 'replyRequests', messageId, b)
      : store.room(roomId).state.replyRequests?.[messageId];
    const replyRequest = request && [request.requesterId, request.recipientId].includes(auth.member.id)
      ? {id:request.id, requesterId:request.requesterId, recipientId:request.recipientId, status:request.status} : null;
    return withContentTrust({roomId, messageContextVersion:1, thread:stampThread({...message, replies:[]}, auth.member.id), ...(replyRequest ? {replyRequest} : {})});
  }));
}

// Selected current subtree only. Refuse oversized families rather than read a
// whole projection or silently give an executing agent incomplete context.
export function readCurrentMessageThread(store, token, roomId, messageId, expectedSessionBinding = null) {
  if (!isCurrentRoom(store.db, roomId)) return undefined;
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const floor = readCurrentHistoryFloor(store.db, roomId, auth.member.id);
    const visible = message => message && messageInHistory(message, floor)
      && (!message.toMemberId || message.authorId === auth.member.id || message.toMemberId === auth.member.id);
    if (!currentMessageMayBeVisible(store.db, roomId, messageId, auth.member.id, b, floor)) fail(404, 'message_not_found', 'Message not found');
    const selected = readCurrentMessage(store.db, roomId, messageId, b);
    if (!visible(selected?.value)) fail(404, 'message_not_found', 'Message not found');
    try {
    const family = selected.row.thread_root_id ?? messageId;
    const indexes = store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN (?,?,?)").all(...THREAD_VISIBILITY_INDEXES.map(index=>index.name));
    chargeCurrentReadBudget(b,indexes.reduce((n,index)=>n+Buffer.byteLength(index.sql??'')+64,0),indexes.length);
    if(indexes.length!==3 || indexes.some(index=>THREAD_VISIBILITY_INDEXES.find(expected=>expected.name===index.name)?.sql!==index.sql))
      fail(409,'current_thread_index_unavailable','Thread visibility indexes require reconciliation');
    // Visibility is an indexed equality/predicate, never a residual over the
    // family stream. Invisible private children cannot consume source work or
    // change whether an otherwise small public thread fits its context limit.
    const sources = [
      ['current_messages_thread_public_seq', "(to_member_id IS NULL OR to_member_id='')", []],
      ['current_messages_thread_incoming_seq', 'to_member_id=?', [auth.member.id]],
      ['current_messages_thread_outgoing_seq', "author_id=? AND to_member_id IS NOT NULL AND to_member_id<>''", [auth.member.id]]
    ];
    const unique = new Map();
    for (const [index, where, args] of sources) {
      const admitted = store.db.prepare(`SELECT message_id,seq FROM messages INDEXED BY ${index}
        WHERE room_id=? AND thread_root_id=? AND seq>? AND ${where}
        ORDER BY seq,message_id LIMIT 25`).all(roomId, family, selected.row.seq, ...args);
      chargeCurrentReadBudget(b, admitted.reduce((n, row) => n + Buffer.byteLength(row.message_id) + 32, 0), admitted.length);
      for (const row of admitted) unique.set(row.message_id, row);
    }
    const rows = [...unique.values()].sort((a, c) => a.seq - c.seq || Buffer.compare(Buffer.from(a.message_id), Buffer.from(c.message_id)));
    if (rows.length > 24) fail(413, 'current_thread_too_large', 'Selected thread exceeds bounded context; request a smaller selected message');
    const messages = [selected.value];
    for (const row of rows) {
      const record = readCurrentMessage(store.db, roomId, row.message_id, b);
      if (!record || record.row.seq !== row.seq || record.row.thread_root_id !== family) fail(409, 'current_thread_changed', 'Selected thread proof changed');
      if (visible(record.value)) messages.push(record.value);
    }
    const byParent = new Map(), names = new Map();
    for (const message of messages.slice(1)) {
      if (!byParent.has(message.replyToId)) byParent.set(message.replyToId, []);
      byParent.get(message.replyToId).push(message);
    }
    const attach = message => {
      if (!names.has(message.authorId)) names.set(message.authorId, readCurrentRecord(store.db, roomId, 'members', message.authorId, b)?.displayName ?? message.authorId);
      return { ...message, author: names.get(message.authorId), replies: (byParent.get(message.id) ?? []).map(attach) };
    };
    const thread = attach(selected.value);
    if (Buffer.byteLength(JSON.stringify(thread)) > 65536) fail(413, 'current_thread_too_large', 'Selected thread exceeds bounded context; request a smaller selected message');
    // A protected request hint lets listeners select the paged request reader
    // rather than mistaking a tracked question for ordinary thread chat. It is
    // not an answer basis; that still comes from a fresh complete request read.
    const request = readCurrentRecord(store.db, roomId, 'replyRequests', messageId, b);
    const replyRequest = request && [request.requesterId, request.recipientId].includes(auth.member.id)
      ? {id:request.id, requesterId:request.requesterId, recipientId:request.recipientId, status:request.status} : null;
    return withContentTrust({ roomId, thread: stampThread(thread, auth.member.id), ...(replyRequest ? {replyRequest} : {}) });
    } catch (error) {
      // Only aggregate quota exhaustion after the selected message and viewer
      // were authenticated is a too-large thread. Integrity and entity
      // geometry refusals retain their original failures.
      if (error instanceof CurrentReadBudgetExceeded)
        fail(413, 'current_thread_too_large', 'Selected thread exceeds bounded context; request a smaller selected message');
      throw error;
    }
  }));
}
