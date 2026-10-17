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

export async function stageReceipt({ origin, roomId, secret, home, claimId, label, slot, isStopped = () => false }) {
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
  if (!stagedManifest.ok) return stagedManifest;
  blobs.push(stagedManifest.blob);
  for (const [index, path] of keyframes(home, claimId).entries()) {
    if (blobs.length >= RECEIPT_BLOB_MAX) break;
    if (isStopped()) return { ok: false, halted: true };
    const bytes = readFileSync(path);
    const staged = await stageFile(origin, roomId, secret, {
      filename: `frame-${index}.png`,
      mediaType: "image/png",
      bytes,
    });
    if (!staged.ok) return staged;
    blobs.push(staged.blob);
  }
  const tags = [machineTag(label), "lease", slotTag(slot), "bot"].filter(tag => TAG_PATTERN.test(tag)).slice(0, 10);
  return { ok: true, blobs: blobs.slice(0, RECEIPT_BLOB_MAX), tags };
}

export async function closeClaim(origin, roomId, secret, claimId, { blobs, tags, note, requestId, isStopped = () => false }) {
  const progressed = await updateClaim(origin, roomId, secret, claimId, { state: "in_progress", note: [note, ...(blobs.length ? [`Receipt ${blobs.join(" ")}`] : [])].join("\n"), requestId: `${requestId}-start` });
  if (!progressed.ok) return { ok: false, status: progressed.status };
  if (isStopped()) return { ok: false, halted: true };
  const done = await updateClaim(origin, roomId, secret, claimId, {
    state: "done", requestId: `${requestId}-done`,
    deliveryMode: "result", tags, blobs, note,
  });
  if (done.ok && done.value?.state === "done") return { ok: true, status: done.status, awaitingReview: false };
  // #3546: under a reviewed policy the claim cannot jump to done — the
  // holder delivers it with the receipt bundle and the reviewer verifies.
  // Deliver from the staged receipt blobs; if the platform refuses the
  // bundle (e.g. the claim carries acceptance criteria the bot cannot map),
  // the claim stays in_progress and the result still awaits review.
  if (done.value?.error?.code === "work_not_delivered" && blobs.length) {
    const bundle = { artifact: { kind: "receipt", ref: blobs[0], sha256: blobs[0].replace(/^sha256:/, "") },
      checks: [{ name: "machine_receipt", result: "pass" }], criteria: [] };
    const delivered = await updateClaim(origin, roomId, secret, claimId, {
      state: "delivered", requestId: `${requestId}-delivered`,
      deliveryMode: "result", tags, blobs, note, delivery: bundle,
    });
    return { ok: false, status: done.status, awaitingReview: true,
      delivered: Boolean(delivered.ok && delivered.value?.state === "delivered") };
  }
  return {
    ok: false, status: done.status,
    awaitingReview: done.status === 403 && done.value?.error?.code === "work_review_rejected",
  };
}
