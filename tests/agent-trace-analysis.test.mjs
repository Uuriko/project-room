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

const handoff = (overrides={}) => ({handoffHash:'a'.repeat(64),clockId:'room-server',fromRuntime:'desktop',toRuntime:'acp-mac',context:'review',openedAtMs:100,responseAtMs:130,responseRuntime:'acp-mac',useful:true,responseEvidenceHash:'b'.repeat(64),deadlineMs:20,...overrides});
const evaluate = records => analyzeAgentTrace([], {nowMs:200,clockId:'room-server',records}).handoffs;
test('shared-seat wrong runtime cannot improve useful latency or erase pending age', () => {
  const r=evaluate([handoff({responseRuntime:'other-acp'})]);
  assert.equal(r.samples[0].useful,false);
  assert.equal(r.samples[0].pendingAgeMs,100);
  assert.equal(r.directions[0].wrongRuntime,1);
  assert.equal(r.directions[0].medianUsefulResponseMs,null);
  assert.equal(r.directions[0].deadlineBreaches,1);
});
test('directions and context remain separate; completed late replies count deadline misses', () => {
  const r=evaluate([handoff(),handoff({handoffHash:'c'.repeat(64),fromRuntime:'acp-mac',toRuntime:'desktop',responseRuntime:'desktop'}),handoff({handoffHash:'d'.repeat(64),context:'decision'})]);
  assert.equal(r.directions.length,3);
  assert.ok(r.directions.every(d=>d.useful===1&&d.medianUsefulResponseMs===30&&d.deadlineBreaches===1));
});
test('missing response and runtime evidence stays unknown, never a zero-latency success or proved drop', () => {
  const r=evaluate([handoff({responseRuntime:null}),handoff({handoffHash:'c'.repeat(64),responseAtMs:null,responseRuntime:null,useful:null,responseEvidenceHash:null,deadlineMs:null})]);
  assert.equal(r.directions[0].unknownOutcomes,2);
  assert.equal(r.directions[0].missingTelemetry,2);
  assert.equal(r.directions[0].deadlineEvaluable,1);
  assert.equal(r.directions[0].useful,0);
});
test('repeated correlations and mismatched or backward clocks cannot fabricate successful samples', () => {
  const r=evaluate([handoff(),handoff({useful:false}),handoff({handoffHash:'c'.repeat(64),clockId:'laptop'}),handoff({handoffHash:'d'.repeat(64),responseAtMs:99})]);
  assert.equal(r.samples.length,0);assert.equal(r.invalidRecords,4);assert.equal(r.duplicateCorrelationKeys,1);
});
test('no freeform body, source or arbitrary fields escape handoff evaluation', () => {
  const r=evaluate([handoff({body:'private contents',source:'secret',unrelated:'private'})]);
  assert.doesNotMatch(JSON.stringify(r),/private|secret/);
  assert.equal(evaluate([handoff({responseEvidenceHash:null})]).directions[0].useful,0);
});

 test('pending deadlines mature at the boundary; resolved on-time responses enter the denominator', () => {
  const r=evaluate([handoff({responseAtMs:null,responseRuntime:null,useful:null,deadlineMs:101}),
    handoff({handoffHash:'c'.repeat(64),responseAtMs:null,responseRuntime:null,useful:null,deadlineMs:100}),
    handoff({handoffHash:'d'.repeat(64),deadlineMs:30})]);
  assert.equal(r.samples[0].deadlineBreached,null);
  assert.equal(r.samples[1].deadlineBreached,true);
  assert.equal(r.samples[2].deadlineBreached,false);
  assert.equal(r.directions[0].deadlineEvaluable,2);
  assert.equal(r.directions[0].deadlineBreaches,1);
});
test('later intended correction recovers the handoff while preserving every response time', () => {
  const r=handoff(); for(const k of ['responseRuntime','responseAtMs','useful','responseEvidenceHash'])delete r[k];
  const result=analyzeAgentTrace([], {nowMs:120000,clockId:'room-server',records:[{...r,openedAtMs:0,responses:[
    {responseRuntime:'other-acp',responseAtMs:29064,useful:true,responseEvidenceHash:'c'.repeat(64)},
    {responseRuntime:'acp-mac',responseAtMs:99207,useful:true,responseEvidenceHash:'d'.repeat(64)}]}]}).handoffs;
  const sample=result.samples[0];
  assert.equal(sample.wrongRuntimeCount,1);assert.equal(sample.useful,true);
  assert.equal(sample.usefulResponseMs,99207);assert.equal(sample.pendingAgeMs,null);
  assert.equal(sample.recoveredAfterWrongRuntime,true);
  assert.deepEqual(sample.responses.map(r=>r.responseMs),[29064,99207]);
  assert.equal(evaluate([{...r,responses:[],responseAtMs:null}]).invalidRecords,1);
});
test('response arrays select earliest useful time regardless of ingestion order and reject repeated evidence', () => {
  const r=handoff();for(const k of ['responseRuntime','responseAtMs','useful','responseEvidenceHash'])delete r[k];
  const responses=[{responseRuntime:'acp-mac',responseAtMs:160,useful:true,responseEvidenceHash:'c'.repeat(64)},
    {responseRuntime:'acp-mac',responseAtMs:120,useful:true,responseEvidenceHash:'d'.repeat(64)}];
  assert.equal(evaluate([{...r,responses}]).samples[0].usefulResponseMs,20);
  assert.equal(evaluate([{...r,responses:[responses[0],responses[0]]}]).invalidRecords,1);
});
