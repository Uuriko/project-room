// Applies breakspec[i] pattern->replacement to the target file. Prints APPLIED or NOOP.
import { readFileSync, writeFileSync } from "node:fs";
const [specPath, idxStr, target] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"))[Number(idxStr)];
const src = readFileSync(target, "utf8");
const re = new RegExp(spec.pattern);
if (!re.test(src)) { console.log("NOOP"); process.exit(0); }
writeFileSync(target, src.replace(re, spec.replacement));
console.log("APPLIED");
