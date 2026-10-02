import { readFileSync } from "node:fs";
import { TAG_PATTERN, RECEIPT_BLOB_MAX } from "../lib/protocol.mjs";
import { keyframes, manifestBytes, appendManifest } from "../lib/recording.mjs";
import { stageFile, updateClaim } from "../lib/room.mjs";

function machineTag(label) {
  const body = String(label || "host").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "host";
  const tag = `machine-${body}`.slice(0, 32);
  return TAG_PATTERN.test(tag) ? tag : "machine-host";
}

function slotTag(slot) {
  const tag = `slot-${slot}`.slice(0, 32);
  return TAG_PATTERN.test(tag) ? tag : "slot-desk";
}

export async function stageReceipt({ origin, roomId, secret, home, claimId, label, slot }) {
  appendManifest(home, claimId, {
    at: new Date().toISOString(),
    tool: "bot.finish",
    args: {},
    resultHash: null,
    frameHash: null,
  });
  const blobs = [];
  const stagedManifest = await stageFile(origin, roomId, secret, {
    filename: "manifest.jsonl",
    mediaType: "text/plain",
    bytes: manifestBytes(home, claimId),
  });
  if (stagedManifest.ok) blobs.push(stagedManifest.blob);
  for (const [index, path] of keyframes(home, claimId).entries()) {
    if (blobs.length >= RECEIPT_BLOB_MAX) break;
    const bytes = readFileSync(path);
    const staged = await stageFile(origin, roomId, secret, {
      filename: `frame-${index}.png`,
      mediaType: "image/png",
      bytes,
    });
    if (staged.ok) blobs.push(staged.blob);
  }
  const tags = [machineTag(label), "lease", slotTag(slot), "bot"].filter(tag => TAG_PATTERN.test(tag)).slice(0, 10);
  return { blobs: blobs.slice(0, RECEIPT_BLOB_MAX), tags };
}

export async function closeClaim(origin, roomId, secret, claimId, { blobs, tags, note }) {
  const progressed = await updateClaim(origin, roomId, secret, claimId, { state: "in_progress" });
  if (!progressed.ok) return { ok: false, status: progressed.status };
  const done = await updateClaim(origin, roomId, secret, claimId, {
    state: "done",
    deliveryMode: "result",
    tags,
    blobs,
    note,
  });
  return { ok: done.ok, status: done.status };
}
