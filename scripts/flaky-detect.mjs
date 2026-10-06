#!/usr/bin/env node
// flaky-detect.mjs — additive flaky-test DETECTOR. Detection only: never gates CI.
//
//   node scripts/flaky-detect.mjs <test-file> [runs] [--runs=N] [--timeout=ms] [--json]
//
// Runs the target test file N times in separate processes, parses the TAP
// output of each run, and reports tests whose outcome VARIED across runs
// (both passes and failures). Exit 0: no flaky tests. Exit 1: flaky tests
// found (their names are printed). Exit 2: usage/target-file error.
//
// Detection only — do not gate any CI merge on this script.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run the target test file once in a fresh process and parse per-test
 * outcomes from TAP output.
 * @returns {Promise<{tests: Map<string, boolean>, error: string|null, durationMs: number}>}
 *   tests maps test-key -> true (passed) / false (failed).
 */
function runOnce(file, { timeout = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // NOTE: run the file directly with a TAP reporter (not `node --test`):
    // under `node --test`, child runs are skipped by node's recursion guard,
    // and NODE_TEST_CONTEXT makes the child report to the parent via IPC
    // instead of stdout. Stripping it keeps each run independent and TAP on stdout.
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test-reporter=tap', file], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ tests: new Map(), error: `spawn failed: ${err.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const tests = new Map();
      // TAP assertion lines: "ok 1 - name" / "not ok 1 - name", possibly indented (subtests).
      // Identity is hierarchy-aware: the "# Subtest: <name>" comment lines
      // the TAP reporter emits before each test block push an ancestor frame,
      // so two subtests with the same (indent, number, name) under different
      // parents never merge into one record (a stable subtest would otherwise
      // be misreported as flaky, and the real culprit's parent invisible).
      // Assertion numbers stay in the key so duplicate names under one parent
      // still get distinct identities.
      const stack = []; // { indent: number, name: string }
      for (const line of stdout.split('\n')) {
        const subComment = line.match(/^(\s*)# Subtest:\s*(.*)$/);
        if (subComment) {
          const indent = subComment[1].length;
          while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
          stack.push({ indent, name: subComment[2].trim() });
          continue;
        }
        const m = line.match(/^(\s*)(not )?ok (\d+) - (.*)$/);
        if (m) {
          const indent = m[1].length;
          const name = m[4].trim();
          while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
          // The test's own "# Subtest:" frame is not an ancestor of itself.
          if (stack.length > 0 && stack[stack.length - 1].indent === indent && stack[stack.length - 1].name === name) stack.pop();
          const key = stack.length > 0
            ? `${stack.map((f) => f.name).join(' > ')} > ${m[3]} - ${name}`
            : `${m[3]} - ${name}`;
          tests.set(key, !m[2]);
        }
      }
      let error = null;
      if (timedOut) error = `timed out after ${timeout}ms`;
      else if (signal) error = `killed by signal ${signal}`;
      else if (tests.size === 0) {
        error = code === 0
          ? 'no TAP assertion lines found in output'
          : `no tests detected (exit ${code}); stderr: ${stderr.trim().slice(0, 500)}`;
      }
      resolve({ tests, error, durationMs: Date.now() - started });
    });
  });
}

/**
 * Run the target test file N times and detect flaky tests.
 * @returns {Promise<{file, runs, flaky: Array<{name, passes, fails}>, runErrors: string[], exitCode: number, error: string|null}>}
 */
export async function detectFlaky(file, { runs = DEFAULT_RUNS, timeout = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) {
    return { file, runs, flaky: [], runErrors: [], exitCode: 2, error: `test file not found: ${file}` };
  }
  const perTest = new Map(); // name -> {passes, fails}
  const runErrors = [];
  for (let i = 0; i < runs; i++) {
    const { tests, error } = await runOnce(resolved, { timeout, env });
    if (error) runErrors.push(`run ${i + 1}: ${error}`);
    // A run with zero detected tests teaches nothing about individual tests —
    // treat it as a run-level error only (do not mark every known test failed).
    if (tests.size > 0) {
      for (const [name, passed] of tests) {
        const agg = perTest.get(name) || { name, passes: 0, fails: 0 };
        if (passed) agg.passes++; else agg.fails++;
        perTest.set(name, agg);
      }
    }
  }
  const flaky = [...perTest.values()]
    .filter((t) => t.passes > 0 && t.fails > 0)
    .sort((a, b) => b.fails - a.fails || a.name.localeCompare(b.name));
  const exitCode = runErrors.length === runs ? 2 : (flaky.length > 0 ? 1 : 0);
  return { file, runs, flaky, runErrors, exitCode, error: null };
}

function formatReport(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [
    `flaky-detect: ${result.runs} run(s) of ${result.file}`,
    '',
  ];
  if (result.error) {
    lines.push(`ERROR: ${result.error}`);
    return lines.join('\n');
  }
  for (const err of result.runErrors) lines.push(`run error: ${err}`);
  if (result.runErrors.length) lines.push('');
  if (result.flaky.length === 0) {
    lines.push('OK: no flaky tests detected (no test varied in outcome across runs).');
  } else {
    lines.push(`FLAKY TESTS (${result.flaky.length}):`);
    for (const f of result.flaky) {
      lines.push(`  - ${f.name}  [${f.passes} pass / ${f.fails} fail over ${result.runs} runs]`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { runs: DEFAULT_RUNS, timeout: DEFAULT_TIMEOUT_MS, json: false, file: null, runsSet: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--runs=')) { opts.runs = parseInt(arg.slice(7), 10); opts.runsSet = true; }
    else if (arg.startsWith('--timeout=')) opts.timeout = parseInt(arg.slice(10), 10);
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else if (opts.file === null) opts.file = arg;
    // A bare positional run count is only accepted when --runs was not given:
    // "--runs=5 file 7" and "file 5 7" are contradictions, not overrides.
    // /^\d+$/ (not parseInt) so "5x" is rejected instead of silently read as 5.
    else if (/^\d+$/.test(arg) && !opts.runsSet) { opts.runs = parseInt(arg, 10); opts.runsSet = true; }
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!opts.file) throw new Error('usage: node scripts/flaky-detect.mjs <test-file> [runs] [--runs=N] [--timeout=ms] [--json]');
  if (!Number.isInteger(opts.runs) || opts.runs < 2) throw new Error('runs must be an integer >= 2');
  if (!Number.isInteger(opts.timeout) || opts.timeout <= 0) throw new Error('timeout must be a positive integer of ms');
  return opts;
}

const invokedAsCli = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch { return false; }
})();

if (invokedAsCli) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const result = await detectFlaky(opts.file, opts);
  console.log(formatReport(result, { json: opts.json }));
  process.exit(result.exitCode);
}
