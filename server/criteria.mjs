// Addressable criteria + per-criterion outcomes beyond the bounty lane
// (#3613, accountability R-2). The bounty lane pins explicit rubric
// criteria ({criterionId, description}) and refuses acceptance unless the
// verifier cites every one with a pass|fail verdict
// (citationsAgainstRubric in server/bounty-escrow.mjs). Offers and board
// claims instead carry their criteria as a plain text list — the list
// itself is the pin (an offer's termsVersion pins its list; a claim's
// stored acceptanceCriteria is its list) — so the addressable id of the
// criterion at position i is derived, never stored: `c${i + 1}`, the same
// c1-style id the bounty lane's default rubric uses. Deriving from the
// pinned list keeps every surface (offer record, task packet, review,
// receipt) in agreement without a second stored copy to drift.

// The pinned criteria of a text list, each with its derived addressable id.
export const criteriaWithIds = criteriaTexts => Object.freeze(
  (Array.isArray(criteriaTexts) ? criteriaTexts : []).map((criterion, index) =>
    Object.freeze({ criterionId: `c${index + 1}`, criterion })));

// Validate a reviewer's per-criterion outcomes against a pinned criteria
// text list, with citationsAgainstRubric semantics: the outcome list must
// cite every pinned criterion exactly once, may cite nothing else, and
// each verdict is pass|fail. `check(condition, message)` is the caller's
// own refusal dialect (each surface keeps its error code); on success the
// frozen, list-ordered outcome list is returned.
export const criterionOutcomesAgainst = (outcomes, criteriaTexts, check) => {
  const criteria = criteriaWithIds(criteriaTexts);
  check(Array.isArray(outcomes) && outcomes.length > 0,
    "criterionOutcomes are required: one {criterionId, verdict} per criterion");
  check(outcomes.length <= criteria.length,
    `criterionOutcomes must hold at most ${criteria.length} entries`);
  const ids = new Set(criteria.map(entry => entry.criterionId));
  const cited = new Set();
  for (const outcome of outcomes) {
    check(outcome !== null && typeof outcome === "object" && !Array.isArray(outcome),
      "criterionOutcomes must be {criterionId, verdict} objects");
    check(ids.has(outcome.criterionId),
      `criterionId "${outcome.criterionId}" is not one of the pinned criteria (${[...ids].join(", ")})`);
    check(!cited.has(outcome.criterionId), `criterion "${outcome.criterionId}" is cited more than once`);
    cited.add(outcome.criterionId);
    check(["pass", "fail"].includes(outcome.verdict),
      `criterion "${outcome.criterionId}" verdict must be pass or fail`);
  }
  for (const { criterionId } of criteria)
    check(cited.has(criterionId), `criterion "${criterionId}" has no outcome — every pinned criterion must be cited`);
  const byId = new Map(outcomes.map(outcome => [outcome.criterionId, outcome.verdict]));
  return Object.freeze(criteria.map(({ criterionId }) =>
    Object.freeze({ criterionId, verdict: byId.get(criterionId) })));
};
