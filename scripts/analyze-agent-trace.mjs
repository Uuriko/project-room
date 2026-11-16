import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const stages = ['signal_received', 'durable_queued', 'session_preparing', 'session_ready', 'prompt_dispatch_attempt', 'first_observable_output', 'durable_result_saved', 'reply_posted'];
const intervals = [
  ['queueMs', 'signal_received', 'durable_queued'],
  ['prepareMs', 'session_preparing', 'session_ready'],
  ['dispatchToOutputMs', 'prompt_dispatch_attempt', 'first_observable_output'],
  ['saveToPostMs', 'durable_result_saved', 'reply_posted'],
  ['receivedToPostMs', 'signal_received', 'reply_posted'],
];

// StageObserver hashes are process-segment scoped. Never join across restarts or
// subtract wall clocks. These observations cannot prove useful work or a wake.
export function analyzeAgentTrace(events) {
  const groups = new Map();
  let invalidEvents = 0;
  for (const e of events) {
    if (!e || e.schemaVersion !== 1 || !/^[a-z][a-z0-9_-]{0,31}$/.test(e.adapter ?? '') ||
        !/^[a-f0-9-]{36}$/.test(e.segmentId ?? '') || !/^[a-f0-9]{64}$/.test(e.signalHash ?? '') ||
        !stages.includes(e.stage) || !Number.isFinite(e.elapsedMs) || e.elapsedMs < 0 ||
        (e.operationHash !== undefined && !/^[a-f0-9]{64}$/.test(e.operationHash)) ||
        (e.outputKind !== undefined && (e.stage !== 'first_observable_output' || !['text', 'tool'].includes(e.outputKind)))) {
      invalidEvents++; continue;
    }
    const key = JSON.stringify([e.adapter, e.segmentId, e.signalHash]);
    if (!groups.has(key)) groups.set(key, { adapter: e.adapter, segmentId: e.segmentId, signalHash: e.signalHash, seen: new Map(), metadata: new Map(), operations: new Set(), conflicts: new Set(), duplicates: 0 });
    const g = groups.get(key);
    if (e.operationHash) g.operations.add(e.operationHash);
    const metadata = JSON.stringify([e.elapsedMs, e.operationHash ?? null, e.outputKind ?? null, e.observedAt ?? null]);
    if (g.seen.has(e.stage)) {
      if (g.metadata.get(e.stage) !== metadata) g.conflicts.add(e.stage);
      else g.duplicates++;
    } else {
      g.seen.set(e.stage, e.elapsedMs);
      g.metadata.set(e.stage, metadata);
    }
  }
  const traces = [...groups.values()].map(g => {
    const errors = [...g.conflicts].map(s => `conflicting_stage:${s}`);
    if (g.operations.size > 1) errors.push('conflicting_operations');
    let previous = -1;
    for (const s of stages) {
      if (!g.seen.has(s)) continue;
      const value = g.seen.get(s);
      if (value < previous) errors.push(`nonmonotonic_stage:${s}`);
      previous = value;
    }
    const durations = Object.fromEntries(intervals.map(([label, a, b]) => [label,
      errors.length || !g.seen.has(a) || !g.seen.has(b) ? null : g.seen.get(b) - g.seen.get(a)]));
    return { adapter: g.adapter, segmentId: g.segmentId, signalHash: g.signalHash,
      valid: !errors.length, errors, duplicateObservations: g.duplicates,
      observedStages: stages.filter(s => g.seen.has(s)), missingStages: stages.filter(s => !g.seen.has(s)), durations };
  });
  return { schemaVersion: 1, invalidEvents, traces,
    interpretation: 'Optional process-local observations only. No proof of runtime identity, automatic wake, useful response, formal closure, or verified outcome. Missing observations remain unknown.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/analyze-agent-trace.mjs TRACE.ndjson');
    process.exitCode = 2;
  } else {
    try {
      const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(line => line.trim());
      const result = analyzeAgentTrace(lines.map(line => JSON.parse(line)));
      console.log(JSON.stringify(result, null, 2));
      if (result.invalidEvents || result.traces.some(t => !t.valid)) process.exitCode = 1;
    } catch {
      console.error('Could not read trace NDJSON; no input content was printed.');
      process.exitCode = 2;
    }
  }
}
