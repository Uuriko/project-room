// Fixture: replay18/28 — "replay-scenarios/skill-harness vs agent-conversations overlap"
// (Dot, COORD-300 redirect seq 8263).
//
// RECONSTRUCTION — not a byte-replay of the original incident. Dot's
// description names two claims whose scopes overlap via ancestor/descendant:
// one claim holds the broad `agent-conversations/` tree, the other holds the
// narrow `agent-conversations/replay-scenarios/skill-harness/` subtree.
// Expected normalizer verdict: replay28 CONTAINED-IN replay18
// (verdict string: "a-contains-b" with a=replay18).
export const claims = [
  {
    "id": "replay18",
    "holder": "guild-05-fixture",
    "scopes": ["agent-conversations/"]
  },
  {
    "id": "replay28",
    "holder": "guild-05-fixture",
    "scopes": ["agent-conversations/replay-scenarios/skill-harness/"]
  }
];
