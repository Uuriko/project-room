// ESLint rule (TST-07): server code must not open, commit or roll back SQLite
// transactions by hand. Use store.transaction(fn) (server/store.mjs). It is
// nesting-safe, takes BEGIN IMMEDIATE for writes, keeps read-only
// transactions read-only, and rolls back only when SQLite has not already.
//
// The rule flags `<anything>.exec(...)`, `.prepare(...)` and `.run(...)` when
// the first argument is recognisably a transaction-control statement. Trigger
// bodies such as "CREATE TRIGGER ... BEGIN SELECT RAISE(...); END" are not
// flagged.
//
// "Recognisably" (#2900) covers more than plain literals. The argument is
// reduced to one or more partial strings — literal text with a HOLE marker
// for each part whose value is not statically known — by resolving string
// literals, templates, `+` concatenation, conditionals, and identifiers
// bound exactly once to a string expression in scope. A partial string is
// flagged when its static text alone already leads with a transaction
// keyword and filling every hole the same way (empty, a savepoint name, or
// a transaction keyword such as IMMEDIATE/TRANSACTION) yields exactly a
// transaction statement: the holes can only be filling slots of that
// statement (the BEGIN mode, the savepoint name, ...), never changing what
// statement it is. Arguments that cannot be reduced this way — parameters,
// imports, reassigned variables, arbitrary expressions — stay unflagged,
// because they are not known to be transaction control at all.
const TX_SQL = /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO(?:\s+SAVEPOINT)?\s+\w+)?|SAVEPOINT\s+\w+|RELEASE(?:\s+SAVEPOINT)?\s+\w+)\s*;?\s*$/i;
const METHODS = new Set(["exec", "prepare", "run"]);
const HOLE = "\u0000";
const HOLE_FILLS = ["", "x", "TRANSACTION", "IMMEDIATE", "DEFERRED", "EXCLUSIVE"];
const TX_LEAD = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const MAX_PARTIALS = 8;

export function isTransactionSql(text) { return typeof text === "string" && TX_SQL.test(text); }

function isTransactionPartial(partial) {
  if (!partial.includes(HOLE)) return isTransactionSql(partial);
  // The transaction keyword itself must be static text, not interpolated:
  // `${stmt}` or `${verb} TRANSACTION` stays unflagged.
  if (!TX_LEAD.test(partial.split(HOLE).join(""))) return false;
  return HOLE_FILLS.some(fill => isTransactionSql(partial.split(HOLE).join(fill)));
}

// Finds the variable an identifier refers to, walking out through scopes.
function lookupVariable(context, node) {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

// The partial strings an identifier is bound to, or null when the binding
// is not a single never-reassigned variable initializer (parameters,
// imports, destructuring, and reassigned variables are all unresolvable).
function resolveIdentifier(context, node, seen) {
  const variable = lookupVariable(context, node);
  if (!variable || seen.has(variable) || variable.defs.length !== 1) return null;
  const def = variable.defs[0];
  if (def.type !== "Variable" || !def.node.init || def.node.id.type !== "Identifier") return null;
  // The initializer write is the only write allowed; any later assignment
  // makes the value at the call site unknowable.
  if (variable.references.some(ref => ref.isWrite() && ref.writeExpr !== def.node.init)) return null;
  seen.add(variable);
  const partials = partialStrings(context, def.node.init, seen);
  seen.delete(variable);
  return partials;
}

// Reduces a node to its possible partial strings (see header), or null when
// the node is not recognisably a string expression at all. In a template or
// concatenation, an unrecognisable part degrades to a single HOLE rather
// than giving up on the static text around it.
function partialStrings(context, node, seen = new Set()) {
  if (!node) return null;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? [node.value] : null;
    case "TemplateLiteral": {
      let partials = [""];
      node.quasis.forEach((quasi, i) => {
        partials = partials.map(p => p + quasi.value.cooked);
        if (i < node.expressions.length) {
          const exprPartials = partialStrings(context, node.expressions[i], seen) ?? [HOLE];
          partials = partials.flatMap(p => exprPartials.map(e => p + e)).slice(0, MAX_PARTIALS);
        }
      });
      return partials;
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const left = partialStrings(context, node.left, seen);
      const right = partialStrings(context, node.right, seen);
      if (left === null && right === null) return null;
      const l = left ?? [HOLE];
      const r = right ?? [HOLE];
      return l.flatMap(a => r.map(b => a + b)).slice(0, MAX_PARTIALS);
    }
    case "ConditionalExpression": {
      const consequent = partialStrings(context, node.consequent, seen);
      const alternate = partialStrings(context, node.alternate, seen);
      if (consequent === null || alternate === null) return null;
      return [...consequent, ...alternate].slice(0, MAX_PARTIALS);
    }
    case "Identifier":
      return resolveIdentifier(context, node, seen);
    default:
      return null;
  }
}

export const noRawTransaction = {
  meta: {
    type: "problem",
    docs: { description: "disallow hand-written BEGIN/COMMIT/ROLLBACK/SAVEPOINT in server code; use store.transaction(fn)" },
    schema: [],
    messages: { raw: "Raw transaction statement \"{{sql}}\". Use store.transaction(fn) from server/store.mjs instead." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        if (!METHODS.has(callee.property.name)) return;
        const partials = partialStrings(context, node.arguments[0]);
        const hit = partials?.find(isTransactionPartial);
        if (hit !== undefined) {
          const sql = hit.split(HOLE).join("${…}").trim().slice(0, 40);
          context.report({ node, messageId: "raw", data: { sql } });
        }
      },
    };
  },
};

export default { rules: { "no-raw-transaction": noRawTransaction } };
