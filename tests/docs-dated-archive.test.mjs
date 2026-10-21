import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const DATED = /(?:^|[-_])20\d\d-?\d\d-?\d\d(?:[-_.]|$)/;

test("docs/ holds living docs only; dated plans live in archive/docs/plans", () => {
  const dated = readdirSync(join(root, "docs")).filter(name => DATED.test(name));
  assert.deepEqual(dated, [], `move dated docs to archive/docs/plans: ${dated.join(", ")}`);
  assert.ok(readdirSync(join(root, "archive/docs/plans")).some(name => DATED.test(name)));
});
