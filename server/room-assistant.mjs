import { enforceAutonomyTierForAction } from './autonomy-tiers.mjs';
import { validId } from '../src/events.js';
import { isGuestAgentMemberId } from './guest-agent-links.mjs';
import { historyFloor, messageInHistory, messageVisibleToViewer } from './history-visibility.mjs';
import { dmTargetIds } from './dm-rooms.mjs';

// Coordination records reserve one publisher. A host claim is an observation,
// not a hosted execution service, and never grants that host additional rights.
export const roomAssistantSchema = `
CREATE TABLE IF NOT EXISTS room_assistant_config (room_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_assistant_runs (room_id TEXT NOT NULL, run_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(room_id,run_id));
CREATE TABLE IF NOT EXISTS room_assistant_ops (room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room_id,actor_id,request_id));`;
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const terminal = new Set(['done', 'cancelled', 'failed']);
const keys = {
  configure: ['name', 'coordinatorMemberId', 'expectedRevision'], invoke: ['runId', 'sourceMessageId'],
  contribute: ['runId', 'sourceMessageId', 'expectedRevision', 'conflict'],
  resolve: ['runId', 'sourceMessageId', 'expectedRevision'],
  claim: ['runId', 'attemptId', 'expectedRevision'],
  report: ['runId', 'attemptId', 'expectedRevision', 'state', 'summary', 'resultMessageId', 'appliedInputMessageIds'],
  resume: ['runId', 'expectedRevision'], pause: ['runId', 'expectedRevision'], cancel: ['runId', 'expectedRevision']
};
// Deleted prompts retain only a stop handle for their existing controllers.
// The history floor still applies: deletion cannot reveal older work to newcomers.
const controlsDeletedSource = (run, opening, actor, state, floor) => Boolean(
  opening?.deletedAt && opening.body == null && dmTargetIds(opening).length === 0 && messageInHistory(opening, floor)
  && (actor.kind === 'human' && (actor.id === run.initiatorId || actor.id === state.room.ownerId)
    || actor.kind === 'agent' && actor.id === run.coordinatorMemberId && run.attemptId && actor.permissions.includes('accept_work')));
const deletedControl = run => Object.fromEntries([
  ...['id', 'sourceMessageId', 'initiatorId', 'coordinatorMemberId', 'status', 'revision', 'attemptId', 'createdAt', 'updatedAt', 'hostReportedAt'].map(key => [key, run[key]]),
  ['sourceDeleted', true], ['inputs', []], ['activity', []]
]);
export class RoomAssistant {
  constructor(store) { this.store = store; }
  init() { this.store.db.exec(roomAssistantSchema); }
  config(roomId) {
    const row = this.store.db.prepare('SELECT value FROM room_assistant_config WHERE room_id=?').get(roomId);
    return row ? JSON.parse(row.value) : { name: 'Room', coordinatorMemberId: null, revision: 0 };
  }
  list(roomId, authorize) {
    return this.store.readTransaction(() => {
      const auth = authorize();
      // Fresh installations have no configuration; reads must not mutate storage.
      if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_assistant_config'").get())
        return { contractVersion: 1, roomId, assistant: { name: 'Room', coordinatorMemberId: null, revision: 0, availability: 'not_connected' }, runs: [] };
      const state = this.store.room(roomId).state;
      const config = this.config(roomId), coordinator = state.members[config.coordinatorMemberId];
      const floor = historyFloor(this.store.db, state, roomId, auth.member.id);
      const visible = id => messageVisibleToViewer(state.messages.find(m => m.id === id), auth.member.id, floor);
      const runs = this.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(roomId)
        .map(row => JSON.parse(row.value)).flatMap(run => {
          if (visible(run.sourceMessageId)) return [run];
          const opening = state.messages.find(m => m.id === run.sourceMessageId);
          return controlsDeletedSource(run, opening, auth.member, state, floor) ? [deletedControl(run)] : [];
        })
        .map(run => ({ ...run, status: run.status === 'working' && (!Number.isFinite(run.hostReportedAt) || this.store.now() - run.hostReportedAt > 120000) ? 'unknown' : run.status }));
      const recent = runs.some(run => run.coordinatorMemberId === config.coordinatorMemberId && run.attemptId && Number.isFinite(run.hostReportedAt) && this.store.now() - run.hostReportedAt <= 120000 && !terminal.has(run.status));
      return { contractVersion: 1, roomId, assistant: { ...config, availability: !coordinator?.active || !coordinator.permissions.includes('accept_work') ? 'not_connected' : recent ? 'connected' : 'awaiting_host' }, runs };
    });
  }
  apply(roomId, input, authorize) {
    if (!input || Array.isArray(input) || !Object.hasOwn(keys, input.action) || !validId(input.requestId)
      || Object.keys(input).some(key => !['action', 'requestId', ...keys[input.action]].includes(key)))
      fail('invalid_assistant_action', 'Choose an assistant action and stable request ID', 422);
    for (const key of ['runId', 'sourceMessageId', 'attemptId', 'resultMessageId'])
      if (input[key] !== undefined && !validId(input[key])) fail('invalid_assistant_action', `Invalid ${key}`, 422);
    return this.store.transaction(() => {
      const auth = authorize(), state = this.store.room(roomId).state, actor = auth.member;
      if (isGuestAgentMemberId(actor.id) || actor.permissions?.some(p => p.startsWith('guest:')))
        fail('assistant_denied', 'Guests cannot coordinate shared work', 403);
      if (state.room.archivedAt) fail('assistant_archived', 'This room is archived');
      this.init();
      const config = this.config(roomId);
      const isOwner = state.room.ownerId === actor.id;
      const isHuman = actor.kind === 'human';
      const floor = historyFloor(this.store.db, state, roomId, actor.id);
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
      const old = this.store.db.prepare('SELECT input,result FROM room_assistant_ops WHERE room_id=? AND actor_id=? AND request_id=?').get(roomId, actor.id, input.requestId);
      if (old) {
        if (old.input !== canonical) fail('assistant_retry_conflict', 'Retry ID already records different input');
        const response = JSON.parse(old.result);
        const opening = state.messages.find(m => m.id === response.result?.sourceMessageId);
        if (opening?.deletedAt) {
          if (!controlsDeletedSource(response.result, opening, actor, state, floor)) fail('assistant_run_missing', 'Request not found', 404);
          return { ...response, result: deletedControl(response.result) };
        }
        return response;
      }
      const source = id => {
        const message = state.messages.find(m => m.id === id);
        if (!message || dmTargetIds(message).length > 0 || !messageVisibleToViewer(message, actor.id, floor) || message.authorId !== actor.id)
          fail('assistant_source_denied', 'Choose your own visible shared message', 403);
        return message;
      };
      let result;
      if (input.action === 'configure') {
        if (!isOwner) fail('assistant_denied', 'Only the room owner configures its assistant', 403);
        if (input.expectedRevision !== config.revision) fail('assistant_revision_conflict', 'Assistant settings changed; read them before retrying');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64
          || input.coordinatorMemberId !== null && (!validId(input.coordinatorMemberId) || state.members[input.coordinatorMemberId]?.kind !== 'agent' || !state.members[input.coordinatorMemberId]?.active || !state.members[input.coordinatorMemberId]?.permissions.includes('accept_work')))
          fail('invalid_assistant_config', 'Choose a name and an active room agent, or disconnect', 422);
        result = { name: input.name.trim(), coordinatorMemberId: input.coordinatorMemberId, revision: config.revision + 1 };
        this.store.db.prepare('INSERT INTO room_assistant_config VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value').run(roomId, JSON.stringify(result));
        if (result.coordinatorMemberId !== config.coordinatorMemberId) {
          for (const row of this.store.db.prepare('SELECT run_id,value FROM room_assistant_runs WHERE room_id=?').all(roomId)) {
            const pending = JSON.parse(row.value);
            if (terminal.has(pending.status)) continue;
            if (!pending.attemptId) pending.coordinatorMemberId = result.coordinatorMemberId;
            else if (!['paused', 'cancel_requested', 'needs_input'].includes(pending.status)) pending.status = 'pause_requested';
            pending.revision++;
            this.store.db.prepare('UPDATE room_assistant_runs SET value=? WHERE room_id=? AND run_id=?').run(JSON.stringify(pending), roomId, row.run_id);
          }
        }
      } else {
        if (!validId(input.runId)) fail('invalid_assistant_action', 'Choose a run ID', 422);
        const row = this.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get(roomId, input.runId);
        let run = row && JSON.parse(row.value);
        if (input.action === 'invoke') {
          if (!isHuman) fail('assistant_denied', 'A human explicitly asks the shared assistant', 403);
          source(input.sourceMessageId);
          const coordinator = state.members[config.coordinatorMemberId];
          if (!coordinator?.active || coordinator.kind !== 'agent' || !coordinator.permissions.includes('accept_work')) fail('assistant_not_connected', 'Connect an authorized room assistant before asking for work');
          if (run || this.store.db.prepare("SELECT 1 FROM room_assistant_runs WHERE room_id=? AND json_extract(value,'$.sourceMessageId')=?").get(roomId, input.sourceMessageId)) fail('assistant_run_exists', 'This message already has a shared request');
          run = { id: input.runId, sourceMessageId: input.sourceMessageId, initiatorId: actor.id,
            coordinatorMemberId: config.coordinatorMemberId, status: 'queued', revision: 0, attemptId: null,
            createdAt: this.store.now(), updatedAt: this.store.now(), hostReportedAt: null, inputs: [{ memberId: actor.id, sourceMessageId: input.sourceMessageId, status: 'pending' }], activity: [] };
        } else {
          if (!run) fail('assistant_run_missing', 'Request not found', 404);
          const opening = state.messages.find(m => m.id === run.sourceMessageId);
          if (!messageVisibleToViewer(opening, actor.id, floor)
            && !(controlsDeletedSource(run, opening, actor, state, floor)
              && (isHuman && ['pause', 'cancel'].includes(input.action)
                || actor.kind === 'agent' && input.action === 'report' && ['paused', 'cancelled', 'failed'].includes(input.state))))
            fail('assistant_run_missing', 'Request not found', 404);
          if (input.expectedRevision !== run.revision) fail('assistant_revision_conflict', 'The request changed; read it before retrying');
          if (terminal.has(run.status)) fail('assistant_run_closed', 'This request has finished');
          if (['contribute', 'resolve'].includes(input.action)) {
            if (!isHuman) fail('assistant_denied', 'Shared inputs preserve human authorship', 403);
            source(input.sourceMessageId);
            if (input.conflict !== undefined && typeof input.conflict !== 'boolean') fail('invalid_assistant_action', 'Conflict must be a boolean', 422);
            if (input.action === 'resolve' && !isOwner && actor.id !== run.initiatorId)
              fail('assistant_denied', 'The requester or room owner resolves conflicting scope', 403);
            if (input.action === 'resolve' && run.status !== 'needs_input') fail('assistant_no_conflict', 'There is no pending scope decision');
            if (run.inputs.length >= 100) fail('assistant_input_limit', 'Start a new request after 100 contributions', 422);
            run.inputs.push({ memberId: actor.id, sourceMessageId: input.sourceMessageId, status: 'pending', conflict: input.conflict === true, resolution: input.action === 'resolve' });
            if (input.conflict) run.status = 'needs_input';
            else if (input.action === 'resolve') run.status = run.attemptId ? 'pause_requested' : 'queued';
          } else if (input.action === 'resume') {
            if (!isHuman || (!isOwner && actor.id !== run.initiatorId)) fail('assistant_denied', 'The requester or owner resumes this request', 403);
            if (run.status !== 'paused') fail('assistant_not_paused', 'Wait for the host to confirm pausing before resuming');
            const coordinator = state.members[config.coordinatorMemberId];
            if (!coordinator?.active || !coordinator.permissions.includes('accept_work') || run.coordinatorMemberId !== config.coordinatorMemberId)
              fail('assistant_not_connected', 'Reconnect the original authorized assistant before resuming');
            run.status = run.attemptId ? 'resume_requested' : 'queued';
          } else if (['pause', 'cancel'].includes(input.action)) {
            if (!isHuman || (!isOwner && actor.id !== run.initiatorId)) fail('assistant_denied', 'The requester or owner controls this request', 403);
            run.status = run.attemptId ? input.action === 'pause' ? 'pause_requested' : 'cancel_requested' : input.action === 'pause' ? 'paused' : 'cancelled';
          } else {
            if (actor.kind !== 'agent' || actor.id !== run.coordinatorMemberId
              || !actor.permissions.includes('accept_work')
              || actor.id !== config.coordinatorMemberId && !(input.action === 'report' && ['paused', 'cancelled', 'failed'].includes(input.state))) fail('assistant_denied', 'Only the configured authorized coordinator reports its host', 403);
            enforceAutonomyTierForAction({ db: this.store.db, roomId, state, actor, action: 'coordinate the shared assistant' });
            if ((input.action === 'claim' || input.state === 'working') && this.store.wakeQueue.pauseStatus(roomId, actor.id)) fail('assistant_host_paused', 'This coordinator is paused');
            if (!validId(input.attemptId)) fail('invalid_assistant_action', 'Choose a stable execution attempt', 422);
            if (input.action === 'claim') {
              if (run.attemptId) fail('assistant_run_owned', 'This request already has an execution owner; reconcile that attempt');
              if (run.status !== 'queued') fail('assistant_not_queued', 'Resolve or resume the request before execution');
              run.attemptId = input.attemptId; run.status = 'working'; run.hostReportedAt = this.store.now();
            } else {
              if (run.attemptId !== input.attemptId) fail('assistant_run_owned', 'Only the reserved host attempt may report');
              if (!['working', 'needs_input', 'paused', 'cancelled', 'done', 'failed'].includes(input.state)
                || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000)
                fail('invalid_assistant_report', 'Report a short public activity summary and supported state', 422);
              if (run.status === 'cancel_requested' && !['cancelled', 'failed'].includes(input.state)
                || run.status === 'pause_requested' && !['paused', 'cancelled', 'failed'].includes(input.state)
                || run.status === 'paused' && input.state === 'working'
                || run.status === 'needs_input' && !['needs_input', 'paused', 'cancelled', 'failed'].includes(input.state)) fail('assistant_stop_pending', 'A stop or scope decision must be acknowledged first');
              if (input.state === 'done') {
                if (!input.resultMessageId) fail('assistant_result_missing', 'Publish a shared result message before reporting done', 422);
                source(input.resultMessageId); run.resultMessageId = input.resultMessageId;
              }
              if (input.appliedInputMessageIds !== undefined) {
                if (!Array.isArray(input.appliedInputMessageIds) || input.appliedInputMessageIds.length > 100
                  || input.appliedInputMessageIds.some(id => !run.inputs.some(entry => entry.sourceMessageId === id)))
                  fail('invalid_assistant_report', 'Applied inputs must name existing shared contributions', 422);
                for (const entry of run.inputs) if (input.appliedInputMessageIds.includes(entry.sourceMessageId)) entry.status = 'applied';
              }
              // A current revision alone does not establish that the host handled
              // every human contribution. Preserve earlier acknowledgments and
              // include this report's acknowledgments before closing the run.
              if (input.state === 'done' && run.inputs.some(entry => entry.status !== 'applied'))
                fail('assistant_inputs_pending', 'Read and account for every shared contribution before reporting done');
              run.hostReportedAt = this.store.now();
              run.status = input.state;
              run.activity.push({ at: this.store.now(), memberId: actor.id, kind: 'reported', summary: input.summary.trim(), state: input.state });
              run.activity = run.activity.slice(-100);
            }
          }
          run.revision++;
        }
        run.updatedAt = this.store.now();
        this.store.db.prepare('INSERT INTO room_assistant_runs VALUES(?,?,?) ON CONFLICT(room_id,run_id) DO UPDATE SET value=excluded.value').run(roomId, run.id, JSON.stringify(run));
        result = state.messages.find(m => m.id === run.sourceMessageId)?.deletedAt ? deletedControl(run) : run;
      }
      const response = { contractVersion: 1, roomId, action: input.action, result };
      this.store.db.prepare('INSERT INTO room_assistant_ops VALUES(?,?,?,?,?)').run(roomId, actor.id, input.requestId, canonical, JSON.stringify(response));
      return response;
    });
  }
}
