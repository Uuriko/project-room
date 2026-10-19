import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
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
if (!existsSync(dest)) {
  // Publish atomically (#4264): write the module to a per-process temp file
  // in the same directory, then rename it into place. Under `node --test`,
  // every test-file process imports this module simultaneously on a cold
  // checkout; the previous bare writeFileSync(dest) let a process import a
  // torn, partially written file and die at load. With rename publishing,
  // dest only ever exists complete — a racing importer either sees it whole
  // or materializes it itself the same way.
  const tmp = join(dir, `.acceptance-fixture.${digest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp.mjs`);
  writeFileSync(tmp, gunzipSync(Buffer.from(payload, "base64")));
  try {
    renameSync(tmp, dest);
  } catch {
    // Another process published first (POSIX rename of identical bytes is
    // harmless anyway) or the rename failed; dest, if present, is complete.
    // If dest is still absent the import below fails loudly, as it should.
  }
  rmSync(tmp, { force: true });
}
const mod = await import(pathToFileURL(dest).href);
export const createAcceptanceFixture = mod.createAcceptanceFixture;
