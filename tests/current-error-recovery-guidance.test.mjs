import test from 'node:test';import assert from 'node:assert/strict';import {agentErrorAx} from '../src/agent-error.mjs';
const recoveries=[
 ['current_room_context_required',/requires a bounded read/,/addressed current-work/],
 ['current_directory_integrity',/integrity check failed/,/report the exact error for recovery/],
 ['current_room_legacy_work_unreconciled',/Active legacy work/,/reconcile holders and recorded outcomes/],
 ['legacy_work_retired',/uses native work/,/work\.proposed/],
 ['current_redaction_historical_prefix',/no data was changed/,/Do not report erasure as complete/],
 ['independent_legacy_work',/independent work or obligations/,/must not drop independent work/],
 ['mirror_retirement_idempotency_conflict',/different reviewed inputs/,/Never reuse that ID with different/],
 ['attachment_cursor_reset',/file selection or service/,/without its old cursor/],
 ['thread_context_invalid',/ancestry is cyclic/,/do not follow the cycle/]
];
for(const[code,meaning,recovery]of recoveries)test(code+' retains its precise safe recovery',()=>{
 const ax=agentErrorAx({httpStatus:409,code,message:'Source refusal',roomId:'commons'});assert.equal(ax.status,'action_required');assert.equal(ax.reason,code);assert.match(ax.hint,meaning);assert.ok(ax.hint.length<120);assert.equal(ax.next.length,1);assert.match(ax.next[0].command,recovery);assert.equal(ax.next[0].tool,undefined);assert.doesNotMatch(ax.hint,/Unknown error/);
});
