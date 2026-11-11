// Derived SQLite access paths over existing protected records, not new state.
export const INBOX_WORK_ROLES=Object.freeze([
 ['accountable','$.work.accountableMemberId'],['verifier','$.work.verifierMemberId'],
 ['decision','$.work.humanDecisionMakerId'],['triage','$.work.handoff.triageMemberId']
]);
export const CURRENT_INBOX_DISCOVERY_INDEXES=INBOX_WORK_ROLES.map(([role,path])=>`CREATE INDEX IF NOT EXISTS current_inbox_work_${role} ON current_room_records(room_id,json_extract(payload,'${path}'),record_key DESC) WHERE domain='workSummary';`).join('\n')+`
CREATE INDEX IF NOT EXISTS current_inbox_owner_handoffs ON current_room_records(room_id,record_key) WHERE domain='workSummary' AND json_extract(payload,'$.work.handoff.open')=1 AND json_extract(payload,'$.work.handoff.triageMemberId') IS NULL;
CREATE INDEX IF NOT EXISTS current_inbox_proposed_by ON current_room_records(room_id,json_extract(payload,'$.work.proposedById'),record_key DESC) WHERE domain='workSummary' AND json_extract(payload,'$.work.state')='proposed';
CREATE INDEX IF NOT EXISTS current_inbox_open_requests ON current_room_records(room_id,json_extract(payload,'$.recipientId'),record_key DESC) WHERE domain='replyRequests' AND json_extract(payload,'$.status')='open';
`;
