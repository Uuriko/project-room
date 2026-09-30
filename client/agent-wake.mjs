// Wake hints are non-consuming. Observation cursors never mean handled work.
import { ConnectionError } from './agent-connection.mjs';
import { RoomAgentClient, RoomClientError } from './room-agent.mjs';
import { resumeAgent } from './agent-resume.mjs';
import { edgeDoorApiPath } from '../deploy/agent-discovery.mjs';

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
  #connection; #fetch; #room;
  constructor({ connection, fetchImpl = fetch }) {
    this.#room = new RoomAgentClient({ ...connection, fetchImpl });
    if (!connection.memberId || !connection.token.startsWith('pri_')) throw usage();
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
  async setup({ hostId, cadenceSeconds }) {
    hostOptions(hostId, cadenceSeconds); await this.#room.checkConnection();
    const value = await this.#request('/api/agent-heartbeats', { hostId, mode: 'wakeable', cadenceSeconds });
    if (!object(value.host) || value.host.hostId !== hostId || value.host.mode !== 'wakeable' || value.host.cadenceSeconds !== cadenceSeconds || !id(value.host.agentId)) throw invalid();
    return { version: 1, status: 'registered_not_listening', hostId, cadenceSeconds, pendingWakes: signals(value.pendingWakes), execution: 'not_observed' };
  }
  async wait({ hostId, cadenceSeconds, waitMs = 25000, attentionCursor, sinceVersion }) {
    hostOptions(hostId, cadenceSeconds);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 55000) throw usage();
    const before = await resumeAgent({ connection: this.#connection, fetchImpl: this.#fetch, attentionCursor, sinceVersion });
    if (before.connection.status !== 'credential_accepted') throw invalid();
    await this.setup({ hostId, cadenceSeconds });
    const value = await this.#request('/api/agent-wakes/poll?hostId=' + encodeURIComponent(hostId) + '&waitMs=' + waitMs, undefined, waitMs + 10000);
    if (!id(value.agentId) || typeof value.timedOut !== 'boolean' || !Number.isFinite(value.waitedMs)) throw invalid();
    const pendingWakes = signals(value.pendingWakes);
    const after = await resumeAgent({ connection: this.#connection, fetchImpl: this.#fetch,
      attentionCursor: before.observedThroughBySource.attention?.cursor });
    if (after.connection.status !== 'credential_accepted') throw invalid();
    return { version: 1, status: pendingWakes.length ? 'signals_received' : 'wait_completed', hostId, pendingWakes,
      timedOut: value.timedOut, waitedMs: value.waitedMs, acknowledged: false,
      observations: { before, after }, sourceCursorsAre: 'read_observations_not_handled', execution: 'not_observed' };
  }
  async ack({ signalIds }) {
    if (!Array.isArray(signalIds) || signalIds.length < 1 || signalIds.length > 50 || !signalIds.every(id) || new Set(signalIds).size !== signalIds.length) throw usage();
    await this.#room.checkConnection();
    const value = await this.#request('/api/agent-heartbeats/ack', { signalIds });
    if (!Array.isArray(value.acknowledged) || !value.acknowledged.every(entry => signalIds.includes(entry)) || new Set(value.acknowledged).size !== value.acknowledged.length) throw invalid();
    return { version: 1, status: 'ack_response_received', acknowledged: value.acknowledged,
      notAcknowledged: signalIds.filter(entry => !value.acknowledged.includes(entry)) };
  }
}
