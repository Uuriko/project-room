// Static weak-test scan: for each test file, list top-level test() blocks and count assertions inside.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
const results = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const blocks = [];
  // find top-level test( / test.only( / test.skip( / it( calls
  const re = /(?:^|[;\n])\s*(?:test|it)(?:\.\w+)*\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const startParen = src.indexOf("(", m.index + m[0].length - 1);
    // find the opening brace of the callback after the paren args... simpler: find first "{" after startParen that is part of an arrow/async fn
    const after = src.slice(startParen);
    // locate test name (first string arg)
    const nameMatch = after.match(/\(\s*["'`]([^"'`]{0,200})/);
    const name = nameMatch ? nameMatch[1] : "?";
    // find body: first "=>" then its "{"
    const arrowIdx = after.indexOf("=>");
    let bodyStart = -1;
    if (arrowIdx !== -1) {
      const brace = after.indexOf("{", arrowIdx);
      if (brace !== -1) bodyStart = startParen + brace;
    }
    if (bodyStart === -1) { blocks.push({ name, assertions: 0, lines: 0, note: "no-body-found" }); continue; }
    // brace match
    let depth = 0, i = bodyStart, body = "";
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) { body = src.slice(bodyStart, i + 1); break; } }
    }
    const lines = body.split("\n").length;
    const asserts = (body.match(/(^|[^\w$.])(assert\.(ok|equal|deepEqual|strictEqual|deepStrictEqual|throws|rejects|doesNotThrow|match|notEqual|fail|ifError|notStrictEqual)\s*\()/g) || []).length
      + (body.match(/(^|[^\w$.])expect\s*\(/g) || []).length
      + (body.match(/(^|[^\w$.])t\.assert/g) || []).length;
    const onlyTrue = /assert\.ok\(\s*true\s*\)/.test(body) && asserts <= 1;
    blocks.push({ name, assertions: asserts, lines, weak: asserts === 0 || onlyTrue });
  }
  results.push({ file: f, tests: blocks.length, weak: blocks.filter(b => b.weak) });
}
console.log(JSON.stringify(results, null, 1));
