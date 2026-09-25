import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const b64 = readFileSync(join(dir, ".calm-return.b64"), "utf8").trim();
const dest = join(dir, ".calm-return-browser-check.generated.mjs");
writeFileSync(dest, gunzipSync(Buffer.from(b64, "base64")));
await import(dest);
