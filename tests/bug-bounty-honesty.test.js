// HP-04 (PRODUCT-200 client craft, honest product): docs/BUG-BOUNTY.md must not
// promise a live paying program. The doc's own header says it is "not
// activated or funded" — the body (Rollout: "starts on merge of this
// document") contradicts that. This test pins the honest copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(root, "docs", "BUG-BOUNTY.md");

test("BUG-BOUNTY.md exists", () => {
  assert.ok(existsSync(docPath), "docs/BUG-BOUNTY.md should exist");
});

test("BUG-BOUNTY.md never promises activation-on-merge", () => {
  const content = readFileSync(docPath, "utf8");
  assert.ok(
    !content.includes("The program starts on merge of this document"),
    "Rollout must not promise the program starts on merge — activation is an explicit owner act"
  );
});

test("BUG-BOUNTY.md keeps the not-activated-or-funded header", () => {
  const content = readFileSync(docPath, "utf8");
  assert.ok(
    content.includes("not activated or funded"),
    "the honest header (proposed program, not activated or funded) must stay"
  );
});

test("BUG-BOUNTY.md says reputation receipts today, $DASHA later", () => {
  const content = readFileSync(docPath, "utf8");
  assert.ok(
    content.includes("reputation receipts"),
    "the doc must say today's payment is reputation receipts"
  );
  const payoutStep = content.match(/5\.\s\*\*Payout\*\*([\s\S]*?)(?=\n\d\.\s\*\*|\n## |$)/);
  assert.ok(payoutStep, "the Payout triage step should exist");
  assert.ok(
    /activated|reputation receipts/.test(payoutStep[1]),
    "the Payout step must not promise $DASHA without naming the activation/receipt condition"
  );
});

test("BUG-BOUNTY.md Rollout names owner activation as the start condition", () => {
  const content = readFileSync(docPath, "utf8");
  const rollout = content.split("## Rollout")[1] ?? "";
  assert.ok(
    /owner.*activat|activat.*owner/i.test(rollout),
    "Rollout must say the program starts only when an owner explicitly activates it"
  );
});
