import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadArtifact, downloadArtifact, sha256, artifactLimits, validateArtifact, roomFileTransport } from "../client/room-artifact-transfer.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "artifact-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = new Map(), calls = [], connection = { origin: "https://room.example", roomId: "room", memberId: "sender", token: "test" };
  let fail = null;
  const transport = async (path, options = {}) => {
    const { body, method = "GET" } = options; calls.push({ path, method });
    if (fail?.(path, options)) throw Object.assign(new Error("Disconnected"), { status: 503 });
    const id = path.split("/")[2];
    if (path === "/files" && method === "POST") {
      const bytes = Buffer.from(body.data, "base64");
      const file = { ...body, sha256: sha256(bytes), byteLength: bytes.length, uploaderId: "sender", state: "staged" };
      files.set(body.id, file); return { attachment: file };
    }
    const file = files.get(id); if (!file) throw Object.assign(new Error("not found"), { status: 404 });
    if (path.endsWith("/commit")) { file.state = "committed"; file.messageId = body.messageId; return { status: "committed", attachment: file }; }
    return method === "HEAD" ? null : { attachment: structuredClone(file) };
  };
  return { directory, files, calls, connection, transport, setFailure: value => { fail = value; } };
}
test("upload resumes after a disconnect without restaging committed chunks; download verifies whole input", async t => {
  const f = fixture(t), bytes = Buffer.alloc(artifactLimits.chunkBytes * 2 + 3, 42);
  const options = { ...f, bytes, operationId: "upload-1", messageId: "message-1" };
  let stages = 0;
  f.setFailure((path, o) => path === "/files" && o.method === "POST" && ++stages === 2);
  await assert.rejects(uploadArtifact(options), /Disconnected/);
  assert.equal(f.files.size, 1);
  f.setFailure(null);
  const reference = await uploadArtifact(options);
  assert.equal(f.files.size, 4);
  const uploaded = f.calls.filter(call => call.path === "/files").length;
  assert.deepEqual(await uploadArtifact(options), reference);
  assert.equal(f.calls.filter(call => call.path === "/files").length, uploaded);
  const result = await downloadArtifact({ ...f, reference });
  assert.deepEqual(result.bytes, bytes);
});
test("download restart reuses only verified chunks and still reauthorizes cached bytes", async t => {
  const f = fixture(t), bytes = Buffer.alloc(artifactLimits.chunkBytes + 10, 17);
  const reference = await uploadArtifact({ ...f, bytes, operationId: "resume", messageId: "msg" });
  let reads = 0;
  f.setFailure((path, o) => !path.endsWith("manifest") && o.method !== "HEAD" && ++reads === 2);
  await assert.rejects(downloadArtifact({ ...f, reference }), /Disconnected/);
  f.setFailure(null); f.calls.length = 0;
  assert.deepEqual((await downloadArtifact({ ...f, reference })).bytes, bytes);
  assert.equal(f.calls.filter(call => call.method === "HEAD").length, 1);
  f.setFailure((path, o) => o.method === "HEAD");
  await assert.rejects(downloadArtifact({ ...f, reference }), /Disconnected/);
});
test("corrupt cache is replaced; remote checksum mismatch and oversized manifests fail", async t => {
  const f = fixture(t), bytes = Buffer.from("verified bytes");
  const reference = await uploadArtifact({ ...f, bytes, operationId: "corrupt", messageId: "msg" });
  writeFileSync(join(f.directory, sha256(bytes)), "wrong");
  assert.deepEqual((await downloadArtifact({ ...f, reference })).bytes, bytes);
  rmSync(join(f.directory, sha256(bytes)));
  const chunk = [...f.files.values()].find(file => !file.id.endsWith("manifest")); chunk.data = Buffer.from("bad").toString("base64");
  await assert.rejects(downloadArtifact({ ...f, reference }), /checksum/);
  assert.throws(() => validateArtifact({ version: 1, sha256: sha256(bytes), byteLength: artifactLimits.bytes + 1, chunks: [] }));
  await assert.rejects(downloadArtifact({ ...f, reference: { ...reference, id: "../../escape" } }));
});
test("transport pins HTTPS origin, refuses redirects, and sets deadlines", async () => {
  let seen;
  const transport = roomFileTransport({ origin: "https://room.example", roomId: "room", memberId: "sender", token: "secret",
    fetchImpl: async (url, options) => { seen = { url, options }; return new Response("{}", { status: 200 }); } });
  await transport("/files/file");
  assert.equal(seen.options.redirect, "error"); assert.equal(seen.options.credentials, "omit"); assert.ok(seen.options.signal);
  await assert.rejects(transport("//attacker.example"));
  assert.throws(() => roomFileTransport({ origin: "http://attacker.example", roomId: "room", memberId: "sender", token: "secret" }));
});
