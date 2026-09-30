// Explicit public-task actions. No admission, automatic renewal or model launch.
import { createHash } from 'node:crypto';
import { assertServiceOrigin, RoomClientError } from './room-agent.mjs';
import { edgeDoorApiPath } from '../deploy/agent-discovery.mjs';
import { validId } from '../src/events.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new RoomClientError(200, 'invalid_response', 'Unsupported public work response');
const positive = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function packet(value, taskId) {
  if (!object(value) || value.schema !== 'public-work-task/1' || !validId(value.taskId) || value.taskId !== taskId
    || !positive(value.termsVersion) || !validId(value.namespaceId) || typeof value.repositoryUrl !== 'string'
    || typeof value.repositoryRef !== 'string' || typeof value.title !== 'string'
    || !Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.every(item => typeof item === 'string')
    || !Array.isArray(value.files) || !value.files.every(item => typeof item === 'string') || !object(value.claim)
    || !['unclaimed', 'claimed', 'submitted'].includes(value.claim.state)
    || !Number.isSafeInteger(value.claim.generation) || value.claim.generation < 0
    || value.claim.identityId !== null && !validId(value.claim.identityId)
    || value.claim.leaseExpiresAt !== null && !date(value.claim.leaseExpiresAt)
    || value.claim.submittedReceiptId !== null && !validId(value.claim.submittedReceiptId)) throw invalid();
  return value;
}
function receipt(value, receiptId) {
  if (!object(value) || value.schema !== 'public-work-receipt/1' || !validId(value.receiptId)
    || receiptId !== undefined && value.receiptId !== receiptId || !validId(value.taskId) || !validId(value.namespaceId)
    || !positive(value.termsVersion) || !positive(value.generation) || !validId(value.identityId)
    || value.state !== 'submitted' || value.verification !== 'hash_only' || !date(value.createdAt)
    || !object(value.artifact) || !/^[a-f0-9]{64}$/.test(value.artifact.sha256)
    || !Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 0 || value.artifact.bytes > 65536
    || !Array.isArray(value.checksReported) || !value.checksReported.every(item => typeof item === 'string')) throw invalid();
  return value;
}
export class PublicWorkClaimsClient {
  #identitySecret;
  constructor({ origin, identitySecret, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    try { this.origin = assertServiceOrigin(origin); }
    catch { throw new RoomClientError(0, 'invalid_config', 'Use a fixed HTTPS service or isolated loopback origin'); }
    if (identitySecret !== undefined && (typeof identitySecret !== 'string' || !identitySecret.startsWith('pri_'))
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new RoomClientError(0, 'invalid_config', 'Use a saved identity and a bounded request deadline');
    this.#identitySecret = identitySecret; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async #request(path, { data, signal, artifact = false, authenticate = Boolean(data) } = {}) {
    if (authenticate && !this.#identitySecret) throw new RoomClientError(0, 'identity_required', 'Use your saved agent identity');
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.origin + edgeDoorApiPath(this.origin, path), {
        method: data ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: stop,
        headers: { Accept: artifact ? 'text/plain' : 'application/json', ...(authenticate ? { Authorization: `Bearer ${this.#identitySecret}` } : {}), ...(data ? { Origin: this.origin, 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {})
      });
    } catch { throw new RoomClientError(0, 'service_unavailable', 'Response unknown. Retry the same request ID and exact payload.'); }
    const reader = response.body?.getReader(); if (!reader) throw invalid();
    // Five legal recommendations plus an explicit claim contain full criteria and paths.
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > (artifact && response.ok ? 65536 : 2 * 1024 * 1024)) throw invalid();
        chunks.push(Buffer.from(value));
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks); let value;
    if (!(artifact && response.ok)) { try { value = JSON.parse(raw.toString('utf8')); } catch { throw invalid(); } }
    if (!response.ok) throw new RoomClientError(response.status, value?.error?.code ?? 'request_failed', 'Public work request was refused; inspect its status and code before retrying.');
    return artifact ? raw : value;
  }
  async match(input = {}, options) {
    if (!object(input) || input.autoClaim !== undefined && typeof input.autoClaim !== 'boolean'
      || input.autoClaim === true && !validId(input.requestId)
      || input.requestId !== undefined && !validId(input.requestId)
      || input.after !== undefined && !validId(input.after)
      || input.limit !== undefined && (!positive(input.limit) || input.limit > 5)
      || input.reward !== undefined && !['volunteer', 'work_trade', 'cash'].includes(input.reward)
      || ['skills', 'interests'].some(key => input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 20 || !input[key].every(value => typeof value === 'string' && value.trim() && value.length <= 100)))) throw new RoomClientError(0, 'invalid_input', 'Use bounded matching preferences and a stable request ID for an explicit claim');
    const result = await this.#request('/api/public-work/match', { ...options, data: input, authenticate: Boolean(this.#identitySecret) || input.autoClaim === true });
    if (!object(result) || !Array.isArray(result.recommendations) || result.recommendations.length > (input.limit ?? 3)
      || !Number.isSafeInteger(result.inspected) || result.inspected < 0 || result.inspected > 100 || typeof result.hasMore !== 'boolean'
      || result.nextCursor !== null && !validId(result.nextCursor) || !Array.isArray(result.supportedRewards)
      || result.supportedRewards.length !== 1 || result.supportedRewards[0] !== 'volunteer') throw invalid();
    for (const item of result.recommendations) {
      if (!object(item) || !Array.isArray(item.reasons) || !item.reasons.every(value => typeof value === 'string')) throw invalid();
      packet(item.task, item.task?.taskId);
    }
    if (result.claim !== null) {
      if (input.autoClaim !== true || !object(result.claim) || result.claim.action !== 'claimed') throw invalid();
      packet(result.claim.task, result.claim.task?.taskId);
      if (!result.recommendations.some(item => item.task.taskId === result.claim.task.taskId)) throw invalid();
    }
    return result;
  }
  read(taskId, options) { if (!validId(taskId)) throw new RoomClientError(0, 'invalid_input', 'Use a public task ID'); return this.#request(`/api/public-work/tasks/${encodeURIComponent(taskId)}`, options).then(value => packet(value, taskId)); }
  async #action(taskId, action, input, options) {
    if (!validId(taskId) || !object(input) || !validId(input.requestId) || !positive(input.expectedTermsVersion)
      || action !== 'claim' && !positive(input.generation)) throw new RoomClientError(0, 'invalid_input', 'Provide the task version, stable request ID and current lease generation');
    if (input.leaseHours !== undefined && (typeof input.leaseHours !== 'number' || !Number.isFinite(input.leaseHours) || input.leaseHours <= 0 || input.leaseHours > 24)) throw new RoomClientError(0, 'invalid_input', 'Lease duration must be positive and at most 24 hours');
    if (action === 'finish' && (typeof input.artifactText !== 'string' || Buffer.byteLength(input.artifactText, 'utf8') > 65536 || !Array.isArray(input.checksReported) || !input.checksReported.every(value => typeof value === 'string'))) throw new RoomClientError(0, 'invalid_input', 'Submit a UTF-8 artifact within 64 KiB and your reported checks');
    const value = await this.#request(`/api/public-work/tasks/${encodeURIComponent(taskId)}/${action}`, { ...options, data: input });
    const expected = { claim: 'claimed', renew: 'renewed', release: 'released', finish: 'submitted' }[action];
    if (!object(value) || value.action !== expected) throw invalid();
    packet(value.task, taskId);
    if (value.task.termsVersion !== input.expectedTermsVersion) throw invalid();
    if (action === 'finish') {
      receipt(value.receipt);
      if (value.receipt.taskId !== taskId || value.receipt.generation !== input.generation || value.receipt.termsVersion !== input.expectedTermsVersion
        || value.task.claim.submittedReceiptId !== value.receipt.receiptId) throw invalid();
    }
    return value;
  }
  claim(id, input, options) { return this.#action(id, 'claim', input, options); }
  renew(id, input, options) { return this.#action(id, 'renew', input, options); }
  release(id, input, options) { return this.#action(id, 'release', input, options); }
  finish(id, input, options) { return this.#action(id, 'finish', input, options); }
  async readReceipt(id, options) { if (!validId(id)) throw new RoomClientError(0, 'invalid_input', 'Use a public receipt ID'); return receipt(await this.#request(`/api/public-work/receipts/${encodeURIComponent(id)}`, options), id); }
  async readReview(record, options) {
    const checked = receipt(record);
    const value = await this.#request(`/api/public-work/receipts/${encodeURIComponent(checked.receiptId)}/review`, { ...options, authenticate: true });
    if (!object(value) || Object.keys(value).some(key => !['receiptId', 'taskId', 'termsVersion', 'generation', 'artifactSha256', 'review'].includes(key))
      || value.receiptId !== checked.receiptId || value.taskId !== checked.taskId || value.termsVersion !== checked.termsVersion
      || value.generation !== checked.generation || value.artifactSha256 !== checked.artifact.sha256 || !object(value.review)) throw invalid();
    const review = value.review;
    if (Object.keys(review).some(key => !['revision', 'state', 'decision', 'reason', 'decidedAt', 'verificationVerdict', 'verificationReviewerKind'].includes(key))
      || !Number.isSafeInteger(review.revision) || review.revision < 0 || !['pending', 'accepted', 'rejected', 'revision_requested'].includes(review.state)
      || review.state !== 'pending' && (review.decision !== review.state || typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 2000 || !date(review.decidedAt))
      || review.verificationVerdict !== undefined && !['PASS', 'FAIL'].includes(review.verificationVerdict)
      || review.verificationReviewerKind !== undefined && !['human', 'agent'].includes(review.verificationReviewerKind)) throw invalid();
    return value;
  }
  async readArtifact(record, options) {
    const checked = receipt(record), raw = await this.#request(`/api/public-work/receipts/${encodeURIComponent(checked.receiptId)}/artifact`, { ...options, artifact: true });
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (raw.byteLength !== checked.artifact.bytes || sha256 !== checked.artifact.sha256) throw new RoomClientError(200, 'artifact_mismatch', 'Artifact bytes do not match the submitted receipt');
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw invalid(); }
    return { text, sha256, bytes: raw.byteLength, verification: 'hash_only' };
  }
}
