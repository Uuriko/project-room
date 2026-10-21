// Team skills: a named, plain-language workflow saved in a room, credited to
// its author, runnable by any member, with a visible run count ("Douglas's
// GTM skill, used 23 times"). Corrections made while running a skill are
// saved to that skill, not to an agent's general memory, so rules stay
// small and only load when the skill runs.
//
// Lean by design (same limits as the memory spec): at most 4 active
// corrections per skill, vague corrections rejected, new corrections start
// as proposals and activate when the skill author confirms or another person
// repeats the same correction. An agent may relay a correction, but it stays
// a proposal until a person confirms it. Nothing is deleted automatically.
//
// Pure, in-memory, deterministic; clock and ids injected.
import { randomUUID } from "node:crypto";

export class SkillError extends Error {
  constructor(code, message) { super(message); this.name = "SkillError"; this.code = code; }
}
const fail = (code, message) => { throw new SkillError(code, message); };
const check = (ok, code, message) => { if (!ok) fail(code, message); };

export const MAX_ACTIVE_CORRECTIONS = 4;
// Proposals wait on the author; bound them so one skill row cannot grow without limit.
export const MAX_PROPOSED_CORRECTIONS = 12;
export const MAX_SKILLS_PER_ROOM = 50;
export const BRIEF_TOKEN_CAP = 400;
const VAGUE = /^(be better|do better|fix it|make it good|improve( it)?|be careful|try harder|no|wrong|bad)\.?$/i;

const text = (value, max, field) => {
  check(typeof value === "string" && value.trim().length >= 1 && value.length <= max, "skill_invalid", `${field} must be 1..${max} characters`);
  return value.trim();
};
const who = (value, field) => {
  check(value && typeof value === "object" && typeof value.id === "string" && value.id && ["human", "agent"].includes(value.kind),
    "skill_invalid", `${field} must be an identity {kind, id}`);
  return Object.freeze({ kind: value.kind, id: value.id, label: typeof value.label === "string" ? value.label : value.id });
};
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = s => Math.ceil(s.length / 4);
const slug = s => norm(s).replace(/ /g, "-").slice(0, 60);

export function createSkillRegistry({ clock = () => Date.now(), id = () => randomUUID(), initial = [] } = {}) {
  const skills = new Map();
  for (const row of initial) skills.set(row.skillId, structuredClone({ ...row, label: undefined }));
  const iso = () => new Date(clock()).toISOString();
  const get = skillId => { const s = skills.get(skillId); if (!s) fail("skill_not_found", "No such skill."); return s; };
  const view = s => Object.freeze({ ...s, corrections: Object.freeze(s.corrections.map(c => Object.freeze({ ...c }))),
    label: `${s.author.label}'s ${s.name}, used ${s.runCount} ${s.runCount === 1 ? "time" : "times"}` });

  function save({ name, instructions, author }) {
    check(skills.size < MAX_SKILLS_PER_ROOM, "skill_limit", `A room keeps at most ${MAX_SKILLS_PER_ROOM} skills.`);
    const n = text(name, 80, "name");
    check(![...skills.values()].some(s => slug(s.name) === slug(n)), "skill_exists", "A skill with that name already exists.");
    const s = { skillId: id(), name: n, slug: slug(n), instructions: text(instructions, 4000, "instructions"),
      author: who(author, "author"), runCount: 0, lastRunBy: null, lastRunAt: null, createdAt: iso(), corrections: [] };
    skills.set(s.skillId, s);
    return view(s);
  }

  function find(nameOrSlug) {
    const key = slug(String(nameOrSlug ?? ""));
    const s = [...skills.values()].find(x => x.slug === key);
    return s ? view(s) : null;
  }

  // Anyone in the room may run any skill; the brief is what the agent loads.
  function run(skillId, { by }) {
    const s = get(skillId);
    const runner = who(by, "by");
    s.runCount += 1; s.lastRunBy = runner; s.lastRunAt = iso();
    return brief(skillId);
  }

  function brief(skillId) {
    const s = get(skillId);
    const rules = s.corrections.filter(c => c.status === "active").map(c => c.text);
    let out = `Skill: ${s.name} (by ${s.author.label})\n${s.instructions}`;
    if (rules.length) out += `\nCorrections:\n${rules.map(r => `- ${r}`).join("\n")}`;
    const words = out.split(/\s+/);
    while (tokens(out) > BRIEF_TOKEN_CAP && words.length) { words.pop(); out = words.join(" "); }
    return Object.freeze({ skillId, text: out, rules: Object.freeze(rules), tokens: tokens(out) });
  }

  // A correction given while a skill ran. Repeating an existing proposal, or
  // the author confirming it, activates it.
  function correct(skillId, { text: t, by, source = null }) {
    const s = get(skillId);
    const body = text(t, 280, "text");
    check(!VAGUE.test(body) && body.split(/\s+/).length >= 3, "correction_vague", "Say what to do differently, specifically.");
    const author = who(by, "by");
    const existing = s.corrections.find(c => norm(c.text) === norm(body) && c.status !== "retired");
    if (existing) {
      const confirms = author.kind === "human" && (existing.by !== author.id || author.id === s.author.id);
      if (existing.status === "proposed" && confirms) return activate(s, existing);
      existing.repeats += 1;
      return view(s);
    }
    const proposed = s.corrections.filter(x => x.status === "proposed").length;
    check(proposed < MAX_PROPOSED_CORRECTIONS, "correction_limit",
      `This skill already has ${MAX_PROPOSED_CORRECTIONS} corrections waiting on its author. Repeat one of those instead.`);
    const c = { correctionId: id(), text: body, by: author.id, byKind: author.kind, source, status: "proposed", repeats: 0, createdAt: iso() };
    s.corrections.push(c);
    if (author.kind === "human" && author.id === s.author.id) return activate(s, c);
    return view(s);
  }

  function activate(s, c) {
    const active = s.corrections.filter(x => x.status === "active");
    check(active.length < MAX_ACTIVE_CORRECTIONS, "correction_limit",
      `This skill already has ${MAX_ACTIVE_CORRECTIONS} active corrections. Retire one or fold it into the instructions.`);
    c.status = "active"; c.activatedAt = iso();
    return view(s);
  }

  function confirm(skillId, correctionId, { by }) {
    const s = get(skillId);
    const confirmer = who(by, "by");
    check(confirmer.kind === "human" && confirmer.id === s.author.id, "skill_forbidden", "Only the skill author confirms corrections.");
    const c = s.corrections.find(x => x.correctionId === correctionId);
    check(c && c.status === "proposed", "correction_not_found", "No such proposed correction.");
    return activate(s, c);
  }

  function retire(skillId, correctionId, { by }) {
    const s = get(skillId);
    check(who(by, "by").id === s.author.id, "skill_forbidden", "Only the skill author retires corrections.");
    const c = s.corrections.find(x => x.correctionId === correctionId);
    check(c && c.status !== "retired", "correction_not_found", "No such correction.");
    c.status = "retired"; c.retiredAt = iso();
    return view(s);
  }

  // Most-used first, the way a team discovers what works.
  function list() {
    return Object.freeze([...skills.values()].sort((a, b) => b.runCount - a.runCount || a.name.localeCompare(b.name)).map(view));
  }

  // Plain rows for persistence; feed back through { initial }.
  function snapshot() { return [...skills.values()].map(s => structuredClone(s)); }

  return Object.freeze({ save, find, run, brief, correct, confirm, retire, list, snapshot, get: id_ => view(get(id_)) });
}
