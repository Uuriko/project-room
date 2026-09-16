/**
 * uptime-monitor.mjs — pure uptime monitoring + alerting.
 *
 * All I/O is injected: the HTTP fetch is a caller-supplied function and the
 * notifier is a caller-supplied callback. The module itself makes no network
 * calls and never sends email/SMS/webhooks — it only computes state and
 * emits alert/recovery events to `notifier`.
 *
 * Config:
 *   endpoints:        [{ name, url }, ...]
 *   checkIntervalMs:  interval between automatic checks (start())
 *   timeoutMs:        per-check timeout; a check that exceeds it counts as failure
 *   failureThreshold: consecutive failures before a 'down' alert fires (default 3)
 *
 * Injected:
 *   fetchFn(url, { timeoutMs }) -> Promise<{ ok: boolean, status?: number, latencyMs?: number }>
 *     Resolves on completion (ok true = healthy), rejects on failure/timeout.
 *     A rejection counts as a failed check. The module fully works offline in tests.
 *   notifier(event) -> void, receiving { type: 'down' | 'recovered', endpoint, at, consecutiveFailures }
 *   now() -> number — clock for timestamps (default Date.now)
 *
 * Returns { checkOnce(), start(), stop(), getStatus(), getSnapshot() }.
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeConfig(config = {}) {
  const endpoints = Array.isArray(config.endpoints) ? config.endpoints : [];
  for (const ep of endpoints) {
    if (!ep || typeof ep.name !== 'string' || ep.name.length === 0) {
      throw new TypeError('uptime-monitor: every endpoint needs a non-empty string name');
    }
    if (typeof ep.url !== 'string' || ep.url.length === 0) {
      throw new TypeError('uptime-monitor: every endpoint needs a non-empty string url');
    }
  }
  const failureThreshold =
    Number.isInteger(config.failureThreshold) && config.failureThreshold > 0
      ? config.failureThreshold
      : DEFAULT_FAILURE_THRESHOLD;
  const timeoutMs =
    Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const checkIntervalMs =
    Number.isInteger(config.checkIntervalMs) && config.checkIntervalMs > 0
      ? config.checkIntervalMs
      : 60_000;
  return { endpoints, failureThreshold, timeoutMs, checkIntervalMs };
}

function freshState() {
  return {
    consecutiveFailures: 0,
    lastStatus: 'unknown', // 'unknown' | 'up' | 'down'
    lastCheckedAt: null,
    isDown: false,
  };
}

export function createMonitor(config, deps = {}) {
  const cfg = normalizeConfig(config);
  const { fetchFn, notifier = () => {}, now = () => Date.now() } = deps;

  if (typeof fetchFn !== 'function') {
    throw new TypeError('uptime-monitor: fetchFn is required (injected dependency)');
  }

  const states = new Map();
  for (const ep of cfg.endpoints) {
    states.set(ep.name, freshState());
  }

  let timer = null;

  async function probe(endpoint) {
    const state = states.get(endpoint.name);
    const at = now();
    let failure = null;
    try {
      const result = await fetchFn(endpoint.url, { timeoutMs: cfg.timeoutMs });
      if (!result || result.ok !== true) {
        failure = { status: result && result.status !== undefined ? result.status : null };
      }
    } catch (err) {
      failure = { error: err && err.message ? err.message : String(err) };
    }

    state.lastCheckedAt = at;
    if (failure === null) {
      const wasDown = state.isDown;
      state.consecutiveFailures = 0;
      state.isDown = false;
      state.lastStatus = 'up';
      if (wasDown) {
        notifier({
          type: 'recovered',
          endpoint: { name: endpoint.name, url: endpoint.url },
          at,
          consecutiveFailures: 0,
        });
      }
      return { name: endpoint.name, up: true, at };
    }

    state.consecutiveFailures += 1;
    state.lastStatus = 'down';
    if (!state.isDown && state.consecutiveFailures >= cfg.failureThreshold) {
      state.isDown = true;
      notifier({
        type: 'down',
        endpoint: { name: endpoint.name, url: endpoint.url },
        at,
        consecutiveFailures: state.consecutiveFailures,
      });
    }
    return { name: endpoint.name, up: false, at, ...failure };
  }

  async function checkOnce() {
    const results = [];
    for (const endpoint of cfg.endpoints) {
      // Sequential: deterministic ordering and no burst load on the targets.
      results.push(await probe(endpoint));
    }
    return results;
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => {
      void checkOnce().catch(() => {
        // checkOnce never rejects (probe catches per-endpoint), but keep the
        // interval alive even if something unexpected escapes.
      });
    }, cfg.checkIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus(name) {
    const state = states.get(name);
    if (!state) return null;
    return {
      name,
      consecutiveFailures: state.consecutiveFailures,
      lastStatus: state.lastStatus,
      lastCheckedAt: state.lastCheckedAt,
      isDown: state.isDown,
    };
  }

  function getSnapshot() {
    return cfg.endpoints.map((ep) => getStatus(ep.name));
  }

  return { checkOnce, start, stop, getStatus, getSnapshot };
}

export default createMonitor;
