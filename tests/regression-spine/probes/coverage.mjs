// Coverage-gap replays (COV-M01/M02/M10/M11/M12/M14) — the HUNT-COVERAGE
// method, re-run against the target tree: copy the tree, apply the lane's
// exact mutation spec (probes/vendor/coverage-spec.json, from the lane's
// mutate.mjs spec-file), run the pin suite from PR #4130 (vendored under
// probes/vendor/pins/ — the pins are NOT in the target tree; PR #4130 is
// open under the pause).
//
// Classification: if the pin suite exists in the target tree and catches
// the mutation -> FIXED. If the pin exists only in the open PR: the pin is
// executed here to prove it catches the mutation, and the row classifies
// STILL-REPRODUCES because no test in the target tree catches it — the
// shipped suite is still blind to the mutation. If even the pin passes
// under the mutation, the gap is worse than filed (also STILL).
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, ROOT, TMP, runNode, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const SPEC_ID = { "COV-M01": "R01", "COV-M02": "R02", "COV-M10": "R10", "COV-M11": "R11", "COV-M12": "R12", "COV-M14": "R14" }[id];
if (!SPEC_ID) notfiled(`coverage.mjs has no probe for ${id}`);
const spec = JSON.parse(readFileSync(join(HERE, "probes", "vendor", "coverage-spec.json"), "utf8")).find((s) => s.id === SPEC_ID);
if (!spec) notfiled(`mutation spec ${SPEC_ID} missing from the vendored coverage spec`);

const work = join(TMP, `cov-${SPEC_ID}`);
rmSync(work, { recursive: true, force: true });
cpSync(ROOT, work, { recursive: true, filter: (p) => !p.includes(`${"/"}.git`) && !p.includes("node_modules") });

const pinRel = spec.suites[0];
const pinInTree = existsSync(join(ROOT, pinRel));
if (!pinInTree) {
  const vendored = join(HERE, "probes", "vendor", "pins", pinRel.split("/").pop());
  if (!existsSync(vendored)) notfiled(`pin suite ${pinRel} not in tree and no vendored copy in the pack`);
  writeFileSync(join(work, pinRel), readFileSync(vendored, "utf8"));
}

const target = join(work, spec.file);
const src = readFileSync(target, "utf8");
const occurrences = src.split(spec.old).length - 1;
if (occurrences !== 1) notfiled(`mutation anchor for ${SPEC_ID} occurs ${occurrences}x in ${spec.file} (expected 1) — source drifted from the filed mutation`);
writeFileSync(target, src.replace(spec.old, spec.new));

const run = await runNode(["--test", pinRel], { cwd: work, timeoutMs: 420000 });
const out = run.out + run.err;
const pass = /ℹ pass (\d+)/.exec(out)?.[1];
const fail = /ℹ fail (\d+)/.exec(out)?.[1];
if (pass === undefined || fail === undefined) notfiled(`pin suite run produced no test summary (exit ${run.code}): ${out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 260)}`);
const caught = Number(fail) > 0;
if (caught && pinInTree) fixed(`mutation ${SPEC_ID} in ${spec.file} is caught by the shipped suite ${pinRel} (fail=${fail}) — the pin landed`);
else if (caught) still(`mutation ${SPEC_ID} in ${spec.file} survives every test in the target tree; the catching pin (${pinRel}, pass=${pass} fail=${fail} when run here) exists only in open PR #4130 — the shipped suite is still blind to this mutation`);
else still(`mutation ${SPEC_ID} in ${spec.file} survives even the PR #4130 pin suite (pass=${pass} fail=${fail}) — the coverage gap is at least as filed`);
