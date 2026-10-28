// REL-20: disposable local server for perf/local-baseline.js. Never prod.
// Usage: node perf/local-server.mjs  (writes throwaway fixture keys to K6_KEYS_FILE)
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const keysFile = process.env.K6_KEYS_FILE || join(tmpdir(), "pr-perf-keys.json");
const port = Number(process.env.PERF_PORT || 18787);
const { createAcceptanceFixture } = await import(`${root}/scripts/acceptance-fixture.mjs`);
const { createRoomServer } = await import(`${root}/server/http.mjs`);
const f = createAcceptanceFixture();
const server = createRoomServer({ store: f.store });
await new Promise(r => server.listen(port, "127.0.0.1", r));
writeFileSync(keysFile, JSON.stringify(f.keys), { mode: 0o600 }); // throwaway fixture keys, local only
console.log("listening", server.address().port, "keys", keysFile);
