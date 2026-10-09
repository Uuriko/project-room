import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const dir = dirname(fileURLToPath(import.meta.url));

// Apply a `.b64.fix` file: one "<pos>:<replacement>" substitution per line.
// Fails loud on malformed lines — the old loop silently corrupted the payload
// instead: a line without a colon parsed as pos 0, an out-of-range pos padded
// the payload with empty strings, and an empty replacement deleted a char.
export function applyFixtureFix(payload, fixText) {
  const chars = payload.split("");
  fixText.split("\n").forEach((line, idx) => {
    if (!line.trim()) return;
    const i = line.indexOf(":");
    const pos = i === -1 ? NaN : Number(line.slice(0, i));
    const replacement = i === -1 ? "" : line.slice(i + 1);
    if (!Number.isInteger(pos) || pos < 0 || pos >= chars.length || replacement.length === 0) {
      throw new Error(`acceptance-fixture: malformed fix line ${idx + 1}: ${JSON.stringify(line)}`);
    }
    chars[pos] = replacement;
  });
  return chars.join("");
}

let payload = readFileSync(join(dir, ".acceptance-fixture.b64"), "utf8").trim();
const fixPath = join(dir, ".acceptance-fixture.b64.fix");
if (existsSync(fixPath)) payload = applyFixtureFix(payload, readFileSync(fixPath, "utf8"));
const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
const dest = join(dir, `.acceptance-fixture.${digest}.generated.mjs`);
// Atomic materialization: a wave's workers all import this module at once, and
// the old existsSync→writeFileSync sequence let a worker import a partially
// written file (SyntaxError). Write to a pid-unique temp file and rename, so
// the destination is always complete; concurrent renames carry identical bytes.
if (!existsSync(dest)) {
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, gunzipSync(Buffer.from(payload, "base64")));
  try {
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    if (!existsSync(dest)) throw err;
  }
}
const mod = await import(pathToFileURL(dest).href);
export const createAcceptanceFixture = mod.createAcceptanceFixture;
