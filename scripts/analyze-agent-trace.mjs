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
export function analyzeAgentTrace(events, handoffEvaluation = null) {
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
    ...(handoffEvaluation ? { handoffs: analyzeHandoffs(handoffEvaluation) } : {}),
    interpretation: 'Optional process-local observations only. No proof of runtime identity, automatic wake, useful response, formal closure, or verified outcome. Missing observations remain unknown.' };
}

// Explicit evaluator evidence, not identity inferred from shared membership or
// trace hashes. All timestamps must come from the same declared clock domain.
export function analyzeHandoffs({ nowMs, clockId, records } = {}) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const label = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
  const time = value => Number.isFinite(value) && value >= 0;
  if (!time(nowMs) || !label(clockId) || !Array.isArray(records)) throw Error('Invalid handoff evaluation envelope');
  const grouped = new Map(), seen = new Set(), duplicates = new Set();
  // Exclude every occurrence of a repeated correlation key: do not select the
  // first or last potentially conflicting observation and invent an outcome.
  for (const r of records) if (hash(r?.handoffHash)) {
    if (seen.has(r.handoffHash)) duplicates.add(r.handoffHash);
    seen.add(r.handoffHash);
  }
  let invalidRecords = 0;
  const samples = [];
  for (const r of records) {
    if (!r || !hash(r.handoffHash) || duplicates.has(r.handoffHash) || r.clockId !== clockId ||
      !time(r.openedAtMs) || r.openedAtMs > nowMs ||
      ![r.fromRuntime, r.toRuntime, r.context].every(v => v == null || label(v)) ||
      (r.responseRuntime != null && !label(r.responseRuntime)) ||
      (r.responseAtMs != null && (!time(r.responseAtMs) || r.responseAtMs < r.openedAtMs || r.responseAtMs > nowMs)) ||
      (r.deadlineMs != null && (!time(r.deadlineMs) || r.deadlineMs === 0)) ||
      (r.useful != null && typeof r.useful !== 'boolean') ||
      (r.responseEvidenceHash != null && !hash(r.responseEvidenceHash))) { invalidRecords++; continue; }
    const responseObserved = r.responseAtMs != null;
    const runtimeMatch = r.toRuntime && r.responseRuntime ? r.toRuntime === r.responseRuntime : null;
    const useful = responseObserved && runtimeMatch === true && r.useful === true && hash(r.responseEvidenceHash);
    const wrongRuntime = responseObserved && runtimeMatch === false;
    const pendingAgeMs = useful ? null : nowMs - r.openedAtMs;
    const usefulResponseMs = useful ? r.responseAtMs - r.openedAtMs : null;
    const deadlineBreached = r.deadlineMs == null ? null : (usefulResponseMs ?? pendingAgeMs) > r.deadlineMs;
    const sample = { handoffHash:r.handoffHash, fromRuntime:r.fromRuntime ?? null, toRuntime:r.toRuntime ?? null,
      context:r.context ?? null, responseRuntime:r.responseRuntime ?? null, responseObserved,
      runtimeMatch, wrongRuntime, useful, usefulResponseMs, pendingAgeMs, deadlineBreached,
      outcomeUnknown:!useful && !wrongRuntime && !(responseObserved && r.useful === false),
      telemetryMissing:!responseObserved || !r.responseRuntime || !r.toRuntime || r.useful == null || !r.responseEvidenceHash };
    samples.push(sample);
    const key=JSON.stringify([sample.fromRuntime,sample.toRuntime,sample.context]);
    if (!grouped.has(key)) grouped.set(key, { fromRuntime:sample.fromRuntime,toRuntime:sample.toRuntime,context:sample.context,samples:[] });
    grouped.get(key).samples.push(sample);
  }
  const directions = [...grouped.values()].map(g => {
    const latencies=g.samples.filter(s=>s.useful).map(s=>s.usefulResponseMs).sort((a,b)=>a-b);
    const ages=g.samples.filter(s=>s.pendingAgeMs!==null).map(s=>s.pendingAgeMs);
    return { fromRuntime:g.fromRuntime,toRuntime:g.toRuntime,context:g.context,total:g.samples.length,
      useful:g.samples.filter(s=>s.useful).length,wrongRuntime:g.samples.filter(s=>s.wrongRuntime).length,
      awaitingUseful:g.samples.filter(s=>!s.useful).length,unknownOutcomes:g.samples.filter(s=>s.outcomeUnknown).length,
      missingTelemetry:g.samples.filter(s=>s.telemetryMissing).length,
      deadlineEvaluable:g.samples.filter(s=>s.deadlineBreached!==null).length,
      deadlineBreaches:g.samples.filter(s=>s.deadlineBreached===true).length,
      medianUsefulResponseMs:latencies.length ? (latencies[Math.floor((latencies.length-1)/2)]+latencies[Math.floor(latencies.length/2)])/2:null,
      maxPendingAgeMs:ages.length?Math.max(...ages):null };
  });
  return { invalidRecords,duplicateCorrelationKeys:duplicates.size,samples,directions,
    interpretation:'Explicit same-clock evaluator evidence. Deadlines are configured targets, not industry benchmarks. Wrong-runtime replies never count useful. Awaiting useful includes wrong-runtime closures; missing telemetry does not prove a drop. Samples without attribution remain unknown; no cross-process trace timing is joined.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (![3, 4].includes(process.argv.length)) {
    console.error('Usage: node scripts/analyze-agent-trace.mjs TRACE.ndjson [HANDOFFS.json]');
    process.exitCode = 2;
  } else {
    try {
      const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(line => line.trim());
      const result = analyzeAgentTrace(lines.map(line => JSON.parse(line)), process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null);
      console.log(JSON.stringify(result, null, 2));
      if (result.handoffs?.invalidRecords || result.invalidEvents || result.traces.some(t => !t.valid)) process.exitCode = 1;
    } catch {
      console.error('Could not read trace NDJSON; no input content was printed.');
      process.exitCode = 2;
    }
  }
}
