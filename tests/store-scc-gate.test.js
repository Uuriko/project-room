// tests/store-scc-gate.test.js — regression tests for the store SCC gate
// (scripts/check-store-scc.mjs, SIMPLIFY-2026-10 §6 / deep-pass S-01).
// The gate ratchets the strongly connected component containing
// server/store.mjs against scripts/store-scc-baseline.json: growth (a new
// member, or a new import edge between members) must fail, shrinkage must
// pass, and importing { ServiceError } from store.mjs must fail even
// where it forms no cycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const script = join(root, "scripts", "check-store-scc.mjs");

const runGate = (cwd) => {
  const r = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  return { ...r, output: `${r.stdout}${r.stderr}` };
};

// Fixture graph: store <-> a, a -> b, b -> store is one SCC of 3.
// leaf.mjs hangs off a with no path back, so it is outside the SCC.
const fixtureFiles = {
  "store.mjs": `import { a } from "./a.mjs";\nexport const store = a;\n`,
  "a.mjs": `import { store } from "./store.mjs";\nimport { b } from "./b.mjs";\nimport { leaf } from "./leaf.mjs";\nexport const a = [store, b, leaf];\n`,
  "b.mjs": `import { store } from "./store.mjs";\nexport const b = store;\n`,
  "leaf.mjs": `export const leaf = 1;\n`,
};
const fixtureBaseline = {
  members: ["server/a.mjs", "server/b.mjs", "server/store.mjs"],
  edges: [
    "server/a.mjs -> server/b.mjs",
    "server/a.mjs -> server/store.mjs",
    "server/b.mjs -> server/store.mjs",
    "server/store.mjs -> server/a.mjs",
  ],
};

const withRepo = (files, baseline, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "scc-gate-"));
  try {
    mkdirSync(join(dir, "server"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "server", name), body);
    writeFileSync(join(dir, "scripts", "store-scc-baseline.json"), JSON.stringify(baseline));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("S-01 gate: the real tree satisfies its pinned baseline", () => {
  const r = runGate(root);
  assert.equal(r.status, 0, `gate should pass on the real tree, got: ${r.output}`);
  assert.match(r.output, /store SCC pinned: \d+ modules, \d+ intra-component edges/);
});

test("S-01 gate: a fixture at its baseline passes", () => {
  withRepo(fixtureFiles, fixtureBaseline, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 0, `unexpected failure: ${r.output}`);
  });
});

test("S-01 gate: NEGATIVE — a new module joining the SCC fails the gate", () => {
  const files = {
    ...fixtureFiles,
    // leaf gains a path back to store and store imports it: leaf joins.
    "leaf.mjs": `import { store } from "./store.mjs";\nexport const leaf = store;\n`,
    "store.mjs": `import { a } from "./a.mjs";\nimport { leaf } from "./leaf.mjs";\nexport const store = [a, leaf];\n`,
  };
  withRepo(files, fixtureBaseline, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `gate must fail on SCC growth, got: ${r.output}`);
    assert.match(r.output, /store SCC growth: server\/leaf\.mjs joined/);
  });
});

test("S-01 gate: NEGATIVE — a new edge between SCC members fails the gate", () => {
  const files = {
    ...fixtureFiles,
    // b -> a is a new intra-component edge; membership is unchanged.
    "b.mjs": `import { store } from "./store.mjs";\nimport { a } from "./a.mjs";\nexport const b = [store, a];\n`,
  };
  withRepo(files, fixtureBaseline, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `gate must fail on a new intra-component edge, got: ${r.output}`);
    assert.match(r.output, /new intra-component edge server\/b\.mjs -> server\/a\.mjs/);
  });
});

test("S-01 gate: NEGATIVE — importing ServiceError from store.mjs fails even with no cycle", () => {
  const files = {
    ...fixtureFiles,
    "leaf.mjs": `import { ServiceError } from "./store.mjs";\nexport const leaf = ServiceError;\n`,
  };
  withRepo(files, fixtureBaseline, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 1, `gate must fail on a ServiceError import from store.mjs, got: ${r.output}`);
    assert.match(r.output, /server\/leaf\.mjs: imports \{ ServiceError \} from store\.mjs/);
  });
});

test("S-01 gate: shrinkage passes — the ratchet only binds growth", () => {
  const files = {
    ...fixtureFiles,
    // b no longer points back: it leaves the SCC. Members and edges shrink.
    "b.mjs": `export const b = 1;\n`,
  };
  withRepo(files, fixtureBaseline, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 0, `shrinkage must pass, got: ${r.output}`);
  });
});
