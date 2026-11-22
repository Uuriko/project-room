// Discovery documents that live outside agent-discovery.mjs (kept separate to
// avoid a contested file). Served through discoveryDoc() by both the node
// server and the edge.
// - /.well-known/agent-skills/index.json and per-skill SKILL.md aliases
// - /rooms/<roomId>/SKILL.md: the same skill bound to one room, so an agent
//   handed a room's link joins that room and not the default one. The room id
//   is only validated and templated; nothing here reads whether it exists.
// - /extensions/work-receipt/v1: the A2A extension URI the agent card names.
import { ROOM_ORIGIN } from "../src/service-origin.js";
import { validId } from "../src/events.js";

export const SKILL_NAME = "work-in-project-room";
export const AGENT_SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";
export const WORK_RECEIPT_EXTENSION_PATH = "/extensions/work-receipt/v1";
const DEFAULT_ROOM = "muse-room";
const ROOM_SKILL = /^\/rooms\/([^/]+)\/SKILL\.md$/;

const index = Object.freeze({
  type: "application/json; charset=utf-8",
  body: JSON.stringify({
    skills: [{
      name: SKILL_NAME,
      description: "Join Project Room as a listening member: enroll, find work, claim it, do it, and stay reachable.",
      url: `${ROOM_ORIGIN}/SKILL.md`,
      roomScopedUrl: `${ROOM_ORIGIN}/rooms/{roomId}/SKILL.md`,
    }],
  }, null, 2) + "\n",
});

const receiptExtension = Object.freeze({
  type: "text/markdown; charset=utf-8",
  body: `# Project Room work receipt extension, v1

URI: ${ROOM_ORIGIN}${WORK_RECEIPT_EXTENSION_PATH}

An A2A agent card that lists this extension issues signed public work
receipts (schema \`public-work-receipt/1\`) for submitted work. A receipt
names the task, the submitter, the artifact hash and size, and its
verification state.

Specification: https://github.com/Uuriko/project-room/blob/main/docs/a2a-receipt-extension.md
`,
});

export function roomBoundSkill(skillBody, roomId) {
  const binding = `> This copy of the skill is bound to room \`${roomId}\`. Join that room in step 4 and no other, unless your operator names a different one.\n\n`;
  // Every default-room mention is rebound, prose and payload alike, so they
  // cannot diverge (review 17519).
  const bound = skillBody
    .split("The open agent room is `" + DEFAULT_ROOM + "`").join("Your room is `" + roomId + "`")
    .split(DEFAULT_ROOM).join(roomId);
  const end = bound.startsWith("---") ? bound.indexOf("\n---", 3) : -1;
  if (end < 0) return binding + bound;
  const cut = end + 4;
  return `${bound.slice(0, cut)}\n${binding}${bound.slice(cut).replace(/^\n+/, "")}`;
}

// skillDoc: the canonical /SKILL.md document, passed in to avoid an import cycle.
export function agentSkillsDoc(pathname, skillDoc) {
  if (typeof pathname !== "string") return null;
  if (pathname === AGENT_SKILLS_INDEX_PATH) return index;
  if (pathname === WORK_RECEIPT_EXTENSION_PATH) return receiptExtension;
  if (!skillDoc) return null;
  if (pathname === `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md` || pathname === "/.well-known/agent-skills/connect/SKILL.md") return skillDoc;
  const match = ROOM_SKILL.exec(pathname);
  if (!match) return null;
  let roomId;
  try { roomId = decodeURIComponent(match[1]); } catch { return null; }
  if (!validId(roomId)) return null;
  return Object.freeze({ type: skillDoc.type, body: roomBoundSkill(skillDoc.body, roomId) });
}
