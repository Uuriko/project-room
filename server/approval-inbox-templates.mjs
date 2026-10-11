// Approval-inbox card templates (WAVE-500 G10 slice 26/50).
//
// The unified approval inbox is one live surface for pending HUMAN decisions.
// Good cards are hard to write, so templates make them consistent: each kind
// declares the fields a decider needs, the decision options, and — on every
// option — the consequence of choosing it. A card option without a stated
// consequence is a card John can't safely decide on.
//
// Pure, no I/O, dependency-free; frozen outputs. Clock and id generator are
// injected so fixtures control time and ids. One error contract:
// TemplateError with a machine-readable code.
import { randomUUID } from "node:crypto";

export class TemplateError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new TemplateError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

const HOUR_MS = 3_600_000;
const MAX_FIELD_LEN = 400;

const templates = Object.freeze([
  {
    id: "money", kind: "money",
    titleTemplate: "Send {amount} via {rail} to {recipient}",
    fields: Object.freeze([
      { name: "amount", required: true, hint: "e.g. 250.00 USDC" },
      { name: "rail", required: true, hint: "solana | ethereum | base | stripe …" },
      { name: "recipient", required: true, hint: "who receives the funds" },
      { name: "reason", required: false, hint: "why this moves — bounty, refund, purchase …" },
    ]),
    defaultOptions: Object.freeze([
      { id: "approve", label: "Approve transfer",
        consequence: "Funds move: {amount} leaves via {rail} to {recipient}. Once sent it cannot be recalled." },
      { id: "deny", label: "Deny",
        consequence: "Nothing moves. The request is closed; no transfer happens." },
      { id: "request-changes", label: "Request changes",
        consequence: "Sent back to the requester for edits. Nothing moves until a new card is approved." },
    ]),
    defaultTtlMs: 24 * HOUR_MS,
  },
  {
    id: "identity", kind: "identity",
    titleTemplate: "{action} {credential}",
    fields: Object.freeze([
      { name: "credential", required: true, hint: "which key / token / secret" },
      { name: "scope", required: true, hint: "what it can touch" },
      { name: "action", required: true, hint: "rotate | revoke" },
      { name: "systems", required: false, hint: "systems that feel the cutover" },
    ]),
    defaultOptions: Object.freeze([
      { id: "rotate", label: "Rotate",
        consequence: "A new credential is issued and the old one is invalidated. Brief overlap during cutover; {scope} stays reachable." },
      { id: "revoke", label: "Revoke without replacement",
        consequence: "The credential is killed immediately with no replacement. {scope} loses access until a new credential is provisioned." },
      { id: "deny", label: "Deny",
        consequence: "Nothing changes. The credential keeps working exactly as before." },
    ]),
    defaultTtlMs: 4 * HOUR_MS,
  },
  {
    id: "deploy", kind: "deploy",
    titleTemplate: "Deploy {what} {version} to {environment}",
    fields: Object.freeze([
      { name: "what", required: true, hint: "which build / bundle" },
      { name: "environment", required: true, hint: "production | staging" },
      { name: "version", required: true, hint: "commit SHA or tag that ships" },
      { name: "rollbackPlan", required: true, hint: "how to undo this if it breaks — a deploy card without one is a gamble" },
    ]),
    defaultOptions: Object.freeze([
      { id: "approve", label: "Approve deploy",
        consequence: "{what} {version} ships to {environment}. Rollback: {rollbackPlan}." },
      { id: "deny", label: "Deny",
        consequence: "Nothing ships. The current build stays live on {environment}." },
    ]),
    defaultTtlMs: 8 * HOUR_MS,
  },
  {
    id: "permission", kind: "permission",
    titleTemplate: "Grant {access} to {who}",
    fields: Object.freeze([
      { name: "who", required: true, hint: "agent or human receiving access" },
      { name: "access", required: true, hint: "what they can do — merge, deploy, read …" },
      { name: "duration", required: true, hint: "e.g. 7d, 1h — 'permanent' is a choice, not a default" },
      { name: "scope", required: false, hint: "which repos / rooms / systems" },
      { name: "reason", required: false, hint: "why they need it" },
    ]),
    defaultOptions: Object.freeze([
      { id: "approve", label: "Approve",
        consequence: "{who} gains {access} for {duration}. The grant is recorded and revocable." },
      { id: "deny", label: "Deny",
        consequence: "No access is granted. {who} keeps exactly what they have now." },
    ]),
    defaultTtlMs: 48 * HOUR_MS,
  },
  {
    id: "publish", kind: "publish",
    titleTemplate: "Publish {what} to {where}",
    fields: Object.freeze([
      { name: "what", required: true, hint: "the post / notes / announcement" },
      { name: "where", required: true, hint: "URL, channel, or feed it lands on" },
      { name: "audience", required: false, hint: "who can see it" },
      { name: "notes", required: false, hint: "review context for the decider" },
    ]),
    defaultOptions: Object.freeze([
      { id: "approve", label: "Approve publish",
        consequence: "{what} goes public at {where}. Once public it can be copied and archived — treat it as permanent." },
      { id: "deny", label: "Deny",
        consequence: "Stays unpublished. Nothing becomes public." },
    ]),
    defaultTtlMs: 24 * HOUR_MS,
  },
]);

// Authoring gate: fail loudly at import if a template ships an option
// without a stated consequence — that's the whole point of this module.
for (const template of templates) {
  check(typeof template.id === "string" && template.id.length > 0, "template_invalid", "template needs an id");
  check(typeof template.titleTemplate === "string" && template.titleTemplate.length > 0,
    "template_invalid", `template ${template.id} needs a titleTemplate`);
  check(Number.isFinite(template.defaultTtlMs) && template.defaultTtlMs > 0,
    "template_invalid", `template ${template.id} needs a positive defaultTtlMs`);
  for (const option of template.defaultOptions) {
    check(typeof option.consequence === "string" && option.consequence.trim().length > 0,
      "template_consequence_missing", `template ${template.id} option ${option.id} has no consequence`);
  }
}

const byId = new Map(templates.map(t => [t.id, t]));

export const templateIds = Object.freeze(templates.map(t => t.id));

export function getTemplate(templateId) {
  const template = byId.get(templateId);
  if (!template) fail("template_unknown", `unknown approval-inbox template: ${templateId}`);
  return template;
}

export function listTemplates() {
  return Object.freeze(templates.map(t => Object.freeze({
    id: t.id, kind: t.kind, titleTemplate: t.titleTemplate,
    fields: t.fields, defaultOptions: t.defaultOptions, defaultTtlMs: t.defaultTtlMs,
  })));
}

const textOf = (value, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    check(optional, "template_field_missing", `field "${field}" is required`);
    return null;
  }
  check(typeof value === "string" && value.isWellFormed() && value.trim().length >= 1 && value.length <= MAX_FIELD_LEN,
    "template_field_invalid", `field "${field}" must be a 1..${MAX_FIELD_LEN} character string`);
  return value;
};

const interpolate = (text, fields) =>
  text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(fields, name) && fields[name] !== null ? fields[name] : match);

export function instantiate(templateId, fields, { now = () => Date.now(), id = () => randomUUID() } = {}) {
  const template = getTemplate(templateId);
  check(fields !== null && typeof fields === "object" && !Array.isArray(fields),
    "template_field_invalid", "fields must be a plain object");

  const known = new Map(template.fields.map(f => [f.name, f]));
  for (const name of Object.keys(fields)) {
    check(known.has(name), "template_field_unknown", `template "${templateId}" has no field "${name}"`);
  }

  const clean = {};
  for (const field of template.fields) {
    const value = textOf(fields[field.name], field.name, { optional: !field.required });
    if (value !== null) clean[field.name] = value;
  }

  const createdAt = now();
  const options = template.defaultOptions.map(o => Object.freeze({
    id: o.id,
    label: interpolate(o.label, clean),
    consequence: interpolate(o.consequence, clean),
  }));
  return Object.freeze({
    id: id(),
    templateId: template.id,
    kind: template.kind,
    title: interpolate(template.titleTemplate, clean),
    fields: Object.freeze({ ...clean }),
    options: Object.freeze(options),
    status: "draft",
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + template.defaultTtlMs).toISOString(),
  });
}
