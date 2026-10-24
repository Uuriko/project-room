// Mechanical acceptance floors stated in a task's acceptance criteria,
// evaluated over the submitted artifact itself at verdict time
// (FIX-VERIFY-GATE). EXP-13R measured the failure this closes: reviewers
// recorded verification PASSes on a 64-byte artifact against criteria
// stating 200/400-character minimums and named required elements — the
// criteria already forbade what was passed, but nothing mechanical stood
// between the artifact and the recorded PASS, and every false PASS then
// settled as verified work.
//
// Only unambiguous stated forms become floors; anything requiring
// judgement ("not a poem or placeholder") is never a floor, and a
// criterion value that is not itself checkable (a bare generation digit,
// a lease read-back the platform no longer holds) is not invented into
// one. The floors are:
//   - stated minimum length: a criterion about the artifact stating an
//     unambiguous minimum ("at least 200 characters", "no fewer than
//     400 characters", "a minimum of 200 bytes", "200 or more
//     characters") — the artifact's length in the stated unit must meet
//     it. Characters count as Unicode code points.
//   - named file citation: a criterion of the form "cites the file
//     <path>" carrying a literal path — the artifact text must contain
//     the path.
//   - states the task id: a criterion stating the artifact states /
//     names / includes the task id — the artifact text must contain
//     the receipt's task id.
const MINIMUM_FORMS = [
  /at least\s+(\d[\d,]*)\s*(characters?|chars?|bytes?)\b/i,
  /(?:no fewer than|not less than)\s+(\d[\d,]*)\s*(characters?|chars?|bytes?)\b/i,
  /minimum(?:\s+of)?\s+(\d[\d,]*)\s*(characters?|chars?|bytes?)\b/i,
  /(\d[\d,]*)\s*(?:or more|\+)\s*(characters?|chars?|bytes?)\b/i,
];
const CITATION_FORM = /cit(?:e|es|ed|ing)\s+(?:the\s+)?file\s+`?([A-Za-z0-9_.\-/]+)`?/i;
const TASK_ID_FORM = /(?:states?|names?|includes?|gives?|reports?)\s+(?:the\s+)?task[\s-]?id\b/i;
const PATH_LIKE = token => token.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(token);

// The floors one criterion states, in machine-readable form. Exported for
// tests and for the census tooling; evaluation is evaluateArtifactFloors.
export function statedArtifactFloors(criterion) {
  if (typeof criterion !== 'string') return [];
  const floors = [];
  if (/\bartifact\b/i.test(criterion)) {
    let minimum = null;
    for (const form of MINIMUM_FORMS) {
      const match = form.exec(criterion);
      if (!match) continue;
      const value = Number(match[1].replace(/,/g, ''));
      if (!Number.isSafeInteger(value) || value <= 0) continue;
      const floor = { kind: 'minimum_length', value, unit: /^b/i.test(match[2]) ? 'bytes' : 'characters' };
      if (!minimum || floor.value > minimum.value) minimum = floor;
    }
    if (minimum) floors.push(minimum);
  }
  const citation = CITATION_FORM.exec(criterion);
  // The captured token can carry the criterion's sentence punctuation
  // ("...cites the file server/bounty-escrow.mjs.") — a file path never
  // ends in it, so trailing punctuation is the sentence's, not the path's.
  if (citation && PATH_LIKE(citation[1])) floors.push({ kind: 'file_citation', path: citation[1].replace(/[.,;:]+$/, '') });
  if (TASK_ID_FORM.test(criterion)) floors.push({ kind: 'task_id' });
  return floors;
}

const measure = (text, unit) => unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : [...text].length;

// Evaluate every stated floor over the artifact text. Returns the count
// of floors checked and one failure per failed floor, each naming the
// criterion, what it requires, and what the artifact actually has — the
// refusal built from these is the worker's re-submission instructions.
export function evaluateArtifactFloors(criteria, artifactText, { taskId } = {}) {
  const text = typeof artifactText === 'string' ? artifactText : '';
  const failures = [];
  let checked = 0;
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    for (const floor of statedArtifactFloors(criterion)) {
      checked += 1;
      if (floor.kind === 'minimum_length') {
        const actual = measure(text, floor.unit);
        if (actual < floor.value) failures.push({ criterion, floor: floor.kind,
          detail: `criterion "${criterion}" requires at least ${floor.value} ${floor.unit}; the artifact has ${actual}` });
      } else if (floor.kind === 'file_citation') {
        if (!text.includes(floor.path)) failures.push({ criterion, floor: floor.kind,
          detail: `criterion "${criterion}" requires the artifact to cite ${floor.path}; the artifact does not contain it` });
      } else if (floor.kind === 'task_id') {
        if (typeof taskId !== 'string' || !taskId || !text.includes(taskId)) failures.push({ criterion, floor: floor.kind,
          detail: `criterion "${criterion}" requires the artifact to state the task id${typeof taskId === 'string' && taskId ? ` ${taskId}` : ''}; the artifact does not contain it` });
      }
    }
  }
  return { checked, failures };
}
