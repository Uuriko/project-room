// Skill/agent registry (B017). A pure registry: agents register skills
// (name, version, capabilities, lane); the registry supports lookup by
// id, query by capability or lane, version comparison, and
// deregistration. All state is caller-owned (a Map); the module is pure
// and dependency-free. Frozen outputs; malformed inputs throw
// RegistryError. Enrollment/HTTP wiring is a later slice.
class RegistryError extends Error { constructor(code, message) { super(message); this.name = "RegistryError"; this.code = code; } }
const fail = (code, message) => { throw new RegistryError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_registry", message); };
const VERSION = /^\d+\.\d+\.\d+$/;
// Compare semver strings. Returns -1, 0, or 1.
export function compareVersions(a, b) {
  check(VERSION.test(a) && VERSION.test(b), "versions must be semver x.y.z");
  const [a1, a2, a3] = a.split(".").map(Number);
  const [b1, b2, b3] = b.split(".").map(Number);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}
// Create a registry. store is a caller-owned Map (skillId -> skill).
export function createSkillRegistry({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const skills = store ?? new Map();
  // Register (or re-register at a new version) a skill.
  const register = ({ skillId, agentId, name, version, capabilities, lane }) => {
    check(typeof skillId === "string" && skillId.length > 0, "skillId must be a non-empty string");
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    check(typeof name === "string" && name.length > 0 && name.length <= 200, "name must be 1-200 chars");
    check(VERSION.test(version), "version must be semver x.y.z");
    check(Array.isArray(capabilities) && capabilities.length > 0 &&
      capabilities.every(c => typeof c === "string" && c.length > 0),
      "capabilities must be a non-empty string array");
    check(typeof lane === "string" && lane.length > 0, "lane must be a non-empty string");
    const skill = Object.freeze({ skillId, agentId, name, version, lane,
      capabilities: Object.freeze([...new Set(capabilities)]) });
    skills.set(skillId, skill);
    return skill;
  };
  const get = skillId => {
    check(typeof skillId === "string" && skillId.length > 0, "skillId must be a non-empty string");
    check(skills.has(skillId), `unknown skill "${skillId}"`);
    return skills.get(skillId);
  };
  // Find skills with a capability, newest version first.
  const byCapability = capability => {
    check(typeof capability === "string" && capability.length > 0, "capability must be a non-empty string");
    const matches = [...skills.values()].filter(s => s.capabilities.includes(capability));
    matches.sort((a, b) => compareVersions(b.version, a.version));
    return Object.freeze(matches.map(s => Object.freeze({ ...s })));
  };
  // Find skills in a lane.
  const byLane = lane => {
    check(typeof lane === "string" && lane.length > 0, "lane must be a non-empty string");
    return Object.freeze([...skills.values()].filter(s => s.lane === lane).map(s => Object.freeze({ ...s })));
  };
  const deregister = skillId => {
    check(typeof skillId === "string" && skillId.length > 0, "skillId must be a non-empty string");
    check(skills.delete(skillId), `unknown skill "${skillId}"`);
  };
  return Object.freeze({ register, get, byCapability, byLane, deregister, size: () => skills.size });
}
export { RegistryError };
