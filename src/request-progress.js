// Reads belong to an access context, not to the lifetime of the page.
export function createRequestProgress({ context, read, changed }) {
  let scope = null, flight = null, readKey = null, runs = {};
  const scopeKey = value => value && JSON.stringify([value.generation, value.roomId, value.viewerId]);
  function reset() { scope = null; flight = null; readKey = null; runs = {}; }
  async function refresh({ force = false } = {}) {
    const value = context(), nextScope = scopeKey(value);
    if (scope !== nextScope) { reset(); scope = nextScope; changed(); }
    if (!value) return;
    const ids = [...value.openIds].sort();
    if (!ids.length) { flight = null; readKey = null; runs = {}; changed(); return; }
    const key = JSON.stringify(ids);
    if (flight || (!force && key === readKey)) return;
    const owner = {};
    flight = owner;
    readKey = key;
    try {
      const view = await read();
      if (flight !== owner || scopeKey(context()) !== nextScope) return;
      if (view.roomId !== value.roomId || view.viewerId !== value.viewerId) return;
      runs = view.runs;
    } catch { /* Retain the heartbeat; its age expresses uncertainty. */ }
    finally { if (flight === owner) flight = null; }
    if (scopeKey(context()) !== nextScope || scope !== nextScope) return;
    changed();
    // Requests arriving during this read need one fresh view, not a poll delay.
    void refresh();
  }
  return { get runs() { return runs; }, reset, refresh };
}
