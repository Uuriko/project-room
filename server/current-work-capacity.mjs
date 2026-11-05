import {boardStateForWorkItem} from './work-item-state.mjs';
import {countsTowardOpenCap,roomWorkClaimConfig,STALE_UNCLAIMED_DAYS} from './work-claims.mjs';
import {ServiceError} from './service-error.mjs';

// A derived index of canonical work, not a second claim authority. Timed
// accepted cards leave the cap exactly when both lease and dormancy allow it.
export function currentWorkCapacity(item) {
  const value={version:1,id:item.id,card:item.state!=='proposed',open:false,until:null};
  if(!value.card)return value;
  if(item.state==='accepted') {
    value.open=true;const at=Date.parse(item.updatedAt||item.createdAt);
    if(Number.isFinite(at)) {
      const expires=item.claim?.status==='active'?Date.parse(item.claim.expiresAt):NaN;
      value.until=Math.max(at+STALE_UNCLAIMED_DAYS*86400000,Number.isFinite(expires)?expires:-Infinity);
    }
  } else value.open=countsTowardOpenCap({state:boardStateForWorkItem(item,0)},0);
  return value;
}
const open="domain='workCapacity' AND json_extract(payload,'$.open')=1";
const permanent=open+" AND json_type(payload,'$.until')='null'";
const timed=open+" AND json_type(payload,'$.until')='integer'";
export const CURRENT_WORK_CAPACITY_INDEXES=`
CREATE INDEX IF NOT EXISTS current_native_capacity_permanent ON current_room_records(room_id,record_key) WHERE ${permanent};
CREATE INDEX IF NOT EXISTS current_native_capacity_timed ON current_room_records(room_id,json_extract(payload,'$.until'),record_key) WHERE ${timed};
`;
export function assertCurrentWorkCapacity(store,roomId,head,previous,item,at,charge) {
  if(previous?.state!=='proposed'||item.state!=='accepted')return;
  if(head.counts.workCapacity!==head.counts.workItems)throw Error('current_room_corrupt: incomplete native capacity qualification');
  const db=store.db,size=db.prepare('SELECT length(CAST(config_json AS BLOB)) bytes FROM work_claim_config WHERE room_id=?').get(roomId);
  if(size?.bytes>131072)throw new ServiceError(409,'current_room_context_unavailable','Native capacity policy exceeds the addressed input bound');
  charge((size?.bytes??0)+256);
  const raw=size?JSON.parse(db.prepare('SELECT config_json FROM work_claim_config WHERE room_id=?').get(roomId).config_json):{};
  const {maxOpenClaims:cap}=roomWorkClaimConfig({workClaims:raw});
  // The independently qualified complete work census is an upper bound.
  // Otherwise COUNT examines at most cap indexed entries, not all history.
  if(head.counts.workItems<cap)return;
  const fixed=db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM current_room_records INDEXED BY current_native_capacity_permanent WHERE room_id=? AND ${permanent} LIMIT ?)`)
    .get(roomId,cap).n;charge(256);
  const expiring=fixed>=cap?0:db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM current_room_records INDEXED BY current_native_capacity_timed WHERE room_id=? AND ${timed} AND json_extract(payload,'$.until')>? LIMIT ?)`)
    .get(roomId,at,cap-fixed).n;charge(256);
  if(fixed+expiring>=cap)throw new ServiceError(409,'work_board_full',`This room already has ${cap} open work items. Close or complete current work before accepting another.`);
}
