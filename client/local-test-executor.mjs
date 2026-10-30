// Fixed operator-selected tests for the existing request journal. No model,
// remote command parsing, shared scheduler, or claim of OS sandboxing.
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { hostSubprocess } from './host-subprocess.mjs';
export const LOCAL_TEST_SUITES = Object.freeze([
  'tests/events-kernel.property.test.js', 'tests/spend-grants-property.test.js',
  'tests/development-loop.test.js', 'tests/mcp-events-http.test.js', 'tests/mcp-events-wire.test.js'
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function testObservation(stdout, code) {
  const get = name => { const rows = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))]; return rows.length ? Number(rows.at(-1)[1]) : null; };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(k => [k, get(k)]));
  const complete = Object.values(counts).every(Number.isSafeInteger) && counts.cancelled === 0 && counts.todo === 0 && counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo && counts.pass + counts.fail > 0;
  const outcome = complete && code === 0 && counts.fail === 0 ? 'passed'
    : complete && Number.isInteger(code) && code !== 0 && counts.fail > 0 ? 'failed' : 'unknown';
  return { outcome, counts };
}
export function configuredLocalTests(config, { run = hostSubprocess } = {}) {
  const c = structuredClone(config);
  if (c?.mode !== 'operator-local-tests' || !sha(c.revision) || !sha(c.tree)
    || !['checkout','node','git','outputRoot'].every(k => typeof c[k] === 'string' && isAbsolute(c[k]) && c[k].length <= 1024)
    || typeof c.requesterId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.requesterId)
    || !Array.isArray(c.suites) || c.suites.length < 1 || c.suites.length > 5 || new Set(c.suites).size !== c.suites.length
    || c.suites.some(s => !LOCAL_TEST_SUITES.includes(s)) || !Number.isSafeInteger(c.seed) || c.seed < 0 || c.seed > 2147483600
    || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 300000)
    throw new Error('Invalid fixed local test profile');
  for (const key of ['checkout', 'node', 'git', 'outputRoot']) if (realpathSync(c[key]) !== c[key]) throw new Error('Use canonical existing operator paths');
  const env = { PATH: `${dirname(c.git)}:/usr/bin:/bin`, PROPERTY_TEST_SEED: String(c.seed) };
  // No HOME, Room bearer, API keys, NODE_OPTIONS, or remote input reaches tests.
  const toolFiles = ['local-test-executor.mjs', 'host-subprocess.mjs', 'request-runner.mjs'];
  const tools = Object.fromEntries(toolFiles.map(name => [name, digest(readFileSync(new URL(name, import.meta.url)))]));
  const nodeSha256 = digest(readFileSync(c.node));
  let nodeVersion, targetPlatform, targetArchitecture;
  const gitRead = async (args, signal) => {
    const r = await run({ command: c.git, args: ['-c','core.fsmonitor=false',...args], timeoutMs: 10000 }, { cwd: c.checkout, env, signal, maxBytes: 1048576 });
    if (r.exitCode !== 0) throw new Error('Source verification failed');
    return r.stdout.toString('utf8').trim();
  };
  const verify = async ({ signal } = {}) => {
    const version = await run({ command: c.node, args: ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], timeoutMs: 10000 }, { cwd: c.checkout, env, signal, maxBytes: 128 });
    const runtime = JSON.parse(version.stdout.toString('utf8'));
    nodeVersion = runtime.version; targetPlatform = runtime.platform; targetArchitecture = runtime.arch;
    if (![targetPlatform, targetArchitecture].every(v => typeof v === 'string' && /^[a-z0-9_]+$/.test(v))) throw new Error('Invalid target runtime identity');
    if (version.exitCode !== 0 || !/^v(2[4-9]|[3-9][0-9])\./.test(nodeVersion)) throw new Error('Node24 or newer required');
    if (await gitRead(['rev-parse','HEAD'], signal) !== c.revision || await gitRead(['rev-parse','HEAD^{tree}'], signal) !== c.tree
      || await gitRead(['status','--porcelain','--untracked-files=no'], signal)) throw new Error('Source must remain clean at the pinned revision/tree');
    for (const suite of c.suites) if (realpathSync(join(c.checkout, suite)) !== join(c.checkout, suite)
      || await gitRead(['ls-files','--error-unmatch','--',suite], signal) !== suite) throw new Error('Suite must be a tracked regular source path');
    if (digest(readFileSync(c.node)) !== nodeSha256 || toolFiles.some(name => digest(readFileSync(new URL(name, import.meta.url))) !== tools[name])) throw new Error('Executor or runtime changed');
  };
  const execute = async (context, { binding } = {}) => {
    if (context?.request?.requesterId !== c.requesterId || !binding || !/^[a-f0-9-]{36}$/.test(binding.attemptId ?? '')
      || binding.requestId !== context.requestId || binding.requestMessageId !== context.request.id) throw new Error('Request binding does not match the selected local profile');
    await verify({ signal: context.signal });
    const out = join(c.outputRoot, binding.attemptId); mkdirSync(out, { mode: 0o700 });
    const startedAt = new Date().toISOString(), results = [], deadline = Date.now() + c.timeoutMs;
    for (const suite of c.suites) {
      context.signal?.throwIfAborted();
      if (Date.now() >= deadline) break;
      let stdout = Buffer.alloc(0), code = null, reason = null;
      try {
        const result = await run({ command: c.node, args: ['--test','--test-concurrency=1','--test-reporter=tap',suite], timeoutMs: Math.max(100, deadline - Date.now()) },
          { cwd: c.checkout, env, signal: context.signal, maxBytes: 1048576 });
        stdout = result.stdout; code = result.exitCode;
      } catch { reason = 'incomplete_child'; }
      const log = `${results.length}.tap`; writeFileSync(join(out, log), stdout, { flag: 'wx', mode: 0o600 });
      results.push({ suite, seed: c.seed, exitCode: code, ...testObservation(stdout.toString('utf8'), code), reason, log, stdoutSha256: digest(stdout), stdoutBytes: stdout.length });
      if (results.at(-1).outcome !== 'passed') break;
    }
    let verified = true;
    try { await verify({ signal: context.signal }); } catch { verified = false; }
    const outcome = !verified || results.some(r => r.outcome === 'unknown') ? 'unknown'
      : results.some(r => r.outcome === 'failed') ? 'failed' : results.length === c.suites.length ? 'passed' : 'unknown';
    const receipt = { version: 1, kind: 'local-test-request', binding, source: { revision: c.revision, tree: c.tree },
      executor: { tools, nodeSha256, nodeVersion, platform: targetPlatform, architecture: targetArchitecture },
      configSha256: digest(JSON.stringify(c)), startedAt, finishedAt: new Date().toISOString(), outcome, results,
      limitations: ['operator-local-not-sandboxed','dependencies-not-attested','stderr-and-incomplete-stdout-not-retained','not-human-review-or-release'] };
    const bytes = JSON.stringify(receipt, null, 2) + '\n'; writeFileSync(join(out, 'receipt.json'), bytes, { flag: 'wx', mode: 0o600 });
    context.signal?.throwIfAborted();
    return { body: `Local test batch: ${outcome}.\nSource: ${c.revision}\n${results.map(r => `${r.suite}: ${r.outcome} (${r.counts.pass ?? '?'} passed, ${r.counts.fail ?? '?'} failed, ${r.counts.skipped ?? '?'} skipped)`).join('\n')}\nReceipt SHA-256: ${digest(bytes)}\nEvidence retained on executor for attempt ${binding.attemptId}.\nObserved local tests; not a review, live external-agent qualification or deployment.` };
  };
  execute.prepare = verify;
  return execute;
}
