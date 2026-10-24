import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const dir = dirname(fileURLToPath(import.meta.url));
let payload = readFileSync(join(dir, ".acceptance-fixture.b64"), "utf8").trim();
const fixPath = join(dir, ".acceptance-fixture.b64.fix");
if (existsSync(fixPath)) {
  const chars = payload.split("");
  for (const line of readFileSync(fixPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    const pos = Number(line.slice(0, i));
    chars[pos] = line.slice(i + 1);
  }
  payload = chars.join("");
}
const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
const dest = join(dir, `.acceptance-fixture.${digest}.generated.mjs`);
const decoded = gunzipSync(Buffer.from(payload, "base64"));
const decodedDigest = createHash("sha256").update(decoded).digest("hex");
// The generated module is a cache of the decoded payload, never a source of
// truth: verify it by digest before importing and regenerate on any mismatch.
// A bare existence check let one truncated write (0 bytes, e.g. an EPERM
// write fault mid-write) poison every importing suite until a human deleted
// the file by hand. The rewrite is atomic (sibling temp file + rename), so a
// failed regeneration can never replace a good copy with a partial one.
let cached = null;
try { cached = readFileSync(dest); } catch { cached = null; }
if (!cached || createHash("sha256").update(cached).digest("hex") !== decodedDigest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, decoded);
  renameSync(tmp, dest);
}
const mod = await import(pathToFileURL(dest).href);
export const createAcceptanceFixture = mod.createAcceptanceFixture;
