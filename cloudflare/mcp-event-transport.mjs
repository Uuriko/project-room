// Restricted provider transport: operator trust in exact HTTPS origins replaces
// arbitrary-destination DNS pinning (which Workers fetch cannot provide).
// Never populate this list from a subscription request or permit a wildcard.
export function createWorkersMcpEventTransport(origins, fetchImpl = globalThis.fetch) {
  if (!Array.isArray(origins) || origins.length > 20 || typeof fetchImpl !== 'function') throw new TypeError('Invalid callback origin configuration');
  const allowed = new Set(origins.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') || url.hostname.includes('*')) throw new TypeError('Callback origins must be exact HTTPS origins');
    return url.origin;
  }));
  const validateTarget = destination => {
    const url = new URL(destination);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowed.has(url.origin)) {
      throw Object.assign(new Error('Callback origin is not approved by the Room operator'), {
        code: -32015, data: { reason: 'callback_origin_not_allowed', origin: url.origin },
      });
    }
    return url;
  };
  const transport = async (destination, _addresses, { body, headers, timeoutMs }) => {
    const url = validateTarget(destination);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || typeof body !== 'string' || Buffer.byteLength(body) > 262144) throw new TypeError('Invalid callback bounds');
    const controller = new AbortController();
    let timer;
    const operation = async () => {
      const response = await fetchImpl(url.href, { method: 'POST', body, headers, redirect: 'manual', signal: controller.signal });
      if (controller.signal.aborted) throw new Error('Callback timed out');
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        return { status: response.status, text: async () => '' };
      }
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      try {
        if (reader) while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw new Error('Callback timed out');
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new Error('Callback response exceeds limit');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader?.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString('utf8');
      return { status: response.status, text: async () => text };
    };
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Callback timed out')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); controller.abort(); }
  };
  transport.validateTarget = validateTarget;
  transport.configurationPending = allowed.size === 0;
  return transport;
}
