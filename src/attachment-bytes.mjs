/**
 * attachment-bytes.mjs — Pure fetch-job pipeline planner for message attachments.
 *
 * Plans and tracks byte-fetch jobs for message attachments. Nothing here
 * touches the network, the DOM, localStorage, or any secret — it is a pure
 * state machine. The actual bytes are fetched through an injected `fetcher`
 * dependency supplied by the production wiring (which owns the Gmail API
 * credentials, the HTTP client, and the retry policy).
 *
 * States:
 *   queued → fetching → fetched
 *   Side states: failed, cancelled, expired
 *
 * Dependency injection (all via the `deps` parameter of createAttachmentBytes):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - id:             () => string  (job id generator; default: per-pipeline counter)
 *   - fetcher:        async (job, hooks) => { bytes } — injected byte source.
 *                     `job` is the job record {messageId, attachmentId,
 *                     filename, mimeType, declaredSize}; `hooks` carries
 *                     {reportProgress(bytesSoFar)} so the fetcher can stream
 *                     progress. Must resolve to { bytes } where bytes is a
 *                     Uint8Array (or string, coerced). Must THROW on failure; a
 *                     thrown error with `transient === true` is retried once.
 *   - maxBytes:       number        (hard byte cap; default: 25 MiB)
 *   - hasher:         (bytes) => string — content-addressed result handle;
 *                     default: FNV-1a hex (see note below)
 *   - onProgress:     (jobId, bytesSoFar) => void — progress sink
 *   - mimeAllowlist:  string[] | null — if set, mimeType MUST be listed
 *   - mimeBlocklist:  string[]      — defaults to common executables
 *   - stallTimeoutMs: number        — `fetching` jobs with no progress for
 *                     this long are swept to `expired`; default: 5 minutes
 *
 * The injected `hasher` is the content-addressed identity of the fetched
 * bytes, so production wiring MUST inject a cryptographic hash (e.g. sha256
 * hex). The default FNV-1a is deterministic but NOT collision-resistant; it
 * exists only so the pipeline is usable/testable without any dependency.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   AB_NOT_FOUND          — unknown job id
 *   AB_INVALID_JOB        — enqueue missing required fields (messageId/attachmentId)
 *   AB_INVALID_TRANSITION — operation not allowed from the current state
 *   AB_TOO_LARGE          — declaredSize > maxBytes at enqueue, or actual
 *                           fetched bytes > maxBytes at completion
 *   AB_MIME_REJECTED      — mimeType on the blocklist, or not on the allowlist
 *   AB_FETCH_FAILED       — injected fetcher threw (after the single retry)
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'queued',
  'fetching',
  'fetched',
  'failed',
  'cancelled',
  'expired',
]);

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default executable blocklist (lowercased mime types). */
export const DEFAULT_MIME_BLOCKLIST = Object.freeze([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-msdos-program',
  'application/x-winexe',
  'application/x-executable',
  'application/x-sh',
  'application/x-bat',
  'application/x-msi',
  'application/x-com',
  'text/x-shellscript',
]);

const TERMINAL_STATES = new Set(['fetched', 'failed', 'cancelled', 'expired']);

/** Throw a coded pipeline error (never silent failures). */
function abError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Default content handle: FNV-1a (32-bit), hex, over raw bytes.
 * Deterministic, non-crypto — inject sha256 in production.
 */
function fnv1aBytesHex(input) {
  const bytes =
    typeof input === 'string'
      ? Buffer.from(input, 'utf8')
      : input instanceof Uint8Array
        ? input
        : null;
  if (!bytes) {
    throw abError(
      'AB_FETCH_FAILED',
      'Hasher received bytes it cannot read (expected Uint8Array or string)',
    );
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Normalize fetched bytes to a Uint8Array; throw AB_FETCH_FAILED otherwise. */
function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  throw abError(
    'AB_FETCH_FAILED',
    'Fetcher resolved without usable bytes (expected { bytes: Uint8Array|string })',
  );
}

/**
 * Create a new attachment byte-fetch pipeline.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(job: object, hooks: object) => Promise<{bytes: Uint8Array|string}>} [deps.fetcher]
 * @param {number} [deps.maxBytes]
 * @param {(bytes: Uint8Array|string) => string} [deps.hasher]
 * @param {(jobId: string, bytesSoFar: number) => void} [deps.onProgress]
 * @param {string[] | null} [deps.mimeAllowlist]
 * @param {string[]} [deps.mimeBlocklist]
 * @param {number} [deps.stallTimeoutMs]
 */
export function createAttachmentBytes(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const hasher = deps.hasher ?? fnv1aBytesHex;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const onProgress = deps.onProgress ?? (() => {});
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const mimeAllowlist =
    deps.mimeAllowlist == null
      ? null
      : deps.mimeAllowlist.map((m) => String(m).toLowerCase());
  const mimeBlocklist = new Set(
    (deps.mimeBlocklist ?? DEFAULT_MIME_BLOCKLIST).map((m) => String(m).toLowerCase()),
  );
  const fetcher = deps.fetcher;

  let idCounter = 0;
  const newId = deps.id ?? (() => `abjob-${(idCounter += 1)}`);

  /** Internal job records, keyed by id. */
  const jobs = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  function record({ at, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function getJobOrThrow(id) {
    const job = jobs.get(id);
    if (!job) {
      throw abError('AB_NOT_FOUND', `Unknown attachment job id: ${id}`, { jobId: id });
    }
    return job;
  }

  function checkMime(mimeType) {
    const mime = String(mimeType ?? '').toLowerCase();
    if (mimeBlocklist.has(mime)) {
      throw abError(
        'AB_MIME_REJECTED',
        `Refusing to fetch blocked mime type: ${mime || '(missing)'}`,
        { mimeType: mime },
      );
    }
    if (mimeAllowlist !== null && !mimeAllowlist.includes(mime)) {
      throw abError(
        'AB_MIME_REJECTED',
        `Refusing to fetch mime type not on the allowlist: ${mime || '(missing)'}`,
        { mimeType: mime },
      );
    }
  }

  function snapshot(job) {
    return Object.freeze({
      id: job.id,
      state: job.state,
      messageId: job.messageId,
      attachmentId: job.attachmentId,
      filename: job.filename,
      mimeType: job.mimeType,
      declaredSize: job.declaredSize,
      queuedAt: job.queuedAt,
      fetchStartedAt: job.fetchStartedAt,
      attempts: job.attempts,
      bytesSoFar: job.bytesSoFar,
      byteLength: job.byteLength,
      handle: job.handle,
      failCode: job.failCode,
      failReason: job.failReason,
      cancelledAt: job.cancelledAt,
      expiredAt: job.expiredAt,
    });
  }

  function transition(job, to, actor, detail) {
    const from = job.state;
    job.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { jobId: job.id, ...(detail ?? {}) },
    });
    return snapshot(job);
  }

  function assertState(job, allowed, op) {
    if (!allowed.includes(job.state)) {
      throw abError(
        'AB_INVALID_TRANSITION',
        `Cannot ${op} attachment job ${job.id} from state '${job.state}'`,
        { jobId: job.id, state: job.state, op },
      );
    }
  }

  /** True when a `fetching` job has had no progress inside stallTimeoutMs. */
  function isStalled(job) {
    return (
      job.state === 'fetching' &&
      job.lastProgressAt != null &&
      clock() - job.lastProgressAt > stallTimeoutMs
    );
  }

  const pipeline = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get maxBytes() {
      return maxBytes;
    },

    get stallTimeoutMs() {
      return stallTimeoutMs;
    },

    /**
     * Enqueue a fetch job. Validates required fields, the mime allow/block
     * lists, and the declaredSize against maxBytes — all BEFORE the job exists,
     * so a rejected enqueue throws and records nothing.
     */
    enqueue(spec, actor = 'agent') {
      if (!spec?.messageId || !spec?.attachmentId) {
        throw abError(
          'AB_INVALID_JOB',
          'enqueue requires spec.messageId and spec.attachmentId',
          { spec: spec ?? null },
        );
      }
      checkMime(spec.mimeType);
      const declaredSize = spec.declaredSize;
      if (declaredSize != null && declaredSize > maxBytes) {
        throw abError(
          'AB_TOO_LARGE',
          `Declared size ${declaredSize} exceeds maxBytes ${maxBytes} at enqueue`,
          { declaredSize, maxBytes },
        );
      }
      if (!fetcher) {
        throw abError(
          'AB_FETCH_FAILED',
          'No fetcher injected: createAttachmentBytes requires deps.fetcher before any job can be fetched',
        );
      }
      const id = newId();
      const job = {
        id,
        state: 'queued',
        messageId: spec.messageId,
        attachmentId: spec.attachmentId,
        filename: spec.filename ?? '',
        mimeType: String(spec.mimeType ?? '').toLowerCase(),
        declaredSize: declaredSize ?? null,
        queuedAt: clock(),
        fetchStartedAt: null,
        lastProgressAt: null,
        attempts: 0,
        bytesSoFar: 0,
        byteLength: null,
        handle: null,
        failCode: null,
        failReason: null,
        cancelledAt: null,
        expiredAt: null,
      };
      jobs.set(id, job);
      record({
        at: clock(),
        from: null,
        to: 'queued',
        actor,
        detail: {
          jobId: id,
          messageId: job.messageId,
          attachmentId: job.attachmentId,
          filename: job.filename,
          mimeType: job.mimeType,
          declaredSize: job.declaredSize,
        },
      });
      return snapshot(job);
    },

    /**
     * Run the fetch for a queued job: queued → fetching → fetched.
     * The injected fetcher does the actual bytes work; this machine enforces
     * the maxBytes cap on the completed bytes, computes the content-addressed
     * handle, retries transient fetcher failures exactly once, and streams
     * progress to the injected onProgress sink. A fetcher promise that resolves
     * after the job left `fetching` (cancel/sweep) is ignored, never applied.
     */
    async fetch(id, actor = 'agent') {
      const job = getJobOrThrow(id);
      assertState(job, ['queued'], 'fetch');
      job.fetchStartedAt = clock();
      job.lastProgressAt = clock();
      transition(job, 'fetching', actor, {
        messageId: job.messageId,
        attachmentId: job.attachmentId,
      });

      const reportProgress = (bytesSoFar) => {
        if (job.state !== 'fetching') return;
        job.bytesSoFar = bytesSoFar;
        job.lastProgressAt = clock();
        onProgress(job.id, bytesSoFar);
      };

      let attempt = 0;
      for (;;) {
        attempt += 1;
        job.attempts = attempt;
        let result;
        try {
          result = await fetcher(
            {
              id: job.id,
              messageId: job.messageId,
              attachmentId: job.attachmentId,
              filename: job.filename,
              mimeType: job.mimeType,
              declaredSize: job.declaredSize,
            },
            { reportProgress },
          );
        } catch (err) {
          if (err?.transient === true && attempt < 2) {
            record({
              at: clock(),
              from: 'fetching',
              to: 'fetching',
              actor,
              detail: {
                jobId: job.id,
                attempt,
                retrying: true,
                reason: err?.message ?? 'transient fetcher failure',
              },
            });
            continue;
          }
          if (job.state !== 'fetching') return snapshot(job);
          job.failCode = 'AB_FETCH_FAILED';
          job.failReason = err?.message ?? 'fetcher threw';
          return transition(job, 'failed', actor, {
            attempt,
            failCode: job.failCode,
            failReason: job.failReason,
            transient: err?.transient === true,
          });
        }

        let bytes;
        try {
          bytes = toBytes(result?.bytes);
        } catch (err) {
          // A malformed fetcher result is a hard failure: no retry.
          if (job.state !== 'fetching') return snapshot(job);
          job.failCode = err.code ?? 'AB_FETCH_FAILED';
          job.failReason = err.message;
          return transition(job, 'failed', actor, {
            attempt,
            failCode: job.failCode,
            failReason: job.failReason,
          });
        }

        if (bytes.length > maxBytes) {
          // Cap enforced at completion: the fetcher reported more than allowed.
          if (job.state !== 'fetching') return snapshot(job);
          job.failCode = 'AB_TOO_LARGE';
          job.failReason = `Fetched ${bytes.length} bytes exceeds maxBytes ${maxBytes}`;
          return transition(job, 'failed', actor, {
            attempt,
            failCode: job.failCode,
            failReason: job.failReason,
            actualBytes: bytes.length,
          });
        }

        if (job.state !== 'fetching') return snapshot(job);
        job.byteLength = bytes.length;
        job.bytesSoFar = bytes.length;
        job.handle = hasher(bytes);
        return transition(job, 'fetched', actor, {
          attempt,
          byteLength: job.byteLength,
          handle: job.handle,
        });
      }
    },

    /**
     * Cancel a queued or in-flight job. Terminal jobs cannot be cancelled.
     * A fetcher promise that resolves after cancel is ignored (see fetch()).
     */
    cancel(id, actor = 'agent') {
      const job = getJobOrThrow(id);
      assertState(job, ['queued', 'fetching'], 'cancel');
      job.cancelledAt = clock();
      return transition(job, 'cancelled', actor, {
        attempts: job.attempts,
        bytesSoFar: job.bytesSoFar,
      });
    },

    /**
     * Sweep every `fetching` job that has had no progress inside
     * stallTimeoutMs and move it to `expired`. Returns the ids expired in
     * this sweep. Never silent: each expiry is a recorded transition.
     */
    sweep(actor = 'system') {
      const expired = [];
      for (const job of jobs.values()) {
        if (isStalled(job)) {
          job.expiredAt = clock();
          transition(job, 'expired', actor, {
            reason: 'no fetch progress inside stallTimeoutMs',
            stallTimeoutMs,
          });
          expired.push(job.id);
        }
      }
      return expired;
    },

    /** Read-only snapshot of a job (null if unknown). */
    get(id) {
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },
  };

  return Object.freeze(pipeline);
}
