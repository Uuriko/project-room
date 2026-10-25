// BG-1 boot-graph census driver: the canonical FIXTURE boot — the shape the
// repo's suites have always used (an in-memory store handed straight to
// createRoomServer, no boot-options wiring, no config gate arguments).
// Driven by tests/boot-graph.test.js under the module-census recorder; not
// a test file itself. Boots, answers one /api/health request (the same
// single request the production boot is driven with), then exits.
import { RoomStore } from "../../server/store.mjs";
import { createRoomServer } from "../../server/http.mjs";

const store = new RoomStore(":memory:");
const server = createRoomServer({ store });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: "close" } });
await response.text();
console.log(`fixture boot ready: GET /api/health -> ${response.status}`);
store.close();
process.exit(0);
