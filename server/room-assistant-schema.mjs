export const terminalExpression="json_extract(value,'$.status') IN ('done','cancelled','failed')";
export const ROOM_ASSISTANT_INDEXES=Object.freeze([
 {name:'room_assistant_status',sql:`CREATE INDEX room_assistant_status ON room_assistant_runs(room_id,(${terminalExpression}))`},
 {name:'room_assistant_source',sql:"CREATE INDEX room_assistant_source ON room_assistant_runs(room_id,json_extract(value,'$.sourceMessageId'))"}
]);
export const roomAssistantSchema = `
CREATE TABLE IF NOT EXISTS room_assistant_config (room_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_assistant_runs (room_id TEXT NOT NULL, run_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(room_id,run_id));
CREATE TABLE IF NOT EXISTS room_assistant_ops (room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room_id,actor_id,request_id));`+ROOM_ASSISTANT_INDEXES.map(row=>row.sql.replace('CREATE INDEX','CREATE INDEX IF NOT EXISTS')+';').join('');
export function verifyRoomAssistantIndexes(db){
 for(const index of ROOM_ASSISTANT_INDEXES)if(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name)?.sql!==index.sql)throw Object.assign(Error('Assistant lookup indexes require reconciliation'),{status:409,code:'assistant_index_unavailable'});
}
