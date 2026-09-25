import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const dir = dirname(fileURLToPath(import.meta.url));
const dest = join(dir, ".acceptance-fixture.generated.mjs");
writeFileSync(dest, gunzipSync(Buffer.from(readFileSync(join(dir, ".acceptance-fixture.b64"), "utf8"), "base64")));
const mod = await import(pathToFileURL(dest).href);
export const createAcceptanceFixture = mod.createAcceptanceFixture;
