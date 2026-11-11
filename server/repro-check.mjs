// Hold an agent wake when a task has no acceptance check, no steps, and no
// link to a failing test or issue. Any one of those is enough to let the
// task through. This module only decides. Posting the question and holding
// the wake are a later route.

export const REPRO_QUESTION = "Which acceptance check, repro steps, or failing test or issue should the agent use?";

const ACCEPTANCE_KEYS = new Set([
  "acceptance", "acceptancecheck", "acceptancechecks", "acceptancecriteria", "acceptancetest", "validation",
]);
const STEP_KEYS = new Set([
  "steps", "repro", "reprosteps", "reproduction", "reproductionsteps",
]);
// These names are the pointer. A non-empty value counts.
const NAMED_LINK_KEYS = new Set([
  "failingtest", "failingtests", "testpath", "testlink", "issueurl", "issuelink",
]);
// "issue" can be prose. Count it only when it names a number, a path, or a URL.
const ISSUE_KEYS = new Set(["issue", "issues", "issueid"]);

const ISSUE_URL = /(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+\/(?:-\/)?(?:issues|pull|pulls)\/\d+/i;
const TEST_PATH = /(?:^|[\s`'"(])(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:test|spec)\.(?:[cm]?js|mjs|jsx|tsx?)\b|(?:^|[\s`'"(])(?:[\w.@+-]+\/)*[\w.@+-]+_test\.go\b/;
const MAX_DEPTH = 8;
const MAX_NODES = 500;

function substantive(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(substantive);
  if (value && typeof value === "object") return Object.values(value).some(substantive);
  return false;
}

function isIssuePointer(value) {
  const text = value.trim();
  if (ISSUE_URL.test(text)) return true;
  if (/(?:^|\s)#\d+\b/.test(text)) return true;
  if (/[\w.-]+\/[\w.-]+#\d+\b/.test(text)) return true;
  if (/^\d{1,10}$/.test(text)) return true;
  return false;
}

function isTestPointer(value) {
  return typeof value === "string" && TEST_PATH.test(value);
}

function linkEvidence(key, value) {
  if (NAMED_LINK_KEYS.has(key)) return substantive(value);
  if (typeof value === "string") return isIssuePointer(value) || isTestPointer(value);
  if (Array.isArray(value)) return value.some(item => linkEvidence(key, item));
  if (value && typeof value === "object") return Object.values(value).some(item => linkEvidence(key, item));
  return false;
}

function walk(value, state, depth) {
  if (state.found || state.truncated) return;
  if (depth > MAX_DEPTH) { state.truncated = true; return; }
  state.nodes += 1;
  if (state.nodes > MAX_NODES) { state.truncated = true; return; }
  if (typeof value === "string") {
    if (ISSUE_URL.test(value) || isTestPointer(value)) state.found = true;
    return;
  }
  if (!value || typeof value !== "object") return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, state, depth + 1);
      if (state.found || state.truncated) return;
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (ACCEPTANCE_KEYS.has(name) && substantive(child)) { state.found = true; return; }
    if (STEP_KEYS.has(name) && substantive(child)) { state.found = true; return; }
    if ((NAMED_LINK_KEYS.has(name) || ISSUE_KEYS.has(name)) && linkEvidence(name, child)) { state.found = true; return; }
    walk(child, state, depth + 1);
    if (state.found || state.truncated) return;
  }
}

// True when the task should be held. A task we cannot finish scanning is
// not held: a missed check must not block a wake.
export function needsRepro(task) {
  const state = { found: false, truncated: false, nodes: 0, seen: new WeakSet() };
  walk(task, state, 0);
  if (state.found || state.truncated) return false;
  return true;
}
