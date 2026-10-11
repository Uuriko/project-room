// r35-4 (John's Tab r35 polish list): adding a second Email mailbox failed with
// "That id already belongs to a different bot or mailbox." because the
// add-dialog id field always prefilled "mailbox". The dialog must prefill an
// id that isn't taken yet ("mailbox-2", "mailbox-3", ...).
import test from "node:test";
import assert from "node:assert/strict";
import { suggestConnectionId } from "../src/connection-id-suggest.js";

test("unused base id is returned unchanged", () => {
  assert.equal(suggestConnectionId("mailbox", []), "mailbox");
});

test("taken base id gets the next numeric suffix", () => {
  assert.equal(suggestConnectionId("mailbox", ["mailbox"]), "mailbox-2");
});

test("skips taken suffixed ids", () => {
  assert.equal(suggestConnectionId("mailbox", ["mailbox", "mailbox-2"]), "mailbox-3");
  assert.equal(suggestConnectionId("mailbox", ["mailbox", "mailbox-2", "mailbox-3", "mailbox-9"]), "mailbox-4");
});

test("applies to the telegram and whatsapp defaults too", () => {
  assert.equal(suggestConnectionId("telegram-bot", ["telegram-bot"]), "telegram-bot-2");
  assert.equal(suggestConnectionId("whatsapp", ["whatsapp", "whatsapp-2"]), "whatsapp-3");
});

test("non-colliding taken ids do not force a suffix", () => {
  assert.equal(suggestConnectionId("mailbox", ["telegram-bot", "whatsapp"]), "mailbox");
});

test("suggested ids always satisfy the connection id pattern", () => {
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  for (const base of ["mailbox", "telegram-bot", "whatsapp"]) {
    const taken = [base, `${base}-2`, `${base}-3`];
    const suggestion = suggestConnectionId(base, taken);
    assert.ok(idPattern.test(suggestion), `suggestion ${suggestion} must match the id pattern`);
  }
});

test("accepts a Set of taken ids", () => {
  assert.equal(suggestConnectionId("mailbox", new Set(["mailbox"])), "mailbox-2");
});
