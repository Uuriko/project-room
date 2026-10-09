// Fixture: broad server lease vs PR #2272 (Dot, COORD-300 redirect seq 8263).
//
// RECONSTRUCTION. A lane holds a broad recursive lease on `server/`.
// PR #2272 ("WIP: signed-in public-work typo suggestion parity (AX-1B)",
// OPEN at fixture time) touches exactly one file:
//   tests/qa5r-mcp-public-work-suggest.test.js   (verified via gh pr view)
// Expected normalizer verdict: disjoint. A broad lease does NOT collide with
// a PR outside its subtree — the tooling must say so plainly instead of
// letting a human guess. (Path overlap is the question here, not whether the
// test exercises server code — see "what is NOT proven" in the doc.)
export const claims = [
  {
    "id": "srv-lease-broad",
    "holder": "guild-05-fixture",
    "scopes": ["server/"]
  },
  {
    "id": "pr-2272",
    "holder": "guild-05-fixture",
    "scopes": ["tests/qa5r-mcp-public-work-suggest.test.js"]
  }
];
