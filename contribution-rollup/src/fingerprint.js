export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Drop revision counters so a retry of the same source + payload matches. */
export function sourcePayloadFingerprint(event) {
  const data = event?.data && typeof event.data === "object" ? { ...event.data } : {};
  delete data.expectedRevision;
  return stableStringify({
    type: event?.type ?? null,
    roomId: event?.roomId ?? null,
    data
  });
}
