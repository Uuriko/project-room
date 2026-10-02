// Notification policy (HB-1a). One pure engine for push, relays, the morning
// brief, and the later email batch (NOTIFY). Nothing here delivers: callers
// pass already-resolved prefs and get a decision back.
//
// Email delivery is inert. `emailDelivery` defaults to "inert", so `decide`
// never schedules an email. NOTIFY turns that on (`"needs_me"` or `"brief"`)
// after a verified address exists. It must not grow a second quiet-hours,
// cap, or batching implementation.
//
// `needs_me` is the policy default. notify-prefs.mjs still stores
// all | mentions | muted until HB-1b adds the level there. Pass either a
// resolved level string or `{ level, quietHours, wakeFor }`.
import { isQuietAt } from "./notify-prefs.mjs";

export class PolicyError extends Error {
  constructor(code, message) { super(message); this.name = "PolicyError"; this.code = code; }
}
const fail = (code, message) => { throw new PolicyError(code, message); };

export const STORED_LEVELS = Object.freeze(["all", "mentions", "muted"]);
export const NEEDS_ME_LEVEL = "needs_me";
export const POLICY_LEVELS = Object.freeze([NEEDS_ME_LEVEL, ...STORED_LEVELS]);
export const POLICY_DEFAULT_LEVEL = NEEDS_ME_LEVEL;
// NOTIFY flips this per decision. The default schedules no email.
export const EMAIL_DELIVERY = "inert";
export const EMAIL_MODES = Object.freeze(["inert", "off", "brief", "needs_me"]);

export const BATCH_WINDOW_MS = 15 * 60 * 1000;
export const DESKTOP_FOCUS_MS = 60 * 1000;
export const DESKTOP_RECHECK_MS = 120 * 1000;
export const PUSH_PER_AGENT_HOUR = 3;
export const PUSH_PER_HUMAN_DAY = 12;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const NEEDS_ME_KINDS = Object.freeze([
  "approval_requested", "input_required", "blocked_on_me", "review_requested",
  "dm", "question_mention", "access_request"
]);
export const FOLLOWING_KINDS = Object.freeze(["claim_done", "pr_merged", "reply", "member_added"]);
const MENTION_KINDS = new Set(["mention", "dm", "question_mention"]);

const done = (base, deliver) => Object.freeze({ ...base, deliver: Object.freeze(deliver.map(entry => Object.freeze(entry))) });

function checkLevel(level) {
  if (!POLICY_LEVELS.includes(level)) fail("invalid_notify_policy", "level must be needs_me, all, mentions, or muted");
  return level;
}

function normalizePrefs(prefs) {
  if (typeof prefs === "string") return { level: checkLevel(prefs), quietHours: null, wakeFor: [] };
  const level = checkLevel(prefs?.level ?? POLICY_DEFAULT_LEVEL);
  const wakeFor = Array.isArray(prefs?.wakeFor) ? prefs.wakeFor.filter(id => typeof id === "string" && id.length > 0) : [];
  return { level, quietHours: prefs?.quietHours ?? null, wakeFor };
}

function localClock(at, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(at));
  const hour = String(Number(parts.find(part => part.type === "hour").value) % 24).padStart(2, "0");
  const minute = parts.find(part => part.type === "minute").value;
  return `${hour}:${minute}`;
}

// Next brief is the quiet-hours end (default 08:00 local). Items deferred
// overnight wait for that instant rather than paging mid-window.
export function nextBriefAt(quietHours, now) {
  const tz = quietHours?.tz || "UTC";
  const end = quietHours?.end || "08:00";
  for (let step = 0; step <= 36 * 60; step += 1) {
    const at = now + step * 60 * 1000;
    if (localClock(at, tz) !== end) continue;
    if (quietHours && isQuietAt(quietHours, at)) continue;
    return at;
  }
  return now + DAY_MS;
}

function addressedTo(item, me) {
  return Array.isArray(item.addressedTo) && item.addressedTo.includes(me);
}

function threadIsMine(item, ctx) {
  return typeof item.threadId === "string" && Array.isArray(ctx.myThreadIds) && ctx.myThreadIds.includes(item.threadId);
}

// Needs me: blocking and addressed, for the kinds that stall an agent on this
// human. access_request counts only for an owner. Following is done/merged
// work in a room this human owns, replies in their threads, and new members.
export function tierFor(item, ctx) {
  const me = ctx.me;
  if (item.blocking === true && addressedTo(item, me) && NEEDS_ME_KINDS.includes(item.kind)) {
    if (item.kind === "access_request" && ctx.owner !== true) return "room";
    return "needs_me";
  }
  if (item.kind === "claim_done" || item.kind === "pr_merged") return ctx.ownsRoom === true ? "following" : "room";
  if (item.kind === "reply") return threadIsMine(item, ctx) ? "following" : "room";
  if (item.kind === "member_added") return "following";
  return "room";
}

// needs_me (default) and all push the needs_me tier. mentions keeps its old
// meaning: mention-like kinds only. muted pushes nothing. Following and room
// never take a per-item push from this function; decide routes them to the
// brief or the in-app list.
export function levelAllows(level, tier, kind) {
  const resolved = checkLevel(level ?? POLICY_DEFAULT_LEVEL);
  if (resolved === "muted" || tier !== "needs_me") return false;
  if (resolved === "mentions") return MENTION_KINDS.has(kind);
  return resolved === "needs_me" || resolved === "all";
}

// Desktop-active hold. A focused tab within the last 60s (and a fresh
// heartbeat, when one is present) stays in-app. The push is a re-check 120s
// later, which is 2 minutes after the tab blurs if it blurs now.
export function desktopHold(presence, now) {
  if (!presence || typeof presence.focusedAt !== "number" || !Number.isFinite(presence.focusedAt)) return null;
  if (now - presence.focusedAt > DESKTOP_FOCUS_MS || now < presence.focusedAt) return null;
  if (typeof presence.heartbeatAt === "number" && (now - presence.heartbeatAt > DESKTOP_FOCUS_MS || now < presence.heartbeatAt)) return null;
  return Object.freeze({ channel: "push", at: now + DESKTOP_RECHECK_MS, recheck: true });
}

export function quietDefer(prefs, fromMemberId, now) {
  const wake = Array.isArray(prefs?.wakeFor) && prefs.wakeFor.includes(fromMemberId);
  if (wake) return Object.freeze({ quiet: false, wake: true });
  const window = prefs?.quietHours;
  if (!window || !isQuietAt(window, now)) return Object.freeze({ quiet: false, wake: false });
  return Object.freeze({ quiet: true, wake: false, at: nextBriefAt(window, now) });
}

// batchKey is member|room|tier. The first item in a 15-minute window
// delivers immediately. Later items collapse to the window's end.
export function batchPlan(batches, batchKey, now) {
  const open = (Array.isArray(batches) ? batches : []).find(row =>
    row && row.batchKey === batchKey && typeof row.openedAt === "number"
    && now >= row.openedAt && now - row.openedAt < BATCH_WINDOW_MS);
  if (!open) return Object.freeze({ at: now, collapsed: false, openedAt: now });
  return Object.freeze({ at: open.openedAt + BATCH_WINDOW_MS, collapsed: true, openedAt: open.openedAt });
}

// At most 3 pushes an hour from one sender, and 12 a day for the human.
// wakeFor senders are outside both caps.
export function capPlan(recentPushes, fromMemberId, now, { wake = false } = {}) {
  if (wake) return Object.freeze({ allowed: true });
  const pushes = Array.isArray(recentPushes) ? recentPushes : [];
  const inHour = pushes.filter(row => row && row.fromMemberId === fromMemberId && typeof row.at === "number" && row.at <= now && now - row.at < HOUR_MS).length;
  const inDay = pushes.filter(row => row && typeof row.at === "number" && row.at <= now && now - row.at < DAY_MS).length;
  if (inHour >= PUSH_PER_AGENT_HOUR || inDay >= PUSH_PER_HUMAN_DAY) {
    return Object.freeze({ allowed: false, at: now + BATCH_WINDOW_MS });
  }
  return Object.freeze({ allowed: true });
}

// Holdout is for re-engagement (HB-4). A direct needs_me request still delivers.
export function holdoutAllows(holdout, tier) {
  if (holdout !== true) return true;
  return tier === "needs_me";
}

function clip(value, max) {
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function reasonFor(item, ctx) {
  const name = typeof ctx?.senderLabel === "string" && ctx.senderLabel.trim() ? clip(ctx.senderLabel, 80) : clip(item.fromMemberId, 80);
  const title = typeof item.title === "string" && item.title.trim() ? clip(item.title, 120) : "this";
  switch (item.kind) {
    case "approval_requested": return `because ${name} asked you to approve '${title}'`;
    case "input_required": return `because ${name} is waiting on your input for '${title}'`;
    case "blocked_on_me": return `because ${name} is blocked on you for '${title}'`;
    case "review_requested": return `because ${name} asked you to review '${title}'`;
    case "dm": return `because ${name} sent you a direct message`;
    case "question_mention": return `because ${name} asked you '${title}'`;
    case "mention": return `because ${name} mentioned you`;
    case "access_request": return `because ${name} asked to join '${title}'`;
    case "claim_done": return `because ${name} finished '${title}'`;
    case "pr_merged": return `because '${title}' merged`;
    case "reply": return `because ${name} replied in '${title}'`;
    case "member_added": return `because ${name} joined the room`;
    default: return `because ${name} updated '${title}'`;
  }
}

function clampMinutes(value) {
  const minutes = Number.isInteger(value) ? value : 15;
  if (minutes < 5) return 5;
  if (minutes > 60) return 60;
  return minutes;
}

// Dormant until NOTIFY sets emailDelivery. Unverified addresses never get a
// slot. needs_me waits out the unread delay (default 15 min, clamped 5–60)
// and collapses to one email per kind per room per hour. Quiet hours defer
// to the brief unless the sender is in wakeFor.
export function emailChannelPlan(item, ctx, tier, now) {
  const mode = ctx.emailDelivery ?? EMAIL_DELIVERY;
  if (mode !== "brief" && mode !== "needs_me") return [];
  if (ctx.emailVerified !== true) return [];
  if (ctx.channelsEnabled?.email === false) return [];
  const prefs = normalizePrefs(ctx.prefs);
  if (prefs.level === "muted") return [];
  const quiet = quietDefer(prefs, item.fromMemberId, now);
  if (mode === "brief") {
    if (tier === "room") return [];
    return [{ channel: "email", at: nextBriefAt(prefs.quietHours, now), brief: true }];
  }
  if (tier !== "needs_me") return [];
  if (quiet.quiet) return [{ channel: "email", at: quiet.at, brief: true }];
  const prior = (Array.isArray(ctx.recentEmails) ? ctx.recentEmails : []).some(row =>
    row && row.kind === item.kind && row.roomId === item.roomId && typeof row.at === "number"
    && row.at <= now && now - row.at < HOUR_MS);
  if (prior) return [{ channel: "email", at: now + HOUR_MS, collapsed: true }];
  return [{ channel: "email", at: now + clampMinutes(ctx.emailUnreadMinutes) * 60 * 1000 }];
}

function externalChannels(ctx) {
  const enabled = ctx.channelsEnabled ?? {};
  const channels = [];
  if (enabled.push !== false) channels.push("push");
  if (enabled.slack === true) channels.push("slack");
  if (enabled.discord === true) channels.push("discord");
  if (enabled.telegram === true) channels.push("telegram");
  return channels;
}

function scheduleExternal(ctx, prefs, item, batchKey, now) {
  const quiet = quietDefer(prefs, item.fromMemberId, now);
  if (quiet.quiet) return [Object.freeze({ channel: "brief", at: quiet.at })];
  const hold = desktopHold(ctx.presence ?? {}, now);
  const capped = capPlan(ctx.recentPushes, item.fromMemberId, now, { wake: quiet.wake });
  const batch = batchPlan(ctx.batches, batchKey, now);
  let at = now;
  let recheck = false;
  if (hold) {
    at = hold.at;
    recheck = true;
  } else if (!capped.allowed) {
    at = batch.collapsed ? Math.max(batch.at, now) : now + BATCH_WINDOW_MS;
  } else if (batch.collapsed) {
    at = batch.at;
  }
  return externalChannels(ctx).map(channel => {
    const entry = { channel, at };
    if (recheck && channel === "push") entry.recheck = true;
    return Object.freeze(entry);
  });
}

function checkItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_notify_policy", "item must be an object");
  if (typeof item.kind !== "string" || item.kind.length === 0) fail("invalid_notify_policy", "item.kind is required");
  if (typeof item.roomId !== "string" || item.roomId.length === 0) fail("invalid_notify_policy", "item.roomId is required");
  if (typeof item.fromMemberId !== "string" || item.fromMemberId.length === 0) fail("invalid_notify_policy", "item.fromMemberId is required");
  if (!Array.isArray(item.addressedTo)) fail("invalid_notify_policy", "item.addressedTo must be an array");
  if (typeof item.blocking !== "boolean") fail("invalid_notify_policy", "item.blocking must be a boolean");
  if (typeof item.title !== "string") fail("invalid_notify_policy", "item.title must be a string");
  if (typeof item.url !== "string") fail("invalid_notify_policy", "item.url must be a string");
}

function checkCtx(ctx) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) fail("invalid_notify_policy", "ctx must be an object");
  if (typeof ctx.me !== "string" || ctx.me.length === 0) fail("invalid_notify_policy", "ctx.me is required");
  if (typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) fail("invalid_notify_policy", "ctx.now must be a finite ms timestamp");
}

function mentionPush(level, item, me) {
  return (level === "mentions" || level === "all") && MENTION_KINDS.has(item.kind) && addressedTo(item, me);
}

// decide(item, ctx) → { deliver: [{channel, at}], batchKey, reason, tier }
// deliver is empty when the level is muted. Otherwise the in-app list is
// always included. Push and relays are only for an allowed needs_me item,
// or for a mention-like item when the stored level is still mentions/all.
export function decide(item, ctx) {
  checkItem(item);
  checkCtx(ctx);
  const now = ctx.now;
  const tier = tierFor(item, ctx);
  const reason = reasonFor(item, ctx);
  const batchKey = `${ctx.me}|${item.roomId}|${tier}`;
  const prefs = normalizePrefs(ctx.prefs);
  const base = { batchKey, reason, tier };
  if (prefs.level === "muted") return done(base, []);
  if (!holdoutAllows(ctx.holdout === true, tier)) return done(base, [{ channel: "in_app", at: now }]);

  const inApp = { channel: "in_app", at: now };
  if (tier === "following") {
    const deliver = [inApp];
    if (prefs.level === "needs_me" || prefs.level === "all") deliver.push({ channel: "brief", at: nextBriefAt(prefs.quietHours, now) });
    deliver.push(...emailChannelPlan(item, ctx, tier, now));
    return done(base, deliver);
  }
  if (tier !== "needs_me") {
    const deliver = [inApp];
    if (mentionPush(prefs.level, item, ctx.me)) deliver.push(...scheduleExternal(ctx, prefs, item, batchKey, now));
    return done(base, deliver);
  }
  if (!levelAllows(prefs.level, tier, item.kind)) return done(base, [inApp]);
  const deliver = [inApp, ...scheduleExternal(ctx, prefs, item, batchKey, now)];
  deliver.push(...emailChannelPlan(item, ctx, tier, now));
  return done(base, deliver);
}
