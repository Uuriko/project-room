// Proofs change only with code-owned writes, in the same transaction as data.
// They detect unregistered mutation; this is not a defense against a database
// administrator who can replace both data and proofs.
import { createHash } from 'node:crypto';
import { hasMessageAuthority } from './message-authority.mjs';
const protocols = new WeakMap();
const replacements = new WeakMap();
const frames = new WeakMap();
export const projectionDigest = text => createHash('sha256').update(text).digest('hex');
export function configureWriteIntegrity(db, verifyLegacy) { protocols.set(db, verifyLegacy); }
export function assertProjectionWrite(db, roomId) {
  const verifyLegacy = protocols.get(db);
  if (!verifyLegacy || replacements.get(db)?.has(roomId)) return;
  if (!db.isTransaction) throw Error('Projection proof requires the write transaction');
  const row = db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get(roomId);
  if (!row) return;
  const proof = db.prepare('SELECT sequence,projection_hash,metadata_hash FROM integrity_room_state WHERE room_id=?').get(roomId);
  if (proof?.metadata_hash ? projectionDigest(row.projection) !== proof.metadata_hash : !verifyLegacy(roomId,row,proof))
    throw Error('projection_corrupt: stored metadata does not match its write proof');
}
// Only the owner-authorized, fully replayed import path may replace missing
// or corrupted old proof. Scope is one room and the surrounding transaction.
export function withVerifiedRoomReconstruction(db,roomId,operation) {
  if (!db.isTransaction) throw Error('History replacement requires its write transaction');
  let active=replacements.get(db);if(!active){active=new Set();replacements.set(db,active);}
  const previous=active.has(roomId);active.add(roomId);
  try{return operation();}finally{if(!previous)active.delete(roomId);}
}
export function beginWriteProofFrame(db) {
  let stack=frames.get(db);if(!stack){stack=[];frames.set(db,stack);}stack.push(new Map());
}
export function endWriteProofFrame(db,committed) {
  const stack=frames.get(db),current=stack?.pop();
  if (!committed || !current || !stack.length) return;
  const parent=stack.at(-1);
  for(const [roomId,hashes] of current) {
    const target=parent.get(roomId) ?? new Set();for(const hash of hashes)target.add(hash);parent.set(roomId,target);
  }
}
export function recordProjectionWrite(db, roomId, projection) {
  if (!protocols.has(db)) return;
  const current=frames.get(db)?.at(-1);
  if(!current)throw Error('Projection proof requires its transaction frame');
  const hashes=current.get(roomId) ?? new Set();hashes.add(projectionDigest(projection));current.set(roomId,hashes);
}
// Serialization is a candidate, not proof of persistence. Publish only bytes
// observed in rooms after a real write, and forget candidates at the boundary.
export function publishProjectionWrites(db,roomId=null) {
  if(!protocols.has(db))return;
  const stack=frames.get(db) ?? [];
  const ids=roomId===null ? new Set(stack.flatMap(frame=>[...frame.keys()])) : [roomId];
  for(const id of ids) {
    if(!stack.some(frame=>frame.has(id)))continue;
    const row=db.prepare('SELECT projection FROM rooms WHERE id=?').get(id);if(!row)continue;
    const hash=projectionDigest(row.projection);
    if(stack.some(frame=>frame.get(id)?.has(hash)))
      db.prepare('UPDATE integrity_room_state SET metadata_hash=? WHERE room_id=?').run(hash,id);
  }
}
export const MESSAGE_PROOF_FIELDS = Object.freeze(['message_id','seq','channel_id','thread_root_id','reply_to_id','to_member_id',
  'work_item_id','author_id','body','created_at','edited_at','deleted_at','reactions_json','pinned','record_json','reducer_extras_json']);
export const MESSAGE_PROOF_SELECT = MESSAGE_PROOF_FIELDS.join(',');
export function messageProofHash(row) {
  return projectionDigest(JSON.stringify(MESSAGE_PROOF_FIELDS.map(key=>row[key] ?? null)));
}
export function messageProofMatches(row) { return typeof row?.entity_hash==='string' && row.entity_hash===messageProofHash(row); }
export function assertMessageWrite(db,roomId,messageId) {
  if (!protocols.has(db)) return;
  const row=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if (row?.entity_hash && !messageProofMatches(row)) throw Error('projection_corrupt: message does not match its write proof');
  if (row && !row.entity_hash && !replacements.get(db)?.has(roomId)
    && db.prepare("SELECT json_type(projection,'$.messageAuthority') AS authority FROM rooms WHERE id=?").get(roomId)?.authority)
    throw Error('projection_corrupt: message write proof requires migration');
}
// Call only after a trusted reducer/replay/erasure has written its result.
export function recordMessageWrite(db,roomId,messageId) {
  if (!protocols.has(db)) return;
  const row=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT} FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if (row) db.prepare('UPDATE messages SET entity_hash=? WHERE room_id=? AND message_id=?').run(messageProofHash(row),roomId,messageId);
}
// ---------------------------------------------------------------------------
// P1 (design §3.2/§3.3, lane B2): the content proof's drift-verdict leg is a
// chunked, resumable scan over the room's messages in message-id order,
// driven by the same stepper idiom as #5625's parity engine (chunk ->
// check deadline -> yieldBetween -> commit cursor). Dual bound per chunk:
// rows AND fetched bytes. Body-bearing queries are paged by key range
// under §3.3's fetch discipline: a LENGTH-only probe chooses each page's
// take before any body is fetched (fetch-then-count is banned for this
// leg), the page size adapts (start 50, halve when a page overshoots,
// floor 1), and the byte counter is per visit segment (one chunk step) —
// accumulated across every page of the segment and never reset inside
// one. A single row larger than the byte bound is processed alone and
// reported (fetchOversize), mirroring the parity engine's
// checkpointOversize. The metadata-digest and work-entity legs run once
// per scan, not per chunk.
//
// Progress representation (B2 scope): the scanner object holds the scan
// bound (room sequence captured at scan start), the range cursor (last
// message id banked), counts and the live digest state in memory, and
// progress() exposes them under the design's checkpoint vocabulary
// (scan_bound / range_cursor plus aliases) so a caller can bank them.
// The DURABLE checkpoint table, attempt fencing and the adoption write
// are lane B4's scope: no table is created here, no verdict is ever
// issued from a partial scan, and the live sha256 state cannot be
// serialized into a durable row until B3's ranged-digest composition
// replaces the single-stream digest — that composition friction is
// B4/B9's reconciliation point, recorded in this lane's STATE.md.
// The ranged-digest composition + snapshot v3 themselves are B3's scope
// (same file, different concern): the digest stream below is byte-for-
// byte the existing v2 stream, only its traversal is chunked.
// ---------------------------------------------------------------------------
export const CONTENT_SCAN_CHUNK_ROWS = 200;
export const CONTENT_SCAN_CHUNK_BYTES = 256 * 1024;
export const CONTENT_SCAN_VISIT_BYTES = CONTENT_SCAN_CHUNK_BYTES;
const CONTENT_SCAN_PAGE_ROWS = 50;
const CONTENT_SCAN_PHASES = Object.freeze(['messages', 'work', 'done']);
const SCAN_AGAIN = Symbol('content-scan-again');
// Step driver, the #5625 parity idiom: run step() synchronously until it
// produces an outcome instead of AGAIN. Only when a yield hook was
// provided does the first AGAIN cross into an async continuation that
// yields between steps — so callers that never ask for a yield (the
// synchronous exports, the existing tests) stay fully synchronous, and
// a scan that completes in one chunk completes synchronously even for
// callers that do ask.
function driveContentScanSteps(step, yieldBetween) {
  for (;;) {
    const outcome = step();
    if (outcome !== SCAN_AGAIN) return outcome;
    if (!yieldBetween) continue;
    return (async () => {
      for (;;) {
        await yieldBetween();
        const next = step();
        if (next !== SCAN_AGAIN) return next;
      }
    })();
  }
}
const rowFetchedBytes = row => {
  let bytes = 0;
  for (const key of [...MESSAGE_PROOF_FIELDS, 'entity_hash']) {
    const value = row[key];
    if (typeof value === 'string') bytes += Buffer.byteLength(value);
    else if (value !== null && value !== undefined) bytes += String(value).length;
  }
  return bytes;
};
const MESSAGE_PROBE_SELECT = MESSAGE_PROOF_FIELDS.map(key => `COALESCE(LENGTH(${key}),0)`).join('+')
  + '+COALESCE(LENGTH(entity_hash),0)';

export function createServingContentScanner(db, roomId, sequence, projection, { verify, hashContent, chunkRows = CONTENT_SCAN_CHUNK_ROWS, chunkBytes = CONTENT_SCAN_CHUNK_BYTES, pageRows = CONTENT_SCAN_PAGE_ROWS } = {}) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1) throw new RangeError('content scan chunkRows must be a positive integer');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('content scan chunkBytes must be a positive integer');
  if (!Number.isSafeInteger(pageRows) || pageRows < 1) throw new RangeError('content scan pageRows must be a positive integer');
  const scanner = {
    roomId, sequence, verify: Boolean(verify), hashContent: Boolean(hashContent),
    chunkRows, chunkBytes, pageSize: pageRows,
    phase: 'messages', cursor: '', count: 0, visible: 0, drift: false,
    done: false, outcome: null, authority: false, archive: null, retained: new Set(),
    state: null, hash: null, fetchedBytes: 0, lastSegmentBytes: 0, maxSegmentBytes: 0,
    fetchOversize: 0, scanDiscards: 0, chunks: 0,
  };
  const initScan = () => {
    scanner.hash = scanner.hashContent
      ? createHash('sha256').update(roomId).update('\0').update(String(sequence)).update('\0').update(projection ?? '') : null;
    scanner.state = JSON.parse(projection);
    scanner.drift = false;
    // Metadata-digest leg: once per scan, at scan start.
    if (scanner.verify) {
      const proof = db.prepare('SELECT metadata_hash FROM integrity_room_state WHERE room_id=?').get(roomId);
      scanner.drift = Boolean(proof?.metadata_hash && proof.metadata_hash !== projectionDigest(projection));
      if (scanner.drift && !scanner.hash) { finish({ drift: true }); }
    }
    if (scanner.done) return;
    scanner.authority = hasMessageAuthority(scanner.state);
    if (scanner.authority) {
      scanner.hash?.update('\0canonical-messages-v1\0');
      scanner.archive = scanner.state.messagesArchive;
      scanner.retained = new Set(scanner.archive?.retainedIds ?? []);
    }
    scanner.phase = 'messages'; scanner.cursor = ''; scanner.count = 0; scanner.visible = 0;
  };
  const finish = outcome => { scanner.done = true; scanner.phase = 'done'; scanner.outcome = outcome; return outcome; };
  // One chunk of the messages leg. Returns SCAN_AGAIN when a chunk was
  // banked (cursor committed on the scanner) and more work remains, or
  // the final outcome. The segment byte counter starts here and is
  // never reset between this chunk's pages.
  const stepMessages = () => {
    if (!scanner.authority) { scanner.phase = 'work'; return SCAN_AGAIN; }
    let segmentBytes = 0, chunkCount = 0;
    const noteSegment = bytes => {
      segmentBytes += bytes; scanner.fetchedBytes += bytes;
      scanner.lastSegmentBytes = segmentBytes;
      if (segmentBytes > scanner.maxSegmentBytes) scanner.maxSegmentBytes = segmentBytes;
    };
    for (;;) {
      if (chunkCount >= scanner.chunkRows) break;
      const limit = Math.min(scanner.pageSize, scanner.chunkRows - chunkCount);
      const probed = db.prepare(`SELECT message_id, (${MESSAGE_PROBE_SELECT}) AS cost FROM messages WHERE room_id=? AND message_id>? ORDER BY message_id LIMIT ?`)
        .all(roomId, scanner.cursor, limit);
      if (!probed.length) {
        // Messages leg complete: the count verdict runs once, here.
        if (scanner.verify && (scanner.visible !== scanner.state.messageAuthority.count
          || scanner.count !== scanner.state.messageAuthority.count + (scanner.archive?.count ?? 0))) scanner.drift = true;
        if (scanner.drift && !scanner.hash) return finish({ drift: true });
        scanner.phase = 'work';
        break;
      }
      let take = 0, probedBytes = 0;
      for (const probe of probed) {
        const cost = Number.isSafeInteger(probe.cost) && probe.cost >= 0 ? probe.cost : 0;
        if (cost > scanner.chunkBytes) scanner.fetchOversize = 1;
        if (take > 0 && segmentBytes + probedBytes + cost > scanner.chunkBytes) break;
        probedBytes += cost; take += 1;
      }
      if (take === 0) take = 1; // one oversize row, processed alone
      const lastId = probed[take - 1].message_id;
      const pageStartBytes = segmentBytes;
      const rows = db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? AND message_id>? AND message_id<=? ORDER BY message_id`)
        .all(roomId, scanner.cursor, lastId);
      let pageBytes = 0;
      for (const row of rows) {
        const bytes = rowFetchedBytes(row); pageBytes += bytes; noteSegment(bytes);
        if (scanner.verify && !messageProofMatches(row)) {
          scanner.drift = true;
          if (!scanner.hash) { scanner.cursor = row.message_id; return finish({ drift: true }); }
        }
        if (scanner.hash) {
          const text = JSON.stringify(MESSAGE_PROOF_FIELDS.map(key => row[key]));
          scanner.hash.update(String(Buffer.byteLength(text))).update(':').update(text);
        }
        scanner.count++;
        if (!scanner.archive || row.seq > scanner.archive.throughSeq || scanner.retained.has(row.message_id)) scanner.visible++;
        scanner.cursor = row.message_id; // commit cursor per row, banked per chunk
      }
      chunkCount += rows.length;
      if (scanner.pageSize > 1 && pageBytes > Math.max(1, (scanner.chunkBytes - pageStartBytes) / 2)) {
        scanner.pageSize = Math.max(1, Math.floor(scanner.pageSize / 2));
      }
      if (rows.length === 0) break; // defensive: probe/fetch disagreement must not spin
      if (take < probed.length) break; // byte bound: bank this chunk and yield
      if (probed.length < limit) {
        if (scanner.verify && (scanner.visible !== scanner.state.messageAuthority.count
          || scanner.count !== scanner.state.messageAuthority.count + (scanner.archive?.count ?? 0))) scanner.drift = true;
        if (scanner.drift && !scanner.hash) return finish({ drift: true });
        scanner.phase = 'work';
        break;
      }
      if (segmentBytes >= scanner.chunkBytes) break;
    }
    scanner.chunks++;
    return SCAN_AGAIN;
  };
  // Work-entity leg: once per scan, after the messages leg completes.
  const stepWork = () => {
    const references = scanner.state.workItems ?? {};
    if (Object.values(references).some(record => record?._workEntity === 1)) {
      scanner.hash?.update('\0canonical-work-v1\0');
      const seen = new Set();
      for (const row of db.prepare('SELECT work_id,revision,digest,body FROM work_entities WHERE room_id=? ORDER BY work_id').iterate(roomId)) {
        if (scanner.hash) {
          const text = JSON.stringify(Object.values(row));
          scanner.hash.update(String(Buffer.byteLength(text))).update(':').update(text);
        }
        const reference = references[row.work_id];
        if (!scanner.verify || reference?._workEntity !== 1) continue;
        seen.add(row.work_id);
        if (reference.digest !== row.digest || reference.revision !== row.revision || projectionDigest(row.body) !== row.digest) {
          scanner.drift = true;
          if (!scanner.hash) return finish({ drift: true });
        }
      }
      if (scanner.verify && Object.entries(references).some(([id, record]) => record?._workEntity === 1 && !seen.has(id))) scanner.drift = true;
    }
    return finish({ drift: scanner.drift, ...(scanner.hash ? { hash: scanner.hash.digest('hex') } : {}) });
  };
  scanner.step = () => {
    if (scanner.done) return scanner.outcome;
    if (!CONTENT_SCAN_PHASES.includes(scanner.phase)) {
      // Unknown phase: the in-memory analogue of the design's corrupt-
      // checkpoint rule — discard, count it, restart the scan; no
      // verdict is ever issued from untrusted progress state.
      scanner.scanDiscards++;
      scanner.done = false; scanner.outcome = null; scanner.chunks = 0; scanner.fetchedBytes = 0;
      scanner.lastSegmentBytes = 0; scanner.maxSegmentBytes = 0; scanner.fetchOversize = 0;
      initScan();
      return scanner.done ? scanner.outcome : SCAN_AGAIN;
    }
    return scanner.phase === 'messages' ? stepMessages() : stepWork();
  };
  scanner.progress = () => ({
    done: false, inProgress: 1, roomId, phase: scanner.phase,
    scanBound: sequence, scan_bound: sequence, bound_seq: sequence, bound: sequence, sequence,
    range_cursor: scanner.cursor, last_message_id: scanner.cursor, cursor: scanner.cursor,
    scannedRows: scanner.count, count: scanner.count, visible: scanner.visible,
    fetchedBytes: scanner.fetchedBytes, lastSegmentBytes: scanner.lastSegmentBytes,
    maxSegmentBytes: scanner.maxSegmentBytes, fetchOversize: scanner.fetchOversize,
    scanDiscards: scanner.scanDiscards, chunks: scanner.chunks,
  });
  scanner.result = () => scanner.done ? scanner.outcome : { ...scanner.progress(), budgetExceeded: 1 };
  // Drive this scanner chunk by chunk: check the deadline before each
  // chunk after the first (the first chunk always runs, so a drive on a
  // spent budget still banks one chunk of progress instead of nothing —
  // the parity engine's first-room rule), yield between chunks, and
  // return a progress result (never a verdict) when the budget stops
  // the drive. With no yield hook and no deadline this is the fully
  // synchronous drive the legacy exports use.
  scanner.drive = ({ deadline = Infinity, yieldBetween = null } = {}) => {
    let chunksThisDrive = 0;
    const step = () => {
      if (scanner.done) return scanner.outcome;
      if (chunksThisDrive > 0 && Date.now() > deadline) return scanner.result();
      const outcome = scanner.step();
      chunksThisDrive++;
      return scanner.done ? scanner.outcome : SCAN_AGAIN;
    };
    return driveContentScanSteps(step, yieldBetween);
  };
  initScan();
  return scanner;
}
export function driveServingContentScan(scanner, { deadline = Infinity, yieldBetween = null } = {}) {
  return scanner.drive({ deadline, yieldBetween });
}
function scanServingContent(db, roomId, sequence, projection, { verify, hashContent }) {
  // The synchronous contract: drive the chunked scanner to completion
  // in one call, exactly as checkMessagesParity's direct callers were
  // preserved in part 2.
  return createServingContentScanner(db, roomId, sequence, projection, { verify, hashContent }).drive();
}
export function projectionContentHash(db,roomId,sequence,projection) {
  return scanServingContent(db,roomId,sequence,projection,{verify:false,hashContent:true}).hash;
}
export function servingContentProof(db,roomId,sequence,projection) {
  return scanServingContent(db,roomId,sequence,projection,{verify:protocols.has(db),hashContent:true});
}
export function servingProofDrift(db,roomId,projection) {
  return protocols.has(db) && scanServingContent(db,roomId,null,projection,{verify:true,hashContent:false}).drift;
}

// Call only for a genuine older schema, or an explicitly attested legacy
// restore after its byte/count/FK checks. This establishes future protection,
// never historical verification. The caller owns the write transaction.
export function bootstrapLegacyWriteProofs(db) {
  if (!db.isTransaction) throw Error('Legacy write proofs require their write transaction');
  const insert = db.prepare(`INSERT OR IGNORE INTO integrity_room_state(room_id,sequence,projection_bytes) VALUES(?,?,?)`);
  const update = db.prepare('UPDATE integrity_room_state SET metadata_hash=? WHERE room_id=? AND metadata_hash IS NULL');
  let added = 0;
  for (const row of db.prepare('SELECT id,sequence,projection,LENGTH(projection) AS bytes FROM rooms').iterate()) {
    const proof = db.prepare('SELECT sequence,projection_hash,metadata_hash FROM integrity_room_state WHERE room_id=?').get(row.id);
    const hash = projectionDigest(row.projection);
    if (proof?.metadata_hash) {
      if (proof.metadata_hash !== hash) throw Error('projection_corrupt: stored metadata does not match its write proof');
      continue;
    }
    // A current metadata proof already covers legitimate writes after an
    // older historical baseline. Consult that baseline only when bootstrapping.
    if (proof?.projection_hash && (proof.sequence !== row.sequence
      || projectionContentHash(db,row.id,row.sequence,row.projection) !== proof.projection_hash))
      throw Error('projection_corrupt: legacy content does not match its baseline');
    insert.run(row.id,row.sequence,row.bytes);
    update.run(hash,row.id);
    added++;
  }
  return added;
}
