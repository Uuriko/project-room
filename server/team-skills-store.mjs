// Durable team skills, one SQLite row per skill, scoped by room. Wraps the
// pure registry (server/team-skills.mjs): load the room's rows, apply one
// operation, write the touched skill back, all in one transaction. The table
// is created on first use so this module needs no change to store.mjs.
import { createSkillRegistry, SkillError } from "./team-skills.mjs";

export const teamSkillsSchema = `
CREATE TABLE IF NOT EXISTS room_team_skills (
  room_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, skill_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS room_team_skills_slug ON room_team_skills(room_id, slug);
`;

const ready = new WeakSet();

export class TeamSkillsStore {
  // store: a RoomStore (needs .db and .transaction(fn)).
  constructor(store, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    if (!ready.has(this.db)) { this.db.exec(teamSkillsSchema); ready.add(this.db); }
  }

  #registry(roomId) {
    const rows = this.db.prepare("SELECT data_json FROM room_team_skills WHERE room_id=? ORDER BY skill_id").all(roomId);
    return createSkillRegistry({ clock: this.clock, initial: rows.map(r => JSON.parse(r.data_json)) });
  }

  #write(roomId, registry, skillId) {
    const row = registry.snapshot().find(s => s.skillId === skillId);
    this.db.prepare(`INSERT INTO room_team_skills (room_id, skill_id, slug, data_json, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(room_id, skill_id) DO UPDATE SET data_json=excluded.data_json, slug=excluded.slug, updated_at=excluded.updated_at`)
      .run(roomId, skillId, row.slug, JSON.stringify(row), new Date(this.clock()).toISOString());
  }

  #tx(fn) { return this.store.transaction(fn); }

  // Resolve a skill by id or by name.
  #resolve(registry, ref) {
    const byName = registry.find(ref);
    if (byName) return byName.skillId;
    try { return registry.get(ref).skillId; } catch { throw new SkillError("skill_not_found", "No such skill."); }
  }

  list(roomId) { return this.#registry(roomId).list(); }
  read(roomId, ref) { const r = this.#registry(roomId); return r.get(this.#resolve(r, ref)); }

  save(roomId, { name, instructions, author }) {
    return this.#tx(() => { const r = this.#registry(roomId); const s = r.save({ name, instructions, author }); this.#write(roomId, r, s.skillId); return s; });
  }
  run(roomId, ref, { by }) {
    return this.#tx(() => { const r = this.#registry(roomId); const id = this.#resolve(r, ref); const brief = r.run(id, { by }); this.#write(roomId, r, id); return { skill: r.get(id), brief }; });
  }
  correct(roomId, ref, { text, by, source = null }) {
    return this.#tx(() => { const r = this.#registry(roomId); const id = this.#resolve(r, ref); const s = r.correct(id, { text, by, source }); this.#write(roomId, r, id); return s; });
  }
  confirm(roomId, ref, correctionId, { by }) {
    return this.#tx(() => { const r = this.#registry(roomId); const id = this.#resolve(r, ref); const s = r.confirm(id, correctionId, { by }); this.#write(roomId, r, id); return s; });
  }
  retire(roomId, ref, correctionId, { by }) {
    return this.#tx(() => { const r = this.#registry(roomId); const id = this.#resolve(r, ref); const s = r.retire(id, correctionId, { by }); this.#write(roomId, r, id); return s; });
  }
}
