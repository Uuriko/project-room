import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACKUP_BINDING } from "../cloudflare/room-backup.mjs";

// The daily room-backup job (server/jobs.mjs) is enabled only when the
// production Worker carries the R2 binding the backup path reads:
// enabled=backupConfigured(env) checks env[BACKUP_BINDING]. If the binding
// ever drops out of the checked-in config, backups silently stop — the job
// logs "ROOM_BACKUPS is not configured" and skips, and dashboard-added
// bindings do not survive the next deploy (docs/BACKUPS.md). This pins the
// config side of that contract: the binding name the code reads, on the
// production env that owns the Durable Object and the cron, pointing at the
// documented bucket.
test("production worker binds the backup R2 bucket the daily backup job reads", () => {
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  const buckets = release.env.production.r2_buckets ?? [];
  const backup = buckets.find(b => b.binding === BACKUP_BINDING);
  assert.ok(
    backup,
    `env.production must declare the ${BACKUP_BINDING} R2 binding or the daily room-backup job stays disabled`,
  );
  assert.equal(backup.bucket_name, "project-room-backups");
});
