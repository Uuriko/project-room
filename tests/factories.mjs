// Test data factories (Q013). Builder functions for creating test
// fixtures: rooms, messages, agents, users, work items. Each builder
// accepts overrides and produces deterministic, frozen objects. The
// module is pure and dependency-free. For use in tests only.
let roomCounter = 0;
let messageCounter = 0;
let agentCounter = 0;
let userCounter = 0;
let workItemCounter = 0;
// Build a room fixture.
export function buildRoom(overrides = {}) {
  const n = ++roomCounter;
  return Object.freeze({ roomId: `room-${n}`, name: `Test Room ${n}`,
    createdAt: "2026-09-16T10:00:00Z", ...overrides });
}
// Build a message fixture.
export function buildMessage(overrides = {}) {
  const n = ++messageCounter;
  return Object.freeze({ messageId: `msg-${n}`, roomId: "room-1",
    authorId: "user-1", text: `Test message ${n}`,
    createdAt: "2026-09-16T10:00:00Z", ...overrides });
}
// Build an agent fixture.
export function buildAgent(overrides = {}) {
  const n = ++agentCounter;
  return Object.freeze({ agentId: `agent-${n}`, name: `Test Agent ${n}`,
    capabilities: ["chat"], ...overrides });
}
// Build a user fixture.
export function buildUser(overrides = {}) {
  const n = ++userCounter;
  return Object.freeze({ userId: `user-${n}`, displayName: `Test User ${n}`,
    email: `user${n}@example.com`, ...overrides });
}
// Build a work-item fixture.
export function buildWorkItem(overrides = {}) {
  const n = ++workItemCounter;
  return Object.freeze({ workItemId: `wi-${n}`, title: `Test Work Item ${n}`,
    status: "open", ...overrides });
}
// Reset all counters (for deterministic test runs).
export function resetFactories() {
  roomCounter = 0;
  messageCounter = 0;
  agentCounter = 0;
  userCounter = 0;
  workItemCounter = 0;
}
