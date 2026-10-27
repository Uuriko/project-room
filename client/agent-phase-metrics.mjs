// Bounded, content-free measurements. No tokens, URLs, bodies or provider errors
// are retained. Unobserved network response bytes and model tokens stay unknown.
export function agentPhaseMetrics({ now = () => performance.now() } = {}) {
  const phases = Object.fromEntries(["discovery", "preparation", "authorization", "model", "publication", "acknowledgement"].map(key => [key, 0]));
  const started = now(); let phase = "discovery", since = started;
  let calls = 0, requestBytes = 0, modelStarts = 0, preparedContextBytes = 0;
  const transition = next => {
    if (!Object.hasOwn(phases, next)) throw new Error("Unknown agent phase");
    const at = now(); phases[phase] += Math.max(0, at - since); since = at; phase = next;
  };
  return {
    transition,
    prepared(bytes) { preparedContextBytes = bytes; },
    modelStarted() { modelStarts += 1; },
    fetch(fetchImpl) { return (...args) => {
      calls += 1;
      if (typeof args[1]?.body === "string") requestBytes += Buffer.byteLength(args[1].body);
      return fetchImpl(...args);
    }; },
    finish({ status, duplicate = false }) {
      const at = now();
      return { version: 1, status, totalMs: Math.round(Math.max(0, at - started)),
        phasesMs: Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, Math.round(value + (key === phase ? Math.max(0, at - since) : 0))])),
        httpCalls: calls, requestBodyBytes: requestBytes, responseBodyBytes: null,
        preparedContextBytes, modelStarts, duplicateReceipt: duplicate, modelTokens: null };
    }
  };
}
