// Work dependencies (K002). A pure blocked-by graph: work items declare
// dependencies on other items; the module detects cycles, computes a
// topological order for unblocked execution, and lists what's blocking or
// blocked-by a given item. All state is caller-owned (a Map of id ->
// Set of dependency ids); the module is pure and dependency-free.
// Frozen outputs; malformed inputs throw DepGraphError. Store/UI wiring
// is a later slice.
class DepGraphError extends Error { constructor(code, message) { super(message); this.name = "DepGraphError"; this.code = code; } }
const fail = (code, message) => { throw new DepGraphError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dep_graph", message); };
// Create a dependency graph. store is a caller-owned Map (id -> Set<id>).
export function createDepGraph({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const edges = store ?? new Map(); // id -> Set of ids it depends on (blocked by)
  const checkId = id => check(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  // Ensure an item exists in the graph.
  const addItem = id => {
    checkId(id);
    if (!edges.has(id)) edges.set(id, new Set());
    return id;
  };
  // Declare that `id` is blocked by `blockedBy`. Refuses cycles.
  const addDependency = (id, blockedBy) => {
    checkId(id); checkId(blockedBy);
    check(id !== blockedBy, `item "${id}" cannot depend on itself`);
    addItem(id); addItem(blockedBy);
    edges.get(id).add(blockedBy);
    const cycle = findCycle();
    if (cycle) {
      edges.get(id).delete(blockedBy);
      fail("dependency_cycle", `adding ${id} blocked-by ${blockedBy} creates a cycle: ${cycle.join(" -> ")}`);
    }
    return Object.freeze({ id, blockedBy });
  };
  const removeDependency = (id, blockedBy) => {
    checkId(id); checkId(blockedBy);
    check(edges.has(id) && edges.get(id).has(blockedBy), `"${id}" is not blocked by "${blockedBy}"`);
    edges.get(id).delete(blockedBy);
  };
  // Items that `id` is directly blocked by.
  const blockedBy = id => {
    checkId(id); check(edges.has(id), `unknown item "${id}"`);
    return Object.freeze([...edges.get(id)].sort());
  };
  // Items directly blocked by `id` (reverse edges).
  const blocking = id => {
    checkId(id); check(edges.has(id), `unknown item "${id}"`);
    return Object.freeze([...edges.entries()]
      .filter(([, deps]) => deps.has(id)).map(([itemId]) => itemId).sort());
  };
  // Find a cycle, or null. Iterative DFS to avoid recursion limits.
  const findCycle = () => {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map([...edges.keys()].map(k => [k, WHITE]));
    const parent = new Map();
    for (const start of edges.keys()) {
      if (color.get(start) !== WHITE) continue;
      const stack = [[start, [...edges.get(start)].sort()[Symbol.iterator]()]];
      color.set(start, GRAY);
      while (stack.length > 0) {
        const [node, it] = stack[stack.length - 1];
        const next = it.next();
        if (next.done) { color.set(node, BLACK); stack.pop(); continue; }
        const dep = next.value;
        if (color.get(dep) === GRAY) {
          const cycle = [dep];
          let cur = node;
          while (cur !== dep) { cycle.push(cur); cur = parent.get(cur); }
          cycle.push(dep);
          return Object.freeze(cycle.reverse());
        }
        if (color.get(dep) === WHITE) {
          color.set(dep, GRAY); parent.set(dep, node);
          stack.push([dep, [...edges.get(dep)].sort()[Symbol.iterator]()]);
        }
      }
    }
    return null;
  };
  // Topological order: items with no unmet dependencies first.
  const topoOrder = () => {
    const cycle = findCycle();
    if (cycle) fail("dependency_cycle", `cannot order a graph with a cycle: ${cycle.join(" -> ")}`);
    const visited = new Set(), order = [];
    const visit = id => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of [...edges.get(id)].sort()) visit(dep);
      order.push(id);
    };
    for (const id of [...edges.keys()].sort()) visit(id);
    return Object.freeze(order);
  };
  return Object.freeze({ addItem, addDependency, removeDependency, blockedBy, blocking,
    findCycle, topoOrder, size: () => edges.size });
}
export { DepGraphError };
