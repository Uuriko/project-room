import {ServiceError} from './service-error.mjs';

// Existing legacy authorities remain intact and inspectable. Automatic
// indexes make a negative conversion gate independent of retired-row volume.
const claimData="(CASE WHEN json_type(item_json,'$.v') IN ('integer','real') THEN json_extract(item_json,'$.data') ELSE item_json END)";
const activeClaim=`COALESCE(json_extract(${claimData},'$.state'),'unclaimed') NOT IN ('done','closed')`;
const activeAssignment="json_extract(record_json,'$.status') IS NOT 'released'";
export const CURRENT_LEGACY_WORK_INDEXES=`
CREATE INDEX IF NOT EXISTS current_legacy_open_claims ON work_claims(room_id,claim_id) WHERE ${activeClaim};
CREATE INDEX IF NOT EXISTS current_legacy_assigned_threads ON collab_assignments(room_id,thread_id) WHERE ${activeAssignment};
`;
export const CURRENT_LEGACY_WORK_GUARDS=[];
for(const [table,predicate] of [['work_claims',activeClaim],['collab_assignments',activeAssignment]]) {
  for(const operation of ['INSERT','UPDATE']) {
    const column=table==='work_claims'?'item_json':'record_json';
    const active=row=>predicate.replaceAll(column,row+'.'+column);
    const reopened=operation==='INSERT'?'1':`(NEW.room_id IS NOT OLD.room_id OR NOT (${active('OLD')}))`;
    const name=`current_room_guard_${table}_legacy_${operation.toLowerCase()}`;
    CURRENT_LEGACY_WORK_GUARDS.push([name,`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${operation} ON ${table}
      WHEN EXISTS(SELECT 1 FROM current_room_head WHERE room_id=NEW.room_id) AND (${active('NEW')}) AND ${reopened}
      BEGIN SELECT RAISE(ABORT,'normalized room requires native work; legacy release close and inspection remain available'); END`]);
  }
}
export function assertLegacyWorkReconciled(db,roomId) {
  if(db.prepare(`SELECT 1 FROM work_claims INDEXED BY current_legacy_open_claims WHERE room_id=? AND ${activeClaim} LIMIT 1`).get(roomId))
    throw new ServiceError(409,'current_room_legacy_work_unreconciled',`Reconcile active legacy board work before conversion. Inspect GET /api/rooms/${encodeURIComponent(roomId)}/work-claims-read and retain each recorded outcome.`);
  if(db.prepare(`SELECT 1 FROM collab_assignments INDEXED BY current_legacy_assigned_threads WHERE room_id=? AND ${activeAssignment} LIMIT 1`).get(roomId))
    throw new ServiceError(409,'current_room_legacy_work_unreconciled',`Reconcile active collaboration assignments before conversion. Inspect GET /api/rooms/${encodeURIComponent(roomId)}/collab/assignments and retain each recorded outcome.`);
}
