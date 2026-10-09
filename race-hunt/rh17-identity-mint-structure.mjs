// RH-17: identity-mint race structural verification.
// The mint does read-checks (revoked credential, name safety, pilot_limit
// count) then INSERT. The race is closed iff all of that sits inside ONE
// store.transaction (BEGIN IMMEDIATE) with no await between check and insert.
import { readFileSync } from "node:fs";
const REPO = process.env.REPO;
if (!REPO) { console.error("REPO env required"); process.exit(1); }
const src = readFileSync(REPO + "/server/agent-identities.mjs", "utf8");
let bad = 0;
const check = (name, cond) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); if (!cond) bad++; };

// extract the mint method: starts at "return this.store.transaction(() => {" (line ~334) through its matching close
const start = src.indexOf("return this.store.transaction(() => {", src.indexOf("assertNotReservedRoleName(name);"));
check("mint wraps in store.transaction", start !== -1);
const tail = src.slice(start);
// crude brace matching to find the mint closure extent
let depth = 0, end = -1;
for (let i = 0; i < tail.length; i++) {
  const ch = tail[i];
  if (ch === "{") depth++;
  else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
}
const mintBody = end === -1 ? "" : tail.slice(0, end);
const limitIdx = mintBody.indexOf("pilot_limit");
const insertIdx = mintBody.indexOf("INSERT INTO agent_identities(");
check("pilot_limit check and INSERT in the same transaction closure",
  limitIdx !== -1 && insertIdx !== -1 && limitIdx < insertIdx);
const between = mintBody.slice(Math.max(0, limitIdx), insertIdx);
check("no await between limit check and INSERT", !/\bawait\b/.test(between));
check("mint closure has no awaits at all (sync critical section)", !/\bawait\b/.test(mintBody));

console.log(bad === 0
  ? "RH-17 RESULT: PASS — mint check-then-insert is one synchronous BEGIN IMMEDIATE transaction"
  : `RH-17 RESULT: FAIL — mint race guard missing (${bad})`);
process.exit(bad === 0 ? 0 : 2);
