// Room file staging refusals name the limit that fired (Fo's 409 repro, muse-room
// seq 21074-21120): a 5765-byte part staged and a 5756-byte part was refused one
// call later because the uploader's byte total, which counts staged and DM-bound
// files other members cannot see, had about 6 KB left. The 409 now says so.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { attachmentLimits } from "../server/attachment-schema.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  const stage = (id, bytes) => store.roomAttachments.stage(key, "commons",
    { id, filename: `${id}.patch`, mediaType: "text/x-diff", data: Buffer.alloc(bytes, 97).toString("base64") });
  return { store, stage };
}

test("the staged-file limit names itself with used, max and remaining", t => {
  const f = fixture(t);
  for (let i = 0; i < attachmentLimits.stagedPerMember; i++) f.stage(`part-${i}`, 10);
  assert.throws(() => f.stage("one-more", 10), error => {
    assert.equal(error.status, 409); assert.equal(error.code, "attachment_quota");
    assert.deepEqual(error.detail.quota, { limit: "staged_files", used: attachmentLimits.stagedPerMember,
      max: attachmentLimits.stagedPerMember, remaining: 0, requested: 1, unit: "files" });
    assert.match(error.message, /staged files limit has 0 files left/);
    assert.match(error.message, /Nothing was stored/);
    return true;
  });
});

test("the uploader byte limit reports exactly what is left, so a smaller part can fit", t => {
  const f = fixture(t), mib = attachmentLimits.fileBytes, leave = 6000;
  const fill = attachmentLimits.memberBytes - leave;
  let staged = 0, n = 0;
  while (staged < fill) { const size = Math.min(mib, fill - staged); f.stage(`fill-${n++}`, size); staged += size; }
  assert.throws(() => f.stage("too-big", leave + 1), error => {
    assert.deepEqual(error.detail.quota, { limit: "uploader_bytes", used: fill, max: attachmentLimits.memberBytes,
      remaining: leave, requested: leave + 1, unit: "bytes" });
    assert.match(error.message, /uploader bytes limit has 6000 bytes left/);
    return true;
  });
  // The detail is enough to act on: a part of exactly the remaining size fits.
  assert.equal(f.stage("fits", leave).status, "staged");
});
