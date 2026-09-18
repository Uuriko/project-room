// Task 28 — per-channel reply templates: Telegram variants.
//
// The generic template engine (server/reply-templates.mjs) is channel-blind.
// Telegram replies are chat, not email: no subject lines, no "Dear …"
// openers, no signature blocks, and every rendered reply must fit the
// sendMessage 4096-character text limit before it can be handed to the
// channel-sends path. This module is pure and dependency-free beyond the
// template engine; frozen outputs, malformed inputs throw TemplateError.
import { createTemplates, placeholdersOf, renderTemplate, TemplateError } from "./reply-templates.mjs";

// Telegram Bot API sendMessage text cap (characters).
export const telegramSendMessageLimit = 4096;

const ELLIPSIS = "…";

// Clip a string to at most `max` UTF-16 code units without splitting a
// surrogate pair.
const clipUtf16 = (value, max) => {
  if (value.length <= max) return value;
  let end = max;
  const lead = value.charCodeAt(end - 1);
  if (lead >= 0xD800 && lead <= 0xDBFF) end -= 1;
  return value.slice(0, end);
};

// Fit rendered text to the sendMessage limit. Truncation backs off to the
// last whitespace boundary so words are never cut mid-word; when there is
// no whitespace in range the cut is hard. Returns { text, truncated }.
export function fitTelegramText(text) {
  if (typeof text !== "string" || !text.isWellFormed())
    throw new TemplateError("invalid_template", "text must be a well-formed string");
  // The cap is conservative UTF-16: Telegram counts the encoded message.
  if (text.length <= telegramSendMessageLimit) return { text, truncated: false };
  const budget = telegramSendMessageLimit - 1; // room for the ellipsis
  const points = Array.from(text).slice(0, budget);
  let cut = points.join("");
  const boundary = cut.search(/\s[^\s]*$/);
  if (boundary > 0) cut = cut.slice(0, boundary);
  const fitted = clipUtf16(cut, budget) + ELLIPSIS;
  return { text: fitted, truncated: true };
}

// Built-in Telegram reply templates. Chat tone: short, direct, no
// email-formal trappings (no subject, no "Dear", no sign-off block) and
// plain text — the send path chooses any parse mode, so bodies avoid
// markup-significant characters entirely.
export const TELEGRAM_REPLY_TEMPLATES = Object.freeze([
  Object.freeze({ templateId: "tg-ack", name: "Acknowledge",
    body: "Got it — on it now, will update you here." }),
  Object.freeze({ templateId: "tg-looking-into", name: "Looking into it",
    body: "Looking into this now {{name}} — back with an answer shortly." }),
  Object.freeze({ templateId: "tg-need-info", name: "Need info",
    body: "Could you share {{what}}? I'll take it from there." }),
  Object.freeze({ templateId: "tg-follow-up", name: "Follow up",
    body: "Quick follow-up on {{topic}}: {{update}}" }),
  Object.freeze({ templateId: "tg-meeting-confirm", name: "Confirm meeting",
    body: "Confirmed for {{when}}. Talk then." }),
  Object.freeze({ templateId: "tg-handoff", name: "Hand off",
    body: "Looping in {{who}} — they'll pick this up from here." }),
  Object.freeze({ templateId: "tg-thanks", name: "Thanks",
    body: "Thanks {{name}} — appreciate it." }),
  Object.freeze({ templateId: "tg-closing", name: "Closing",
    body: "All set on my side — shout if anything else comes up." }),
]);

// Seed the built-ins into a createTemplates() store under category
// "telegram". Returns the template ids. Seeding twice throws
// TemplateError (invalid_template) on the duplicate id.
export function seedTelegramTemplates(templates) {
  if (!templates || typeof templates.create !== "function")
    throw new TemplateError("invalid_template", "templates must be a createTemplates() store");
  const ids = [];
  for (const { templateId, name, body } of TELEGRAM_REPLY_TEMPLATES) {
    templates.create({ templateId, name, body, category: "telegram" });
    ids.push(templateId);
  }
  return Object.freeze(ids);
}

// Render a Telegram template by id and fit it to the sendMessage limit.
// Returns { text, truncated, templateId }. Unknown ids and missing
// variables throw TemplateError, exactly as the base engine does.
export function renderTelegramReply(templates, templateId, variables) {
  if (!templates || typeof templates.render !== "function")
    throw new TemplateError("invalid_template", "templates must be a createTemplates() store");
  const { text, truncated } = fitTelegramText(templates.render(templateId, variables));
  return { text, truncated, templateId };
}

export { createTemplates, placeholdersOf, renderTemplate, TemplateError };
