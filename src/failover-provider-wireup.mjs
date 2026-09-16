/**
 * failover-provider-wireup.mjs — Pure failover planner across channel providers.
 *
 * Model: each channel is backed by an ordered provider list (priority, lower
 * wins). send(payload) walks providers in priority order, skipping providers
 * whose circuit breaker is open, and returns a per-send audit of every
 * attempt. Nothing here touches the network, the DOM, localStorage, or any
 * secret — real sends happen only through the injected per-provider `sender`
 * functions.
 *
 * Circuit breaker (per provider):
 *   closed   — normal; consecutive failures counted.
 *   open     — N consecutive failures (failureThreshold, default 3) trips the
 *              circuit; the provider is skipped for cooldownMs (default 60s)
 *              measured on the injected clock.
 *   half-open — after cooldownMs elapses, the next send admits exactly one
 *              trial: success closes the circuit, failure re-opens it with a
 *              fresh cooldown.
 *
 * Dependency injection (all via the `deps` parameter of createFailover):
 *   - clock:            () => number  (ms epoch; default: Date.now)
 *   - id:               () => string  (audit/send id generator; default: per-instance counter)
 *   - providers:        [{ name, sender, priority }]  (sender: (payload) => any|Promise<any>)
 *   - healthChecker:    (name) => boolean|Promise<boolean>  (optional; a false
 *                       marks the provider unhealthy and it is skipped)
 *   - failureThreshold: number  (consecutive failures to open; default 3)
 *   - cooldownMs:       number  (open-circuit cooldown; default 60000)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   FO_NO_PROVIDERS       — no providers configured (or all malformed)
 *   FO_NOT_FOUND          — unknown provider name (pinProvider, stats, reset)
 *   FO_INVALID_TRANSITION — invalid manual operation (e.g. unpin with no pin set)
 *   FO_ALL_FAILED         — every candidate failed/skipped; error.detail carries
 *                           the per-send audit { attempts: [...] }
 * Attempt-level codes recorded inside the audit (not thrown):
 *   FO_CIRCUIT_OPEN       — provider skipped because its circuit is open
 *   FO_PROVIDER_UNHEALTHY — provider skipped because healthChecker said no
 *   FO_PROVIDER_FAILED    — sender threw (original error on the attempt's `error`)
 * Failures are never silent.
 */

export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open']);

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 60 * 1000;

/** Throw a coded failover error (never silent failures). */
function failoverError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Create a channel failover planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {Array<{name: string, sender: Function, priority: number}>} [deps.providers]
 * @param {(name: string) => boolean|Promise<boolean>} [deps.healthChecker]
 * @param {number} [deps.failureThreshold]
 * @param {number} [deps.cooldownMs]
 */
export function createFailover(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const failureThreshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `send-${(idCounter += 1)}`);

  const rawProviders = deps.providers ?? [];
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    throw failoverError('FO_NO_PROVIDERS', 'Failover requires at least one provider', {
      provided: rawProviders,
    });
  }

  const providers = rawProviders.map((p, index) => {
    if (!p || typeof p.name !== 'string' || p.name === '' || typeof p.sender !== 'function') {
      throw failoverError('FO_NO_PROVIDERS', `Provider at index ${index} is malformed`, { index });
    }
    return {
      name: p.name,
      sender: p.sender,
      priority: typeof p.priority === 'number' ? p.priority : Number.MAX_SAFE_INTEGER,
      registrationOrder: index,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      circuitState: 'closed',
      openedAt: null,
      halfOpenTrialInFlight: false,
    };
  });

  const healthChecker = deps.healthChecker ?? null;

  /** Currently pinned provider name, or null. */
  let pinnedName = null;

  /** Append-only audit of every send: {id, at, provider, attempts}. */
  const sendAudit = [];

  function getProviderOrThrow(name) {
    const provider = providers.find((p) => p.name === name);
    if (!provider) {
      throw failoverError('FO_NOT_FOUND', `Unknown provider: ${name}`, { name });
    }
    return provider;
  }

  /** Roll an open circuit to half-open once its cooldown has elapsed. */
  function refreshCircuit(provider) {
    if (provider.circuitState === 'open' && provider.openedAt != null) {
      if (clock() - provider.openedAt >= cooldownMs) {
        provider.circuitState = 'half-open';
        provider.openedAt = null;
        provider.halfOpenTrialInFlight = false;
      }
    }
  }

  function openCircuit(provider) {
    provider.circuitState = 'open';
    provider.openedAt = clock();
    provider.halfOpenTrialInFlight = false;
  }

  function closeCircuit(provider) {
    provider.circuitState = 'closed';
    provider.openedAt = null;
    provider.consecutiveFailures = 0;
    provider.halfOpenTrialInFlight = false;
  }

  function recordFailure(provider) {
    provider.failures += 1;
    provider.consecutiveFailures += 1;
    if (provider.circuitState === 'half-open') {
      // Half-open trial failed: re-open with a fresh cooldown.
      openCircuit(provider);
    } else if (provider.consecutiveFailures >= failureThreshold) {
      openCircuit(provider);
    }
  }

  function recordSuccess(provider) {
    provider.successes += 1;
    closeCircuit(provider);
  }

  function statsSnapshot(provider) {
    return Object.freeze({
      name: provider.name,
      successes: provider.successes,
      failures: provider.failures,
      consecutiveFailures: provider.consecutiveFailures,
      circuitState: provider.circuitState,
    });
  }

  function orderedCandidates() {
    if (pinnedName != null) {
      return [getProviderOrThrow(pinnedName)];
    }
    return [...providers].sort(
      (a, b) => a.priority - b.priority || a.registrationOrder - b.registrationOrder,
    );
  }

  const failover = {
    /** Append-only log of every send: {id, at, provider, attempts}. */
    get audit() {
      return [...sendAudit];
    },

    get failureThreshold() {
      return failureThreshold;
    },

    get cooldownMs() {
      return cooldownMs;
    },

    /** Name of the pinned provider, or null. */
    get pinned() {
      return pinnedName;
    },

    /**
     * Pin all sends to a single provider (manual override). The pin is by
     * name; the provider's circuit breaker and health checks still apply —
     * a broken pinned provider fails closed with FO_ALL_FAILED, never a
     * silent skip.
     */
    pinProvider(name) {
      getProviderOrThrow(name);
      pinnedName = name;
      return pinnedName;
    },

    /** Remove the manual pin and restore priority-order failover. */
    unpin() {
      if (pinnedName == null) {
        throw failoverError(
          'FO_INVALID_TRANSITION',
          'Cannot unpin: no provider is currently pinned',
          {},
        );
      }
      pinnedName = null;
      return null;
    },

    /** Manually reset a provider's circuit to closed (clears failure streak). */
    resetProvider(name) {
      const provider = getProviderOrThrow(name);
      closeCircuit(provider);
      return statsSnapshot(provider);
    },

    /** Read-only per-provider stats {name, successes, failures, consecutiveFailures, circuitState}. */
    stats(name) {
      if (name === undefined) {
        return providers.map(statsSnapshot);
      }
      return statsSnapshot(getProviderOrThrow(name));
    },

    /**
     * Send via providers in priority order (or the pinned provider), skipping
     * circuit-broken/unhealthy ones. Returns {ok, id, provider, result,
     * attempts}. Throws FO_ALL_FAILED with the audit attached when every
     * candidate fails.
     */
    async send(payload) {
      const id = newId();
      const at = clock();
      const attempts = [];
      const candidates = orderedCandidates();

      for (const provider of candidates) {
        refreshCircuit(provider);

        if (provider.circuitState === 'open') {
          attempts.push(
            Object.freeze({
              provider: provider.name,
              ok: false,
              code: 'FO_CIRCUIT_OPEN',
              latencyMs: 0,
            }),
          );
          continue;
        }

        if (healthChecker) {
          const healthy = await healthChecker(provider.name);
          if (!healthy) {
            attempts.push(
              Object.freeze({
                provider: provider.name,
                ok: false,
                code: 'FO_PROVIDER_UNHEALTHY',
                latencyMs: 0,
              }),
            );
            continue;
          }
        }

        if (provider.circuitState === 'half-open') {
          // Exactly one trial leaves the half-open gate at a time.
          if (provider.halfOpenTrialInFlight) {
            attempts.push(
              Object.freeze({
                provider: provider.name,
                ok: false,
                code: 'FO_CIRCUIT_OPEN',
                latencyMs: 0,
              }),
            );
            continue;
          }
          provider.halfOpenTrialInFlight = true;
        }

        const started = clock();
        try {
          const result = await provider.sender(payload);
          provider.halfOpenTrialInFlight = false;
          recordSuccess(provider);
          const attempt = Object.freeze({
            provider: provider.name,
            ok: true,
            code: null,
            latencyMs: clock() - started,
          });
          attempts.push(attempt);
          const record = Object.freeze({ id, at, provider: provider.name, attempts: [...attempts] });
          sendAudit.push(record);
          return Object.freeze({
            ok: true,
            id,
            provider: provider.name,
            result,
            attempts: [...attempts],
          });
        } catch (err) {
          provider.halfOpenTrialInFlight = false;
          recordFailure(provider);
          attempts.push(
            Object.freeze({
              provider: provider.name,
              ok: false,
              code: 'FO_PROVIDER_FAILED',
              latencyMs: clock() - started,
              error: err,
            }),
          );
        }
      }

      const record = Object.freeze({ id, at, provider: null, attempts: [...attempts] });
      sendAudit.push(record);
      throw failoverError(
        'FO_ALL_FAILED',
        `All providers failed or were skipped for send ${id}`,
        { id, attempts: [...attempts] },
      );
    },
  };

  return Object.freeze(failover);
}
