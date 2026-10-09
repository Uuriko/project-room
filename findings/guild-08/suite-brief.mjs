// Emits a brief per suite: header comment, test names, assertion stats.
import { readFileSync } from "node:fs";
const files = process.argv.slice(2);
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const header = (src.match(/^(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\n?|#[^\n]*\n)+/) || [""])[0].trim().split("\n").slice(0, 18).join("\n");
  const tests = [...src.matchAll(/(?:^|[;\n])\s*(?:test|it)(?:\.\w+)*\s*\(\s*["'`]([^"'`]{1,120})/g)].map(m => m[1]);
  console.log("### " + f);
  console.log("header: " + (header ? header.replace(/\n/g, " | ").slice(0, 400) : "(none)"));
  console.log("tests(" + tests.length + "): " + tests.slice(0, 12).join(" ~ "));
  console.log("");
}
