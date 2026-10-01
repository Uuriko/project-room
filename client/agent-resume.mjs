// Read-only host coordination. Source cursors are observations, never acknowledgements.
import { RoomAgentClient, RoomClientError } from './room-agent.mjs';
import { connectionDiagnostic } from './agent-connection.mjs';
import { parseNeedsMeBody } from './grok-host.mjs';
import { validId } from '../src/events.js';
import { edgeDoorApiPath } from '../deploy/agent-discovery.mjs';

const invalid = () => new RoomClientError(200, 'invalid_response', 'Unsupported resume response');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function checkedCursor(value) {
  if (!isObject(value) || Buffer.byteLength(JSON.stringify(value)) > 16384
    || Object.keys(value).some(key => !['rooms', 'land', 'landIds', 'floor', 'roomAfter'].includes(key)) || !isObject(value.rooms)) throw invalid();
  for (const key of ['rooms', 'land', 'landIds']) if (value[key] !== undefined) {
    if (!isObject(value[key]) || Object.keys(value[key]).length > 500
      || Object.entries(value[key]).some(([id, entry]) => !validId(id) || (key === 'landIds' ? typeof entry !== 'string' || entry.length > 256 : !count(entry)))) throw invalid();
  }
  if (value.floor !== undefined && !count(value.floor) || value.roomAfter !== undefined && value.roomAfter !== '' && !validId(value.roomAfter)) throw invalid();
  return value;
}
function attentionRead(item) {
  const roomId = item.roomId;
  if (item.kind === 'handoff') return { tool: 'room_read_work', arguments: { roomId, workItemId: item.id } };
  if (item.kind === 'direct_ask') return { tool: 'room_read_request', arguments: { roomId, requestMessageId: item.id } };
  if (item.kind === 'bond_request') return { tool: 'bond_list', arguments: { roomId } };
  if (item.kind === 'land_queue') return { tool: 'list_land_queue', arguments: { roomId } };
  if (item.next?.tool === 'room_list_peer_dms' && validId(item.next.arguments?.threadId)) {
    return { tool: 'room_list_peer_dms', arguments: { roomId, threadId: item.next.arguments.threadId } };
  }
  return { tool: 'room_list_events', arguments: { roomId, after: Math.max(0, item.seq - 1), limit: 1 } };
}

async function beforeAbort(promise, signal) {
  if (signal.aborted) throw signal.reason;
  let listener;
  const stopped = new Promise((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', listener); }
}

export async function resumeAgent({ connection, fetchImpl = fetch, sinceVersion, attentionCursor, focus, maxPages = 2,
  timeoutMs = 10000, signal, maxResponseBytes = 262144 } = {}) {
  if (focus !== undefined && focus !== 'replies' || !connection?.memberId || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 1048576
    || sinceVersion !== undefined && !/^[a-f0-9]{64}$/.test(sinceVersion)
    ) throw invalid();
  if (attentionCursor !== undefined) checkedCursor(attentionCursor);
  const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const metrics = { requests: 0, responseBytes: 0, attentionPages: 0 };
  const boundedFetch = async (url, options) => {
    metrics.requests++;
    const response = await beforeAbort(fetchImpl(url, { ...options, signal: stop, redirect: 'error', credentials: 'omit' }), stop);
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await beforeAbort(reader.read(), stop);
        if (done) break;
        bytes += value.byteLength; metrics.responseBytes += value.byteLength;
        if (bytes > maxResponseBytes) throw invalid();
        chunks.push(Buffer.from(value));
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
  const client = new RoomAgentClient({ ...connection, memberId: undefined, fetchImpl: boundedFetch });
  const out = { version: 1, scope: { roomId: connection.roomId, memberId: connection.memberId, readOnly: true },
    connection: { status: 'unconfirmed' }, toolProfile: { transport: 'hosted_mcp', profile: 'full' }, contextVersion: null, authoritySummary: null,
    observedThroughBySource: {}, attention: [], ownClaims: [], obligations: [], pendingReconciliations: { status: 'not_read' },
    incompleteSources: [], nextReads: [], metrics };
  if (focus === 'replies') Object.assign(out, { focus, openRequests: [], optionalConversations: [] });
  const safe = () => { if (JSON.stringify(out).includes(connection.token)) throw invalid(); return out; };
  const incomplete = (source, error) => out.incompleteSources.push({ source, ...connectionDiagnostic(error) });
  const contextRead = async version => {
    const value = await client.roomContext({ sinceVersion: version, signal: stop });
    if (!value?.not_modified && value?.contractVersion !== 1 || !count(value?.evaluatedThrough) || !/^[a-f0-9]{64}$/.test(value.context_version)
      || value.roomId !== connection.roomId || value.viewerId !== connection.memberId
      || value.viewerAccountId !== null || value.viewerAuthEpoch !== null || value.viewerSessionBinding !== null || value.viewerSessionRevision !== null
      || !isObject(value.cursors) || value.cursors.roomSequence !== value.evaluatedThrough || !count(value.cursors.caughtUp) || value.cursors.caughtUp > value.evaluatedThrough
      || value.not_modified && (version === undefined || value.context_version !== version) || !value.not_modified && (!Array.isArray(value.focusWork) || !Array.isArray(value.locks) || !Array.isArray(value.roster))) throw invalid();
    if (!value.not_modified) {
      const viewer = value.roster.find(member => member.id === connection.memberId);
      if (!viewer || viewer.kind !== 'agent' || viewer.active !== true || !Array.isArray(viewer.permissions)) throw invalid();
    }
    return value;
  };
  let initial;
  try { initial = await contextRead(undefined); }
  catch (error) { incomplete('connection', error); return safe(); }
  const project = value => {
    out.contextVersion = value.context_version;
    out.observedThroughBySource.context = { evaluatedThrough: value.evaluatedThrough, cursors: value.cursors, notModified: value.not_modified === true };
    if (value.not_modified) return;
    out.authoritySummary = pick(value.roster.find(member => member.id === connection.memberId), ['id', 'kind', 'active', 'permissions']);
    out.obligations = focus === 'replies' ? [] : value.focusWork.map(item => pick(item, ['id', 'title', 'state', 'revision', 'nextAction', 'nextMemberId', 'needsAttention']));
    out.ownClaims = focus === 'replies' ? [] : value.locks.filter(lock => lock.holderId === connection.memberId)
      .map(lock => pick(lock, ['workItemId', 'repository', 'ref', 'paths', 'expiresAt', 'status']));
    out.nextReads = out.nextReads.filter(read => read.source !== 'work');
    for (const item of out.obligations) out.nextReads.push({ source: 'work', tool: 'room_read_work', arguments: { roomId: connection.roomId, workItemId: item.id } });
  };
  project(initial);
  try {
    const items = []; let cursor = attentionCursor, more = false;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams();
      if (cursor !== undefined) query.set('since', JSON.stringify(cursor));
      const path = '/api/needs-me' + (query.size ? `?${query}` : '');
      const response = await boundedFetch(connection.origin + edgeDoorApiPath(connection.origin, path), {
        method: 'GET', headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' }
      });
      if (!response.ok) throw new RoomClientError(response.status, 'request_failed', 'Attention unavailable');
      let parsed;
      try {
        const raw = await response.json();
        if (typeof raw?.hasMore !== 'boolean') throw invalid();
        parsed = parseNeedsMeBody(raw);
      } catch { throw invalid(); }
      if (!validId(parsed.identityId) || parsed.items.length > 100) throw invalid();
      checkedCursor(parsed.cursor);
      metrics.attentionPages++;
      // Other rooms remain outside this command's content scope.
      items.push(...parsed.items.filter(item => item.roomId === connection.roomId && (focus !== 'replies' || ['mention', 'dm'].includes(item.kind)))
        .map(item => ({ ...pick(item, ['kind', 'roomId', 'seq', 'id']), nextRead: attentionRead(item) })));
      cursor = parsed.cursor; more = parsed.hasMore;
      if (!more) break;
    }
    out.attention = items;
    out.observedThroughBySource.attention = { cursor, hasMore: more };
    for (const item of items) out.nextReads.push({ source: 'attention', ...item.nextRead });
    if (more) {
      out.incompleteSources.push({ source: 'attention', code: 'page_limit' });
      out.nextReads.push({ source: 'attention', action: 'continue_with_returned_cursor' });
    }
  } catch (error) { incomplete('attention', error); }
  if (focus === 'replies') {
    // Optional conversation observations are a bounded delta, not an unhandled inbox.
    out.optionalConversations = out.attention;
    try {
      // Current obligations are read independently of any observation continuation.
      const listing = await client.replyRequests({ direction: 'incoming', status: 'open', signal: stop });
      if (listing.viewerId !== connection.memberId || listing.viewerAccountId !== null || listing.viewerAuthEpoch !== null) throw invalid();
      out.openRequests = listing.requests.map(request => ({
        ...pick(request, ['id', 'requesterId', 'workItemId', 'revision']),
        nextRead: { tool: 'room_read_request', arguments: { roomId: connection.roomId, requestMessageId: request.id } }
      }));
      const requiredIds = new Set(out.openRequests.map(request => request.id));
      out.attention = out.attention.filter(item => !requiredIds.has(item.id));
      out.optionalConversations = out.attention;
      out.nextReads = out.nextReads.filter(read => read.source !== 'attention' || read.action);
      for (const item of out.attention) out.nextReads.push({ source: 'attention', ...item.nextRead });
      out.observedThroughBySource.openRequests = { evaluatedThrough: listing.evaluatedThrough, selection: { direction: 'incoming', status: 'open' } };
      for (const request of out.openRequests) out.nextReads.push({ source: 'openRequests', ...request.nextRead });
    } catch (error) { incomplete('openRequests', error); }
  }
  // Fresh compact read, not a cached grant. Changed context replaces the earlier projection.
  try {
    const fresh = await contextRead(initial.context_version);
    out.connection.status = 'credential_accepted';
    project(fresh);
    if (sinceVersion === out.contextVersion) {
      out.authoritySummary = null; out.obligations = []; out.ownClaims = [];
      out.nextReads = out.nextReads.filter(read => read.source !== 'work');
      out.nextReads.push({ source: 'context', action: 'reuse_same_version_local_context' });
    }
  } catch (error) {
    out.contextVersion = null; out.authoritySummary = null; out.observedThroughBySource = {};
    if (focus === 'replies') { out.openRequests = []; out.optionalConversations = []; }
    out.attention = []; out.obligations = []; out.ownClaims = []; out.nextReads = [];
    incomplete('connection', error);
  }
  // Service text is untrusted; a response must never echo the bearer, even through IDs/cursors.
  return safe();
}
