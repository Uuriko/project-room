// Reminders store instants, not floating local dates. Reject normalized invalid
// dates (including spring-forward gaps); show the chosen offset before saving.
export function localReminderTime(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)?.slice(1).map(Number);
  if (!parts) return NaN;
  const [year, month, day, hour, minute] = parts;
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : NaN;
}
export function reminderTime(choice, now, custom = "") {
  if (choice === "custom") return localReminderTime(custom);
  if (choice === "hour") return Math.round(now + 3600000);
  if (choice !== "tomorrow") return NaN;
  const date = new Date(now);
  date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0);
  return date.getTime();
}
export function formatReminderTime(at) {
  if (!Number.isFinite(at)) return "Choose a valid local time.";
  const offset = -new Date(at).getTimezoneOffset(), pad = value => String(value).padStart(2, "0");
  const zone = `UTC${offset >= 0 ? "+" : "−"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(at)} (${zone})`;
}
