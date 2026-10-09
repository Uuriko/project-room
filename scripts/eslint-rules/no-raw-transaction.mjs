// ESLint rule (TST-07): server code must not open, commit or roll back SQLite
// transactions by hand. Use store.transaction(fn) (server/store.mjs). It is
// nesting-safe, takes BEGIN IMMEDIATE for writes, keeps read-only
// transactions read-only, and rolls back only when SQLite has not already.
//
// The rule flags `<anything>.exec(...)`, `.prepare(...)` and `.run(...)` when
// the first argument is a plain string (or a template with no expressions)
// that is only a transaction-control statement. Trigger bodies such as
// "CREATE TRIGGER ... BEGIN SELECT RAISE(...); END" are not flagged.
const TX_SQL = /^\s*(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO(?:\s+SAVEPOINT)?\s+\w+)?|SAVEPOINT\s+\w+|RELEASE(?:\s+SAVEPOINT)?\s+\w+)\s*;?\s*$/i;
const METHODS = new Set(["exec", "prepare", "run"]);

export function isTransactionSql(text) { return typeof text === "string" && TX_SQL.test(text); }

function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map(q => q.value.cooked).join("");
  return null;
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
        const sql = staticString(node.arguments[0]);
        if (sql !== null && isTransactionSql(sql)) context.report({ node, messageId: "raw", data: { sql: sql.trim().slice(0, 40) } });
      },
    };
  },
};

export default { rules: { "no-raw-transaction": noRawTransaction } };
