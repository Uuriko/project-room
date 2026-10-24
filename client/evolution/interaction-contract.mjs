// Shared presentation/transport contract. Validation NEVER grants execution.
// Callers must obtain source records through authenticated Room APIs and
// recheck authorization at the action boundary, including after reconnect.
const check = (ok, code) => { if (!ok) throw new Error(code); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const natural = value => Number.isSafeInteger(value) && value >= 0;
const fields = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const scopeKeys = ['origin', 'roomId', 'roomCreatedEventId', 'viewerId', 'authorizationRevision'];
const attemptKeys = ['operationId', 'attemptId', 'packageHash'];
export function validateInteractionScope(scope) {
  check(fields(scope, scopeKeys) && scopeKeys.every(key => text(scope[key])), 'invalid_interaction_scope');
  const url = new URL(scope.origin);
  check(url.origin === scope.origin && ['http:', 'https:'].includes(url.protocol), 'invalid_interaction_origin');
  return scope;
}
export function validateInteractionAttempt(attempt) {
  check(fields(attempt, attemptKeys) && attemptKeys.every(key => text(attempt[key]))
    && /^[a-f0-9]{64}$/.test(attempt.packageHash), 'invalid_interaction_attempt');
  return attempt;
}
const stable = value => value && typeof value === 'object'
  ? (Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}')
  : JSON.stringify(value);
const same = (a, b, keys) => keys.every(key => a[key] === b[key]);
export function sameInteractionScope(a, b) {
  validateInteractionScope(a); validateInteractionScope(b); return same(a, b, scopeKeys);
}
export function sameInteractionAttempt(a, b) {
  validateInteractionAttempt(a); validateInteractionAttempt(b); return same(a, b, attemptKeys);
}
export function validateInteraction(value) {
  check(fields(value, ['version', 'id', 'scope', 'attempt', 'source', 'kind', 'state', 'payload'])
    && value.version === 1 && text(value.id), 'invalid_interaction');
  validateInteractionScope(value.scope); validateInteractionAttempt(value.attempt);
  check(fields(value.source, ['id', 'revision']) && text(value.source.id) && natural(value.source.revision), 'invalid_interaction_source');
  const p = value.payload;
  if (value.kind === 'question' || value.kind === 'approval') {
    check(['open', 'answered', 'declined', 'cancelled', 'expired'].includes(value.state), 'invalid_interaction_state');
    check(fields(p, ['requestMessageId', 'recipientId', 'prompt', 'expiresAt', 'operationDigest'])
      && text(p.requestMessageId) && text(p.recipientId) && text(p.prompt)
      && Number.isSafeInteger(p.expiresAt) && p.expiresAt > 0, 'invalid_interaction_question');
    check(value.kind === 'approval' ? typeof p.operationDigest === 'string' && /^[a-f0-9]{64}$/.test(p.operationDigest)
      : p.operationDigest === null, 'invalid_interaction_approval_binding');
  } else if (value.kind === 'result') {
    check(['completed', 'needs_attention', 'cancelled', 'unknown'].includes(value.state), 'invalid_interaction_state');
    check(fields(p, ['jobId', 'artifactDigest', 'evidenceLocation', 'acceptance']) && text(p.jobId) && text(p.acceptance)
      && (p.artifactDigest === null || /^[a-f0-9]{64}$/.test(p.artifactDigest))
      && ['executing_laptop', 'room', 'partial'].includes(p.evidenceLocation), 'invalid_interaction_result');
  } else throw new Error('invalid_interaction_kind');
  return value;
}
// A complete authoritative snapshot may replace prior presentation state.
// Partial reads cannot advance its watermark or erase unseen interactions.
export function interactionSnapshot({ scope, attempt, complete, watermark, items }) {
  validateInteractionScope(scope); validateInteractionAttempt(attempt);
  check(complete === true && natural(watermark) && Array.isArray(items) && items.length <= 1000, 'incomplete_interaction_snapshot');
  const ids = new Set();
  for (const item of items) {
    validateInteraction(item);
    check(sameInteractionScope(scope, item.scope) && sameInteractionAttempt(attempt, item.attempt), 'interaction_binding_mismatch');
    check(!ids.has(item.id), 'duplicate_interaction'); ids.add(item.id);
  }
  return structuredClone({ scope, attempt, watermark, items });
}
// Same reducer for replay/live data. Sequence order alone is insufficient:
// source revision and exact attempt must agree as well.
export function reduceInteraction(snapshot, { sequence, item }) {
  validateInteraction(item);
  check(natural(sequence), 'invalid_interaction_sequence');
  check(sameInteractionScope(snapshot.scope, item.scope) && sameInteractionAttempt(snapshot.attempt, item.attempt), 'interaction_binding_mismatch');
  if (sequence <= snapshot.watermark) return snapshot;
  const prior = snapshot.items.find(entry => entry.id === item.id);
  check(!prior || prior.source.id === item.source.id, 'interaction_source_changed');
  if (prior && item.source.revision <= prior.source.revision) {
    check(item.source.revision !== prior.source.revision || stable(prior) === stable(item), 'interaction_revision_conflict');
    return { ...snapshot, watermark: sequence };
  }
  return { ...snapshot, watermark: sequence, items: [...snapshot.items.filter(entry => entry.id !== item.id), structuredClone(item)] };
}
