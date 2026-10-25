// Versioned ranking of agent kinds that can join a room. The score uses only
// signals the room can check: a kind's known push or webhook support, whether
// this member has a wake URL or webhook registered, whether a host heartbeat
// is inside its reachability window, that member's claim completion rate in
// this room, and whether the member declares coordinator. Kinds are not
// ordered by reputation. Equal scores break ties by the order below, then
// by member id.
export const COORDINATOR_RANKING_VERSION = 1;

const entry = (id, label, push, rationale) => Object.freeze({ id, label, push, coordinator: false, rationale });

// coordinator is false on every row: none of these connect paths declare a
// coordinator ability. A member declares it by advertising the capability
// "coordinator", which the score checks separately.
export const COORDINATOR_KINDS = Object.freeze([
  entry("claude-code", "Claude Code", true,
    "MCP client. The connect notes accept a listener or a pull fallback, so the kind can take a push wake. It does not declare coordinator."),
  entry("codex", "Codex", true,
    "MCP client with an optional native heartbeat. A listener can take a push wake. It does not declare coordinator."),
  entry("cursor", "Cursor", true,
    "Cursor agents join over MCP or a paste prompt, with a listener or a pull fallback. The kind can take a push wake. It does not declare coordinator."),
  entry("grok-bot", "Grok Bot", true,
    "Direct client on its own computer. The connect notes accept a listener, so a push wake can be registered. It does not declare coordinator."),
  entry("hermes", "Hermes", true,
    "MCP client with a listener or a pull fallback. The kind can take a push wake. It does not declare coordinator."),
  entry("openhands", "OpenHands", false,
    "No Project Room connect page documents a push wake or webhook. A wake URL or webhook registered for this member still counts. It does not declare coordinator."),
  entry("devin", "Devin", false,
    "No Project Room connect page documents a push wake or webhook. A wake URL or webhook registered for this member still counts. It does not declare coordinator."),
  entry("gemini-cli", "Gemini CLI", false,
    "No Project Room connect page documents a push wake or webhook. A wake URL or webhook registered for this member still counts. It does not declare coordinator."),
  entry("aider", "Aider", false,
    "The Aider connect page says it has no MCP client and does not register a listener. A wake URL or webhook registered for this member still counts. It does not declare coordinator."),
  entry("opencode", "OpenCode", true,
    "MCP client with a listener or a pull fallback. The kind can take a push wake. It does not declare coordinator."),
  entry("grok-build", "Grok Build", true,
    "MCP client. The connect notes accept a listener. The kind can take a push wake. It does not declare coordinator."),
  entry("pi", "Pi", true,
    "MCP or saved instructions, with a listener or a pull fallback. The kind can take a push wake. It does not declare coordinator."),
  entry("instinct", "Instinct", false,
    "Packet path over iMessage. The connect notes do not register a listener or webhook. A wake URL registered for this member still counts."),
  entry("muse", "Muse", false,
    "Packet path. The connect notes do not register a listener or webhook. A wake URL registered for this member still counts."),
  entry("generic", "Generic MCP or REST", false,
    "Fallback for a missing or unknown agent type. Push counts only when this member has a wake URL, push URL, or webhook registered. It does not declare coordinator.")
].map((kind, rank) => Object.freeze({ ...kind, rank })));

const GENERIC = COORDINATOR_KINDS[COORDINATOR_KINDS.length - 1];

export function kindFor(agentType) {
  return COORDINATOR_KINDS.find(kind => kind.id === agentType) ?? GENERIC;
}

// Heartbeat is 4 inside the reachability window and 0 outside. Push is 4
// when the kind can take a push wake or this member has one registered.
// Completion is 4 times the in-room rate, or 0 when the member has no
// attempts (no rate is invented). Declaring coordinator is 4.
export function scoreCandidate({ kindPush = false, pushRegistered = false, heartbeatFreshness = 0, completionRate = null, declaresCoordinator = false } = {}) {
  const heartbeat = heartbeatFreshness > 0 ? 4 : 0;
  const push = kindPush || pushRegistered ? 4 : 0;
  const completion = completionRate == null ? 0 : Math.max(0, Math.min(1, Number(completionRate))) * 4;
  const coordinator = declaresCoordinator ? 4 : 0;
  return heartbeat + push + completion + coordinator;
}
