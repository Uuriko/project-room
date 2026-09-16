// Agent capability cards (B010). A pure A2A capability-card builder: on
// enrollment, an agent's metadata (id, name, lanes, tools, model) is
// turned into a frozen capability card that other agents can read to
// decide what to delegate. Cards are versioned; a registry keeps the
// latest card per agent. All state is caller-owned (a Map); the module
// is pure and dependency-free. Frozen outputs; malformed inputs throw
// CapCardError. Auto-publish wiring on enrollment is a later slice.
const CARD_VERSION = 1;
class CapCardError extends Error { constructor(code, message) { super(message); this.name = "CapCardError"; this.code = code; } }
const fail = (code, message) => { throw new CapCardError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_cap_card", message); };
// Build a capability card from enrollment metadata.
export function buildCard({ agentId, name, lanes, tools, model, description }) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  check(typeof name === "string" && name.length > 0, "name must be a non-empty string");
  check(Array.isArray(lanes) && lanes.length > 0 && lanes.every(l => typeof l === "string" && l.length > 0),
    "lanes must be a non-empty array of strings");
  check(Array.isArray(tools) && tools.every(t => typeof t === "string" && t.length > 0),
    "tools must be an array of strings");
  check(model === undefined || (typeof model === "string" && model.length > 0), "model must be a non-empty string if given");
  check(description === undefined || (typeof description === "string" && description.length <= 1000),
    "description must be ≤1000 chars if given");
  return Object.freeze({ version: CARD_VERSION, agentId, name,
    lanes: Object.freeze([...lanes].sort()), tools: Object.freeze([...tools].sort()),
    model: model ?? null, description: description ?? null,
    publishedAt: new Date().toISOString() });
}
// Registry of the latest card per agent. store is a caller-owned Map.
export function createCardRegistry({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const cards = store ?? new Map();
  const publish = card => {
    check(card !== null && typeof card === "object" && typeof card.agentId === "string",
      "card must be a built capability card");
    check(card.version === CARD_VERSION, `unsupported card version ${card.version}`);
    cards.set(card.agentId, Object.freeze({ ...card }));
    return cards.get(card.agentId);
  };
  const get = agentId => {
    check(typeof agentId === "string" && cards.has(agentId), `no card for agent "${agentId}"`);
    return cards.get(agentId);
  };
  // Find agents whose card lists a lane.
  const byLane = lane => {
    check(typeof lane === "string" && lane.length > 0, "lane must be a non-empty string");
    return Object.freeze([...cards.values()].filter(c => c.lanes.includes(lane)));
  };
  // Find agents whose card lists a tool.
  const byTool = tool => {
    check(typeof tool === "string" && tool.length > 0, "tool must be a non-empty string");
    return Object.freeze([...cards.values()].filter(c => c.tools.includes(tool)));
  };
  return Object.freeze({ publish, get, byLane, byTool, size: () => cards.size });
}
export { CapCardError, CARD_VERSION };
