import { initialRoom } from '../../server/bootstrap.mjs';
import { wakeListenerLeaseSchema, wakeRoomActivitySchema } from '../../server/agent-heartbeats.mjs';
import { PATROL_SCHEMA } from '../../server/patrol.mjs';
import { PROJECT_MAP_SCHEMA } from '../../server/project-map-store.mjs';
import { PROJECTION_SHAPE_UPGRADES_SCHEMA } from '../../server/legacy-message-shape.mjs';
export const lazyRestoreTables = ['agent_wake_listener_leases','agent_wake_signal_claims','agent_host_disconnects','agent_wake_room_activity',
  'integrity_failures','patrol_cursor','patrol_claims','patrol_messages','patrol_findings','patrol_blocks',
  'project_maps','project_map_queue','project_map_pulls','project_map_notices','projection_shape_upgrades'];
export function seedLazyRestoreStore(store) {
  store.initialize(initialRoom('commons'));
  const db=store.db;
  db.exec(wakeListenerLeaseSchema);db.exec(wakeRoomActivitySchema);db.exec(PATROL_SCHEMA);db.exec(PROJECT_MAP_SCHEMA);db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
  store.recordIntegrityFailure('messages_parity','commons',new Error('messages parity failed for commons: fixture'));
  db.exec(`
    INSERT INTO agent_wake_listener_leases VALUES('agent','commons','listener','synthetic-fence',1,1);
    INSERT INTO agent_wake_signal_claims VALUES('signal','agent','synthetic-fence',1,0);
    INSERT INTO agent_host_disconnects VALUES('agent','host',1);
    INSERT INTO agent_wake_room_activity VALUES('agent','commons',1);
    INSERT INTO patrol_cursor VALUES('commons',1,'event',0,NULL);
    INSERT INTO patrol_claims VALUES('commons','claim','done','owner',1,1);
    INSERT INTO patrol_messages VALUES('commons','message','owner','digest','2026-10-31',0,0,1);
    INSERT INTO patrol_findings VALUES(1,'commons',1,'event','sequence','fixture','message','metadata','2026-10-31');
    INSERT INTO patrol_blocks VALUES('commons',1,'event',1,'fixture','metadata',1);
    INSERT INTO project_maps VALUES('commons','fixture/repo','revision',1,'fixture','{}');
    INSERT INTO project_map_queue VALUES(1,'commons','fixture/repo','{}',1);
    INSERT INTO project_map_pulls VALUES('commons','fixture/repo',1,'fixture','open','[]','claim',1);
    INSERT INTO project_map_notices VALUES('commons','notice','event',1);
    INSERT INTO projection_shape_upgrades VALUES('commons',1,'projection',1,1,1,'2026-10-31','2026-10-31');
  `);
}
export function lazyRestoreRows(store) {
  return Object.fromEntries(lazyRestoreTables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row}))]));
}
