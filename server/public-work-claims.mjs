import { validId } from '../src/events.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { createWork, claimWork, renewWork, updateWork, releaseExpired } from './work-claims.mjs';
import { withPublicWorkClaimWriter } from './public-work-claim-fence.mjs';
import { ServiceError } from './service-error.mjs';
import { projectPublicWorkReceipt } from './public-read-model.mjs';
import { isUnpublished } from './legal-store.mjs'; // operator unpublish hides a room or receipt from every public read

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
  // Name the real fault: a string like "6h" is a type error, not a range one (#1553).
  check(typeof hours === 'number' && Number.isFinite(hours), `leaseHours must be a JSON number of hours, like 6, not ${JSON.stringify(hours)}`);
  check(hours > 0 && hours <= 24, 'leaseHours must be greater than zero and at most 24');
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

// #3530: the standard public-work starter set — the newcomer tasks an
// operator first seeded on the public board (the pw-garden round of
// 2026-10-05). An enabled public task is one-shot: once it carries a
// submitted receipt it never becomes claimable again, and the only
// follow-on paths (a fresh owner offer, the review successor flow) are
// manual. The seed pool was therefore consumed exactly once and the
// anonymous front door llms.txt routes new agents to dead-ended at
// claimableCount 0. reseedStarterPool() below is the replenishment: it
// clones the next round of each seed from that seed's own latest round —
// same room, owner, terms, repository and files — so what comes back is
// exactly what the operator originally published; only the offer id
// advances (<base>-r2, -r3, ...). Anchored by design: a store where the
// operator never published a seed grows nothing here, and the
// seed-dc-* tasks are deliberately absent — they belong to another
// product's repository pinned at a historical commit, so re-issuing
// them from this codebase would mint stale work, not starter work.
export const PUBLIC_WORK_STARTER_SEED_IDS = Object.freeze([
  'pw-garden-firsttask-probe-20261005',
  'pw-garden-glossary-20261005',
  'pw-garden-linkcheck-20261005',
  'pw-garden-mcp-paths-20261005',
]);
// Round 1 is the operator's original offer id; later rounds append -rN.
export const starterRoundOf = (offerId, baseId) => {
  if (offerId === baseId) return 1;
  if (!offerId.startsWith(baseId + '-r')) return 0;
  const suffix = offerId.slice(baseId.length + 2);
  return /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : 0;
};
export const starterRoundId = (baseId, round) => (round === 1 ? baseId : `${baseId}-r${round}`);

export const PUBLIC_WORK_IDENTITY_RATE_LIMIT = 60;
export const PUBLIC_WORK_IDENTITY_RATE_WINDOW_MS = 60000;
// At most this many distinct identity buckets stay live, matching the bound
// server/http.mjs sets for each of its rate families: a flood of foreign
// identities evicts the least recently touched bucket instead of growing
// memory or refusing every new identity.
const PUBLIC_WORK_IDENTITY_RATE_KEYS = 2000;

export class PublicWorkClaims {
  constructor(store) { this.store = store; this.db = store.db; this.identityRateBuckets = new Map(); }
  // The one per-identity public-work claim ceiling (#3271): the bucket
  // lives here so every door counts against the same state, and the doors
  // invoke it — the REST act route and the MCP public-work handler before
  // delegating to act(), and match() at its claim site when autoClaim
  // actually claims. act()/apply() deliberately do not enforce: they are
  // also the in-process domain entry (state seeding, keeper flows), which
  // is not a network door and must be able to represent boards whose
  // claims accumulated over time rather than within one window. Semantics mirror the fixed-window bucket the
  // direct REST door used in server/http.mjs (60 per minute, same
  // rate_limited shape and X-RateLimit-* headers): every authenticated
  // attempt counts, including attempts that go on to fail downstream and
  // journal replays, exactly as the REST door counted them before its
  // transport-level bucket was folded into this one.
  enforceIdentityRateLimit(identityId) {
    const now = this.store.now();
    for (const [key, entry] of this.identityRateBuckets) if (entry.until <= now) this.identityRateBuckets.delete(key);
    let entry = this.identityRateBuckets.get(identityId);
    if (entry) this.identityRateBuckets.delete(identityId);
    else {
      if (this.identityRateBuckets.size >= PUBLIC_WORK_IDENTITY_RATE_KEYS)
        this.identityRateBuckets.delete(this.identityRateBuckets.keys().next().value);
      entry = { n: 0, until: now + PUBLIC_WORK_IDENTITY_RATE_WINDOW_MS };
    }
    entry.n++;
    this.identityRateBuckets.set(identityId, entry);
    if (entry.n > PUBLIC_WORK_IDENTITY_RATE_LIMIT) throw new ServiceError(429, 'rate_limited', 'Too many requests; retry after a minute',
      { 'X-RateLimit-Limit': PUBLIC_WORK_IDENTITY_RATE_LIMIT, 'X-RateLimit-Remaining': 0, 'X-RateLimit-Reset': Math.ceil(entry.until / 1000), 'X-RateLimit-Bucket': 'public-work-identity' });
  }
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
    const state = receipt ? 'submitted' : live.owner ? 'claimed' : 'unclaimed';
    return { schema: 'public-work-task/1', taskId: row.offer_id, termsVersion: row.terms_version,
      namespaceId: row.namespace_key, repositoryUrl: row.repository_url, repositoryRef: row.repository_ref,
      title: offer.title, acceptanceCriteria: offer.acceptanceCriteria, files: JSON.parse(row.files_json),
      claimable: state === 'unclaimed',
      claim: { state, generation: row.generation,
        identityId: receipt?.identity_id ?? live.owner, leaseExpiresAt: receipt ? null : live.leaseExpiresAt, submittedReceiptId: receipt?.receipt_id ?? null } };
  }
  read(offerId) {
    return this.store.readTransaction(() => {
      const row = this.task(offerId);
      // Operator unpublish hides the task (and its submittedReceiptId) here too.
      if (isUnpublished(this.db, 'room', row.room_id)) fail(404, 'public_work_not_found', 'Public task not found');
      const offer = this.offer(row);
      return this.packet(row, this.store.workClaims.get(row.namespace_key, offerId), offer);
    });
  }
  // claimableFirst defaults to claimable-first for browse callers (#2988).
  // match() opts out: its `after` cursor is an offer_id-order scan position
  // with its own documented continuation semantics, so it passes
  // claimableFirst: false and keeps scanning in offer_id order.
  list({ limit = 20, after = '', claimable = false, claimableFirst = true } = {}) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 100 && (after === '' || identifier(after)), 'Invalid page');
    check(typeof claimable === 'boolean' && typeof claimableFirst === 'boolean', 'Invalid page');
    return this.store.readTransaction(() => {
      if (!this.available()) return { tasks: [], claimableCount: 0, nextCursor: null };
      const rows = this.db.prepare(`SELECT t.* FROM public_work_tasks t JOIN project_offers o ON o.offer_id=t.offer_id
        JOIN rooms r ON r.id=t.room_id WHERE o.status='published' AND r.archived_at IS NULL
        AND o.version=t.terms_version AND json_extract(o.terms,'$.reward.kind')='unpaid' ORDER BY t.offer_id`).all();
      // Claim state lives in the work-claims store and receipts, not in a
      // column SQL can order by, so packets are materialized before ordering.
      // Operator-unpublished rooms are dropped before materializing: their
      // packets (including submittedReceiptId) must never be built or served.
      let tasks = rows.filter(row => !isUnpublished(this.db, 'room', row.room_id))
        .map(row => this.packet(row, this.store.workClaims.get(row.namespace_key, row.offer_id), this.offer(row)));
      const claimableCount = tasks.filter(task => task.claimable).length;
      if (claimable) tasks = tasks.filter(task => task.claimable);
      if (claimableFirst) {
        // Stable claimable-first order; rows arrive in offer_id order, which
        // is the deterministic tiebreak inside each claimability group.
        tasks = [...tasks.filter(task => task.claimable), ...tasks.filter(task => !task.claimable)];
      }
      // The cursor is the last returned task's offer_id; resuming finds that
      // id in the (recomputed) ordering, so a page walk over a stable set
      // visits each task exactly once, claimable tasks first. An unknown
      // cursor falls back to the old offer_id boundary.
      let start = 0;
      if (after !== '') {
        const index = tasks.findIndex(task => task.taskId === after);
        if (index >= 0) start = index + 1;
        else {
          const fallback = tasks.findIndex(task => task.taskId > after);
          start = fallback < 0 ? tasks.length : fallback;
        }
      }
      const page = tasks.slice(start, start + limit);
      return { tasks: page, claimableCount,
        nextCursor: start + limit < tasks.length ? page.at(-1).taskId : null };
    });
  }
  // #3530 keeper surface: the starter pool's state in the same terms the
  // public board serves. `due` lists the anchored seeds whose latest
  // round is fully submitted — the only seeds a reseed may advance.
  starterPoolStatus() {
    if (!this.available()) return { available: false, anchored: 0, claimable: 0, due: [] };
    const claimable = this.list({ limit: 100 }).claimableCount;
    const due = [];
    let anchored = 0;
    for (const baseId of PUBLIC_WORK_STARTER_SEED_IDS) {
      const family = this._starterFamily(baseId);
      if (!family.length) continue;
      anchored++;
      if (this._starterTaskState(family.at(-1).row) === 'submitted') due.push(baseId);
    }
    return { available: true, anchored, claimable, due };
  }
  _starterFamily(baseId) {
    const rows = this.db.prepare('SELECT * FROM public_work_tasks WHERE offer_id=? OR offer_id LIKE ?').all(baseId, `${baseId}-r%`);
    return rows.map(row => ({ row, round: starterRoundOf(row.offer_id, baseId) }))
      .filter(entry => entry.round > 0).sort((left, right) => left.round - right.round);
  }
  // packet()'s state derivation without the packet: a receipt at the
  // current generation is terminal, a live lease is claimed, else open.
  _starterTaskState(row) {
    if (this.db.prepare('SELECT 1 FROM public_work_receipts WHERE offer_id=? AND generation=?').get(row.offer_id, row.generation)) return 'submitted';
    const item = this.store.workClaims.get(row.namespace_key, row.offer_id);
    const live = item ? releaseExpired([item], this.store.now())[0] : null;
    return live?.owner ? 'claimed' : 'unclaimed';
  }
  // Replenish the starter set, bounded so it cannot spam: it fires only
  // when the board's public claimableCount is exactly zero, it mints at
  // most one new round per anchored seed, and only for a seed whose
  // latest round is submitted (a live claimed round blocks its own seed
  // alone). The create/publish/enable request ids are derived from the
  // round, so a repeated or interrupted tick replays the journals and
  // converges on the same offers instead of duplicating them.
  reseedStarterPool() {
    if (!this.available()) return { seeded: 0, claimable: 0, rounds: [], skipped: [], errors: [] };
    return this.store.transaction(() => {
      const { claimableCount } = this.list({ limit: 100 });
      const summary = { seeded: 0, claimable: claimableCount, rounds: [], skipped: [], errors: [] };
      if (claimableCount > 0) return summary;
      for (const baseId of PUBLIC_WORK_STARTER_SEED_IDS) {
        try {
          const outcome = this._reseedStarter(baseId);
          if (outcome.seeded) { summary.seeded++; summary.rounds.push(outcome.offerId); }
          else summary.skipped.push({ seed: baseId, reason: outcome.reason });
        } catch (error) {
          summary.errors.push({ seed: baseId, code: error?.code ?? 'error', message: String(error?.message ?? error).slice(0, 200) });
        }
      }
      return summary;
    });
  }
  _reseedStarter(baseId) {
    const family = this._starterFamily(baseId);
    if (!family.length) return { seeded: false, reason: 'not_anchored' };
    const latest = family.at(-1), { row } = latest;
    const state = this._starterTaskState(row);
    if (state !== 'submitted') return { seeded: false, reason: `latest_round_${state}` };
    const offerRow = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=?').get(row.offer_id);
    // The anchor offer must still be exactly the offer the latest round
    // was enabled against; an operator who withdrew or revised it has
    // retired the seed, and the keeper must not resurrect it.
    if (!offerRow || offerRow.status !== 'published' || offerRow.version !== row.terms_version)
      return { seeded: false, reason: 'anchor_offer_changed' };
    if (isUnpublished(this.db, 'room', row.room_id)) return { seeded: false, reason: 'room_unpublished' };
    const { state: roomState } = this.store.room(row.room_id);
    if (roomState.room.archivedAt) return { seeded: false, reason: 'room_archived' };
    const ownerId = roomState.room.ownerId;
    const source = this.store.projectOffers.record(offerRow, true);
    const terms = { kind: source.kind, title: source.title, summary: source.summary,
      acceptanceCriteria: source.acceptanceCriteria, exclusions: source.exclusions ?? [],
      reward: source.reward, approvalPolicy: source.approvalPolicy };
    for (const field of ['repositoryUrl', 'submissionUrl', 'deadline']) if (source[field] != null) terms[field] = source[field];
    const round = latest.round + 1, offerId = starterRoundId(baseId, round), stamp = `reseed-${baseId}-r${round}`;
    const created = this.store.projectOffers.create(row.room_id, ownerId,
      { requestId: `${stamp}-create`, offerId, terms, reviewerMemberIds: source.reviewerMemberIds });
    const published = this.store.projectOffers.transition(row.room_id, ownerId, offerId, 'publish',
      { requestId: `${stamp}-publish`, expectedRevision: created.revision });
    this.enable(row.room_id, ownerId, offerId, { requestId: `${stamp}-enable`, expectedRevision: published.revision,
      expectedTermsVersion: published.version, repositoryRef: row.repository_ref, files: JSON.parse(row.files_json) });
    return { seeded: true, offerId, round };
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
          if (item.state !== 'unclaimed') {
            // G4: name the holder and the lease expiry — a bare
            // "Task already claimed" teaches the raced agent nothing actionable.
            const holder = item.owner === identity.identityId ? 'you' : (item.owner ?? 'another agent');
            fail(409, 'public_work_claim_conflict', `Task already claimed by ${holder} (lease expires ${item.leaseExpiresAt ?? 'unknown'})`);
          }
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
          if (row.generation !== input.generation || !item.owner) {
            // G5: say which — the generation changed, or the claim expired —
            // so the agent knows the recovery. The rejected artifact bytes are
            // never persisted: the generation check runs before the receipt
            // write and before the request journal, so the agent must keep
            // them and re-submit after re-reading and re-claiming.
            if (row.generation !== input.generation)
              fail(409, 'stale_public_claim', `Claim generation changed (submitted ${input.generation}, current ${row.generation})`);
            fail(409, 'stale_public_claim', `Claim expired: the lease lapsed or the claim was released (generation ${input.generation} is no longer held)`);
          }
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
          const receipt = { schema: 'public-work-receipt/1', receiptId, taskId: offerId, title: offer.title, termsVersion: row.terms_version,
            namespaceId: row.namespace_key, generation: row.generation, identityId: identity.identityId, agentName: identity.displayName, state: 'submitted',
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
      // match with autoClaim is a claim door (#3271): when it actually
      // claims, the claim counts against the same per-identity ceiling as a
      // direct claim. The count is taken at the claim site below, not here:
      // a search that matches nothing claimable performs no claim and must
      // not burn ceiling (the recommendation page's empty-result recovery
      // searches would otherwise lock the identity out for retrying). A
      // plain recommendation (autoClaim not set, including MCP
      // public_work_recommend) claims nothing and is never counted.
      const recommend = () => {
        const outcome = { recommendations: [], claim: null, inspected: 0, hasMore: false, nextCursor: null, supportedRewards: ['volunteer'] };
        if (reward !== 'volunteer') return outcome;
        const page = this.list({ limit: 100, after: input.after ?? '', claimableFirst: false });
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
        // Machine-readable complement to a bare empty list (#2988): tasks
        // were inspected but none of them is claimable. Deliberately named
        // reasonCode, not reason/guidance — those are human-readable fields
        // used by other (stale) proposals for this same outcome object.
        if (!candidates.length && outcome.inspected > 0 && page.tasks.every(task => !task.claimable)) outcome.reasonCode = 'no_claimable_tasks';
        if (input.autoClaim === true && candidates.length) {
          // #3271: an auto-claim is a claim — count it against the ceiling
          // here, where a claim actually happens (see the note above).
          this.enforceIdentityRateLimit(identity.identityId);
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

  receiptRoomId(receiptId) {
    return this._receiptRow(receiptId).roomId;
  }
  // Owner-only public-receipts toggle: a room that turned receipts private
  // still serves them to its members; everyone else gets 403. Rows without
  // a task link (legacy) stay public, preserving current behavior.
  _receiptRow(receiptId) {
    check(identifier(receiptId), 'Invalid receipt ID');
    const row = this.available() && this.db.prepare(
      `SELECT r.receipt_json AS receiptJson, t.room_id AS roomId
       FROM public_work_receipts r LEFT JOIN public_work_tasks t ON t.offer_id = r.offer_id
       WHERE r.receipt_id = ?`).get(receiptId);
    if (!row) fail(404, 'public_receipt_not_found', 'Public receipt not found');
    // Operator unpublish overrides owner sharing on this public door, for the
    // receipt itself and for its room — same predicate as public-read-model.
    if (isUnpublished(this.db, 'receipt', receiptId)
      || (row.roomId && isUnpublished(this.db, 'room', row.roomId))) {
      fail(404, 'public_receipt_not_found', 'Public receipt not found');
    }
    return { receiptJson: row.receiptJson, roomId: row.roomId ?? null };
  }
  _requireReceiptVisible(roomId, memberId) {
    if (this.store.roomDirectory.publicReceiptsVisible(roomId)) return;
    if (typeof memberId === "string" && memberId) {
      const members = this.store.roomAuthority(roomId)?.members ?? {};
      const member = members[memberId];
      if (member && member.active !== false) return;
    }
    fail(403, 'receipts_private', 'This room keeps its work receipts private');
  }
  receipt(receiptId, viewer = {}) {
    const row = this._receiptRow(receiptId);
    this._requireReceiptVisible(row.roomId, viewer.memberId);
    return JSON.parse(row.receiptJson);
  }
  artifact(receiptId, viewer = {}) {
    const row = this._receiptRow(receiptId);
    this._requireReceiptVisible(row.roomId, viewer.memberId);
    const detail = this.db.prepare('SELECT artifact_text,artifact_sha256,artifact_bytes FROM public_work_receipts WHERE receipt_id=?').get(receiptId);
    return { artifactText: detail.artifact_text, sha256: detail.artifact_sha256, bytes: detail.artifact_bytes };
  }
}
