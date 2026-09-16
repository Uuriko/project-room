/**
 * voice-note-transcription.mjs — Pure voice-note transcription job state machine.
 *
 * Models a voice-note transcription job end to end: enqueue a voice note,
 * hand it to a transcriber, and track the result (segments) or the failure.
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure state machine. Actual transcription happens in an injected
 * `transcriber` dependency so the machine stays testable and offline.
 *
 * States:
 *   queued → transcribing → transcribed
 *   Side states: failed, cancelled, expired
 *
 * Dependency injection (all via the `deps` parameter of createVoiceNoteTranscriber):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - id:             () => string  (job id generator; default: per-machine counter)
 *   - transcriber:    async ({job, attempt}) => {segments, language?}
 *                     (default: throws VN_NO_TRANSCRIBER; production wiring MUST
 *                      inject the real transcription backend)
 *   - maxDurationSec: number        (enqueue duration cap; default: 300)
 *   - stallTimeoutMs: number        (transcribing stall TTL; default: 5 minutes)
 *   - queuedTtlMs:    number        (queued TTL before expiry; default: 24 hours)
 *
 * Transcription result shape: segments = [{start, end, text, speaker?}] where
 * start/end are seconds (numbers), text is a string, and speaker is an optional
 * label. When the job was enqueued with speakerLabels: false, any speaker
 * labels returned by the transcriber are stripped before the job reaches
 * `transcribed` (the caller asked for no speaker labels).
 *
 * Retry semantics: a transcriber failure is retried ONCE when the error is
 * transient — i.e. the thrown Error has `transient: true` (or its `code` is
 * VN_TRANSCRIBE_TRANSIENT). Non-transient failures, a failed retry, or an
 * invalid result move the job to `failed` with no further retries.
 *
 * Sweep: jobs stuck in `transcribing` longer than stallTimeoutMs move to
 * `failed` (audit entry recorded); jobs sitting in `queued` longer than
 * queuedTtlMs move to `expired`. Returns the ids that moved.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   VN_NOT_FOUND            — unknown job id
 *   VN_INVALID_TRANSITION   — operation not allowed from the current state
 *   VN_TOO_LONG             — durationSec exceeds maxDurationSec at enqueue
 *   VN_UNSUPPORTED_MIME     — mimeType not in the audio/* allowlist
 *   VN_INVALID_AUDIO        — bad audio payload (missing/invalid duration or mime)
 *   VN_TRANSCRIBE_FAILED    — transcription failed (retry exhausted or non-transient)
 *   VN_INVALID_RESULT       — transcriber returned an invalid result shape
 *   VN_STALLED              — transcribing job past stallTimeoutMs (failed by sweep)
 *   VN_NO_TRANSCRIBER       — start called without a transcriber injected
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'queued',
  'transcribing',
  'transcribed',
  'failed',
  'cancelled',
  'expired',
]);

/** Mime types the machine will accept at enqueue. */
export const ALLOWED_MIME_TYPES = Object.freeze([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/webm',
]);

export const DEFAULT_MAX_DURATION_SEC = 300;
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_QUEUED_TTL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATES = new Set(['transcribed', 'failed', 'cancelled', 'expired']);

/** Throw a coded transcription-job error (never silent failures). */
function vnError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Default transcriber: loudly refuses. The machine must never silently
 * "transcribe" with a missing backend.
 */
async function missingTranscriber() {
  throw vnError(
    'VN_NO_TRANSCRIBER',
    'No transcriber injected: start() requires a deps.transcriber',
  );
}

/** True when a transcriber error is transient and worth one retry. */
function isTransient(err) {
  return err?.transient === true || err?.code === 'VN_TRANSCRIBE_TRANSIENT';
}

/** Validate a transcriber result; throws VN_INVALID_RESULT with detail on problems. */
function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw vnError('VN_INVALID_RESULT', 'Transcriber result must be an object', { result });
  }
  const { segments } = result;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw vnError('VN_INVALID_RESULT', 'Transcriber result must include a non-empty segments array', {
      segments,
    });
  }
  segments.forEach((seg, i) => {
    const bad =
      !seg ||
      typeof seg !== 'object' ||
      typeof seg.start !== 'number' ||
      typeof seg.end !== 'number' ||
      Number.isNaN(seg.start) ||
      Number.isNaN(seg.end) ||
      seg.start < 0 ||
      seg.end < seg.start ||
      typeof seg.text !== 'string' ||
      seg.text.length === 0 ||
      (seg.speaker !== undefined && typeof seg.speaker !== 'string');
    if (bad) {
      throw vnError('VN_INVALID_RESULT', `Invalid segment at index ${i}`, { index: i, segment: seg });
    }
  });
  return { segments, language: typeof result.language === 'string' ? result.language : null };
}

/**
 * Create a new voice-note transcription job machine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(input: object) => Promise<object>} [deps.transcriber]
 * @param {number} [deps.maxDurationSec]
 * @param {number} [deps.stallTimeoutMs]
 * @param {number} [deps.queuedTtlMs]
 */
export function createVoiceNoteTranscriber(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const transcriber = deps.transcriber ?? missingTranscriber;
  const maxDurationSec = deps.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const queuedTtlMs = deps.queuedTtlMs ?? DEFAULT_QUEUED_TTL_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `vn-${(idCounter += 1)}`);

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
      throw vnError('VN_NOT_FOUND', `Unknown voice-note job id: ${id}`, { jobId: id });
    }
    return job;
  }

  function snapshot(job) {
    return Object.freeze({
      id: job.id,
      state: job.state,
      audio: Object.freeze({ ...job.audio }),
      languageHint: job.languageHint,
      speakerLabels: job.speakerLabels,
      enqueuedAt: job.enqueuedAt,
      transcribingStartedAt: job.transcribingStartedAt,
      attempts: job.attempts,
      segments: job.segments ? Object.freeze(job.segments.map((s) => Object.freeze({ ...s }))) : null,
      resultLanguage: job.resultLanguage,
      failCode: job.failCode,
      failReason: job.failReason,
      cancelledBy: job.cancelledBy,
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
      throw vnError(
        'VN_INVALID_TRANSITION',
        `Cannot ${op} job ${job.id} from state '${job.state}'`,
        { jobId: job.id, state: job.state, op },
      );
    }
  }

  const machine = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get maxDurationSec() {
      return maxDurationSec;
    },

    get stallTimeoutMs() {
      return stallTimeoutMs;
    },

    get queuedTtlMs() {
      return queuedTtlMs;
    },

    /**
     * Enqueue a voice note in `queued` state. Validates duration (cap enforced
     * here) and mime type before the job exists.
     * @param {object} audio {durationSec, mimeType, sizeBytes?}
     * @param {object} [options] {languageHint?, speakerLabels?}
     */
    enqueue(audio, options = {}, actor = 'agent') {
      const durationSec = audio?.durationSec;
      const mimeType = audio?.mimeType;
      if (typeof durationSec !== 'number' || Number.isNaN(durationSec) || durationSec <= 0) {
        throw vnError(
          'VN_INVALID_AUDIO',
          'Voice note must carry a positive durationSec',
          { durationSec },
        );
      }
      if (typeof mimeType !== 'string' || mimeType.length === 0) {
        throw vnError('VN_INVALID_AUDIO', 'Voice note must carry a mimeType', { mimeType });
      }
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        throw vnError(
          'VN_UNSUPPORTED_MIME',
          `Unsupported voice-note mime type: ${mimeType}`,
          { mimeType, allowed: [...ALLOWED_MIME_TYPES] },
        );
      }
      if (durationSec > maxDurationSec) {
        throw vnError(
          'VN_TOO_LONG',
          `Voice note is ${durationSec}s, longer than the ${maxDurationSec}s cap`,
          { durationSec, maxDurationSec },
        );
      }
      const id = newId();
      const job = {
        id,
        state: 'queued',
        audio: Object.freeze({
          durationSec,
          mimeType,
          sizeBytes: audio?.sizeBytes ?? null,
        }),
        languageHint: options?.languageHint ?? null,
        speakerLabels: options?.speakerLabels === true,
        enqueuedAt: clock(),
        transcribingStartedAt: null,
        attempts: 0,
        segments: null,
        resultLanguage: null,
        failCode: null,
        failReason: null,
        cancelledBy: null,
      };
      jobs.set(id, job);
      record({
        at: clock(),
        from: null,
        to: 'queued',
        actor,
        detail: {
          jobId: id,
          durationSec,
          mimeType,
          languageHint: job.languageHint,
          speakerLabels: job.speakerLabels,
        },
      });
      return snapshot(job);
    },

    /**
     * Move a queued job to `transcribing` and run the injected transcriber
     * once (retrying once on transient failure). Resolves to the `transcribed`
     * snapshot on success; rejects (job in `failed`) when transcription fails.
     */
    async start(id, actor = 'agent') {
      const job = getJobOrThrow(id);
      assertState(job, ['queued'], 'start transcription for');
      job.transcribingStartedAt = clock();
      transition(job, 'transcribing', actor, {});

      const input = {
        jobId: job.id,
        audio: { ...job.audio },
        languageHint: job.languageHint,
        speakerLabels: job.speakerLabels,
      };

      let attempt = 0;
      let lastError = null;
      while (attempt < 2) {
        attempt += 1;
        job.attempts = attempt;
        try {
          const raw = await transcriber({ job: input, attempt });
          const { segments, language } = validateResult(raw);
          // Caller asked for no speaker labels: strip any the transcriber returned.
          const cleaned = job.speakerLabels
            ? segments.map((s) => ({ ...s }))
            : segments.map((s) => {
                const { speaker, ...rest } = s;
                return rest;
              });
          job.segments = Object.freeze(cleaned.map((s) => Object.freeze({ ...s })));
          job.resultLanguage = language ?? job.languageHint ?? null;
          if (job.state !== 'transcribing') {
            // Cancelled (or swept) while the transcriber was in flight: the
            // cancel/sweep decision stands; do not overwrite the state.
            return snapshot(job);
          }
          return transition(job, 'transcribed', actor, {
            segments: cleaned.length,
            attempts: attempt,
            ...(attempt > 1 ? { retried: true } : {}),
          });
        } catch (err) {
          lastError = err;
          if (isTransient(err) && attempt < 2) {
            record({
              at: clock(),
              from: 'transcribing',
              to: 'transcribing',
              actor,
              detail: {
                jobId: job.id,
                event: 'transient-failure-retrying',
                attempt,
                code: err?.code ?? null,
                message: err?.message ?? String(err),
              },
            });
            continue;
          }
          break;
        }
      }

      if (job.state !== 'transcribing') {
        // Cancelled (or swept) during the attempt: keep that decision.
        return snapshot(job);
      }
      const invalidResult = lastError?.code === 'VN_INVALID_RESULT';
      const failCode = invalidResult ? 'VN_INVALID_RESULT' : 'VN_TRANSCRIBE_FAILED';
      const reason = invalidResult
        ? `transcriber returned an invalid result: ${lastError.message}`
        : `transcription failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${lastError?.message ?? String(lastError)}`;
      job.failCode = failCode;
      job.failReason = reason;
      transition(job, 'failed', actor, {
        code: failCode,
        reason,
        attempts: attempt,
        transcriberCode: lastError?.code ?? null,
      });
      throw vnError('VN_TRANSCRIBE_FAILED', `Transcription failed for job ${job.id}: ${reason}`, {
        jobId: job.id,
        failCode,
        attempts: attempt,
        cause: lastError?.message ?? String(lastError),
      });
    },

    /** Cancel a queued or transcribing job. Terminal states cannot be cancelled. */
    cancel(id, actor = 'agent') {
      const job = getJobOrThrow(id);
      assertState(job, ['queued', 'transcribing'], 'cancel');
      job.cancelledBy = actor;
      return transition(job, 'cancelled', actor, {});
    },

    /**
     * Sweep: stalled `transcribing` jobs (past stallTimeoutMs) → `failed`
     * with an audit entry; over-TTL `queued` jobs → `expired`. Returns the ids
     * that moved in this sweep.
     */
    sweep(actor = 'system') {
      const now = clock();
      const moved = [];
      for (const job of jobs.values()) {
        if (
          job.state === 'transcribing' &&
          job.transcribingStartedAt != null &&
          now - job.transcribingStartedAt > stallTimeoutMs
        ) {
          job.failCode = 'VN_STALLED';
          job.failReason = `transcribing for more than ${stallTimeoutMs}ms without completing`;
          transition(job, 'failed', actor, {
            reason: 'stall timeout elapsed',
            code: 'VN_STALLED',
            stallTimeoutMs,
            transcribingStartedAt: job.transcribingStartedAt,
          });
          moved.push(job.id);
        } else if (
          job.state === 'queued' &&
          job.enqueuedAt != null &&
          now - job.enqueuedAt > queuedTtlMs
        ) {
          transition(job, 'expired', actor, {
            reason: 'queued TTL elapsed',
            queuedTtlMs,
          });
          moved.push(job.id);
        }
      }
      return moved;
    },

    /** Read-only snapshot of a job (null if unknown). */
    get(id) {
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },

    /** Ids of jobs currently in a non-terminal state. */
    activeIds() {
      return [...jobs.values()]
        .filter((job) => !TERMINAL_STATES.has(job.state))
        .map((job) => job.id);
    },
  };

  return Object.freeze(machine);
}
