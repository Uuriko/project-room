// Synonym map for MCP retrieval-based tool discovery (G5). Data, not code:
// the retriever (server/mcp-tool-retrieval.mjs) consumes this table, so an
// entry can be added or corrected without a change to the retriever. Every
// entry carries the frozen-task evidence that motivated it — an entry with
// no task evidence is a defect (charter mechanism checklist: the map is
// capped by evidence, not by taste). Source: DISCOVERY-50 lane G5 measured
// misses on the frozen 30-task set (tests/fixtures/mcp-discovery-tasks.json).
//
// Shape: phrases are matched against the normalised query text; when the
// entry names a context, one of those (stemmed) terms must also be present
// in the query; add lists the extra query terms the match contributes.
export const MCP_DISCOVERY_SYNONYMS = Object.freeze([
  Object.freeze({
    phrases: ["direct message", "direct messages"],
    add: ["dm"],
    evidence: "Frozen task \"list direct message conversations with peers\" -> room_list_peer_dms: the task says \"direct message\"; the tool name's dm token is never expanded (lane G5 REPORT, named miss 2)."
  }),
  Object.freeze({
    phrases: ["hand off"],
    add: ["handoff"],
    evidence: "Frozen task \"hand off your work to another agent\" -> room_handoff: \"hand off\" splits into hand+off while the tool name carries the single token handoff (lane G5 REPORT, named miss 3)."
  }),
  Object.freeze({
    phrases: ["create", "creating"],
    context: ["bounty", "bounties"],
    add: ["post"],
    evidence: "Frozen task \"create a new bounty offering credits for a task\" -> bounty_post: creation vocabulary pulls retrieval toward room/squad create tools; in the bounty context the catalog's verb is post (lane G5 REPORT, named miss 1)."
  })
]);
