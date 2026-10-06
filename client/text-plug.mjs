// SMS / iMessage / WhatsApp plug for Instinct, Fo, and other text-only agents.
// One short line becomes match, claim, pull, or a playbook claim action.
// Does not send SMS, mint identities, or hold a lease. The next hop is the
// existing matcher or the existing work-claim route.

const VERBS = new Set(["match", "claim", "pull", "done", "progress", "blocked", "handoff", "holders", "collisions", "reply", "tags"]);
const MOTIVES = new Set(["hobby", "credits", "cash", "any"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function leaseHoursFromUntil(iso, now = Date.now()) {
  const end = Date.parse(iso);
  if (!Number.isFinite(end)) fail("invalid_text_plug");
  const hours = Math.ceil((end - now) / 3600000);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) fail("invalid_text_plug");
  return hours;
}

function workItemIdOf(value) {
  if (!value || value.length > 128 || /\s/.test(value)) fail("invalid_text_plug");
  return value;
}

function roomIdOf(value) {
  if (!value || value.length > 128 || /\s/.test(value)) fail("invalid_text_plug");
  return value;
}

function noteOf(value, max = 512) {
  if (!value || value.length > max) fail("invalid_text_plug");
  return value;
}

function memberTokenOf(value) {
  if (!value || value.length > 128) fail("invalid_text_plug");
  return value;
}

function filesOf(value) {
  const files = [];
  for (const path of value.split(",").map(item => item.trim()).filter(Boolean)) {
    if (path.length > 512 || path.startsWith("/") || path.split("/").includes("..")) fail("invalid_text_plug");
    files.push(path);
  }
  if (files.length > 64) fail("invalid_text_plug");
  return files;
}

// Playbook segments are `key: value`, split on `|`. Unknown keys fail closed.
// `not touching` is acknowledged and dropped: it is not a lease.
function parseSegments(joined, allowed) {
  const [head, ...segments] = joined.split("|").map(part => part.trim());
  const fields = {};
  for (const segment of segments) {
    const split = segment.indexOf(":");
    if (split < 1) fail("invalid_text_plug");
    const key = segment.slice(0, split).trim().toLowerCase();
    const value = segment.slice(split + 1).trim();
    if (!allowed.has(key)) fail("invalid_text_plug");
    if (key === "files") fields.files = filesOf(value);
    else if (key === "lease until") {
      if (!Number.isFinite(Date.parse(value))) fail("invalid_text_plug");
      fields.leaseUntil = new Date(value).toISOString();
    } else if (key === "not touching") continue;
    else if (key === "room") fields.roomId = roomIdOf(value);
    else if (key === "note") fields.note = noteOf(value, allowed.has("reply-note") ? 900 : 512);
    else if (key === "to") fields.to = memberTokenOf(value);
    else fail("invalid_text_plug");
  }
  return { head, fields };
}

function withRoom(fields) {
  return fields.roomId ? { roomId: fields.roomId } : {};
}

export function parseRoomText(text) {
  if (typeof text !== "string") fail("invalid_text_plug");
  if (/pri_[A-Za-z0-9_-]{8,}/i.test(text)) fail("secret_in_text");
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw || raw.length > 1000) fail("invalid_text_plug");
  const rawParts = raw.split(" ");
  const lowerParts = rawParts.map(part => part.toLowerCase());
  const start = lowerParts[0] === "pr" || lowerParts[0] === "room" ? 1 : 0;
  const verb = lowerParts[start];
  const restLower = lowerParts.slice(start + 1);
  const restRaw = rawParts.slice(start + 1);
  if (!VERBS.has(verb)) fail("unknown_text_verb");
  if (verb === "pull") {
    if (restLower.length !== 0) fail("invalid_text_plug");
    return { verb };
  }
  if (verb === "tags") {
    if (restRaw.length === 0) return { verb };
    const { head, fields } = parseSegments(restRaw.join(" "), new Set(["room"]));
    if (head) fail("invalid_text_plug");
    return { verb, ...withRoom(fields) };
  }
  if (verb === "reply") {
    const { head, fields } = parseSegments(restRaw.join(" "), new Set(["room", "note", "reply-note"]));
    if (!fields.note) fail("invalid_text_plug");
    return { verb, workItemId: workItemIdOf(head), note: fields.note, ...withRoom(fields) };
  }
  if (verb === "collisions") {
    if (restRaw.length === 0) return { verb };
    const { head, fields } = parseSegments(restRaw.join(" "), new Set(["room"]));
    if (head) fail("invalid_text_plug");
    return { verb, ...withRoom(fields) };
  }
  if (verb === "holders") {
    const { head, fields } = parseSegments(restRaw.join(" "), new Set(["room"]));
    if (!head || head.length > 512 || head.startsWith("/") || head.split("/").includes("..")) fail("invalid_text_plug");
    return { verb, path: head, ...withRoom(fields) };
  }
  if (verb === "done" && restRaw.length === 0) return { verb };
  if (verb === "claim" && !restRaw.join(" ").includes("|")) {
    const id = restRaw[0];
    if (!id || restRaw.length !== 1) fail("invalid_text_plug");
    return { verb, workItemId: workItemIdOf(id) };
  }
  if (verb === "claim" || verb === "progress" || verb === "blocked" || verb === "handoff" || verb === "done") {
    const allowed = new Set(["files", "lease until", "not touching", "room", "note", "to"]);
    const { head, fields } = parseSegments(restRaw.join(" "), allowed);
    const workItemId = workItemIdOf(head);
    if (verb === "claim" && fields.to) fail("invalid_text_plug");
    if (verb === "claim" && fields.note) fail("invalid_text_plug");
    if (verb !== "claim" && fields.files) fail("invalid_text_plug");
    if (verb !== "claim" && fields.leaseUntil) fail("invalid_text_plug");
    if (verb === "handoff" && !fields.to) fail("invalid_text_plug");
    if (verb !== "handoff" && fields.to) fail("invalid_text_plug");
    return {
      verb,
      workItemId,
      ...withRoom(fields),
      ...(fields.files?.length ? { files: Object.freeze(fields.files) } : {}),
      ...(fields.leaseUntil ? { leaseUntil: fields.leaseUntil } : {}),
      ...(fields.note ? { note: fields.note } : {}),
      ...(fields.to ? { to: fields.to } : {}),
    };
  }
  const motive = MOTIVES.has(restLower[0]) ? restLower[0] : "any";
  const tagSource = MOTIVES.has(restLower[0]) ? restLower.slice(1) : restLower;
  const tags = tagSource.filter(tag => tag.length <= 32).slice(0, 8);
  return { verb: "match", motive, tags };
}
