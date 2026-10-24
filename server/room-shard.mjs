// Facade for the per-room object work. The Worker re-exports this module
// so the classification stays on the runtime import graph. Later steps add
// their functions here. Nothing in this module reads or writes a room.
export { assertShardClassification, roomKeyColumn, tableHome } from "./room-shard-tables.mjs";
export { ensureStorageHomeIfEnabled, perRoomObjectsEnabled, readStorageHome, storageHomeColumnPresent } from "./room-shard-flag.mjs";
