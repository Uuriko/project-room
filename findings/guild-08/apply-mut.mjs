// Applies mutspec[i] to target. Prints APPLIED n / NOOP.
import { readFileSync, writeFileSync } from "node:fs";
const [specPath, idxStr, target] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"))[Number(idxStr)];
const src = readFileSync(target, "utf8");
const re = new RegExp(spec.pattern, spec.global ? "g" : "");
const matches = (src.match(re) || []).length;
if (matches === 0) { console.log("NOOP"); process.exit(0); }
writeFileSync(target, src.replace(re, spec.replacement));
console.log("APPLIED " + matches);
