import test from "node:test";
import assert from "node:assert/strict";
import { checkSource, checkRepo, refProblem, imageProblem, collectContainerImages } from "../scripts/check-workflow-pins.mjs";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const DIGEST = "a".repeat(64);
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
  assert.deepEqual(checkSource(wrap(`      - uses: docker://alpine@sha256:${DIGEST}`)), []);
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

test("a job container image must carry a sha256 digest", () => {
  const job = container => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    container: ${container}\n    steps:\n      - run: true\n`;
  assert.equal(checkSource(job("postgres:16")).length, 1, "scalar container with a mutable tag fails");
  assert.deepEqual(checkSource(job(`postgres@sha256:${DIGEST}`)), [], "scalar container pinned by digest passes");
  assert.equal(checkSource(job("postgres")).length, 1, "scalar container with no tag or digest fails");
  const mapped = `jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: postgres:16\n    steps:\n      - run: true\n`;
  assert.equal(checkSource(mapped).length, 1, "container mapping image with a mutable tag fails");
  assert.deepEqual(checkSource(mapped.replace("postgres:16", `postgres@sha256:${DIGEST}`)), [], "container mapping image pinned by digest passes");
  assert.deepEqual(collectContainerImages(mapped), ["postgres:16"]);
});

test("service images must carry a sha256 digest", () => {
  const withService = image => `jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: ${image}\n    steps:\n      - run: true\n`;
  assert.equal(checkSource(withService("redis:7")).length, 1, "service image with a mutable tag fails");
  assert.deepEqual(checkSource(withService(`redis@sha256:${DIGEST}`)), [], "service image pinned by digest passes");
  assert.deepEqual(collectContainerImages(withService("redis:7")), ["redis:7"]);
  assert.match(imageProblem("redis:7"), /sha256/);
  assert.equal(imageProblem(`redis@sha256:${DIGEST}`), null);
  assert.match(imageProblem(null), /not a non-empty string/);
});

test("a bare image outside container/services is not a container image", () => {
  // A docker action's `image:` may name a local Dockerfile; only the
  // docker:// form is a registry ref there, and it stays checked as before.
  assert.deepEqual(checkSource("runs:\n  using: docker\n  image: Dockerfile\n"), []);
});

test("the repository's own workflows are all pinned", () => {
  assert.deepEqual(checkRepo("."), []);
});
