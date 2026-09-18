// Task 28: Telegram reply-template variants. Pure tests: the 4096-char
// sendMessage cap, word-boundary truncation, surrogate safety, chat tone
// of the built-ins, seeding, and render+fit integration.
import test from "node:test";
import assert from "node:assert/strict";
import {
  telegramSendMessageLimit, fitTelegramText, TELEGRAM_REPLY_TEMPLATES,
  seedTelegramTemplates, renderTelegramReply, createTemplates, placeholdersOf, TemplateError,
} from "../server/reply-templates-telegram.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TemplateError && error.code === code);

test("the sendMessage limit is Telegram's documented 4096-char cap", () => {
  assert.equal(telegramSendMessageLimit, 4096);
});

test("fitTelegramText passes short text through untouched", () => {
  assert.deepEqual(fitTelegramText("hi"), { text: "hi", truncated: false });
  assert.deepEqual(fitTelegramText(""), { text: "", truncated: false });
  const exact = "x".repeat(4096);
  assert.deepEqual(fitTelegramText(exact), { text: exact, truncated: false });
});

test("fitTelegramText truncates at a word boundary with an ellipsis", () => {
  const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  assert.ok(words.length > 4096, "fixture must exceed the cap");
  const { text, truncated } = fitTelegramText(words);
  assert.equal(truncated, true);
  assert.ok(text.length <= 4096, `fitted length ${text.length}`);
  assert.ok(text.endsWith("…"), "ends with an ellipsis");
  // No word is cut mid-word: the char before the ellipsis ends a word.
  assert.match(text, /[a-z0-9]…$/);
  // The dropped tail starts at a whitespace boundary of the original.
  const kept = text.slice(0, -1);
  assert.ok(words.startsWith(kept));
  assert.ok(kept.length < words.length);
});

test("fitTelegramText hard-cuts when there is no whitespace in range", () => {
  const solid = "z".repeat(5000);
  const { text, truncated } = fitTelegramText(solid);
  assert.equal(truncated, true);
  assert.equal(text.length, 4096);
  assert.equal(text, "z".repeat(4095) + "…");
});

test("fitTelegramText never splits a surrogate pair", () => {
  const emoji = "😀".repeat(3000); // 6000 UTF-16 units
  const { text, truncated } = fitTelegramText(emoji);
  assert.equal(truncated, true);
  assert.ok(text.length <= 4096, `fitted length ${text.length}`);
  assert.ok(text.isWellFormed(), "no lone surrogates");
  assert.ok(!/[\uD800-\uDBFF]$/.test(text.slice(0, -1)), "no trailing lead surrogate before the ellipsis");
  assert.ok(text.endsWith("…"));
});

test("fitTelegramText rejects non-strings", () => {
  throwsCode(() => fitTelegramText(null), "invalid_template");
  throwsCode(() => fitTelegramText(42), "invalid_template");
});

test("built-ins are short, chat-toned, and placeholder-clean", () => {
  const ids = new Set();
  for (const template of TELEGRAM_REPLY_TEMPLATES) {
    assert.ok(Object.isFrozen(template), `${template.templateId} frozen`);
    assert.ok(!ids.has(template.templateId), `duplicate id ${template.templateId}`);
    ids.add(template.templateId);
    assert.ok(template.body.length <= 200, `${template.templateId} is chat-length`);
    assert.ok(!/^Subject:/im.test(template.body), `${template.templateId}: no subject line`);
    assert.ok(!/^Dear /m.test(template.body), `${template.templateId}: no email opener`);
    assert.ok(!/^--$/m.test(template.body), `${template.templateId}: no signature block`);
    assert.ok(!/<[a-z][^>]*>/i.test(template.body), `${template.templateId}: no HTML markup`);
    assert.ok(!/[*_`~]/.test(template.body), `${template.templateId}: no markdown-significant chars`);
    // Every placeholder is a valid engine placeholder.
    assert.deepEqual(placeholdersOf(template.body),
      [...template.body.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map(m => m[1]));
  }
  assert.equal(ids.size, TELEGRAM_REPLY_TEMPLATES.length);
  assert.ok(Object.isFrozen(TELEGRAM_REPLY_TEMPLATES));
});

test("seedTelegramTemplates loads the built-ins under the telegram category", () => {
  const templates = createTemplates();
  const ids = seedTelegramTemplates(templates);
  assert.deepEqual([...ids].sort(), [...TELEGRAM_REPLY_TEMPLATES.map(t => t.templateId)].sort());
  assert.equal(templates.list({ category: "telegram" }).length, TELEGRAM_REPLY_TEMPLATES.length);
  const ack = templates.get("tg-ack");
  assert.equal(ack.category, "telegram");
  assert.ok(Object.isFrozen(ids));
});

test("seeding twice throws on the duplicate id", () => {
  const templates = createTemplates();
  seedTelegramTemplates(templates);
  throwsCode(() => seedTelegramTemplates(templates), "invalid_template");
  throwsCode(() => seedTelegramTemplates(null), "invalid_template");
});

test("renderTelegramReply renders variables and fits to the cap", () => {
  const templates = createTemplates();
  seedTelegramTemplates(templates);
  assert.deepEqual(renderTelegramReply(templates, "tg-looking-into", { name: "Avery" }),
    { text: "Looking into this now Avery — back with an answer shortly.", truncated: false, templateId: "tg-looking-into" });
  // A long variable value triggers the ellipsis fit, still under the cap.
  const long = renderTelegramReply(templates, "tg-follow-up", { topic: "launch", update: "w".repeat(5000) });
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 4096);
  assert.ok(long.text.startsWith("Quick follow-up on launch:"), "keeps the template head, no dangling space");
  assert.equal(long.templateId, "tg-follow-up");
  throwsCode(() => renderTelegramReply(templates, "tg-looking-into", {}), "missing_variable");
  throwsCode(() => renderTelegramReply(templates, "tg-nope", {}), "invalid_template");
  throwsCode(() => renderTelegramReply(null, "tg-ack", {}), "invalid_template");
});
