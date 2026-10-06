// Phase 1a way back: inline every slim rooms.projection row so code that
// predates projection-codec reads plain JSON again. Run with the flag off,
// before rolling back past Phase 1a:  node scripts/phase1a-inline-rooms.mjs <db.sqlite>
// Idempotent; prints how many rows it inlined.
import { DatabaseSync } from "node:sqlite";
import { rehydrateAllRooms } from "../server/projection-codec.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/phase1a-inline-rooms.mjs <db.sqlite>"); process.exit(2); }
const db = new DatabaseSync(file);
db.exec("BEGIN IMMEDIATE");
try { const rows = rehydrateAllRooms(db); db.exec("COMMIT"); console.log(JSON.stringify({ inlined: rows })); }
catch (error) { db.exec("ROLLBACK"); throw error; }
finally { db.close(); }
