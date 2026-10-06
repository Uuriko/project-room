// SSE frame sequence extraction shared by the QA3 contract gate.
// An SSE frame without an `id:` line has no sequence; Number(null) is 0,
// which must not be mistaken for sequence 0 (synthetic id-less events like
// `typing` would otherwise corrupt ordering and Last-Event-ID resume checks).
export const sequenceOf = frame => {
  if (frame.id === null || frame.id === undefined) {
    const fromBody = frame.json?.sequence;
    return Number.isInteger(fromBody) ? fromBody : null;
  }
  const fromId = Number(frame.id);
  if (Number.isInteger(fromId)) return fromId;
  const fromBody = frame.json?.sequence;
  return Number.isInteger(fromBody) ? fromBody : null;
};
