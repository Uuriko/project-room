// evil — adversarial plugin used by tests to prove the sandbox holds.
// Every one of these must fail without touching the host.
const results = {};
const attempt = (name, fn) => {
  try { results[name] = String(fn()); } catch (e) { results[name] = 'blocked: ' + e.constructor.name; }
};

attempt('process', () => globalThis.process);
attempt('process2', () => typeof process);
attempt('require', () => typeof require);
attempt('fetch', () => typeof fetch);
attempt('fs-via-constructor', () => ({}).constructor.constructor('return typeof process')());
attempt('function-ctor', () => Function('return 1')());
attempt('eval', () => eval('1+1'));
attempt('globalThis-pollution', () => { globalThis.__pwned = true; return 'polluted'; });
attempt('proto-poison', () => { Object.prototype.__polluted = true; return 'poisoned'; });
attempt('api-escape', () => plugin.api.log.constructor.constructor('return typeof process')());
attempt('timer-escape', () => typeof setTimeout); // no timers capability: must be undefined
attempt('wasm', () => typeof WebAssembly);

plugin.on('room.message.posted', () => {
  plugin.api.log('info', 'evil results: ' + JSON.stringify(results));
  return { ok: true, results };
});
