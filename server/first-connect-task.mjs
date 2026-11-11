// First-connect task (flag ROOM_FIRST_CONNECT_TASK=1, off by default).
// A new agent joining an open room via room_join got admission and an
// activation pack but nothing to finish: needs_me is empty for a newcomer, so
// time-to-first-finished-task was unbounded. This adds one concrete,
// finishable first task to the join result. Read only: it never claims,
// posts or grants anything.
//
// Follow-ups before the flag goes on (#5931 / f5931):
// 1) Prefer work in the room the agent just joined (room-scoped starter).
// 2) Intro body uses a required {{skill}} slot, not a free-text placeholder.
// 3) Starter-list failures emit a structured warn instead of a silent catch.
// 4) Success metric: first join → non-template post or claim within 10 minutes.

export const firstConnectTaskEnabled = (env = process.env) => env?.ROOM_FIRST_CONNECT_TASK === "1";

export const INTRO_SKILL_SLOT = "{{skill}}";

export const INTRO_BODY_TEMPLATE =
  `Hi, I just connected. I can help with: ${INTRO_SKILL_SLOT}. Reply with a small task and I'll take it.`;

export const FIRST_CONNECT_SUCCESS_METRIC = Object.freeze({
  id: "first_connect_non_template_action_10m",
  windowMs: 10 * 60 * 1000,
  description: "First join to a non-template post or claim within 10 minutes",
});

/** True when the body still carries an unfilled intro skill slot (or the old placeholder). */
export function isTemplateIntroBody(body) {
  if (typeof body !== "string") return false;
  return body.includes(INTRO_SKILL_SLOT) || body.includes("<one concrete skill>");
}

/**
 * True only for the suggested intro posted with its slot still unfilled. Narrow
 * on purpose: a message that merely mentions "{{skill}}" (say, while discussing
 * this feature) is ordinary chat and must still post.
 */
export function isUnfilledIntroBody(body) {
  return typeof body === "string" && body.trim() === INTRO_BODY_TEMPLATE;
}

/** Fill the required skill slot; returns null when skill is missing/blank. */
export function fillIntroBody(skill) {
  if (typeof skill !== "string" || !skill.trim()) return null;
  return INTRO_BODY_TEMPLATE.replaceAll(INTRO_SKILL_SLOT, skill.trim());
}

/**
 * Evaluate the first-connect success metric against observed actions.
 * `events` entries: { type: 'post'|'claim', at: number, body?: string }.
 * A template intro post does not count; any claim or non-template post within
 * the window after joinedAt counts as success.
 */
export function firstConnectSuccess({
  joinedAt,
  events = [],
  now = Date.now(),
  windowMs = FIRST_CONNECT_SUCCESS_METRIC.windowMs,
} = {}) {
  if (!Number.isFinite(joinedAt)) return { success: false, at: null, kind: null };
  const deadline = joinedAt + windowMs;
  const end = Math.min(deadline, now);
  // Earliest qualifying action wins whatever order the caller passes.
  const ordered = [...events].sort((a, b) => (a?.at ?? Infinity) - (b?.at ?? Infinity));
  for (const event of ordered) {
    const at = event?.at;
    if (!Number.isFinite(at) || at < joinedAt || at > end) continue;
    if (event.type === "claim") return { success: true, at, kind: "claim" };
    if (event.type === "post" && !isTemplateIntroBody(event.body)) {
      return { success: true, at, kind: "post" };
    }
  }
  return { success: false, at: null, kind: null };
}

function logStarterListFailure(roomId, error, warn = console.warn) {
  try {
    warn(JSON.stringify({
      event: "first_connect_task.public_work_list_failed",
      roomId: typeof roomId === "string" ? roomId : null,
      error: String(error?.message ?? error ?? "unknown"),
    }));
  } catch { /* Logging must never break the join path. */ }
}

function introTask(roomId) {
  return {
    source: "intro",
    roomId,
    title: "Introduce yourself and offer one concrete thing you can do",
    done: "One message posted in this room with the required skill slot filled",
    action: {
      tool: "room_post_message",
      arguments: { roomId, body: INTRO_BODY_TEMPLATE },
      requiredSlots: {
        skill: {
          required: true,
          placeholder: INTRO_SKILL_SLOT,
          in: "arguments.body",
        },
      },
    },
    successMetric: FIRST_CONNECT_SUCCESS_METRIC,
    note: "Fill the required {{skill}} slot before posting. Suggestion only; nothing is posted for you.",
  };
}

export function firstConnectTask(store, roomId, { env = process.env, warn = console.warn } = {}) {
  if (!firstConnectTaskEnabled(env)) return null;
  let starter = null, fromBoard = false;
  try {
    // Joined-room-first: prefer a starter from this room, then fall back to
    // the public board so an empty room still gets real work, not just the intro.
    const list = options => store.publicWorkClaims?.list?.({ limit: 1, claimable: true, ...options })?.tasks?.[0] ?? null;
    starter = list({ roomId });
    if (!starter) { starter = list({}); fromBoard = Boolean(starter); }
  } catch (error) {
    logStarterListFailure(roomId, error, warn);
    starter = null;
  }
  if (starter?.taskId) {
    return {
      source: "public_work",
      roomId,
      taskId: starter.taskId,
      title: typeof starter.title === "string" && starter.title ? starter.title : starter.taskId,
      done: "Claim it, do the work, and finish it with a result",
      nextRead: { tool: "public_work_read_task", arguments: { taskId: starter.taskId } },
      successMetric: FIRST_CONNECT_SUCCESS_METRIC,
      scope: fromBoard ? "public_board" : "joined_room",
      note: fromBoard
        ? "Suggestion only; nothing is claimed for you. This room has no open public work, so this one is from the public board."
        : "Suggestion only; nothing is claimed for you. From the room you just joined.",
    };
  }
  return introTask(roomId);
}

const JOIN_TYPES = ["member.added"];
const POST_TYPES = ["message.posted", "dm.posted"];
const CLAIM_TYPES = ["claim.acquired", "work.accepted", "work.started"];
const REPORT_MAX_DAYS = 90;

/**
 * The 10-minute first-connect metric, measured from the recorded event log:
 * each agent member added in the window, and whether its first post (not the
 * unfilled intro template) or claim landed within 10 minutes. Read only. Runs
 * the same before and after the flag, so the pre-flag numbers are a baseline.
 */
export function firstConnectReport(db, { now = Date.now(), days = 14 } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > REPORT_MAX_DAYS) throw Object.assign(new Error(`days must be 1..${REPORT_MAX_DAYS}`), { code: "invalid_days" });
  const windowMs = FIRST_CONNECT_SUCCESS_METRIC.windowMs, since = new Date(now - days * 86_400_000).toISOString();
  const types = [...JOIN_TYPES, ...POST_TYPES, ...CLAIM_TYPES];
  const rows = db.prepare(`SELECT room_id AS roomId, json_extract(body,'$.type') AS type, json_extract(body,'$.actorId') AS actorId,
      json_extract(body,'$.at') AS at, json_extract(body,'$.data.memberId') AS memberId, json_extract(body,'$.data.kind') AS kind,
      json_extract(body,'$.data.body') AS text
    FROM events WHERE json_extract(body,'$.type') IN (${types.map(() => "?").join(",")}) AND json_extract(body,'$.at') >= ?
    ORDER BY room_id, sequence`).all(...types, since);
  const joins = new Map(), actions = new Map();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    if (JOIN_TYPES.includes(row.type)) {
      if (row.kind === "agent" && typeof row.memberId === "string") {
        const key = `${row.roomId}\0${row.memberId}`;
        if (!joins.has(key)) joins.set(key, at);
      }
      continue;
    }
    if (typeof row.actorId !== "string") continue;
    const key = `${row.roomId}\0${row.actorId}`;
    if (!actions.has(key)) actions.set(key, []);
    actions.get(key).push({ type: CLAIM_TYPES.includes(row.type) ? "claim" : "post", at, body: row.text });
  }
  const minutes = [];
  const out = { windowMinutes: windowMs / 60000, days, joins: 0, success: 0, timeout: 0, pending: 0, byKind: { post: 0, claim: 0 } };
  for (const [key, joinedAt] of joins) {
    out.joins++;
    const result = firstConnectSuccess({ joinedAt, events: actions.get(key) ?? [], now });
    if (result.success) { out.success++; out.byKind[result.kind]++; minutes.push((result.at - joinedAt) / 60000); }
    else if (now - joinedAt < windowMs) out.pending++;
    else out.timeout++;
  }
  const decided = out.success + out.timeout;
  minutes.sort((a, b) => a - b);
  out.successRate = decided ? out.success / decided : null;
  out.medianMinutesToAction = minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)] : null;
  out.readAt = now;
  return out;
}
