// Kill-criteria / tripwire evaluator (200-hard-tasks #20).
// Reads research/tripwire-rules.yaml plus a metrics snapshot JSON, outputs
// GO / PAUSE / KILL with reasons. Zero dependencies: includes a small YAML
// subset parser supporting exactly the shape the rules file uses (nested
// maps via 2-space indent, "- " lists, "- key: value" list-maps, and
// string/number/boolean/null scalars).
// CLI: node scripts/evaluate-tripwires.mjs <rules.yaml> <snapshot.json> [--json]
// Exit codes: 0 = GO, 1 = PAUSE or WARN (warnings listed), 2 = KILL.

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s; // bare string
}

// Minimal YAML subset parser. Throws on anything outside the supported
// shape so rules files fail loudly instead of mis-parsing.
export function parseYamlSubset(text) {
  const lines = text.split("\n");
  const root = {};
  // Stack entries: { indent, container, parent, key }
  // container: object or array being filled; parent[key] === container (or root).
  const stack = [{ indent: -2, container: root, parent: null, key: null }];

  const frameAt = (indent) => {
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    return stack[stack.length - 1];
  };

  // Attach a nested block (map or list, decided by first child) under parent[key].
  const attachPending = (parent, key, indent) => {
    const holder = { __pending: true };
    parent[key] = holder;
    const frame = { indent, container: holder, parent, key };
    stack.push(frame);
    return frame;
  };

  // Convert a pending holder into a real array (first child was a "- " item).
  const holderToArray = (frame) => {
    const arr = [];
    frame.parent[frame.key] = arr;
    frame.container = arr;
    delete frame.container.__pending;
  };

  const parseMappingLine = (container, line, indent, lineNo) => {
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`yaml subset: expected "key: value" at line ${lineNo}`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!key) throw new Error(`yaml subset: empty key at line ${lineNo}`);
    if (rest === "") {
      attachPending(container, key, indent);
    } else {
      container[key] = parseScalar(rest);
    }
  };

  lines.forEach((rawLine, n) => {
    const lineNo = n + 1;
    const hashIdx = rawLine.indexOf("#");
    const noComment = hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx);
    if (!noComment.trim()) return;
    const indent = noComment.length - noComment.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error(`yaml subset: odd indentation at line ${lineNo} (use 2 spaces)`);
    }
    const line = noComment.trim();

    if (line.startsWith("- ")) {
      const frame = frameAt(indent);
      if (frame.container && frame.container.__pending) holderToArray(frame);
      if (!Array.isArray(frame.container)) {
        throw new Error(`yaml subset: list item at line ${lineNo} but parent is not a list`);
      }
      const rest = line.slice(2);
      if (/^[^"' \t][^:]*:/.test(rest)) {
        const item = {};
        frame.container.push(item);
        stack.push({ indent, container: item, parent: frame.container, key: frame.container.length - 1 });
        parseMappingLine(item, rest, indent, lineNo);
      } else {
        frame.container.push(parseScalar(rest));
      }
      return;
    }

    const frame = frameAt(indent);
    if (Array.isArray(frame.container)) {
      throw new Error(`yaml subset: mapping key at line ${lineNo} inside a list without "- "`);
    }
    if (frame.container && frame.container.__pending) {
      // First child of a pending block is a mapping key: it stays a map.
      delete frame.container.__pending;
    }
    parseMappingLine(frame.container, line, indent, lineNo);
  });

  const finalize = (node) => {
    if (Array.isArray(node)) return node.map(finalize);
    if (node && typeof node === "object") {
      const { __pending, ...rest } = node;
      const out = {};
      for (const [k, v] of Object.entries(rest)) out[k] = finalize(v);
      return out;
    }
    return node;
  };
  return finalize(root);
}

// --- condition evaluation -------------------------------------------------

function resolvePath(snapshot, path) {
  let cur = snapshot;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const OPS = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

function evalCondition(snapshot, cond) {
  const m = cond.trim().match(/^([a-zA-Z0-9_.]+)\s*(>=|<=|==|!=|>|<)\s*([a-zA-Z0-9_.-]+)$/);
  if (!m) throw new Error(`bad condition: ${JSON.stringify(cond)} (want "<path> <op> <number|path>")`);
  const [, leftPath, op, rightRaw] = m;
  const left = resolvePath(snapshot, leftPath);
  let right = /^-?\d+(\.\d+)?$/.test(rightRaw) ? parseFloat(rightRaw) : resolvePath(snapshot, rightRaw);
  if (left === undefined) return false; // missing signal: condition does not fire; reported in missingSignals
  if (right === undefined) throw new Error(`bad condition ${JSON.stringify(cond)}: right side resolves to nothing`);
  // Raw-unit amounts are integer strings by convention: coerce numeric strings.
  const num = (v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? parseFloat(v) : v);
  const l = num(left), r = num(right);
  if (typeof l !== "number" || typeof r !== "number") {
    throw new Error(`bad condition ${JSON.stringify(cond)}: comparisons need numbers`);
  }
  return OPS[op](l, r);
}

function evalWhen(snapshot, when) {
  if (typeof when === "string") return evalCondition(snapshot, when);
  if (when && typeof when === "object") {
    if (Array.isArray(when.all)) return when.all.every((c) => evalCondition(snapshot, c));
    if (Array.isArray(when.any)) return when.any.some((c) => evalCondition(snapshot, c));
  }
  throw new Error(`bad "when" clause: ${JSON.stringify(when)}`);
}

const SEVERITY = { GO: 0, WARN: 1, PAUSE: 2, KILL: 3 };

export function evaluateRules(rulesDoc, snapshot) {
  if (!rulesDoc || !Array.isArray(rulesDoc.rules)) throw new Error("rules document needs a 'rules' list");
  const fired = [];
  for (const rule of rulesDoc.rules) {
    if (!rule.id || !rule.verdict || !rule.when) throw new Error(`rule missing id/verdict/when: ${JSON.stringify(rule)}`);
    if (!SEVERITY.hasOwnProperty(rule.verdict) || rule.verdict === "GO") {
      throw new Error(`rule ${rule.id}: verdict must be WARN, PAUSE or KILL`);
    }
    if (evalWhen(snapshot, rule.when)) {
      fired.push({ id: rule.id, verdict: rule.verdict, reason: rule.reason || "", action: rule.action || "" });
    }
  }
  let verdict = "GO";
  for (const f of fired) {
    if (SEVERITY[f.verdict] > SEVERITY[verdict]) verdict = f.verdict;
  }
  // Report missing signals: conditions referencing absent snapshot paths.
  const known = new Set();
  const collect = (node) => {
    if (typeof node === "string") {
      const m = node.match(/^([a-zA-Z0-9_.]+)\s*(>=|<=|==|!=|>|<)/);
      if (m) known.add(m[1]);
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node)) collect(v);
    }
  };
  collect(rulesDoc.rules.map((r) => r.when));
  const missing = [...known].filter((p) => resolvePath(snapshot, p) === undefined);
  return { verdict, fired, missingSignals: missing, evaluatedAt: new Date().toISOString() };
}

// --- CLI ------------------------------------------------------------------
import { readFileSync } from "node:fs";

const isCli = process.argv[1] && process.argv[1].endsWith("evaluate-tripwires.mjs");
if (isCli) {
  const [rulesFile, snapshotFile, flag] = process.argv.slice(2);
  if (!rulesFile || !snapshotFile) {
    console.error("usage: evaluate-tripwires.mjs <rules.yaml> <snapshot.json> [--json]");
    process.exit(2);
  }
  const rulesDoc = parseYamlSubset(readFileSync(rulesFile, "utf8"));
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  const result = evaluateRules(rulesDoc, snapshot);
  if (flag === "--json") {
    console.log(JSON.stringify(result, null, 1));
  } else {
    console.log(`verdict: ${result.verdict}`);
    for (const f of result.fired) {
      console.log(`  [${f.verdict}] ${f.id}: ${f.reason}`);
      if (f.action) console.log(`           action: ${f.action}`);
    }
    if (result.missingSignals.length) {
      console.log(`  missing signals (not evaluated): ${result.missingSignals.join(", ")}`);
    }
    if (!result.fired.length) console.log("  no tripwires fired");
  }
  process.exit(result.verdict === "KILL" ? 2 : result.verdict === "PAUSE" || result.fired.some((f) => f.verdict === "WARN") ? 1 : 0);
}
