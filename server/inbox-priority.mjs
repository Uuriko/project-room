// Inbox priority scoring (Superhuman-style ranked queue). Pure scorer plus
// ranking: given a message and signal inputs it returns a 0..100 score with
// frozen component breakdowns, and rankQueue() sorts a batch most-urgent
// first. Signals: VIP senders, @mentions of the viewer, SLA urgency (a
// deadline approaching), and staleness (unreplied age). No network I/O.
class PriorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PriorityError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new PriorityError(code, message);
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

export const DEFAULT_WEIGHTS = Object.freeze({
  vip: 30,       // from a VIP sender
  mention: 25,   // viewer is @mentioned in the body
  sla: 25,       // deadline inside the SLA window
  staleness: 20, // unread / unreplied age
});
export const SLA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STALE_FULL_MS = 72 * 60 * 60 * 1000;
export const MAX_MESSAGES = 10000;

const checkMessage = message => {
  check(message !== null && typeof message === "object" && !Array.isArray(message), "PRIO_INVALID_INPUT", "message must be an object");
  check(typeof message.id === "string" && message.id.length > 0 && message.id.length <= 512, "PRIO_INVALID_INPUT", "message id must be 1..512 characters");
  return message;
};

const normalizeSet = value => {
  if (value instanceof Set) return value;
  check(Array.isArray(value) || value === undefined || value === null, "PRIO_INVALID_INPUT", "vipSenders must be a Set or list");
  return new Set(value ?? []);
};

// SLA urgency: 1 when the deadline has passed or is imminent, decaying to 0
// at the far edge of the SLA window. No deadline → 0.
const slaUrgency = (message, now) => {
  const deadline = message.deadlineAt;
  if (deadline === undefined || deadline === null) return 0;
  check(Number.isSafeInteger(deadline), "PRIO_INVALID_INPUT", "deadlineAt must be a safe integer ms epoch");
  if (deadline <= now) return 1;
  return 1 - Math.min(1, (deadline - now) / SLA_WINDOW_MS);
};

// Staleness: unread/unreplied age normalized so STALE_FULL_MS saturates to 1.
// Read messages get no staleness points.
const stalenessOf = (message, now) => {
  if (message.read === true) return 0;
  const receivedAt = message.receivedAt;
  check(Number.isSafeInteger(receivedAt), "PRIO_INVALID_INPUT", "receivedAt must be a safe integer ms epoch");
  return Math.min(1, Math.max(0, now - receivedAt) / STALE_FULL_MS);
};

/**
 * Score one message 0..100 with a frozen component breakdown.
 * @param {object} message { id, sender, body?, receivedAt, read?, deadlineAt? }
 * @param {object} [options]
 * @param {Set|string[]} [options.vipSenders]
 * @param {string[]} [options.mentionTokens] tokens that count as an @mention of the viewer (e.g. ["@quill"])
 * @param {number} [options.now] ms epoch
 * @param {object} [options.weights] overrides for DEFAULT_WEIGHTS
 */
export function scoreMessage(message, { vipSenders = new Set(), mentionTokens = [], now = Date.now(), weights = {} } = {}) {
  const checked = checkMessage(message);
  check(Number.isSafeInteger(now), "PRIO_INVALID_INPUT", "now must be a safe integer ms epoch");
  const vip = normalizeSet(vipSenders);
  check(Array.isArray(mentionTokens), "PRIO_INVALID_INPUT", "mentionTokens must be a list");
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    check(typeof merged[key] === "number" && merged[key] >= 0, "PRIO_INVALID_INPUT", `weight '${key}' must be a non-negative number`);
  }

  const isVip = typeof checked.sender === "string" && vip.has(checked.sender) ? 1 : 0;
  const body = typeof checked.body === "string" ? checked.body.toLowerCase() : "";
  const mentioned = mentionTokens.some(token => typeof token === "string" && token && body.includes(token.toLowerCase())) ? 1 : 0;
  const sla = slaUrgency(checked, now);
  const stale = stalenessOf(checked, now);

  const components = Object.freeze({
    vip: isVip * merged.vip,
    mention: mentioned * merged.mention,
    sla: sla * merged.sla,
    staleness: stale * merged.staleness,
  });
  const score = Math.min(100, Math.max(0, components.vip + components.mention + components.sla + components.staleness));
  return Object.freeze({
    messageId: checked.id,
    score: Math.round(score * 100) / 100,
    tier: score >= 70 ? "urgent" : score >= 40 ? "important" : score >= 15 ? "normal" : "low",
    components,
    signals: Object.freeze({
      vip: isVip === 1,
      mentioned: mentioned === 1,
      slaUrgency: Math.round(sla * 1000) / 1000,
      staleness: Math.round(stale * 1000) / 1000,
    }),
  });
}

/**
 * Rank a batch of messages most-urgent first. Ties break by oldest receivedAt
 * first (the one waiting longest wins), then message id.
 */
export function rankQueue(messages, options = {}) {
  check(Array.isArray(messages) && messages.length <= MAX_MESSAGES, "PRIO_INVALID_INPUT", `messages must be a list of at most ${MAX_MESSAGES}`);
  const scored = messages.map(message => {
    const result = scoreMessage(message, options);
    const receivedAt = Number.isSafeInteger(message.receivedAt) ? message.receivedAt : Number.MAX_SAFE_INTEGER;
    return { ...result, receivedAt };
  });
  scored.sort((a, b) => b.score - a.score || a.receivedAt - b.receivedAt || (a.messageId < b.messageId ? -1 : 1));
  return Object.freeze(scored.map(({ receivedAt: _receivedAt, ...rest }) => Object.freeze(rest)));
}

export { PriorityError };
