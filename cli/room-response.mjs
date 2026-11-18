const MAX_RPC_BYTES = 64 * 1024;

export async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Room response has no body");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RPC_BYTES) throw new Error("Room response exceeded the byte limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
