// Custom analytics dashboards (G010). A pure dashboard-view manager:
// define saved views (named metric sets with filters), list, and resolve
// a view into a query spec. Metric computation stays in the analytics
// engine; this module owns view definitions. All state is caller-owned
// (a Map); the module is pure and dependency-free. Frozen outputs;
// malformed inputs throw DashboardError. Dashboard UI is a later slice.
class DashboardError extends Error { constructor(code, message) { super(message); this.name = "DashboardError"; this.code = code; } }
const fail = (code, message) => { throw new DashboardError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dashboard", message); };
const METRICS = ["messages", "reactions", "activeUsers", "workItems", "polls", "joins"];
// Create a dashboard manager. store is a caller-owned Map (viewId -> view).
export function createDashboards({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const views = store ?? new Map();
  let viewCounter = 0;
  // Create a saved view.
  const create = ({ name, ownerId, metrics, roomIds, days }) => {
    check(typeof name === "string" && name.trim().length > 0, "name must be a non-empty string");
    check(typeof ownerId === "string" && ownerId.length > 0, "ownerId must be a non-empty string");
    check(Array.isArray(metrics) && metrics.length > 0, "metrics must be a non-empty array");
    check(metrics.every(m => METRICS.includes(m)), `metrics must be from ${METRICS.join(", ")}`);
    check(roomIds === undefined || (Array.isArray(roomIds) && roomIds.every(r => typeof r === "string")),
      "roomIds must be an array of strings if given");
    check(days === undefined || (Number.isInteger(days) && days > 0), "days must be positive if given");
    const viewId = `view-${++viewCounter}`;
    const view = Object.freeze({ viewId, name: name.trim(), ownerId,
      metrics: Object.freeze([...metrics]), roomIds: Object.freeze(roomIds || []),
      days: days || 30 });
    views.set(viewId, view);
    return view;
  };
  // List views for an owner.
  const list = ownerId => {
    check(typeof ownerId === "string" && ownerId.length > 0, "ownerId must be a non-empty string");
    return Object.freeze([...views.values()].filter(v => v.ownerId === ownerId));
  };
  // Resolve a view into a query spec.
  const resolve = viewId => {
    check(typeof viewId === "string" && viewId.length > 0, "viewId must be a non-empty string");
    check(views.has(viewId), `unknown view "${viewId}"`);
    const view = views.get(viewId);
    return Object.freeze({ viewId, metrics: view.metrics, roomIds: view.roomIds, days: view.days });
  };
  // Delete a view.
  const remove = (ownerId, { viewId }) => {
    check(typeof viewId === "string" && viewId.length > 0, "viewId must be a non-empty string");
    const view = views.get(viewId);
    check(view !== undefined, `unknown view "${viewId}"`);
    check(view.ownerId === ownerId, "only the owner can delete a view");
    views.delete(viewId);
    return Object.freeze({ viewId, deleted: true });
  };
  return Object.freeze({ create, list, resolve, remove, METRICS: Object.freeze([...METRICS]) });
}
export { DashboardError };
