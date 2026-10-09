// Partition 126 slice files into 16 hardening batches (H01..H16)
import { readFileSync } from "node:fs";
const files = readFileSync("findings/guild-08/files.txt", "utf8").trim().split("\n");
const N = 16;
const batches = Array.from({ length: N }, () => []);
files.forEach((f, i) => batches[i % N].push(f));
batches.forEach((b, i) => {
  const id = `H${String(i + 1).padStart(2, "0")}`;
  console.log(`${id}: ${b.length} files`);
});
import { writeFileSync } from "node:fs";
writeFileSync("findings/guild-08/batches.json", JSON.stringify(batches.map((b, i) => ({ id: `H${String(i + 1).padStart(2, "0")}`, files: b })), null, 1));
