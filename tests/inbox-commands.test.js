// A023: inbox command parser. Fixture-free pure tests; no store, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseInboxCommand, listInboxCommands, isInboxCommand, InboxCommandError } from "../server/inbox-commands.mjs";
const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof InboxCommandError && error.code === code);

test("plain chat text is not a command", () => {
  assert.equal(parseInboxCommand("hello, how are you?"), null);
  assert.equal(parseInboxCommand("  just chatting  "), null);
  assert.equal(parseInboxCommand(""), null);
  assert.equal(isInboxCommand("hello"), false);
  assert.equal(isInboxCommand("/summarize"), true);
});
test("/summarize parses with or without a target", () => {
  assert.deepEqual(parseInboxCommand("/summarize"), { command: "summarize", target: null });
  assert.deepEqual(parseInboxCommand("/summarize msg-42"), { command: "summarize", target: "msg-42" });
  assert.deepEqual(parseInboxCommand("  /summarize  thread:7  "), { command: "summarize", target: "thread:7" });
  throwsCode(() => parseInboxCommand("/summarize a b"), "invalid_inbox_command");
});
test("/draft-reply keeps the body whitespace-preserved", () => {
  const intent = parseInboxCommand("/draft-reply msg-1  Thanks for the update!\n\nWill review tomorrow.");
  assert.deepEqual(intent, { command: "draft_reply", target: "msg-1", body: "Thanks for the update!\n\nWill review tomorrow." });
  throwsCode(() => parseInboxCommand("/draft-reply"), "invalid_inbox_command");
  throwsCode(() => parseInboxCommand("/draft-reply msg-1"), "invalid_inbox_command");
});
test("/file parses with an optional folder", () => {
  assert.deepEqual(parseInboxCommand("/file msg-9"), { command: "file", target: "msg-9", folder: null });
  assert.deepEqual(parseInboxCommand("/file msg-9 receipts"), { command: "file", target: "msg-9", folder: "receipts" });
  throwsCode(() => parseInboxCommand("/file"), "invalid_inbox_command");
  throwsCode(() => parseInboxCommand("/file a b c"), "invalid_inbox_command");
});
test("/help lists the catalog", () => {
  assert.deepEqual(parseInboxCommand("/help"), { command: "help", target: null });
  const catalog = listInboxCommands();
  assert.ok(catalog.length >= 4 && catalog.every(entry => entry.name && entry.usage && entry.description));
  assert.ok(Object.isFrozen(catalog));
});
test("unknown commands are explicit errors, not guesses", () => {
  throwsCode(() => parseInboxCommand("/delete-everything"), "unknown_inbox_command");
  
});
test("malicious shapes are refused", () => {
  throwsCode(() => parseInboxCommand("/summarize msg\u0000x"), "invalid_inbox_command");
  throwsCode(() => parseInboxCommand("/file msg-1 ../../etc"), "invalid_inbox_command");
  throwsCode(() => parseInboxCommand("/draft-reply msg-1 " + "x".repeat(65537)), "invalid_inbox_command");
  throwsCode(() => parseInboxCommand(42), "invalid_inbox_command");
  const intent = parseInboxCommand("/summarize msg-1");
  assert.throws(() => { intent.command = "x"; }, TypeError);
});
