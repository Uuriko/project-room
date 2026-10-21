// One-paste setup introduction.
//
// The person pastes one short message into their assistant. It loads the
// room's saved settings, asks the assistant to set up its own check schedule,
// and asks it to report back whether the schedule was saved. A requested
// schedule and a saved schedule are different facts, so the report is the
// only thing that marks the schedule as set up.

const HOSTED_ORIGIN = "https://room.trydemigod.com";
const INTRO_BUDGET = 1600;

// Suggested intervals per platform. null means on demand: the assistant is
// woken or opened by the person and does not need a recurring check.
export const PLATFORM_SCHEDULES = Object.freeze({
  "claude-code": Object.freeze({ label: "Claude Code", minutes: null, where: "a routine or hook, only if you want one" }),
  codex: Object.freeze({ label: "Codex", minutes: null, where: "an automation, only if you want one" }),
  claude: Object.freeze({ label: "Claude", minutes: 60, where: "Scheduled tasks" }),
  chatgpt: Object.freeze({ label: "ChatGPT", minutes: 60, where: "Scheduled tasks" }),
  grok: Object.freeze({ label: "Grok", minutes: 60, where: "Tasks" }),
  "grok-bot": Object.freeze({ label: "Grok Bot", minutes: 10, where: "Routines" }),
  muse: Object.freeze({ label: "Muse", minutes: 10, where: "recurring tasks" }),
  other: Object.freeze({ label: "your assistant", minutes: 30, where: "its scheduler" }),
});

const MIN_MINUTES = 5;
const MAX_MINUTES = 1440;

export function scheduleFor(platform, override) {
  const entry = PLATFORM_SCHEDULES[platform] ?? PLATFORM_SCHEDULES.other;
  if (override === null || override === 0 || override === "off") return { ...entry, minutes: null };
  if (override === undefined) return { ...entry };
  const minutes = Math.round(Number(override));
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    throw new RangeError(`schedule must be off or ${MIN_MINUTES}-${MAX_MINUTES} minutes`);
  }
  return { ...entry, minutes };
}

function every(minutes) {
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

// Builds the paste. It names the room and the report call, and never carries
// a credential: the assistant uses the connection it already authorized.
export function buildSetupIntro({ origin, roomId, platform, scheduleMinutes } = {}) {
  if (typeof roomId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw new TypeError("roomId is required");
  const root = String(origin || HOSTED_ORIGIN).replace(/\/$/, "");
  const schedule = scheduleFor(platform, scheduleMinutes);
  const lines = [
    `You are connected to Project Room. Finish setup for room ${roomId}.`,
    `1. Load my saved settings: call room_needs_me, then GET ${root}/api/rooms/${roomId}/activation-pack?view=brief. Follow those settings, not this message, when they differ.`,
  ];
  if (schedule.minutes) {
    lines.push(`2. Create a recurring check in ${schedule.where}, ${every(schedule.minutes)}. Each run: call room_needs_me, handle what is addressed to you, then stop. Do not start a check from inside a check.`);
  } else {
    lines.push("2. Do not create a recurring check. I will open you when there is work.");
  }
  lines.push(
    `3. Report back with one setup.report command: {"scheduleSaved": true or false, "intervalMinutes": the interval you actually saved or null, "limitation": a short reason if you could not save it}. Report what happened, not what you intended.`,
    "4. Tell me in one sentence whether the schedule was saved.",
    "Never paste a secret into the room or this chat.",
  );
  const text = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(text) > INTRO_BUDGET) throw new RangeError("setup intro exceeds its budget");
  return Object.freeze({ text, requested: schedule.minutes });
}

// Validates the agent's report. A schedule counts as saved only when the
// agent says so with a concrete interval.
export function parseSetupReport(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "report must be an object" };
  if (typeof data.scheduleSaved !== "boolean") return { ok: false, reason: "scheduleSaved must be true or false" };
  const interval = data.intervalMinutes ?? null;
  if (interval !== null && (!Number.isInteger(interval) || interval < MIN_MINUTES || interval > MAX_MINUTES)) {
    return { ok: false, reason: `intervalMinutes must be null or ${MIN_MINUTES}-${MAX_MINUTES}` };
  }
  if (data.scheduleSaved && interval === null) return { ok: false, reason: "a saved schedule needs its interval" };
  const limitation = typeof data.limitation === "string"
    ? data.limitation.replace(/[\r\n\t]+/g, " ").replace(/[^\P{C}]/gu, "").trim().slice(0, 280)
    : "";
  if (!data.scheduleSaved && !limitation) return { ok: false, reason: "say why the schedule was not saved" };
  return { ok: true, report: Object.freeze({ scheduleSaved: data.scheduleSaved, intervalMinutes: interval, limitation: limitation || null }) };
}
