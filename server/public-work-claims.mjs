import { validId } from '../src/events.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { createWork, claimWork, renewWork, updateWork, releaseExpired } from './work-claims.mjs';
import { withPublicWorkClaimWriter } from './public-work-claim-fence.mjs';
import { ServiceError } from './service-error.mjs';
import { projectPublicWorkReceipt } from './public-read-model.mjs';

export const publicWorkClaimsSchema = `
CREATE TABLE IF NOT EXISTS public_work_tasks (
  offer_id TEXT PRIMARY KEY, namespace_key TEXT NOT NULL, room_id TEXT NOT NULL,
  terms_version INTEGER NOT NULL, repository_url TEXT NOT NULL, repository_ref TEXT NOT NULL,
  files_json TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS public_work_requests (
  offer_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
  input_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
  PRIMARY KEY(offer_id,actor_id,request_id)
);
CREATE TABLE IF NOT EXISTS public_work_receipts (
  receipt_id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, namespace_key TEXT NOT NULL,
  generation INTEGER NOT NULL, identity_id TEXT NOT NULL, artifact_text TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL, artifact_bytes INTEGER NOT NULL,
  receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL
);`;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const check = (condition, message) => { if (!condition) fail(422, 'invalid_public_work', message); };
const identifier = value => validId(value);
const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = sql => sql?.trim().replace(/;$/, '').replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ');
const shape = (input, required, optional = []) => {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && required.every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key => required.includes(key) || optional.includes(key)), 'Unexpected or missing fields');
};
const lease = value => {
  const hours = value === undefined ? 1 : value;
  check(typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= 24, 'Lease must be greater than zero and at most 24 hours');
  return hours;
};
const filesOf = input => {
  check(Array.isArray(input) && input.length > 0 && input.length <= 64, 'Declare 1..64 repository paths');
  const files = input.map(raw => {
    check(typeof raw === 'string', 'Invalid repository path');
    const path = raw.trim().replace(/\/+/g, '/').replace(/^(\.\/)+/, '').replace(/\/$/, '');
    check(path && path.length <= 512 && !path.startsWith('/') && !path.split('/').some(segment => !segment || segment === '..' || segment === '.')
      && !/[\\*\x00-\x1f\x7f]/.test(path), 'Paths must be normalized repository-relative paths');
    return path;
  });
  return [...new Set(files)].sort();
};
const overlaps = (left, right) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');

export class PublicWorkClaims {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const definitions = publicWorkClaimsSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
    const shapes = definitions.map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
    if (allowAbsent && shapes.every(entry => entry.actual === undefined)) return false;
    if (shapes.some(entry => normalize(entry.sql) !== normalize(entry.actual))) throw new Error('Public work claim schema requires operator reconciliation');
    return true;
  }
  available() { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_work_tasks'").get()); }
  task(offerId) {
    check(identifier(offerId), 'Invalid task ID');
    const row = this.available() && this.db.prepare('SELECT * FROM public_work_tasks WHERE offer_id=?').get(offerId);
    if (!row) fail(404, 'public_work_not_found', 'Public task not found');
    return row;
  }
  offer(row) {
    // Recheck publication, archive state and immutable public terms each time.
    const offer = this.store.projectOffers.read(row.offer_id);
    if (offer.version !== row.terms_version || offer.reward.kind !== 'unpaid') fail(409, 'public_work_unavailable', 'Task is no longer available');
    return offer;
  }
  request(row, actorId, action, input, operation) {
    check(identifier(input.requestId), 'Invalid request ID');
    const encoded = canonicalJson({ action, ...input });
    const previous = this.db.prepare('SELECT * FROM public_work_requests WHERE offer_id=? AND actor_id=? AND request_id=?').get(row.offer_id, actorId, input.requestId);
    if (previous) {
      if (previous.input_json !== encoded) fail(409, 'request_id_reused', 'Request ID was already used for different input');
      return JSON.parse(previous.outcome_json);
    }
    const outcome = operation();
    this.db.prepare('INSERT INTO public_work_requests VALUES (?,?,?,?,?)').run(row.offer_id, actorId, input.requestId, encoded, JSON.stringify(outcome));
    return outcome;
  }
  packet(row, item, offer) {
    const live = releaseExpired([item], this.store.now())[0];
    const receipt = this.db.prepare('SELECT receipt_id,identity_id FROM public_work_receipts WHERE offer_id=? AND generation=?').get(row.offer_id, row.generation);
    return { schema: 'public-work-task/1', taskId: row.offer_id, termsVersion: row.terms_version,
      namespaceId: row.namespace_key, repositoryUrl: row.repository_url, repositoryRef: row.repository_ref,
      title: offer.title, acceptanceCriteria: offer.acceptanceCriteria, files: JSON.parse(row.files_json),
      claim: { state: receipt ? 'submitted' : live.owner ? 'claimed' : 'unclaimed', generation: row.generation,
        identityId: receipt?.identity_id ?? live.owner, leaseExpiresAt: receipt ? null : live.leaseExpiresAt, submittedReceiptId: receipt?.receipt_id ?? null } };
  }
  read(offerId) {
    return this.store.readTransaction(() => {
      const row = this.task(offerId), offer = this.offer(row);
      return this.packet(row, this.store.workClaims.get(row.namespace_key, offerId), offer);
    });
  }
  list({ limit = 20, after = '' } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 100 && (after === '' || identifier(after)), 'Invalid page');
    return this.store.readTransaction(() => {
      if (!this.available()) return { tasks: [], nextCursor: null };
      const rows = this.db.prepare(`SELECT t.* FROM public_work_tasks t JOIN project_offers o ON o.offer_id=t.offer_id
        JOIN rooms r ON r.id=t.room_id WHERE t.offer_id>? AND o.status='published' AND r.archived_at IS NULL
        AND o.version=t.terms_version AND json_extract(o.terms,'$.reward.kind')='unpaid' ORDER BY t.offer_id LIMIT ?`).all(after, limit + 1);
      return { tasks: rows.slice(0, limit).map(row => this.packet(row, this.store.workClaims.get(row.namespace_key, row.offer_id), this.offer(row))),
        nextCursor: rows.length > limit ? rows[limit - 1].offer_id : null };
    });
  }
  enable(roomId, actorId, offerId, input) {
    shape(input, ['requestId', 'expectedRevision', 'expectedTermsVersion', 'repositoryRef', 'files']);
    check(identifier(offerId) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0
      && Number.isSafeInteger(input.expectedTermsVersion) && input.expectedTermsVersion > 0, 'Expected offer revision and terms version required');
    check(typeof input.repositoryRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(input.repositoryRef)
      && !input.repositoryRef.split('/').some(part => !part || part === '..' || part === '.'), 'Explicit repository ref required');
    const files = filesOf(input.files);
    return withPublicWorkClaimWriter(this.store, () => {
      this.store.projectOffers.requireOwner(roomId, actorId);
      const reference = { offer_id: offerId };
      return this.request(reference, `owner:${roomId}:${actorId}`, 'enable', input, () => {
        const row = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?').get(offerId, roomId);
        if (!row) fail(404, 'offer_not_found', 'Offer not found');
        if (row.revision !== input.expectedRevision || row.version !== input.expectedTermsVersion) fail(409, 'stale_offer', 'Offer changed; read it again');
        const offer = this.store.projectOffers.read(offerId);
        if (offer.reward.kind !== 'unpaid' || !offer.repositoryUrl) fail(422, 'public_work_not_eligible', 'Public claims currently require an unpaid offer with a repository URL');
        if (this.db.prepare('SELECT 1 FROM public_work_tasks WHERE offer_id=?').get(offerId)) fail(409, 'public_work_already_enabled', 'Public claims already enabled');
        const url = new URL(offer.repositoryUrl); url.pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
        if (url.hostname === 'github.com') url.pathname = url.pathname.toLowerCase();
        const namespace = 'public_' + hash(roomId + '\n' + url.href + '\n' + input.repositoryRef);
        this.db.prepare('INSERT INTO public_work_tasks VALUES (?,?,?,?,?,?,?,?,?)').run(offerId, namespace, roomId, offer.version, url.href, input.repositoryRef, JSON.stringify(files), 0, this.store.now());
        // Kernel done means submitted delivery here, never independent acceptance.
        const item = createWork({ id: offerId, title: offer.title, files, reviewPolicy: 'self_attested' }, { now: this.store.now() });
        this.store.workClaims.set(namespace, item);
        return this.packet(this.task(offerId), item, offer);
      });
    });
  }
  act(offerId, secret, action, input) {
    const required = ['requestId', 'expectedTermsVersion'];
    if (action !== 'claim') required.push('generation');
    if (action === 'finish') required.push('artifactText', 'checksReported');
    check(['claim', 'renew', 'release', 'finish'].includes(action), 'Unknown action');
    shape(input, required, ['claim', 'renew'].includes(action) ? ['leaseHours'] : []);
    check(Number.isSafeInteger(input.expectedTermsVersion) && input.expectedTermsVersion > 0
      && (action === 'claim' || Number.isSafeInteger(input.generation) && input.generation > 0), 'Expected terms version and claim generation required');
    if (['claim', 'renew'].includes(action)) lease(input.leaseHours);
    return withPublicWorkClaimWriter(this.store, () => {
      const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
      if (!identity) fail(401, 'unauthenticated', 'Unknown or revoked identity');
      return this.apply(offerId, identity, action, input);
    });
  }
  // Both direct commands and matchmaking share the same serialized claim path.
  apply(offerId, identity, action, input, journal = true) {
    const row = this.task(offerId);
      const operation = () => {
        if (input.expectedTermsVersion !== row.terms_version) fail(409, 'stale_public_work', 'Task terms changed');
        if (this.db.prepare('SELECT 1 FROM public_work_receipts WHERE offer_id=? AND generation=?').get(offerId, row.generation))
          fail(409, 'public_work_already_submitted', 'This task already has a submitted receipt');
        const offer = action === 'release' ? this.store.projectOffers.record(this.db.prepare('SELECT * FROM project_offers WHERE offer_id=?').get(offerId)) : this.offer(row);
        // Sweep the whole shared repository/ref namespace before collision checks.
        for (const item of releaseExpired(this.store.workClaims.list(row.namespace_key), this.store.now())) this.store.workClaims.set(row.namespace_key, item);
        let item = this.store.workClaims.get(row.namespace_key, offerId);
        if (action === 'claim') {
          if (item.state !== 'unclaimed') fail(409, 'public_work_claim_conflict', 'Task already claimed');
          const files = JSON.parse(row.files_json);
          for (const other of this.store.workClaims.list(row.namespace_key)) {
            if (other.id !== offerId && other.owner && other.files.some(path => files.some(file => overlaps(path, file))))
              fail(409, 'public_work_path_conflict', 'Another live claim holds these repository paths');
          }
          item = claimWork(item, identity.identityId, { files, leaseHours: lease(input.leaseHours), now: this.store.now() });
          item = updateWork(item, identity.identityId, { state: 'in_progress', now: this.store.now() });
          this.db.prepare('UPDATE public_work_tasks SET generation=generation+1 WHERE offer_id=?').run(offerId);
          row.generation += 1;
        } else {
          if (row.generation !== input.generation || !item.owner) fail(409, 'stale_public_claim', 'Claim generation expired or changed');
          if (item.owner !== identity.identityId) fail(403, 'public_work_not_owner', 'Only the claimant may change this lease');
          if (action === 'renew') item = renewWork(item, identity.identityId, { leaseHours: lease(input.leaseHours), now: this.store.now() });
          if (action === 'release') {
            item = updateWork(item, identity.identityId, { state: 'claimed', now: this.store.now() });
            item = updateWork(item, identity.identityId, { state: 'unclaimed', now: this.store.now() });
          }
        }
        this.store.workClaims.set(row.namespace_key, item);
        const outcome = { action: { claim: 'claimed', renew: 'renewed', release: 'released', finish: 'submitted' }[action], task: this.packet(row, item, offer) };
        if (action === 'finish') {
          check(typeof input.artifactText === 'string' && Buffer.byteLength(input.artifactText, 'utf8') <= 65536
            && Buffer.from(input.artifactText, 'utf8').toString('utf8') === input.artifactText, 'Artifact must be valid UTF-8 text no larger than 64 KiB');
          check(Array.isArray(input.checksReported) && input.checksReported.length <= 20 && input.checksReported.every(text => typeof text === 'string' && text.length > 0 && text.length <= 1000), 'Invalid caller-reported checks');
          const sha256 = hash(input.artifactText), bytes = Buffer.byteLength(input.artifactText, 'utf8');
          const receiptId = 'pwr_' + hash(canonicalJson({ offerId, identityId: identity.identityId, generation: row.generation, sha256, checksReported: input.checksReported }));
          const receipt = { schema: 'public-work-receipt/1', receiptId, taskId: offerId, termsVersion: row.terms_version,
            namespaceId: row.namespace_key, generation: row.generation, identityId: identity.identityId, state: 'submitted',
            artifact: { sha256, bytes }, checksReported: input.checksReported, verification: 'hash_only', createdAt: new Date(this.store.now()).toISOString() };
          this.db.prepare('INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)').run(receiptId, offerId, row.namespace_key, row.generation, identity.identityId, input.artifactText, sha256, bytes, JSON.stringify(receipt), this.store.now());
          projectPublicWorkReceipt(this.store, receipt, sha256);
          item = updateWork({ ...item, files: [] }, identity.identityId, { state: 'done', deliveryMode: 'result', blobs: ['sha256:' + sha256], now: this.store.now() });
          this.store.workClaims.set(row.namespace_key, item);
          outcome.receipt = receipt;
          outcome.task = this.packet(row, item, offer);
        }
        return outcome;
      };
      return journal ? this.request(row, identity.identityId, action, input, operation) : operation();
  }
  match(secret, input) {
    shape(input, [], ['requestId', 'skills', 'interests', 'reward', 'autoClaim', 'limit', 'leaseHours', 'after']);
    if (input.requestId !== undefined) check(identifier(input.requestId), 'Invalid request ID');
    const limit = input.limit ?? 3, reward = input.reward ?? 'volunteer';
    check(Number.isInteger(limit) && limit >= 1 && limit <= 5 && ['volunteer', 'work_trade', 'cash'].includes(reward), 'Invalid matching preferences');
    check(input.autoClaim === undefined || typeof input.autoClaim === 'boolean', 'autoClaim must be explicit boolean');
    const preferences = ['skills', 'interests'].flatMap(key => {
      const values = input[key] ?? [];
      check(Array.isArray(values) && values.length <= 20 && values.every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value)), 'Invalid matching preferences');
      return values.map(value => value.trim().toLowerCase());
    });
    check(input.after === undefined || identifier(input.after), 'Invalid matching cursor');
    lease(input.leaseHours);
    const run = operation => input.autoClaim === true ? withPublicWorkClaimWriter(this.store, operation) : this.store.readTransaction(operation);
    return run(() => {
      const identity = secret ? this.store.identities.resolveGlobalIdentitySecret(secret) : null;
      if ((secret || input.autoClaim === true) && !identity) fail(401, 'unauthenticated', 'Unknown or revoked identity');
      const recommend = () => {
        const outcome = { recommendations: [], claim: null, inspected: 0, hasMore: false, nextCursor: null, supportedRewards: ['volunteer'] };
        if (reward !== 'volunteer') return outcome;
        const page = this.list({ limit: 100, after: input.after ?? '' });
        outcome.inspected = page.tasks.length; outcome.hasMore = page.nextCursor !== null; outcome.nextCursor = page.nextCursor;
        const ages = new Map(page.tasks.length ? this.db.prepare(`SELECT offer_id,created_at FROM public_work_tasks WHERE offer_id IN (${page.tasks.map(() => '?').join(',')})`).all(...page.tasks.map(task => task.taskId)).map(row => [row.offer_id, row.created_at]) : []);
        const candidates = page.tasks.filter(task => {
          if (task.claim.state !== 'unclaimed') return false;
          return !releaseExpired(this.store.workClaims.list(task.namespaceId), this.store.now()).some(other =>
            other.id !== task.taskId && other.owner && other.files.some(path => task.files.some(file => overlaps(path, file))));
        }).map(task => {
          const text = [task.title, ...task.acceptanceCriteria].join(' ').toLowerCase();
          const matched = [...new Set(preferences.filter(value => text.includes(value)))];
          return { task, score: matched.length, reasons: matched.length ? matched.map(value => 'Matches preference: ' + value) : ['Available volunteer task with declared repository paths'] };
        }).sort((left, right) => right.score - left.score || ages.get(left.task.taskId) - ages.get(right.task.taskId) || (left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0));
        outcome.recommendations = candidates.slice(0, limit).map(({ task, reasons }) => ({ task, reasons }));
        if (input.autoClaim === true && candidates.length) {
          const selected = candidates[0].task;
          const claimInput = { expectedTermsVersion: selected.termsVersion };
          // The outer @match journal owns this choice; direct-command keys cannot alias it.
          if (input.leaseHours !== undefined) claimInput.leaseHours = input.leaseHours;
          outcome.claim = this.apply(selected.taskId, identity, 'claim', claimInput, false);
          outcome.recommendations = [{ task: outcome.claim.task, reasons: candidates[0].reasons }, ...candidates.slice(1).filter(candidate =>
            candidate.task.namespaceId !== selected.namespaceId || !candidate.task.files.some(path => selected.files.some(file => overlaps(path, file))))
            .slice(0, limit - 1).map(({ task, reasons }) => ({ task, reasons }))];
        }
        return outcome;
      };
      return input.autoClaim === true ? this.request({ offer_id: '@match' }, identity.identityId, 'match', input, recommend) : recommend();
    });
  }

  receipt(receiptId) {
    check(identifier(receiptId), 'Invalid receipt ID');
    const row = this.available() && this.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receiptId);
    if (!row) fail(404, 'public_receipt_not_found', 'Public receipt not found');
    return JSON.parse(row.receipt_json);
  }
  artifact(receiptId) {
    this.receipt(receiptId);
    const row = this.db.prepare('SELECT artifact_text,artifact_sha256,artifact_bytes FROM public_work_receipts WHERE receipt_id=?').get(receiptId);
    return { artifactText: row.artifact_text, sha256: row.artifact_sha256, bytes: row.artifact_bytes };
  }
}
