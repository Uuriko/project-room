// Daily Durable Object backup. The cron calls this only when the owning
// script has an R2 binding named ROOM_BACKUPS. No binding means skip.
// A binding that cannot put and head is an error, so a broken bucket is
// logged instead of looking like a quiet success.
export const BACKUP_BINDING = "ROOM_BACKUPS";
export const BACKUP_PREFIX = "room-backups/";

export function backupObjectKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${BACKUP_PREFIX}${year}-${month}-${day}.ndjson`;
}

function backupBucket(env) {
  const bucket = env?.[BACKUP_BINDING];
  if (bucket == null) return null;
  if (typeof bucket.put !== "function" || typeof bucket.head !== "function") throw new Error("ROOM_BACKUPS binding is missing put or head");
  return bucket;
}

export async function writeDailyBackup(env, room, now = new Date()) {
  const bucket = backupBucket(env);
  if (!bucket) return { skipped: "unconfigured" };
  const key = backupObjectKey(now);
  if (await bucket.head(key)) return { skipped: "exists", key };
  const body = await room.exportRoomNdjson();
  await bucket.put(key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
  return { wrote: key };
}
