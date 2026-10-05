// Curiosity ranking for work discovery.
//
// Formalizes Schmidhuber (2009): interestingness is compression progress —
// the steepness of the learning curve. Work that is already fully familiar
// teaches nothing; work that shares nothing with what you know is noise.
// The interesting middle is unfamiliar-but-learnable.
//
// For a candidate work item we measure textual familiarity f against the
// calling member's completed work (title + definition-of-done, cosine over
// token-frequency vectors) and score it f*(1-f)^2, normalized to peak at 1:
// interestingness = what you can latch onto, times the square of what you
// still don't know. It is zero for exact repeats (nothing to learn) and for
// pure noise (nothing to latch onto), and peaks at f = 1/3. A symmetric
// 4f(1-f) would be wrong here: it scores a near-duplicate at f = 0.75 as
// 0.75, ranking routine work above genuinely new work.
// With no completed work on record the familiarity is
// measured against the centroid of the candidates themselves, so the most
// distinctive items surface first instead of arbitrary order.
//
// Pure function, no I/O, deterministic: ties break by id ascending.

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,from,at,by,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,should,could,can,may,might,must,not,no,yes,if,then,than,that,this,these,those,it,its,they,them,their,we,our,you,your,i,me,my,he,she,his,her,we,us,up,out,off,over,under,into,about,after,before,during,between,through,all,any,both,each,few,more,most,other,some,such,only,own,same,so,too,very,just".split(",")
);

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function tfVector(tokens) {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, ca] of a) {
    na += ca * ca;
    const cb = b.get(t);
    if (cb !== undefined) dot += ca * cb;
  }
  for (const cb of b.values()) nb += cb * cb;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function centroid(vectors) {
  const c = new Map();
  for (const v of vectors) for (const [t, n] of v) c.set(t, (c.get(t) ?? 0) + n);
  if (vectors.length > 0) for (const t of c.keys()) c.set(t, c.get(t) / vectors.length);
  return c;
}

// familiarity of one candidate vector against a history: the max cosine to
// any single completed item (your closest prior experience sets the bar).
function familiarity(candidate, historyVectors) {
  if (historyVectors.length === 0) return null;
  let best = 0;
  for (const h of historyVectors) best = Math.max(best, cosine(candidate, h));
  return best;
}

export function curiosityLabel(f) {
  if (f < 0.15) return "unfamiliar — may be noise, skim before committing";
  if (f < 0.35) return "stretch — unfamiliar but learnable";
  if (f < 0.6) return "sweet spot — adjacent to what you know";
  return "routine — you have done this before";
}

// Peak of f*(1-f)^2 is at f = 1/3 with value 4/27; normalize to [0,1].
const CURIOSITY_PEAK = 4 / 27;

export function curiosityScore(f) {
  return Math.min(1, (f * (1 - f) * (1 - f)) / CURIOSITY_PEAK);
}

import { completedResults } from "./work-selectors.js";

// Completed work produced by one member: the familiarity baseline for
// curiosity ranking. producerId is the receipt's producer; items without
// one never match a viewer and are excluded.
export function viewerHistory(state, viewerId) {
  return completedResults(state).filter(item => item.receipt?.producerId === viewerId);
}

// Rank raw work items ({ id, title, definitionOfDone }) by curiosity against
// historyItems (the viewer's completed work). Returns
// [{ item, curiosity: { score, familiarity, label } }] in ranked order.
export function sortWorkByCuriosity(items, historyItems) {
  const ranked = rankByCuriosity(
    items.map(item => ({ id: item.id, title: item.title, text: item.definitionOfDone })),
    historyItems.map(item => ({ title: item.title, text: item.definitionOfDone })));
  const byId = new Map(items.map(item => [item.id, item]));
  return ranked.map(r => ({
    item: byId.get(r.id),
    curiosity: { score: r.score, familiarity: r.familiarity, label: r.label },
  }));
}

// candidates: [{ id, title, text }]. history: [{ title, text }].
// Returns [{ id, title, score, familiarity, label }] sorted by score
// descending, id ascending on ties. Score and familiarity round to 3 dp.
export function rankByCuriosity(candidates, history) {
  const candVecs = candidates.map(c => tfVector(tokenize(`${c.title} ${c.text ?? ""}`)));
  const histVecs = (history ?? []).map(h => tfVector(tokenize(`${h.title} ${h.text ?? ""}`)));
  const basis = histVecs.length > 0 ? histVecs : null;
  const basisCentroid = basis === null && candVecs.length > 1 ? centroid(candVecs) : null;

  return candidates.map((c, i) => {
    let f = familiarity(candVecs[i], basis ?? []);
    let labelBasis = "completed work";
    if (f === null) {
      labelBasis = "no completed work";
      f = basisCentroid ? cosine(candVecs[i], basisCentroid) : 0;
    }
    const score = curiosityScore(f);
    return {
      id: c.id,
      title: c.title,
      score: Math.round(score * 1000) / 1000,
      familiarity: Math.round(f * 1000) / 1000,
      label: labelBasis === "no completed work" ? "unranked — no completed work yet" : curiosityLabel(f),
    };
  }).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
