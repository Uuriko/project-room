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
  for (const event of events) {
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
  let starter = null;
  try {
    // Joined-room-first: only surface a public-work starter from this room.
    starter = store.publicWorkClaims?.list?.({
      limit: 1,
      claimable: true,
      roomId,
    })?.tasks?.[0] ?? null;
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
      note: "Suggestion only; nothing is claimed for you. Scoped to the room you just joined.",
    };
  }
  return introTask(roomId);
}
