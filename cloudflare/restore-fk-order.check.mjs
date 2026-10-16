// #3324: operator restore from the KV daily backup on the real Durable Object
// SQLite engine, which enforces foreign keys for the whole replay (the
// foreign_keys=OFF pragma is ignored there). Regression for the large-backup
// case: a child table's batch (500 events) committed before the single
// buffered rooms row landed, failing the restore with FOREIGN KEY constraint
// failed and leaving the store empty after cleanup. The fix flushes FK
// dependencies before a batch and defers FK checks to each batch COMMIT.
// The small control case proves the normal path still verifies and survives
// a restart. Mirrors the independent Worker regression published on
// Uuriko/project-room#3324, kept repo-side so the batched KV replay path
// stays covered as the restore code evolves.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
import { exportNdjsonStream } from "../server/room-export.mjs";
import { writeKvBackup } from "./room-backup.mjs";

const source = process.env.ROOM_SOURCE_ROOT || process.cwd();
const require = createRequire(join(source, "cloudflare/package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");

const fixture = `
import entry, { ProjectRoom } from "./room.mjs";
export class RestoreProbeRoom extends ProjectRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__fixture/state") {
      const db = this.store.db;
      return Response.json({
        rooms: db.prepare("SELECT count(*) AS n FROM rooms").get().n,
        events: db.prepare("SELECT count(*) AS n FROM events").get().n,
        permit: db.prepare("SELECT enabled FROM public_work_claim_writer_permit WHERE singleton=1").get().enabled,
      });
    }
    return super.fetch(request);
  }
}
export default entry;
`;

const bundled = await build({ stdin: { contents: fixture, resolveDir: join(source, "cloudflare"), sourcefile: "restore-fk-order-fixture.mjs" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:*"] });

for (const messages of [10, 510]) {
  test(`operator Worker restore survives restart with ${messages} messages`, { timeout: 120000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "restore-fk-order-"));
    let mf, seed;
    try {
      const origin = "https://room.example.test", token = randomUUID();
      const config = {
        modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ROOM: { className: "RestoreProbeRoom", useSQLite: true } },
        durableObjectsPersist: join(directory, "persist"),
        kvNamespaces: ["ROOM_BACKUPS_KV"], kvPersist: join(directory, "kv"),
        bindings: { ROOM_ORIGIN: origin, ROOM_BACKUP_TOKEN: token },
      };
      mf = new Miniflare(config);
      seed = new RoomStore(join(directory, "seed.sqlite"));
      const events = [...initialRoom(), ...Array.from({ length: messages }, (_, i) =>
        event({ roomId: "commons", actorId: "owner", type: T.MESSAGE_POSTED, data: { messageId: `fk-order-${i}`, body: `Synthetic restore ${i}` } }))];
      seed.initialize(events);
      const kv = await mf.getKVNamespace("ROOM_BACKUPS_KV");
      const key = "room-backups/2026-10-15.ndjson";
      await writeKvBackup(kv, key, exportNdjsonStream(seed.db), { partBytes: 16384 });
      const state = async () => { const r = await mf.dispatchFetch(`${origin}/__fixture/state`); assert.equal(r.status, 200); return r.json(); };
      assert.deepEqual(await state(), { rooms: 0, events: 0, permit: 0 });
      const restored = await mf.dispatchFetch(`${origin}/api/operator/restore-from-backup`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ key }),
      });
      const result = await restored.json();
      assert.equal(restored.status, 200, JSON.stringify(result));
      assert.equal(result.verified, true);
      assert.equal(result.contentVerification, "full");
      assert.equal(result.events, events.length);
      assert.deepEqual(await state(), { rooms: 1, events: events.length, permit: 0 });
      await mf.dispose();
      mf = new Miniflare(config);
      assert.deepEqual(await state(), { rooms: 1, events: events.length, permit: 0 });
    } finally {
      seed?.close();
      await mf?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
