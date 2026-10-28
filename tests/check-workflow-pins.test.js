import test from "node:test";
import assert from "node:assert/strict";
import { checkSource, checkRepo, refProblem } from "../scripts/check-workflow-pins.mjs";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const wrap = steps => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;

test("a SHA-pinned ref and a local ref pass", () => {
  assert.deepEqual(checkSource(wrap(`      - uses: actions/checkout@${SHA} # v4\n      - uses: ./.github/actions/x`)), []);
});

test("tag, branch and truncated-SHA refs fail", () => {
  for (const ref of ["actions/checkout@v4", "actions/checkout@main", `actions/checkout@${SHA.slice(0, 36)}`, "actions/checkout"])
    assert.equal(checkSource(wrap(`      - uses: ${ref}`)).length, 1, ref);
});

test("a value on the next line, a flow mapping and quotes cannot hide a ref", () => {
  assert.equal(checkSource(wrap("      - uses:\n          evil/x@v1")).length, 1);
  assert.equal(checkSource(wrap("      - {uses: evil/q@v1}")).length, 1);
  assert.equal(checkSource(wrap('      - uses: "evil/y@v1"')).length, 1);
  assert.equal(checkSource(wrap("      - uses: 'evil/z@v1'")).length, 1);
});

test("a docker:// ref needs a sha256 digest", () => {
  assert.equal(checkSource(wrap("      - uses: docker://evil/img:latest")).length, 1);
  assert.deepEqual(checkSource(wrap(`      - uses: docker://alpine@sha256:${"a".repeat(64)}`)), []);
});

test("reusable workflow refs (job-level uses) and composite action steps are checked", () => {
  assert.equal(checkSource("jobs:\n  a:\n    uses: org/repo/.github/workflows/w.yml@main\n").length, 1);
  assert.equal(checkSource("runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n").length, 1);
  assert.equal(checkSource("runs:\n  using: docker\n  image: docker://evil/img:1\n").length, 1);
});

test("a non-string uses value is refused", () => {
  assert.match(refProblem(null), /not a non-empty string/);
  assert.equal(checkSource(wrap("      - uses:")).length, 1);
});

test("the repository's own workflows are all pinned", () => {
  assert.deepEqual(checkRepo("."), []);
});
