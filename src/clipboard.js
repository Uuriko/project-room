// OS clipboard writes cannot be cancelled. A slow write keeps ownership until
// it settles; never queue a second user's intent behind a stale operation.
export function createClipboard({ write = text => navigator.clipboard.writeText(text), delay = 1500 } = {}) {
  let flight = null;
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    get busy() { return flight !== null; },
    get slow() { return flight?.slow === true; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    copy(text) {
      if (flight) return Promise.resolve("busy");
      const attempt = { slow: false };
      flight = attempt;
      notify();
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          attempt.slow = true;
          notify();
          resolve("pending");
        }, delay);
        const finish = outcome => {
          clearTimeout(timer);
          flight = null;
          notify();
          resolve(outcome);
        };
        try { Promise.resolve(write(text)).then(() => finish("copied"), () => finish("failed")); }
        catch { finish("failed"); }
      });
    }
  };
}

export const clipboard = createClipboard();
