import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StageObserver } from '../room-acp/src/stage-observer.mjs';
import { analyzeAgentTrace } from '../scripts/analyze-agent-trace.mjs';

function trace() {
  const events = []; let time = 0;
  const observer = new StageObserver({ observe: e => events.push(e), monotonic: () => time, wall: () => 0 });
  observer.received(['private-request']);
  for (const [stage, at] of [['durable_queued', 2], ['session_preparing', 3], ['session_ready', 8], ['prompt_dispatch_attempt', 9], ['first_observable_output', 29], ['durable_result_saved', 35], ['reply_posted', 40]]) {
    time = at; observer.mark(['private-request'], stage);
  }
  return events;
}
test('actual StageObserver output yields process-local delays without useful-work claims', () => {
  const r = analyzeAgentTrace(trace());
  assert.deepEqual(r.traces[0].durations, { queueMs: 2, prepareMs: 5, dispatchToOutputMs: 20, saveToPostMs: 5, receivedToPostMs: 40 });
  assert.equal(r.traces[0].valid, true);
  assert.doesNotMatch(JSON.stringify(r), /private-request/);
});
test('missing output stays unknown, not zero or successful execution', () => {
  const r = analyzeAgentTrace(trace().filter(e => e.stage !== 'first_observable_output'));
  assert.equal(r.traces[0].durations.dispatchToOutputMs, null);
  assert.ok(r.traces[0].missingStages.includes('first_observable_output'));
});
test('unordered ingestion is sorted by stage; identical duplicate is not duplicate execution', () => {
  const rows = trace(); const r = analyzeAgentTrace([...rows].reverse().concat(rows[0]));
  assert.equal(r.traces[0].durations.receivedToPostMs, 40);
  assert.equal(r.traces[0].duplicateObservations, 1);
});
test('conflicting duplicate and backward monotonic clock invalidate timing', () => {
  const rows = trace();
  assert.equal(analyzeAgentTrace([...rows, { ...rows[1], elapsedMs: 99 }]).traces[0].valid, false);
  const backwards = rows.map(e => e.stage === 'reply_posted' ? { ...e, elapsedMs: 1 } : e);
  assert.equal(analyzeAgentTrace(backwards).traces[0].durations.receivedToPostMs, null);
});
test('separate process segments cannot create a false completed trace', () => {
  const a = trace(); const b = trace();
  const r = analyzeAgentTrace([...a.slice(0, 4), ...b.slice(4)]);
  assert.equal(r.traces.length, 2);
  assert.ok(r.traces.every(t => t.durations.receivedToPostMs === null));
});
test('reject malformed metadata and never export arbitrary fields', () => {
  const rows = trace();
  const r = analyzeAgentTrace([{ ...rows[0], adapter: 'secret-value!' }, { ...rows[1], elapsedMs: -1 }, { ...rows[2], body: 'do not export this' }, null]);
  assert.equal(r.invalidEvents, 3);
  assert.doesNotMatch(JSON.stringify(r), /secret-value|do not export/);
});
test('different receipt operations cannot form one successful interval', () => {
  const rows = trace().map(e => ({ ...e, operationHash: (e.stage === 'first_observable_output' ? 'b' : 'a').repeat(64) }));
  const r = analyzeAgentTrace(rows);
  assert.equal(r.traces[0].durations.dispatchToOutputMs, null);
  assert.ok(r.traces[0].errors.includes('conflicting_operations'));
});
test('same timestamp with conflicting semantic metadata is not an identical duplicate', () => {
  const rows = trace(); const output = rows.find(e => e.stage === 'first_observable_output');
  const r = analyzeAgentTrace([...rows, { ...output, outputKind: 'text' }, { ...output, outputKind: 'tool' }]);
  assert.equal(r.traces[0].valid, false);
  assert.equal(r.traces[0].duplicateObservations, 0);
  assert.equal(analyzeAgentTrace([{ ...rows[0], operationHash: 'invalid' }]).invalidEvents, 1);
});
