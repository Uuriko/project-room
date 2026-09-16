// Q014: CI failure auto-bisect to the offending commit.
//
// Given a last-green commit and a first-red commit, plus a test command,
// this script finds the first commit in the range that breaks the test by
// binary search ("auto-bisect"). The pure planning logic is exported and
// dependency-free; every external effect (git checkout, running the test
// command) goes through an injectable runner interface, so the whole
// search is unit-testable without touching a real repo.
//
// CLI:
//   node scripts/ci-bisect.mjs --plan <green>..<red>
//       Dry run: resolve the commit range with git, print the probe order
//       (a preorder traversal of the bisect decision tree: order[0] is the
//       first probe, and the real probe sequence is always a subsequence
//       of it), plus the expected and worst-case probe counts. Checks
//       nothing out, runs nothing.
//   node scripts/ci-bisect.mjs --bisect <green>..<red> -- <test command...>
//       Drive the bisect: verify the green/red endpoints reproduce (green
//       passes, red fails), then checkout + test commits in binary-search
//       order until the first bad commit is found. The original ref is
//       restored afterwards. Prints the result as JSON on stdout; exits
//       non-zero when the endpoints do not reproduce or git fails.
//   node scripts/ci-bisect.mjs --self-test
//       Exercise the planner against synthetic commit lists (no git, no
//       child processes): asserts every possible culprit position is found
//       with probe counts matching the plan, and that invalid inputs throw
//       TypeError. This is how the script is exercised by CI; no test file
//       is claimed for Q014.
//
// API:
//   planBisect(commits) — commits: ordered array of commit identifiers,
//     oldest first, where commits[0] is known good and commits[n-1] is
//     known bad. Returns { order, expectedProbes, worstCaseProbes }.
//     order is the probe order as indices into commits, a preorder
//     traversal of the bisection decision tree (fail-branch first).
//     expectedProbes is the exact mean probe count for a uniformly random
//     culprit in [1, n-1]; worstCaseProbes is ceil(log2(n-1)). Throws
//     TypeError on a non-array, an empty array, fewer than 2 commits, or
//     any non-string / empty-string entry.
//   expectedProbesFor(n) — the expected probe count over n commits for a
//     uniformly random culprit in [1, n-1]. Throws TypeError unless n is
//     an integer >= 2.
//   simulateProbes(n, culprit) — the probe index sequence binary search
//     would take over n commits when test(i) fails iff i >= culprit.
//     Pure; the self-test uses it to prove the plan finds every culprit.
//     Throws TypeError on invalid n or culprit.
//   bisectWithRunner({ commits, testCmd, runner, logger }) — drive the
//     search. runner: { listCommits, checkout(sha), runTest(cmd, argv),
//     currentRef() }. runTest must resolve/return { ok } (ok = the test
//     passed). Validates inputs (TypeError), verifies the endpoints
//     reproduce, runs the binary search, restores the original ref, and
//     returns { culprit, culpritIndex, probes, plan } where probes is
//     [{ index, sha, ok }, ...]. Throws Error when the endpoints do not
//     reproduce the failure.
//   createGitRunner({ cwd }) — the real runner built on child_process
//     spawnSync: listCommits via `git rev-list --reverse green..red` with
//     green prepended as the known-good anchor (green should be an
//     ancestor of red), checkout via `git checkout --detach`, runTest via
//     the test command's exit code, currentRef via `git rev-parse HEAD`.
//   selfTest() — the built-in synthetic exercise; throws on the first
//     failed assertion, prints a summary line on success.

import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

// --- Pure planning logic (no I/O) -------------------------------------------

function assertCommits(commits) {
  if (!Array.isArray(commits)) {
    throw new TypeError(`commits must be an array, got ${typeof commits}`);
  }
  if (commits.length < 2) {
    throw new TypeError(
      `commits needs at least 2 entries (last-green + first-red), got ${commits.length}`
    );
  }
  commits.forEach((c, i) => {
    if (!isNonEmptyString(c)) {
      throw new TypeError(`commits[${i}] must be a non-empty string, got ${String(c)}`);
    }
  });
  return commits;
}

// Probe index sequence binary search takes over n commits when the culprit
// (first failing commit) is at index `culprit`: test(i) fails iff i >=
// culprit. The search invariant is test(lo) passes and test(hi) fails, so
// the culprit always lies in (lo, hi]; probing mid moves the failing bound
// down (mid >= culprit) or the passing bound up (mid < culprit) until the
// bounds are adjacent.
export function simulateProbes(n, culprit) {
  if (!Number.isInteger(n) || n < 2) {
    throw new TypeError(`n must be an integer >= 2, got ${String(n)}`);
  }
  if (!Number.isInteger(culprit) || culprit < 1 || culprit >= n) {
    throw new TypeError(`culprit must be an integer in [1, ${n - 1}], got ${String(culprit)}`);
  }
  const probes = [];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = lo + ((hi - lo) >> 1);
    probes.push(mid);
    if (mid >= culprit) hi = mid; // test failed: culprit is at or before mid
    else lo = mid; // test passed: culprit is after mid
  }
  return probes;
}

export function expectedProbesFor(n) {
  if (!Number.isInteger(n) || n < 2) {
    throw new TypeError(`n must be an integer >= 2, got ${String(n)}`);
  }
  let total = 0;
  for (let culprit = 1; culprit < n; culprit++) {
    total += simulateProbes(n, culprit).length;
  }
  return total / (n - 1);
}

// Preorder traversal of the bisection decision tree rooted at (lo, hi):
// visit the probe for this node first, then the fail-branch subtree
// (culprit at or before mid), then the pass-branch subtree. The real probe
// sequence for any culprit is exactly the root-to-leaf path, which is a
// subsequence of this order — so `order` is a stable, outcome-independent
// probe plan: order[0] is always the first probe.
function decisionTreeOrder(lo, hi, out) {
  if (hi - lo <= 1) return out; // adjacent bounds: culprit is hi, nothing to probe
  const mid = lo + ((hi - lo) >> 1);
  out.push(mid);
  decisionTreeOrder(lo, mid, out);
  decisionTreeOrder(mid, hi, out);
  return out;
}

export function planBisect(commits) {
  assertCommits(commits);
  const n = commits.length;
  const order = decisionTreeOrder(0, n - 1, []);
  const expectedProbes = expectedProbesFor(n);
  const worstCaseProbes = Math.ceil(Math.log2(n - 1));
  return { order, expectedProbes, worstCaseProbes };
}

// --- Runner-driven search (external effects behind the runner) ---------------

function assertTestCmd(testCmd) {
  if (!Array.isArray(testCmd) || testCmd.length === 0) {
    throw new TypeError("testCmd must be a non-empty array of command strings");
  }
  testCmd.forEach((part, i) => {
    if (!isNonEmptyString(part)) {
      throw new TypeError(`testCmd[${i}] must be a non-empty string, got ${String(part)}`);
    }
  });
  return testCmd;
}

function assertRunner(runner) {
  if (!runner || typeof runner !== "object") {
    throw new TypeError("runner must be an object with listCommits/checkout/runTest/currentRef");
  }
  for (const method of ["listCommits", "checkout", "runTest", "currentRef"]) {
    if (typeof runner[method] !== "function") {
      throw new TypeError(`runner.${method} must be a function`);
    }
  }
  return runner;
}

export function bisectWithRunner({ commits, testCmd, runner, logger = () => {} }) {
  assertCommits(commits);
  assertTestCmd(testCmd);
  assertRunner(runner);
  if (typeof logger !== "function") {
    throw new TypeError("logger must be a function");
  }
  const [cmd, ...argv] = testCmd;
  const startRef = runner.currentRef();
  const green = commits[0];
  const red = commits[commits.length - 1];
  try {
    // Endpoint check: the range must reproduce the failure, otherwise the
    // binary search is meaningless (e.g. flaky test, wrong range).
    runner.checkout(green);
    const greenResult = runner.runTest(cmd, argv);
    if (!greenResult || typeof greenResult.ok !== "boolean") {
      throw new TypeError("runner.runTest must return an object with a boolean ok field");
    }
    if (!greenResult.ok) {
      throw new Error(`range does not reproduce: last-green commit ${green} fails the test`);
    }
    runner.checkout(red);
    const redResult = runner.runTest(cmd, argv);
    if (!redResult || typeof redResult.ok !== "boolean") {
      throw new TypeError("runner.runTest must return an object with a boolean ok field");
    }
    if (redResult.ok) {
      throw new Error(`range does not reproduce: first-red commit ${red} passes the test`);
    }
    // Binary search between the known-good and known-bad bounds.
    const plan = planBisect(commits);
    const probes = [];
    let lo = 0;
    let hi = commits.length - 1;
    while (hi - lo > 1) {
      const mid = lo + ((hi - lo) >> 1);
      runner.checkout(commits[mid]);
      const { ok } = runner.runTest(cmd, argv);
      probes.push({ index: mid, sha: commits[mid], ok });
      logger(`probe ${commits[mid]} (index ${mid}): ${ok ? "pass" : "fail"} — culprit in (${ok ? mid : lo}, ${ok ? hi : mid}]`);
      if (ok) lo = mid;
      else hi = mid;
    }
    return { culprit: commits[hi], culpritIndex: hi, probes, plan };
  } finally {
    runner.checkout(startRef);
  }
}

// --- Real git runner --------------------------------------------------------

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return (result.stdout || "").trim();
}

export function createGitRunner({ cwd = process.cwd() } = {}) {
  return {
    // Ordered oldest-first; green is prepended as the known-good anchor
    // (rev-list's green..red form excludes green itself).
    listCommits(green, red) {
      if (!isNonEmptyString(green) || !isNonEmptyString(red)) {
        throw new TypeError("green and red must be non-empty strings");
      }
      if (green === red) {
        throw new TypeError("green and red must differ (empty range)");
      }
      git(["rev-parse", "--verify", `${green}^{commit}`], cwd);
      git(["rev-parse", "--verify", `${red}^{commit}`], cwd);
      const rest = git(["rev-list", "--reverse", `${green}..${red}`], cwd);
      const commits = [green, ...rest.split("\n").map((s) => s.trim()).filter(Boolean)];
      assertCommits(commits);
      return commits;
    },
    checkout(sha) {
      if (!isNonEmptyString(sha)) throw new TypeError("sha must be a non-empty string");
      git(["checkout", "--detach", "--quiet", sha], cwd);
    },
    runTest(cmd, argv = []) {
      const result = spawnSync(cmd, argv, { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      return { ok: result.status === 0, code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    currentRef() {
      return git(["rev-parse", "HEAD"], cwd);
    }
  };
}

// --- Self test (synthetic; no git, no child processes) -----------------------

// A runner that checks out a SHA and fails iff the checked-out index is at
// or after the culprit — the monotone failure model bisection requires.
function monotoneRunner(commits, culprit) {
  let current = -1;
  const indexOf = (sha) => {
    const i = commits.indexOf(sha);
    if (i < 0) throw new Error(`unknown sha ${sha}`);
    return i;
  };
  return {
    listCommits: () => [...commits],
    checkout: (sha) => {
      current = sha === "start" ? -1 : indexOf(sha);
    },
    runTest: () => ({ ok: current < culprit }),
    currentRef: () => "start"
  };
}

function isSubsequenceInOrder(sub, seq) {
  let j = 0;
  for (const x of sub) {
    while (j < seq.length && seq[j] !== x) j++;
    if (j >= seq.length) return false;
    j++;
  }
  return true;
}

export function selfTest() {
  // Planner correctness across range sizes: every culprit is found, the
  // probe sequence is a subsequence of the planned order, and probe counts
  // respect the expected/worst-case bounds.
  for (const n of [2, 3, 4, 5, 7, 8, 9, 16, 17, 100]) {
    const commits = Array.from({ length: n }, (_, i) => `c${i}`);
    const plan = planBisect(commits);
    assert.equal(plan.order[0] ?? null, n === 2 ? null : (0 + ((n - 1) >> 1)), `n=${n}: order[0] is the first probe`);
    assert.equal(plan.worstCaseProbes, Math.ceil(Math.log2(n - 1)), `n=${n}: worst case`);
    assert.ok(plan.expectedProbes <= plan.worstCaseProbes, `n=${n}: expected <= worst case`);
    assert.ok(new Set(plan.order).size === plan.order.length, `n=${n}: no duplicate probes`);
    assert.ok(plan.order.every((i) => i > 0 && i < n - 1), `n=${n}: probes are interior commits`);
    let total = 0;
    for (let culprit = 1; culprit < n; culprit++) {
      const probes = simulateProbes(n, culprit);
      total += probes.length;
      assert.ok(probes.length <= plan.worstCaseProbes, `n=${n} culprit=${culprit}: probe count in bounds`);
      assert.ok(
        isSubsequenceInOrder(probes, plan.order),
        `n=${n} culprit=${culprit}: probes follow the planned order`
      );
      // Drive the real search loop through the injectable runner: the
      // culprit must come out the other end.
      const result = bisectWithRunner({
        commits,
        testCmd: ["true"],
        runner: monotoneRunner(commits, culprit),
        logger: () => {}
      });
      assert.equal(result.culprit, commits[culprit], `n=${n} culprit=${culprit}: found`);
      assert.equal(result.culpritIndex, culprit, `n=${n} culprit=${culprit}: index`);
      assert.deepEqual(
        result.probes.map((p) => p.index),
        probes,
        `n=${n} culprit=${culprit}: runner probes match simulation`
      );
    }
    assert.equal(total / (n - 1), plan.expectedProbes, `n=${n}: expected probes exact`);
  }
  // Endpoint reproduction: green failing or red passing is an Error (the
  // range is wrong), not a silent wrong answer.
  assert.throws(
    () => bisectWithRunner({ commits: ["g", "r"], testCmd: ["true"], runner: monotoneRunner(["g", "r"], 0), logger: () => {} }),
    /does not reproduce/,
    "green failing the test is an Error"
  );
  assert.throws(
    () => bisectWithRunner({ commits: ["g", "r"], testCmd: ["true"], runner: monotoneRunner(["g", "r"], 2), logger: () => {} }),
    /does not reproduce/,
    "red passing the test is an Error"
  );
  // Original ref is restored even when the search throws.
  {
    const restored = [];
    const runner = monotoneRunner(["g", "r"], 0);
    const origCheckout = runner.checkout;
    runner.checkout = (sha) => {
      restored.push(sha);
      origCheckout(sha);
    };
    assert.throws(() => bisectWithRunner({ commits: ["g", "r"], testCmd: ["true"], runner, logger: () => {} }));
    assert.equal(restored[restored.length - 1], "start", "original ref restored on failure");
  }
  // Invalid inputs are TypeErrors.
  const badCommits = [null, undefined, "nope", [], [""], ["a"], ["a", ""], ["a", 7]];
  for (const commits of badCommits) {
    assert.throws(() => planBisect(commits), TypeError, `planBisect(${JSON.stringify(commits)})`);
  }
  for (const n of [0, 1, 1.5, NaN, "8"]) {
    assert.throws(() => expectedProbesFor(n), TypeError, `expectedProbesFor(${String(n)})`);
    assert.throws(() => simulateProbes(n, 1), TypeError, `simulateProbes(${String(n)}, 1)`);
  }
  assert.throws(() => simulateProbes(5, 0), TypeError, "culprit 0");
  assert.throws(() => simulateProbes(5, 5), TypeError, "culprit == n");
  const okRunner = monotoneRunner(["g", "r"], 1);
  for (const testCmd of [null, [], [""], ["x", 1]]) {
    assert.throws(
      () => bisectWithRunner({ commits: ["g", "r"], testCmd, runner: okRunner, logger: () => {} }),
      TypeError,
      `testCmd ${JSON.stringify(testCmd)}`
    );
  }
  assert.throws(
    () => bisectWithRunner({ commits: ["g", "r"], testCmd: ["true"], runner: {}, logger: () => {} }),
    TypeError,
    "runner without methods"
  );
  assert.throws(
    () => bisectWithRunner({ commits: ["g", "r"], testCmd: ["true"], runner: okRunner, logger: "x" }),
    TypeError,
    "non-function logger"
  );
  assert.throws(() => createGitRunner().listCommits("a", "a"), TypeError, "green == red");
  console.log("ci-bisect self-test: all assertions passed");
}

// --- CLI --------------------------------------------------------------------

function parseRange(raw) {
  if (!isNonEmptyString(raw) || !raw.includes("..")) {
    throw new TypeError(`expected <green>..<red>, got ${String(raw)}`);
  }
  const idx = raw.indexOf("..");
  const green = raw.slice(0, idx);
  const red = raw.slice(idx + 2);
  if (!isNonEmptyString(green) || !isNonEmptyString(red)) {
    throw new TypeError(`expected <green>..<red> with both sides non-empty, got ${String(raw)}`);
  }
  if (green === red) throw new TypeError("green and red must differ (empty range)");
  return { green, red };
}

function printPlan(commits, plan) {
  const short = (sha) => (sha.length > 12 ? sha.slice(0, 12) : sha);
  console.log(`range: ${commits.length} commits (${short(commits[0])} .. ${short(commits[commits.length - 1])})`);
  console.log(`expected probes: ${plan.expectedProbes.toFixed(2)}  worst case: ${plan.worstCaseProbes}`);
  if (plan.order.length === 0) {
    console.log("no probes needed: with only last-green and first-red, the culprit is first-red");
    return;
  }
  console.log(`first probe: ${short(commits[plan.order[0]])} (index ${plan.order[0]})`);
  console.log("probe order (outcome-independent; actual probes are a subsequence of this list):");
  for (const [i, idx] of plan.order.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}  ${short(commits[idx])}  (index ${idx})`);
  }
}

function usage(exitCode) {
  console.error("usage:");
  console.error("  node scripts/ci-bisect.mjs --plan <green>..<red>");
  console.error("  node scripts/ci-bisect.mjs --bisect <green>..<red> -- <test command...>");
  console.error("  node scripts/ci-bisect.mjs --self-test");
  process.exit(exitCode);
}

function main(argv) {
  const [flag, ...rest] = argv;
  if (flag === "--self-test") {
    selfTest();
    return;
  }
  if (flag === "--plan") {
    if (rest.length !== 1) usage(2);
    const { green, red } = parseRange(rest[0]);
    const runner = createGitRunner();
    const commits = runner.listCommits(green, red);
    printPlan(commits, planBisect(commits));
    return;
  }
  if (flag === "--bisect") {
    const dashdash = rest.indexOf("--");
    const range = dashdash === -1 ? rest[0] : rest.slice(0, dashdash).join(" ");
    const testCmd = dashdash === -1 ? [] : rest.slice(dashdash + 1);
    if (!isNonEmptyString(range) || testCmd.length === 0) usage(2);
    const { green, red } = parseRange(range);
    const runner = createGitRunner();
    const commits = runner.listCommits(green, red);
    const result = bisectWithRunner({
      commits,
      testCmd,
      runner,
      logger: (line) => console.error(line)
    });
    console.log(JSON.stringify({
      culprit: result.culprit,
      culpritIndex: result.culpritIndex,
      probes: result.probes.length,
      rangeSize: commits.length
    }));
    return;
  }
  usage(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`ci-bisect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof TypeError ? 2 : 1);
  }
}
