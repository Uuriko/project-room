// Wake hints are non-consuming. Observation cursors never mean handled work.
import { ConnectionError } from './agent-connection.mjs';
import { RoomAgentClient, RoomClientError } from './room-agent.mjs';
import { resumeAgent } from './agent-resume.mjs';
import { edgeDoorApiPath } from '../server/agent-discovery.mjs';

const invalid = () => new RoomClientError(200, 'invalid_response', 'Unsupported wake response');
const usage = () => new ConnectionError('invalid_config');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
function hostOptions(hostId, cadenceSeconds) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '') || !Number.isFinite(cadenceSeconds) || cadenceSeconds <= 0) throw usage();
}
function signals(value) {
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  return value.map(row => {
    if (!object(row) || !id(row.signalId) || typeof row.kind !== 'string' || row.kind.length > 64) throw invalid();
    const out = { signalId: row.signalId, kind: row.kind };
    for (const key of ['roomId', 'messageId', 'workItemId', 'requestId']) if (row[key] !== undefined && row[key] !== null) {
      if (!id(row[key])) throw invalid(); out[key] = row[key];
    }
    if (!Number.isFinite(row.createdAt)) throw invalid(); out.createdAt = row.createdAt;
    if (row.workRevision !== undefined) {
      if (!Number.isSafeInteger(row.workRevision) || row.workRevision < 1) throw invalid();
      out.workRevision = row.workRevision;
    }
    if (row.kind === 'work' && out.roomId && out.workItemId) out.nextRead = { tool: 'room_read_work', arguments: { roomId: out.roomId, workItemId: out.workItemId } };
    return out;
  });
}
export class AgentWakeClient {
  #connection; #fetch; #room; #fencingToken = null; #listenerRequired = false;
  constructor({ connection, fetchImpl = fetch }) {
    this.#room = new RoomAgentClient({ ...connection, fetchImpl });
    // CX5-FIX: two supported listener credentials — the pri_ identity
    // secret (identity-level listener), or the rak_ API key standard
    // setup saves, which is room-scoped by construction and therefore
    // requires the connection's roomId (the server binds the key to that
    // room and re-verifies membership on every call). A rak_ key without
    // a room binding is not a supported listener configuration.
    if (!connection.memberId
      || !(connection.token.startsWith('pri_')
        || (connection.token.startsWith('rak_') && typeof connection.roomId === 'string' && connection.roomId.length > 0)))
      throw usage();
    this.#connection = { ...connection }; this.#fetch = fetchImpl;
  }
  async #request(path, body, timeoutMs = 15000) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.#fetch(this.#connection.origin + edgeDoorApiPath(this.#connection.origin, path), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', signal,
        headers: { Authorization: 'Bearer ' + this.#connection.token, 'User-Agent': 'project-room-agent',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: this.#connection.origin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      let length = 0; const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        length += chunk.length; if (length > 262144) { throw invalid(); }
        chunks.push(Buffer.from(chunk));
      }
      let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
      if (!response.ok) throw new RoomClientError(response.status, typeof value?.error?.code === 'string' ? value.error.code : 'service_unavailable', 'Wake request not confirmed');
      if (!object(value) || JSON.stringify(value).includes(this.#connection.token)) throw invalid();
      return value;
    } catch (error) {
      if (error instanceof RoomClientError) throw error;
      if (signal.aborted) throw new ConnectionError('request_timeout');
      throw new RoomClientError(0, 'service_unavailable', 'Wake request not confirmed');
    }
  }
  async doctor({ hostId }) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '')) throw usage();
    const connection = await this.#room.checkConnection();
    const value = await this.#request('/api/agent-heartbeats');
    if (!id(value.agentId) || !['online', 'offline', 'unregistered'].includes(value.status) || !Array.isArray(value.hosts)) throw invalid();
    const host = value.hosts.find(row => row.hostId === hostId);
    if (host && !['wakeable', 'pull-only'].includes(host.mode)) throw invalid();
    return { version: 1, connection, hostId, registration: host ? 'registered' : 'not_registered',
      heartbeatStatus: value.status, hostMode: host?.mode ?? null, listening: 'not_observed', execution: 'not_observed' };
  }
  async setup({ hostId, cadenceSeconds, listener = false }) {
    hostOptions(hostId, cadenceSeconds); await this.#room.checkConnection();
    const value = await this.#request('/api/agent-heartbeats', { hostId, mode: 'wakeable', cadenceSeconds,
      // The lease is per-room: name the connection's pinned room when it
      // has one (the scoped setup credential is bound to it anyway), else
      // lease the roomless identity queue.
      ...(listener ? { listenerLease: this.#connection.roomId ? { roomId: this.#connection.roomId } : true } : {}) });
    if (!object(value.host) || value.host.hostId !== hostId || value.host.mode !== 'wakeable' || value.host.cadenceSeconds !== cadenceSeconds || !id(value.host.agentId)) throw invalid();
    // CX5-FIX: listener:true asks the same heartbeat to acquire/renew the
    // durable listener lease. Contention is data, not an error — the host
    // is registered either way; only the lease holder's ack is fenced in.
    let listenerInfo = null;
    if (listener) {
      this.#listenerRequired = true;
      this.#fencingToken = null;
      if (!object(value.listener) || typeof value.listener.acquired !== 'boolean') throw invalid();
      if (value.listener.acquired) {
        if (typeof value.listener.fencingToken !== 'string' || !value.listener.fencingToken || !Number.isFinite(value.listener.leaseExpiresAt)) throw invalid();
        this.#fencingToken = value.listener.fencingToken;
        listenerInfo = { acquired: true, leaseExpiresAt: value.listener.leaseExpiresAt, renewed: value.listener.renewed === true };
      } else {
        if (!id(value.listener.activeListenerId)) throw invalid();
        listenerInfo = { acquired: false, activeListenerId: value.listener.activeListenerId, leaseExpiresAt: value.listener.leaseExpiresAt };
      }
    }
    return { version: 1, status: 'registered_not_listening', hostId, cadenceSeconds, pendingWakes: listener && !listenerInfo.acquired ? [] : signals(value.pendingWakes),
      ...(listener ? { listener: listenerInfo } : {}), execution: 'not_observed' };
  }
  async wait({ hostId, cadenceSeconds, waitMs = 25000, attentionCursor, sinceVersion }) {
    hostOptions(hostId, cadenceSeconds);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 55000) throw usage();
    const before = await resumeAgent({ connection: this.#connection, fetchImpl: this.#fetch, attentionCursor, sinceVersion });
    if (before.connection.status !== 'credential_accepted') throw invalid();
    const contended = (after = before) => ({ version: 1, status: 'listener_contended', hostId,
      pendingWakes: [], timedOut: false, waitedMs: 0, acknowledged: false,
      observations: { before, after }, sourceCursorsAre: 'read_observations_not_handled', execution: 'not_observed' });
    // Raw HTTP polling remains observation. Standard receiving adapters own
    // the room queue before exposing pointers to their host.
    const registered = await this.setup({ hostId, cadenceSeconds, listener: true });
    if (!registered.listener.acquired) return contended();
    const receivingToken = this.#fencingToken;
    const value = await this.#request('/api/agent-wakes/poll?hostId=' + encodeURIComponent(hostId) + '&waitMs=' + waitMs, undefined, waitMs + 10000);
    if (!id(value.agentId) || typeof value.timedOut !== 'boolean' || !Number.isFinite(value.waitedMs)) throw invalid();
    const pendingWakes = signals(value.pendingWakes);
    const after = await resumeAgent({ connection: this.#connection, fetchImpl: this.#fetch,
      attentionCursor: before.observedThroughBySource.attention?.cursor });
    if (after.connection.status !== 'credential_accepted') throw invalid();
    // Authority reads and a slow poll can outlive the lease. Revalidate
    // before dispatch; a newly acquired token cannot bless the old page.
    if (pendingWakes.length) {
      const renewed = await this.setup({ hostId, cadenceSeconds, listener: true });
      if (!renewed.listener.acquired || this.#fencingToken !== receivingToken) return contended(after);
    }
    return { version: 1, status: pendingWakes.length ? 'signals_received' : 'wait_completed', hostId, pendingWakes,
      timedOut: value.timedOut, waitedMs: value.waitedMs, acknowledged: false,
      observations: { before, after }, sourceCursorsAre: 'read_observations_not_handled', execution: 'not_observed' };
  }
  async ack({ signalIds, hostId }) {
    if (!Array.isArray(signalIds) || signalIds.length < 1 || signalIds.length > 50 || !signalIds.every(id) || new Set(signalIds).size !== signalIds.length) throw usage();
    await this.#room.checkConnection();
    // Separate CLI invocations retain the caller's stable host id, not a
    // private token. Rejoin that same receiving lease using its recorded
    // cadence; a competing host's live lease still refuses ownership.
    if (hostId && !this.#fencingToken) {
      const presence = await this.#request('/api/agent-heartbeats');
      const host = presence.hosts?.find(row => row.hostId === hostId);
      if (!host || !Number.isFinite(host.cadenceSeconds)) throw usage();
      await this.setup({ hostId, cadenceSeconds: host.cadenceSeconds, listener: true });
    }
    if (this.#listenerRequired && !this.#fencingToken)
      throw new RoomClientError(409, 'listener_fenced', 'This listener does not own the receiving lease');
    const value = await this.#request('/api/agent-heartbeats/ack', { signalIds,
      ...(this.#fencingToken ? { fencingToken: this.#fencingToken } : {}) });
    if (!Array.isArray(value.acknowledged) || !value.acknowledged.every(entry => signalIds.includes(entry)) || new Set(value.acknowledged).size !== value.acknowledged.length) throw invalid();
    return { version: 1, status: 'ack_response_received', acknowledged: value.acknowledged,
      notAcknowledged: signalIds.filter(entry => !value.acknowledged.includes(entry)) };
  }
}
