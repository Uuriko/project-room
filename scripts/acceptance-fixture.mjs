import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
if (!existsSync(dest)) writeFileSync(dest, gunzipSync(Buffer.from(payload, "base64")));
const mod = await import(pathToFileURL(dest).href);
export const createAcceptanceFixture = mod.createAcceptanceFixture;
