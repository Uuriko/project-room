// Track C slice C8 — Growth trend comparison.
//
// Read-only analytics over two C5 summary() outputs: per-type deltas and
// percent changes, engagement shifts, and top-mentioned-agent movers. Pure,
// dependency-free, deterministic. No I/O, no network, no timers, no storage.
// Outputs are frozen. Percent changes are never NaN/Infinity: a move from
// zero is reported as pctChange null with fromZero: true.

const deltaOf = (current, previous) => {
  const delta = current - previous;
  if (previous === 0) {
    return current === 0
      ? { current, previous, delta: 0, pctChange: 0, fromZero: false, direction: "flat" }
      : { current, previous, delta, pctChange: null, fromZero: true, direction: "up" };
  }
  return {
    current,
    previous,
    delta,
    pctChange: delta / previous,
    fromZero: false,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat"
  };
};

const freezeDeep = value => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    return Object.freeze(value);
  }
  return value;
};

const isPlainObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const checkSummary = (summary, label) => {
  if (!isPlainObject(summary)) {
    throw new TypeError(`compareSummaries: "${label}" must be a summary object`);
  }
  if (!isPlainObject(summary.totals)) {
    throw new TypeError(`compareSummaries: "${label}".totals must be an object`);
  }
  if (!isPlainObject(summary.engagement)) {
    throw new TypeError(`compareSummaries: "${label}".engagement must be an object`);
  }
  if (!Array.isArray(summary.topMentionedAgents)) {
    throw new TypeError(`compareSummaries: "${label}".topMentionedAgents must be an array`);
  }
  if (!isPlainObject(summary.window)) {
    throw new TypeError(`compareSummaries: "${label}".window must be an object`);
  }
  for (const [type, count] of Object.entries(summary.totals)) {
    if (typeof count !== "number" || Number.isNaN(count)) {
      throw new TypeError(`compareSummaries: "${label}".totals["${type}"] must be a number`);
    }
  }
  for (const entry of summary.topMentionedAgents) {
    if (!isPlainObject(entry) || typeof entry.agentId !== "string" || typeof entry.mentions !== "number") {
      throw new TypeError(`compareSummaries: "${label}".topMentionedAgents entries must be {agentId, mentions}`);
    }
  }
  return summary;
};

const mentionMap = topMentionedAgents =>
  new Map(topMentionedAgents.map(entry => [entry.agentId, entry.mentions]));

const ratioDelta = (currentRatio, previousRatio) => {
  if (currentRatio === null && previousRatio === null) {
    return { current: null, previous: null, delta: null, pctChange: null, fromZero: false, direction: "flat" };
  }
  if (previousRatio === null) {
    return { current: currentRatio, previous: null, delta: null, pctChange: null, fromZero: true, direction: currentRatio === null || currentRatio === 0 ? "flat" : "up" };
  }
  if (currentRatio === null) {
    return { current: null, previous: previousRatio, delta: null, pctChange: null, fromZero: false, direction: "down" };
  }
  const delta = currentRatio - previousRatio;
  if (previousRatio === 0) {
    return delta === 0
      ? { current: currentRatio, previous: previousRatio, delta: 0, pctChange: 0, fromZero: false, direction: "flat" }
      : { current: currentRatio, previous: previousRatio, delta, pctChange: null, fromZero: true, direction: delta > 0 ? "up" : "down" };
  }
  return {
    current: currentRatio,
    previous: previousRatio,
    delta,
    pctChange: delta / previousRatio,
    fromZero: false,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat"
  };
};

// Compare two C5 summary() outputs (current window vs previous window).
// Fail-closed: any missing or malformed input throws a clear Error.
export function compareSummaries(current, previous) {
  checkSummary(current, "current");
  checkSummary(previous, "previous");

  const types = [...new Set([...Object.keys(current.totals), ...Object.keys(previous.totals)])].sort();
  const perType = types.map(type => ({
    type,
    ...deltaOf(current.totals[type] ?? 0, previous.totals[type] ?? 0)
  }));

  const metric = name =>
    deltaOf(current.engagement[name] ?? 0, previous.engagement[name] ?? 0);
  const engagementShift = {
    messages: metric("messages"),
    reactions: metric("reactions"),
    pins: metric("pins"),
    mentions: metric("mentions"),
    mentionsPerMessage: ratioDelta(
      current.engagement.mentionsPerMessage ?? null,
      previous.engagement.mentionsPerMessage ?? null
    )
  };

  const currentMentions = mentionMap(current.topMentionedAgents);
  const previousMentions = mentionMap(previous.topMentionedAgents);
  const agentIds = [...new Set([...currentMentions.keys(), ...previousMentions.keys()])];
  const topMentionedMovers = agentIds
    .map(agentId => {
      const currentMentionsCount = currentMentions.get(agentId) ?? 0;
      const previousMentionsCount = previousMentions.get(agentId) ?? 0;
      return {
        agentId,
        currentMentions: currentMentionsCount,
        previousMentions: previousMentionsCount,
        delta: currentMentionsCount - previousMentionsCount
      };
    })
    .sort((a, b) =>
      b.delta - a.delta || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
    );

  return freezeDeep({
    perType,
    engagementShift,
    topMentionedMovers,
    windows: {
      current: { ...current.window },
      previous: { ...previous.window }
    }
  });
}
