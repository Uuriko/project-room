// Fixture: docs10/33 — "docs partitions" (Dot, COORD-300 redirect seq 8263).
//
// RECONSTRUCTION. Two claims that LOOK scary (both under `docs/`) but are
// disjoint partitions of it: docs10 owns tutorials+guides, docs33 owns
// api+reference. Expected normalizer verdict: disjoint — the tooling must NOT
// false-positive on a shared ancestor directory.
export const claims = [
  {
    "id": "docs10",
    "holder": "guild-05-fixture",
    "scopes": ["docs/tutorials/", "docs/guides/"]
  },
  {
    "id": "docs33",
    "holder": "guild-05-fixture",
    "scopes": ["docs/api/", "docs/reference/"]
  }
];
