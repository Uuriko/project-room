// Work-claim duplicate detection — Linear "similar issues" emulation.
//
// A pure decider: given the room's work-claim items and a free-text query,
// returns ranked candidate duplicates with scores in [0, 1]. Pure,
// dependency-free, deterministic; frozen outputs.
//
// The tool suggests; agents decide. Nothing here auto-merges, auto-closes,
// or auto-links — a candidate is a hint, and marking a real duplicate stays
// an explicit agent action.
//
// Scoring: tokenize (lowercase alphanumeric runs, stopword-stripped), then
// weighted Jaccard similarity: 0.6 * title overlap + 0.4 * note overlap.
// Only items at or above minScore are returned, ranked score-descending
// with id-ascending tie-breaks so repeated calls are byte-identical.
class DuplicateError extends Error { constructor(code, message) { super(message); this.name = "DuplicateError"; this.code = code; } }
const fail = (code, message) => { throw new DuplicateError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_duplicate_input", message); };

export { DuplicateError };

const STOPWORDS = new Set((
  "a,an,the,and,or,of,to,in,on,for,with,by,at,from,as,is,are,was,were,be,been," +
  "it,its,this,that,these,those,we,you,he,she,they,it,i,our,your,my,his,her,their," +
  "do,does,did,not,no,yes,if,then,else,when,what,which,who,how,can,will,just,so," +
  "into,out,up,down,over,under,again,once,here,there,all,any,both,each,few,more," +
  "most,other,some,such,only,own,same,than,too,very"
).split(","));

const TITLE_WEIGHT = 0.6;
const NOTE_WEIGHT = 0.4;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// Lowercase alphanumeric tokens minus stopwords. Returns a Set.
export function tokenize(text) {
  check(text === null || text === undefined || typeof text === "string", "text must be a string");
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter(word => !STOPWORDS.has(word)));
}

const jaccard = (a, b) => {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
};

const textOf = (value, field) => {
  const text = value?.[field];
  check(text === undefined || text === null || typeof text === "string", `item ${field} must be a string`);
  return text ?? "";
};

// Score one item against the query token set, in [0, 1], rounded to 4dp.
export function scoreItem(item, queryTokens) {
  check(item !== null && typeof item === "object" && !Array.isArray(item), "item must be an object");
  check(queryTokens instanceof Set, "queryTokens must be a Set");
  const titleScore = jaccard(tokenize(textOf(item, "title")), queryTokens);
  const noteScore = jaccard(tokenize(textOf(item, "note")), queryTokens);
  return Math.round((TITLE_WEIGHT * titleScore + NOTE_WEIGHT * noteScore) * 10000) / 10000;
}

// Ranked duplicate candidates for a free-text query over work-claim items.
// Each item needs at least { id }; title/note/state/owner are optional.
// Returns frozen [{ id, title, state, owner, score }], best first.
export function findDuplicates(items, query, { limit = DEFAULT_LIMIT, minScore = DEFAULT_MIN_SCORE, excludeId = null } = {}) {
  check(Array.isArray(items), "items must be an array");
  check(typeof query === "string" && query.length >= 1 && query.length <= 512, "query must be 1..512 characters");
  check(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT, `limit must be an integer 1..${MAX_LIMIT}`);
  check(typeof minScore === "number" && Number.isFinite(minScore) && minScore >= 0 && minScore <= 1, "minScore must be 0..1");
  check(excludeId === null || (typeof excludeId === "string" && excludeId.length > 0), "excludeId must be a string or null");
  const queryTokens = tokenize(query);
  const ranked = [];
  for (const item of items) {
    check(item !== null && typeof item === "object" && !Array.isArray(item), "items must be objects");
    check(typeof item.id === "string" && item.id.length > 0, "every item needs a string id");
    if (excludeId !== null && item.id === excludeId) continue;
    const score = scoreItem(item, queryTokens);
    if (score < minScore) continue;
    ranked.push(Object.freeze({
      id: item.id,
      title: textOf(item, "title"),
      state: typeof item.state === "string" ? item.state : "unclaimed",
      owner: typeof item.owner === "string" ? item.owner : null,
      score,
    }));
  }
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(ranked.slice(0, limit));
}
