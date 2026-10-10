import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// A separate POSIX process group contains the shell, model CLI and ordinary
// descendants. Do not acknowledge cancellation until termination has settled.
// Deliberately detached processes and remote effects require their own cancel API.
export function commandExecutor(command, { timeoutMs = 120000, stopGraceMs = 500 } = {}) {
  return (brief, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const grouped = process.platform !== 'win32';
    const child = spawn(command, { shell: true, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', reason, closed = false, escalated = false, escalation, killFailure;
    const finish = (error, value) => {
      clearTimeout(timer); clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const kill = how => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, how);
        else child.kill(how);
      } catch (error) {
        if (error.code !== 'ESRCH') killFailure = Object.assign(new Error('Could not stop the executor process group', { cause: error }), { code: 'executor_stop_failed' });
      }
    };
    const stopped = () => { if (closed && escalated) finish(killFailure ?? reason); };
    const stop = error => {
      if (reason) return;
      reason = error;
      clearTimeout(timer);
      kill('SIGTERM');
      // Still kill the group when the shell closes first: its descendants may
      // ignore SIGTERM or retain redirected files after its pipes have closed.
      escalation = setTimeout(() => { kill('SIGKILL'); escalated = true; stopped(); }, stopGraceMs);
    };
    const abort = () => stop(signal.reason ?? new Error('Executor cancelled'));
    const timer = setTimeout(() => stop(new Error(`executor timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', error => { closed = true; if (reason) stopped(); else finish(error); });
    child.on('close', code => {
      closed = true;
      if (reason) { stopped(); return; }
      if (code !== 0) finish(new Error(`executor exited ${code}: ${err.trim().slice(0, 200)}`));
      else if (!out.trim()) finish(new Error('executor printed no answer'));
      else finish(null, out.trim().slice(0, 8000));
    });
    // An early-exiting command can close stdin before the brief is written.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin.end(JSON.stringify(brief));
  });
}

// Watch authority while the executor runs, not only after it returns. The
// executor must settle its own cancellation before this function can return.
export async function executeWatchingRun(execute, brief, run, reread, pollMs) {
  const execution = new AbortController(), watcher = new AbortController();
  let interruption;
  const changed = current => !current || current.status !== 'working' || current.revision !== run.revision
    || current.attemptId !== run.attemptId || current.sourceDeleted;
  const superseded = () => Object.assign(new Error('Assistant instructions or execution authority changed'), { code: 'assistant_execution_superseded' });
  // Brief assembly makes network reads too; a stop during those reads must
  // be observed before starting a command capable of external effects.
  if (changed(await reread())) throw superseded();
  const monitor = (async () => {
    while (!watcher.signal.aborted) {
      await delay(pollMs, undefined, { signal: watcher.signal });
      const current = await reread(watcher.signal);
      if (changed(current)) {
        interruption = superseded();
        execution.abort(interruption);
        return;
      }
    }
  })().catch(error => {
    if (!watcher.signal.aborted) { interruption = error; execution.abort(error); }
  });
  try {
    const answer = await execute(brief, { signal: execution.signal });
    if (interruption) throw interruption;
    return answer;
  } finally {
    watcher.abort();
    await monitor;
  }
}
