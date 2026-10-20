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
//   - stated minimum length: a criterion about the submitted artifact
//     stating an unambiguous minimum ("at least 200 characters", "no
//     fewer than 400 characters", "a minimum of 200 bytes", "200 or more
//     characters") — the artifact's length in the stated unit must meet
//     it. Characters count as Unicode code points. The subject nouns are
//     the artifact's own names in task criteria — artifact, submission,
//     response, deliverable (REV-FIXES-1, from REV-PRS-1 F-4296-2: the
//     literal noun "artifact" alone let the submission-phrased criteria
//     bypass the gate); a minimum stated about something else (a
//     summary) is still not an artifact floor. Word counts ("at least
//     300 words", a whitespace-separated token count), ranges ("300–600
//     words", "between 200 and 400 characters" — the floor is the
//     range's lower bound), and decimal minima ("at least 200.5
//     characters" — the floor is the smallest whole unit meeting it)
//     floor the same way (REV-FIXES-1, from REV-PRS-1 F-4296-1: the
//     EXP-13R glossary criterion is a word range and escaped entirely).
//     A negated minimum ("need not be at least 200 characters") still
//     floors: the parser stays literal in the safe direction — it can
//     only block a PASS, never admit one (REV-PRS-1 F-4296-4, accepted
//     as-is).
//   - named file citation: a criterion of the form "cites the file
//     <path>" carrying a literal path — the artifact text must contain
//     the path.
//   - states the task id: a criterion stating the artifact states /
//     names / includes the task id — the artifact text must contain
//     the receipt's task id.
const MINIMUM_FORMS = [
  /at least\s+(\d[\d,]*(?:\.\d+)?)\s*(characters?|chars?|bytes?|words?)\b/i,
  /(?:no fewer than|not less than)\s+(\d[\d,]*(?:\.\d+)?)\s*(characters?|chars?|bytes?|words?)\b/i,
  /minimum(?:\s+of)?\s+(\d[\d,]*(?:\.\d+)?)\s*(characters?|chars?|bytes?|words?)\b/i,
  /(\d[\d,]*(?:\.\d+)?)\s*(?:or more|\+)\s*(characters?|chars?|bytes?|words?)\b/i,
];
const RANGE_FORMS = [
  /(\d[\d,]*(?:\.\d+)?)\s*(?:–|—|-)\s*(\d[\d,]*(?:\.\d+)?)\s*(characters?|chars?|bytes?|words?)\b/i,
  /between\s+(\d[\d,]*(?:\.\d+)?)\s+and\s+(\d[\d,]*(?:\.\d+)?)\s*(characters?|chars?|bytes?|words?)\b/i,
];
// The subjects a length criterion can be about and still be a floor over
// the submitted artifact: its own names in task criteria. A minimum
// stated about anything else (a summary, a cover note) is not a floor.
const SUBJECT_FORM = /\b(?:artifact|submission|response|deliverable)\b/i;
const CITATION_FORM = /cit(?:e|es|ed|ing)\s+(?:the\s+)?file\s+`?([A-Za-z0-9_.\-/]+)`?/i;
const TASK_ID_FORM = /(?:states?|names?|includes?|gives?|reports?)\s+(?:the\s+)?task[\s-]?id\b/i;
const PATH_LIKE = token => token.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(token);

// A stated value as a floor value: lengths are whole units, so a
// decimal minimum floors at the smallest whole unit that satisfies it
// ("at least 200.5 characters" is met by exactly 201 characters).
const floorValue = raw => {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const whole = Math.ceil(value);
  return Number.isSafeInteger(whole) ? whole : null;
};
const unitOf = raw => /^b/i.test(raw) ? 'bytes' : /^w/i.test(raw) ? 'words' : 'characters';

// The floors one criterion states, in machine-readable form. Exported for
// tests and for the census tooling; evaluation is evaluateArtifactFloors.
export function statedArtifactFloors(criterion) {
  if (typeof criterion !== 'string') return [];
  const floors = [];
  if (SUBJECT_FORM.test(criterion)) {
    let minimum = null;
    const consider = (value, unit) => {
      if (value === null) return;
      const floor = { kind: 'minimum_length', value, unit };
      if (!minimum || floor.value > minimum.value) minimum = floor;
    };
    for (const form of MINIMUM_FORMS) {
      // Every match of the form counts, not just the first: a criterion
      // may state a minimum more than once ("at least 200 characters
      // ... at least 400 characters"), and the floor is the STRONGEST
      // minimum stated, wherever in the criterion it appears.
      for (const match of criterion.matchAll(new RegExp(form.source, `${form.flags}g`))) {
        consider(floorValue(match[1]), unitOf(match[2]));
      }
    }
    for (const form of RANGE_FORMS) {
      // A stated range floors at its lower bound: "300–600 words"
      // forbids a 289-word artifact exactly as "at least 300 words"
      // does, and permits everything the range itself permits.
      for (const match of criterion.matchAll(new RegExp(form.source, `${form.flags}g`))) {
        const lower = Math.min(Number(match[1].replace(/,/g, '')), Number(match[2].replace(/,/g, '')));
        consider(Number.isFinite(lower) ? floorValue(String(lower)) : null, unitOf(match[3]));
      }
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

const measure = (text, unit) => unit === 'bytes' ? Buffer.byteLength(text, 'utf8')
  : unit === 'words' ? text.split(/\s+/).filter(token => token.length > 0).length
  : [...text].length;

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
