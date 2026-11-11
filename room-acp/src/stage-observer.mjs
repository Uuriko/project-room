// Transport-neutral, optional metadata observations. Never an execution receipt.
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const stages = new Set(['signal_received', 'durable_queued', 'session_preparing', 'session_ready', 'prompt_dispatch_attempt', 'first_observable_output', 'durable_result_saved', 'reply_posted']);
export function safelyObserve(observer, value) {
  try { const result = observer?.(value); if (result?.then) Promise.resolve(result).catch(() => {}); } catch { /* Telemetry cannot change work. */ }
}
export class StageObserver {
  constructor({ observe = null, adapter = 'acp', monotonic = () => performance.now(), wall = () => Date.now(), maxSignals = 2048 } = {}) {
    this.observe = typeof observe === 'function' ? observe : null;
    this.adapter = /^[a-z][a-z0-9_-]{0,31}$/.test(adapter) ? adapter : 'unknown';
    this.monotonic = monotonic; this.wall = wall; this.maxSignals = maxSignals;
    this.segment = randomUUID(); this.signals = new Map();
  }
  hash(value) { return createHash('sha256').update(this.segment + ':' + value).digest('hex'); }
  received(ids) {
    if (!this.observe) return;
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > 1024 || this.signals.has(id) || this.signals.size >= this.maxSignals) continue;
      this.signals.set(id, { start: this.monotonic(), stages: new Set() });
      this.mark([id], 'signal_received');
    }
  }
  mark(ids, stage, operationId = null, outputKind = null) {
    if (!this.observe || !stages.has(stage)) return;
    for (const id of ids) {
      const trace = this.signals.get(id);
      if (!trace || trace.stages.has(stage)) continue;
      const elapsedMs = this.monotonic() - trace.start, now = this.wall();
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(now)) continue;
      const event = { schemaVersion: 1, adapter: this.adapter, segmentId: this.segment,
        signalHash: this.hash(id), stage, elapsedMs, observedAt: new Date(now).toISOString() };
      if (typeof operationId === 'string' && operationId.length <= 1024) event.operationHash = this.hash(operationId);
      if (stage === 'first_observable_output' && ['text', 'tool'].includes(outputKind)) event.outputKind = outputKind;
      trace.stages.add(stage);
      safelyObserve(this.observe, Object.freeze(event));
    }
  }
}
