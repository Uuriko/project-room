// Bot mode is a local switch on the machine config. It stays off until
// `room-machine bot enable --room <roomId>`. Room never stores this switch.

export const BOT_TIERS = Object.freeze(["t1", "t2", "t3"]);
export const PROGRESS_INTERVAL_MS = 2 * 60 * 1000;

const LIMITS = Object.freeze({
  maxSteps: 8,
  maxWallMs: 10 * 60 * 1000,
  maxSpendUsd: 1,
  progressIntervalMs: PROGRESS_INTERVAL_MS,
});

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === "string" && item.trim().length > 0).map(item => item.trim()))];
}

export function normalizeBot(bot) {
  const source = bot && typeof bot === "object" && !Array.isArray(bot) ? bot : {};
  const tier = BOT_TIERS.includes(source.tier) ? source.tier : "t1";
  return {
    enabled: source.enabled === true,
    rooms: strings(source.rooms),
    goMembers: strings(source.goMembers),
    tier,
    model: typeof source.model === "string" && source.model.trim() ? source.model.trim() : "",
    maxSteps: positive(source.maxSteps, LIMITS.maxSteps),
    maxWallMs: positive(source.maxWallMs, LIMITS.maxWallMs),
    maxSpendUsd: positive(source.maxSpendUsd, LIMITS.maxSpendUsd),
    progressIntervalMs: positive(source.progressIntervalMs, LIMITS.progressIntervalMs),
  };
}

export function enableBot(bot, { roomId, goMembers = [] } = {}) {
  const current = normalizeBot(bot);
  if (typeof roomId !== "string" || !roomId.trim()) return { ok: false, error: "room_required", bot: current };
  const rooms = strings([...current.rooms, roomId.trim()]);
  const named = goMembers.length > 0 ? strings([...current.goMembers, ...goMembers]) : current.goMembers;
  return { ok: true, bot: { ...current, enabled: true, rooms, goMembers: named } };
}

export function disableBot(bot) {
  const current = normalizeBot(bot);
  return { ...current, enabled: false };
}

// Room's shipped tiers are t1_readonly and t2_standard. t2_standard is the
// default for every agent, so it does not raise the bot above its local
// tier. AX has not given the member a t1/t2/t3 read yet. An explicit t1,
// t2, t3, or t1_readonly on a report the bot could actually read wins.
// Local config is the ceiling: the room's tier report can only LOWER the
// bot's tier, never raise it. An operator who enables the bot at t1 must
// not be silently upgraded to t3 by whoever controls the room's report.
const TIER_ORDER = Object.freeze({ t1: 0, t2: 1, t3: 2 });
export function botTierFromRoom(report, configured = "t1") {
  const raw = report?.status?.autonomyTier ?? report?.autonomyTier ?? null;
  const roomTier = raw === "t1" || raw === "t1_readonly" ? "t1"
    : raw === "t2" ? "t2"
    : raw === "t3" ? "t3" : null;
  const localTier = TIER_ORDER[configured] === undefined ? "t1" : configured;
  if (!roomTier) return localTier;
  return TIER_ORDER[roomTier] <= TIER_ORDER[localTier] ? roomTier : localTier;
}

export function isDesktopTask(text) {
  return /\b(screenshot|click|safari|browser|desktop)\b/i.test(String(text ?? ""));
}
