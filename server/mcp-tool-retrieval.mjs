// MCP retrieval-based tool discovery (G5): a server-side TF-IDF cosine
// retriever over the live catalog's tool names and descriptions. It is a
// discovery layer over the catalog, never a second catalog: callers pass
// the exact listing a profile would serve (see listedMcpTools in
// server/mcp-discovery.mjs) and get a ranked top-5 drawn from that listing.
//
// Ranker: field-weighted TF-IDF cosine — the name field and the description
// field are indexed separately and combined 0.65 / 0.35. The DISCOVERY-50
// lane G5 prototype scored names alone (the snapshot it had carries no
// descriptions); indexing the richer production text naively as one field
// dilutes the name signal and scored 28/30 on the lane's frozen 30-task
// set, while the field-weighted ranker scores 30/30 and places all three
// of the lane's named misses first. The fixture, not the algorithm, is the
// contract (tests/mcp-tool-retrieval.test.js re-runs the frozen set).
//
// Safety property: discoverMcpTools in server/mcp-discovery.mjs gates this
// retriever on RETRIEVAL_CONFIDENCE_THRESHOLD — below it the caller gets
// the full/profile listing byte-for-byte, so a weak retrieval never
// becomes a missing tool. Results are computed per query from the listing
// passed in and are never cached, so a result computed against a
// superseded catalog is never served after the catalog moves.
import { MCP_DISCOVERY_SYNONYMS } from "./mcp-discovery-synonyms.mjs";

// Revocation switch: set to false (one act) and discoverMcpTools returns
// the plain profile/full listing for every query — the pre-build path.
export const MCP_TOOL_RETRIEVAL_ENABLED = true;

// Named confidence threshold on the combined cosine score. The frozen
// 30-task set's weakest winning top score is ~0.19 against the catalog at
// build time; an unrelated-vocabulary query scores 0. 0.1 sits between
// them with margin on both sides and is pinned by the fallback test.
export const RETRIEVAL_CONFIDENCE_THRESHOLD = 0.1;

export const RETRIEVAL_TOP_N = 5;
const NAME_FIELD_WEIGHT = 0.65;

// Light plural stem: messages->message, peers->peer, dms->dm. Deliberately
// minimal (trailing s, sparing ss/us/is endings) — it is normalisation for
// matching, not linguistics.
const stem = word => word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
export const discoveryTokens = text => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1).map(stem);

// Applies the synonym map (data: server/mcp-discovery-synonyms.mjs) to the
// query's tokens. An entry fires when one of its phrases appears in the
// normalised query text (or as a stemmed token) and, when it names a
// context, one of those stemmed terms is among the query tokens.
export function expandDiscoveryQuery(query, synonyms = MCP_DISCOVERY_SYNONYMS) {
  const text = String(query ?? "").toLowerCase();
  const terms = discoveryTokens(query);
  const out = [...terms];
  for (const entry of synonyms ?? []) {
    if (entry.context && !entry.context.some(term => terms.includes(stem(term)))) continue;
    const hit = (entry.phrases ?? []).some(phrase => text.includes(phrase) || terms.includes(stem(phrase)));
    if (!hit) continue;
    for (const term of entry.add ?? []) if (!out.includes(term)) out.push(term);
  }
  return out;
}

function fieldIndex(fields) {
  const df = new Map();
  for (const tokens of fields) for (const word of new Set(tokens)) df.set(word, (df.get(word) ?? 0) + 1);
  const idf = word => Math.log((fields.length + 1) / ((df.get(word) ?? 0) + 1)) + 1;
  const vector = tokens => {
    const vec = new Map();
    for (const word of tokens) vec.set(word, (vec.get(word) ?? 0) + idf(word));
    const norm = Math.hypot(...vec.values()) || 1;
    for (const [word, value] of vec) vec.set(word, value / norm);
    return vec;
  };
  return { vector, docVectors: fields.map(vector) };
}

const cosine = (queryVector, docVector) => {
  let score = 0;
  for (const [word, value] of queryVector) score += value * (docVector.get(word) ?? 0);
  return score;
};

// Ranks the tools of one live listing for a plain-words discovery query.
// Returns the scored matches (score > 0, best first, catalog order breaking
// ties so the result is deterministic), capped at `limit`, plus the top
// score as the confidence the fallback gate consumes. Match objects are
// the listing entries themselves plus their score.
export function retrieveMcpTools(query, { tools = [], synonyms = MCP_DISCOVERY_SYNONYMS, limit = RETRIEVAL_TOP_N } = {}) {
  const terms = expandDiscoveryQuery(query, synonyms);
  if (terms.length === 0 || tools.length === 0) return { query, matches: [], confidence: 0 };
  const names = fieldIndex(tools.map(tool => discoveryTokens(String(tool.name ?? "").replaceAll("_", " "))));
  const descriptions = fieldIndex(tools.map(tool => discoveryTokens(tool.description)));
  const nameQuery = names.vector(terms);
  const descriptionQuery = descriptions.vector(terms);
  const scored = [];
  tools.forEach((tool, index) => {
    const score = NAME_FIELD_WEIGHT * cosine(nameQuery, names.docVectors[index])
      + (1 - NAME_FIELD_WEIGHT) * cosine(descriptionQuery, descriptions.docVectors[index]);
    if (score > 0) scored.push({ score, index, tool });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = scored.slice(0, limit).map(({ score, tool }) => ({ ...tool, score }));
  return { query, matches, confidence: scored.length ? scored[0].score : 0 };
}
