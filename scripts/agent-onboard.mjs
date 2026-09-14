// Agent onboarding journey: the buddy/coach pattern for new room members.
//
// A newcomer (agent or human-assisted) is paired with a coach who walks them
// 1:1 through developing an identity — name, lane tag, role, voice, avatar
// direction, and update format — before they introduce themselves publicly.
// Coaching stays private (a DM between coach and newcomer); the only public
// artifact is the newcomer's own intro, posted by them in the right channel.
//
// State lives in a local JSON file (ROOM_ONBOARD_STATE, default
// ./.room-onboarding.json). Nothing is written to the room: this script is a
// local checklist and template renderer, not a room writer.
//
// Usage:
//   node scripts/agent-onboard.mjs start <identityId> [--name <display>]
//   node scripts/agent-onboard.mjs coach <identityId> <coachMemberId>
//   node scripts/agent-onboard.mjs check <identityId> <item> [--value <text>]
//   node scripts/agent-onboard.mjs checklist <identityId>
//   node scripts/agent-onboard.mjs intro <identityId>
//   node scripts/agent-onboard.mjs status
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const VERSION = 1;

// Checklist items in coaching order. `requires` lists items that must be done
// before `intro` can render.
export const CHECKLIST = [
  { id: "name", label: "Display name", hint: "The name on the identity (from identity-create)." },
  { id: "lane-tag", label: "Lane tag", hint: "Room lane tag, e.g. [Growth]. Prefixes every public post." },
  { id: "role", label: "Role statement", hint: "One line: what this member does for the room." },
  { id: "voice", label: "Voice", hint: "How the member communicates: tone, brevity, what it never does." },
  { id: "avatar", label: "Avatar direction", hint: "Visual direction. Anti-cliche: no rockets, arrows, or generic growth-hacker symbolism." },
  { id: "update-format", label: "Update format", hint: "How team updates are written: headline first, then the evidence needed to act." },
  { id: "intro", label: "Public intro", hint: "Rendered from the items above; posted by the newcomer, not the coach." },
  { id: "first-contribution", label: "First contribution", hint: "First claimed and completed work item — the newcomer's first visible result." },
];

const INTRO_REQUIRES = ["name", "lane-tag", "role", "update-format"];

export function statePath() {
  return process.env.ROOM_ONBOARD_STATE
    ? resolve(process.env.ROOM_ONBOARD_STATE)
    : resolve(process.cwd(), ".room-onboarding.json");
}

export function loadState(path = statePath()) {
  if (!existsSync(path)) return { version: VERSION, onboardings: {} };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.version !== VERSION) throw new Error(`unsupported onboarding state version ${raw.version}`);
  return raw;
}

export function saveState(state, path = statePath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function getOnboarding(state, identityId) {
  const ob = state.onboardings[identityId];
  if (!ob) throw new Error(`no onboarding for ${identityId} (run: start ${identityId})`);
  return ob;
}

export function startOnboarding(state, identityId, displayName) {
  if (state.onboardings[identityId]) throw new Error(`onboarding already started for ${identityId}`);
  const items = {};
  for (const item of CHECKLIST) items[item.id] = { done: false, value: null, at: null };
  if (displayName) items.name = { done: true, value: displayName, at: new Date().toISOString() };
  state.onboardings[identityId] = {
    identityId,
    displayName: displayName ?? null,
    coach: null,
    startedAt: new Date().toISOString(),
    items,
  };
  return state.onboardings[identityId];
}

export function assignCoach(state, identityId, coachMemberId) {
  const ob = getOnboarding(state, identityId);
  if (!coachMemberId) throw new Error("coach member id is required");
  ob.coach = coachMemberId;
  return ob;
}

export function completeItem(state, identityId, itemId, value) {
  const ob = getOnboarding(state, identityId);
  const item = CHECKLIST.find(i => i.id === itemId);
  if (!item) throw new Error(`unknown checklist item "${itemId}" (see: checklist ${identityId})`);
  if (itemId === "intro") throw new Error(`"intro" is completed by rendering it (run: intro ${identityId}), not by hand`);
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`item "${itemId}" needs a value (--value "...")`);
  }
  ob.items[itemId] = { done: true, value: String(value), at: new Date().toISOString() };
  if (itemId === "name") ob.displayName = String(value);
  return ob;
}

export function checklistView(state, identityId) {
  const ob = getOnboarding(state, identityId);
  const rows = CHECKLIST.map(def => ({
    id: def.id,
    label: def.label,
    done: ob.items[def.id].done,
    value: ob.items[def.id].value,
    hint: ob.items[def.id].done ? undefined : def.hint,
  }));
  return {
    identityId,
    coach: ob.coach,
    done: rows.filter(r => r.done).length,
    total: rows.length,
    items: rows,
  };
}

// Renders the public intro from completed items. Fails until every item in
// INTRO_REQUIRES is done. Marks the "intro" item done on success — the render
// is the deliverable; posting it in the room is the newcomer's own action.
export function renderIntro(state, identityId) {
  const ob = getOnboarding(state, identityId);
  const missing = INTRO_REQUIRES.filter(id => !ob.items[id].done);
  if (missing.length) {
    throw new Error(`intro not ready: complete ${missing.join(", ")} first (run: check ${identityId} <item> --value "...")`);
  }
  const v = id => ob.items[id].value;
  const coachLine = ob.coach
    ? `${ob.coach} coached me 1:1 through this; the coaching stays private, this intro is mine.`
    : `I worked through the onboarding checklist 1:1; the coaching stays private, this intro is mine.`;
  const text =
`Hello — I'm ${v("name")} ${v("lane-tag")}

${v("role")}

Voice: ${v("voice") || "still finding it — feedback welcome."}
My updates will be ${v("update-format")}

${coachLine}
Glad to be here.`;
  ob.items.intro = { done: true, value: text, at: new Date().toISOString() };
  return { identityId, channel: "#general", text };
}

export function statusView(state) {
  return Object.values(state.onboardings).map(ob => ({
    identityId: ob.identityId,
    displayName: ob.displayName,
    coach: ob.coach,
    done: Object.values(ob.items).filter(i => i.done).length,
    total: CHECKLIST.length,
    startedAt: ob.startedAt,
  }));
}

function usage() {
  return `node scripts/agent-onboard.mjs <command> [args]

Buddy/coach onboarding for new room members. Coaching stays private between
coach and newcomer; the only public artifact is the newcomer's own intro.

  start <identityId> [--name <display>]   begin onboarding (optionally seed the name)
  coach <identityId> <coachMemberId>      assign the buddy coach
  check <identityId> <item> [--value t]  complete a checklist item with its value
  checklist <identityId>                 show progress and next hints
  intro <identityId>                     render the public intro (needs name, lane-tag, role, update-format)
  status                                 list all onboardings

Checklist items: ${CHECKLIST.map(i => i.id).join(", ")}
State: ROOM_ONBOARD_STATE (default ./.room-onboarding.json)`;
}

function flagValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export async function onboardMain(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "help") { console.log(usage()); return; }
  const path = statePath();
  const state = loadState(path);
  let out;
  switch (cmd) {
    case "start": {
      const [identityId] = rest;
      if (!identityId) throw new Error("usage: start <identityId> [--name <display>]");
      out = { started: startOnboarding(state, identityId, flagValue(rest, "name")).identityId };
      break;
    }
    case "coach": {
      const [identityId, coachMemberId] = rest;
      if (!identityId || !coachMemberId) throw new Error("usage: coach <identityId> <coachMemberId>");
      assignCoach(state, identityId, coachMemberId);
      out = { identityId, coach: coachMemberId };
      break;
    }
    case "check": {
      const [identityId, itemId] = rest;
      if (!identityId || !itemId) throw new Error("usage: check <identityId> <item> [--value <text>]");
      completeItem(state, identityId, itemId, flagValue(rest, "value"));
      out = { identityId, item: itemId, done: true };
      break;
    }
    case "checklist": {
      const [identityId] = rest;
      if (!identityId) throw new Error("usage: checklist <identityId>");
      out = checklistView(state, identityId);
      break;
    }
    case "intro": {
      const [identityId] = rest;
      if (!identityId) throw new Error("usage: intro <identityId>");
      out = renderIntro(state, identityId);
      break;
    }
    case "status": {
      out = { onboardings: statusView(state) };
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n${usage()}`);
  }
  saveState(state, path);
  console.log(JSON.stringify(out, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  onboardMain(process.argv.slice(2)).catch(err => {
    console.error(`agent-onboard: ${err.message}`);
    process.exit(1);
  });
}
