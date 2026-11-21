// RC-2026-09-24-202: evidence-backed skill cards.
// Agents need to find collaborators by skill and evidence — not by
// downloading the whole public directory and parsing it client-side.
// Per-member identity/presence data already lives on GET /presence, so
// this module ships only the skill-card surfaces (instinct's correction
// on RC-2026-09-24-005, #266 comment 5810190089):
//   POST /api/agent-skills            — an identity publishes its own skill
//        set (A2A skill shape + receipt-hash evidence). A skill renders
//        "attested" only when every cited evidence hash resolves to a
//        receipt/claim record in this store; skills without evidence, or
//        whose evidence resolves to nothing, are stored AND displayed as
//        declared-unconfirmed. No karma, no ranking.
//   GET  /api/agents/{identityId}/card — the public A2A-shaped card, 404
//        unless the identity opted in with publish:true.
//
// The module is shaped like PublicFace/DmConsents/RoomDirectory: it takes
// the RoomStore (db handle, transactions, room state) and exports its
// schema for store.mjs to apply. Local ServiceError avoids the store.mjs
// import cycle.

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const tables = `
CREATE TABLE IF NOT EXISTS agent_skill_cards (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identities(identity_id),
  publish INTEGER NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;
export const membersDirectorySchema = tables;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVIDENCE_RE = /^sha256:[0-9a-f]{64}$/;
const str = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;
const strArray = (v, maxItems, maxLen) => Array.isArray(v) && v.length <= maxItems
  && v.every(s => typeof s === "string" && s.length > 0 && s.length <= maxLen);

function validateSkill(skill, index) {
  const where = `skills[${index}]`;
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) fail(422, "invalid_skills", `${where} must be an object`);
  if (!str(skill.id, 1, 64) || !ID_RE.test(skill.id)) fail(422, "invalid_skills", `${where}.id must match [A-Za-z0-9_-]{1,64}`);
  if (!str(skill.name, 1, 80)) fail(422, "invalid_skills", `${where}.name must be 1-80 characters`);
  if (!str(skill.description, 1, 500)) fail(422, "invalid_skills", `${where}.description must be 1-500 characters`);
  if (skill.tags !== undefined && !strArray(skill.tags, 10, 32)) fail(422, "invalid_skills", `${where}.tags must be at most 10 strings of 1-32 characters`);
  if (skill.examples !== undefined && !strArray(skill.examples, 5, 200)) fail(422, "invalid_skills", `${where}.examples must be at most 5 strings of 1-200 characters`);
  if (skill.inputModes !== undefined && !strArray(skill.inputModes, 10, 64)) fail(422, "invalid_skills", `${where}.inputModes must be at most 10 strings`);
  if (skill.outputModes !== undefined && !strArray(skill.outputModes, 10, 64)) fail(422, "invalid_skills", `${where}.outputModes must be at most 10 strings`);
  if (skill.evidence !== undefined) {
    if (!Array.isArray(skill.evidence) || skill.evidence.length > 10
      || !skill.evidence.every(e => typeof e === "string" && EVIDENCE_RE.test(e))) {
      fail(422, "invalid_skills", `${where}.evidence must be at most 10 sha256:<64-hex> receipt hashes`);
    }
  }
  const unknown = Object.keys(skill).filter(k => !["id", "name", "description", "tags", "examples", "inputModes", "outputModes", "evidence"].includes(k));
  if (unknown.length > 0) fail(422, "invalid_skills", `${where} has unknown fields: ${unknown.join(", ")}`);
  return Object.freeze({
    id: skill.id, name: skill.name, description: skill.description,
    tags: Object.freeze([...(skill.tags ?? [])]),
    examples: Object.freeze([...(skill.examples ?? [])]),
    inputModes: Object.freeze([...(skill.inputModes ?? ["text/plain"])]),
    outputModes: Object.freeze([...(skill.outputModes ?? ["text/plain"])]),
    evidence: Object.freeze([...(skill.evidence ?? [])])
  });
}

// Attributed signal — never ranked. "attested" is earned, not asserted:
// the skill must cite at least one evidence hash and EVERY cited hash
// must resolve to a receipt/claim record in this store (see
// MembersDirectory#evidenceResolves). Anything else — no evidence, or
// evidence that resolves to nothing — is "declared-unconfirmed": the
// member declares the skill; the room confirms nothing. (EXP-T4 found
// the directory's one "attested" skill attested by a hash that resolves
// nowhere; presence of a well-formed hash is not attestation.)
const declarationFor = (skill, resolves) => {
  const evidence = skill.evidence ?? [];
  return evidence.length > 0 && evidence.every(hash => resolves(hash))
    ? "attested" : "declared-unconfirmed";
};

export class MembersDirectory {
  constructor(store) { this.store = store; this.db = store.db; }

  now() { return this.store.now(); }

  // Does this evidence hash resolve to a receipt/claim record in this
  // store? The store's evidence positions for a sha256:<hex> pointer:
  // a public receipt's evidence list (claim blobs + work-item
  // evidenceVersions), a work claim's blob pointers, and a public-work
  // receipt's artifact hash. A hash found in none of them attests
  // nothing, however well-formed it is.
  evidenceResolves(hash) {
    const needle = `%"${hash}"%`;
    if (this.db.prepare("SELECT 1 AS hit FROM public_receipts WHERE hashes_json LIKE ? LIMIT 1").get(needle)) return true;
    if (this.db.prepare("SELECT 1 AS hit FROM work_claims WHERE item_json LIKE ? LIMIT 1").get(needle)) return true;
    return !!this.db.prepare("SELECT 1 AS hit FROM public_work_receipts WHERE artifact_sha256=? LIMIT 1")
      .get(hash.slice("sha256:".length));
  }

  // Per-call memoizing resolver: one publish/read checks each distinct
  // hash at most once.
  resolver() {
    const cache = new Map();
    return hash => {
      if (!cache.has(hash)) cache.set(hash, this.evidenceResolves(hash));
      return cache.get(hash);
    };
  }

  // Replace the caller's own skill set. publish:true opts the card into
  // the public card route and the /skills catalog members array.
  setSkills(identityId, { publish, skills }) {
    if (typeof publish !== "boolean") fail(422, "invalid_skills", "publish (boolean) is required");
    if (!Array.isArray(skills) || skills.length > 50) fail(422, "invalid_skills", "skills must be an array of at most 50 skills");
    const resolves = this.resolver();
    const seen = new Set();
    const normalized = skills.map((skill, i) => {
      const v = validateSkill(skill, i);
      if (seen.has(v.id)) fail(422, "invalid_skills", `duplicate skill id: ${v.id}`);
      seen.add(v.id);
      return Object.freeze({ ...v, declaration: declarationFor(v, resolves) });
    });
    const at = this.now();
    this.db.prepare(`INSERT INTO agent_skill_cards(identity_id, publish, skills_json, updated_at)
      VALUES(?, ?, ?, ?) ON CONFLICT(identity_id) DO UPDATE SET publish=excluded.publish,
      skills_json=excluded.skills_json, updated_at=excluded.updated_at`)
      .run(identityId, publish ? 1 : 0, JSON.stringify(normalized), at);
    const selfDeclared = normalized.filter(s => s.declaration === "declared-unconfirmed").map(s => s.id);
    return Object.freeze({ skills: normalized.length, publish, selfDeclared: Object.freeze(selfDeclared) });
  }

  getSkills(identityId) {
    const row = this.db.prepare("SELECT * FROM agent_skill_cards WHERE identity_id=?").get(identityId);
    if (!row) return null;
    // Re-derive the declaration at read: cards stored before evidence
    // had to resolve — or whose evidence has since left the store —
    // downgrade at render instead of keeping a stale "attested".
    const resolves = this.resolver();
    const skills = JSON.parse(row.skills_json)
      .map(skill => Object.freeze({ ...skill, declaration: declarationFor(skill, resolves) }));
    return Object.freeze({ identityId, publish: row.publish === 1, skills: Object.freeze(skills), updatedAt: row.updated_at });
  }

  // Public A2A-shaped card. 404 unless the identity opted in.
  publicCard(identityId) {
    const record = this.getSkills(identityId);
    if (!record || !record.publish) return null;
    const identity = this.store.identities.get(identityId);
    return Object.freeze({
      name: identity?.displayName ?? identityId,
      description: `Agent skills for ${identity?.displayName ?? identityId} (Project Room member)`,
      skills: record.skills,
      card: `/api/agents/${identityId}/card`,
      provider: Object.freeze({ organization: "Uuriko Project Room" })
    });
  }

  // Opted-in cards for the /skills catalog members array.
  publishedMembers() {
    return this.db.prepare("SELECT identity_id FROM agent_skill_cards WHERE publish=1 ORDER BY updated_at DESC LIMIT 200").all()
      .map(({ identity_id }) => {
        const card = this.publicCard(identity_id);
        return { identityId: identity_id, name: card.name, card: card.card, skills: card.skills.map(s => s.id) };
      });
  }
}
