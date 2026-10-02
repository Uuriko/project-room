// Read room SSE frames until `until` returns true or the deadline passes.
export function parseSseFrame(raw) {
  if (!raw || raw.startsWith(":")) return null;
  let id = null;
  let event = null;
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  const text = data.join("\n");
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON comment frames stay text */ }
  return { id, event, text, json };
}

export async function collectSse(response, { until, timeoutMs = 20_000 } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), remaining)),
      ]);
      if (next.timeout || next.done) break;
      buf += decoder.decode(next.value, { stream: true });
      let split = buf.indexOf("\n\n");
      while (split >= 0) {
        const frame = parseSseFrame(buf.slice(0, split));
        buf = buf.slice(split + 2);
        if (frame) frames.push(frame);
        split = buf.indexOf("\n\n");
      }
      if (until?.(frames)) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* the caller aborts the request */ }
  }
  return frames;
}
