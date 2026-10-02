// Workerd proof that GET /api/operator/export is answered by the Durable
// Object: 404 when the backup token is unset, 401 or 405 when it is set and
// the request does not match, NDJSON when the token matches.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const origin = "https://room.example.test";
const backupToken = "operator-backup-value";

test("operator export streams NDJSON for the backup token and refuses anything else", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./room.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"]
  });
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "ProjectRoom", useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, ROOM_BACKUP_TOKEN: backupToken }
  });
  const call = (headers = {}, method = "GET") => mf.dispatchFetch(origin + "/api/operator/export", { method, headers: { "CF-Connecting-IP": "192.0.2.10", ...headers } });
  try {
    const wrong = await call({ authorization: "Bearer wrong-token" });
    assert.equal(wrong.status, 401);
    const posted = await call({ authorization: `Bearer ${backupToken}` }, "POST");
    assert.equal(posted.status, 405);
    const ok = await call({ authorization: `Bearer ${backupToken}` });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.match(ok.headers.get("content-type") ?? "", /application\/x-ndjson/);
    assert.match(await ok.text(), /"kind":"watermark"/);
  } finally {
    await mf.dispose();
  }
});

test("operator export is 404 when ROOM_BACKUP_TOKEN is unset", async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./room.mjs", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"]
  });
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { ROOM: { className: "ProjectRoom", useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin }
  });
  try {
    const response = await mf.dispatchFetch(origin + "/api/operator/export", { headers: { "CF-Connecting-IP": "192.0.2.10", authorization: `Bearer ${backupToken}` } });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found\n");
  } finally {
    await mf.dispose();
  }
});
