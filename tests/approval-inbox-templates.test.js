// Approval-inbox card templates (WAVE-500 G10 slice 26/50).
//
// Authoring gate:
// 1. Every template instantiates with valid fields into a frozen card draft:
//    interpolated title, the template's kind, non-empty options each with a
//    stated consequence, and expiresAt = createdAt + defaultTtlMs.
// 2. A missing required field fails with code template_field_missing — one
//    assertion per required field per template, so a template that grows a
//    field without a gate here fails loudly.
// 3. Unknown template id, unknown field name, and non-string field values
//    fail with their own codes; every option on every template carries a
//    non-empty consequence string (a card option without a stated
//    consequence is a card John can't safely decide on).
// 4. Pure module: deterministic under an injected clock/id; no I/O.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TemplateError,
  templateIds,
  listTemplates,
  getTemplate,
  instantiate,
} from "../server/approval-inbox-templates.mjs";

const fixedNow = () => 1_790_000_000_000; // deterministic clock
const fixedId = () => "card-0001";
const isoOf = ms => new Date(ms).toISOString();

const goodFields = {
  money: { amount: "250.00 USDC", rail: "solana", recipient: "worker-7", reason: "bounty payout" },
  identity: { credential: "GH_DEPLOY_KEY", scope: "repo:Uuriko/project-room", action: "rotate", systems: "CI deploy lane" },
  deploy: { what: "room web build", environment: "production", version: "fcf0b18a", rollbackPlan: "redeploy prior bundle via deploy lane" },
  permission: { who: "lane-codex", access: "merge", duration: "7d", reason: "wave merge duty" },
  publish: { what: "release notes v3", where: "room.trydemigod.com/blog", audience: "public" },
};

test("all five templates exist and list as frozen summaries", () => {
  assert.deepEqual([...templateIds].sort(), ["deploy", "identity", "money", "permission", "publish"]);
  const list = listTemplates();
  assert.equal(list.length, 5);
  assert.throws(() => { list.push({}); }, TypeError);
  for (const t of list) {
    assert.equal(typeof t.id, "string");
    assert.equal(typeof t.kind, "string");
    assert.equal(typeof t.titleTemplate, "string");
    assert.ok(Array.isArray(t.fields) && t.fields.length > 0);
    assert.ok(Array.isArray(t.defaultOptions) && t.defaultOptions.length >= 2);
    assert.equal(typeof t.defaultTtlMs, "number");
    assert.ok(t.defaultTtlMs > 0);
    assert.throws(() => { t.fields = []; }, TypeError);
  }
});

test("each template instantiates with valid fields", () => {
  for (const id of templateIds) {
    const draft = instantiate(id, goodFields[id], { now: fixedNow, id: fixedId });
    assert.equal(draft.id, "card-0001");
    assert.equal(draft.templateId, id);
    assert.equal(draft.kind, id);
    assert.equal(draft.status, "draft");
    assert.equal(draft.createdAt, isoOf(fixedNow()));
    const ttl = getTemplate(id).defaultTtlMs;
    assert.equal(draft.expiresAt, isoOf(fixedNow() + ttl));
    assert.ok(!/\{[^}]+\}/.test(draft.title), `title still has placeholders for ${id}: ${draft.title}`);
    assert.deepEqual(draft.fields, { ...goodFields[id] });
    assert.ok(draft.options.length >= 2);
    assert.throws(() => { draft.options = []; }, TypeError);
    assert.throws(() => { draft.title = "x"; }, TypeError);
  }
});

test("missing required field fails per field per template", () => {
  for (const id of templateIds) {
    const template = getTemplate(id);
    const required = template.fields.filter(f => f.required).map(f => f.name);
    assert.ok(required.length > 0, `template ${id} has no required fields`);
    for (const name of required) {
      const fields = { ...goodFields[id] };
      delete fields[name];
      assert.throws(() => instantiate(id, fields, { now: fixedNow }), err =>
        err instanceof TemplateError && err.code === "template_field_missing" && err.message.includes(name),
        `template ${id} did not require field ${name}`);
    }
  }
});

test("unknown template id fails", () => {
  assert.throws(() => instantiate("nonsense", {}, { now: fixedNow }), err =>
    err instanceof TemplateError && err.code === "template_unknown");
  assert.throws(() => getTemplate("nonsense"), err =>
    err instanceof TemplateError && err.code === "template_unknown");
});

test("unknown field name fails", () => {
  for (const id of templateIds) {
    assert.throws(() => instantiate(id, { ...goodFields[id], bogus: "x" }, { now: fixedNow }), err =>
      err instanceof TemplateError && err.code === "template_field_unknown",
      `template ${id} accepted an unknown field`);
  }
});

test("non-string or empty field values fail", () => {
  for (const id of templateIds) {
    const template = getTemplate(id);
    const name = template.fields.find(f => f.required).name;
    for (const bad of ["", "   ", 42, {}, []]) {
      assert.throws(() => instantiate(id, { ...goodFields[id], [name]: bad }, { now: fixedNow }), err =>
        err instanceof TemplateError && err.code === "template_field_invalid",
        `template ${id} accepted bad value for ${name}: ${JSON.stringify(bad)}`);
    }
    // explicit null/undefined reads as missing, not malformed
    for (const bad of [null, undefined]) {
      assert.throws(() => instantiate(id, { ...goodFields[id], [name]: bad }, { now: fixedNow }), err =>
        err instanceof TemplateError && err.code === "template_field_missing",
        `template ${id} did not treat ${name}=${bad} as missing`);
    }
  }
});

test("every option on every template states a consequence", () => {
  for (const id of templateIds) {
    const template = getTemplate(id);
    const ids = template.defaultOptions.map(o => o.id);
    // every template offers "deny" (nothing happens) plus at least one
    // decision; identity's decisions are rotate/revoke, not a generic approve
    assert.ok(ids.includes("deny"), `template ${id} has no deny option`);
    assert.ok(ids.some(o => o !== "deny"), `template ${id} has no decision option`);
    for (const option of template.defaultOptions) {
      assert.equal(typeof option.label, "string");
      assert.ok(option.label.length > 0, `template ${id} option ${option.id} has empty label`);
      assert.equal(typeof option.consequence, "string");
      assert.ok(option.consequence.trim().length > 0,
        `template ${id} option ${option.id} is missing its consequence`);
    }
    // instantiated drafts carry the consequences through, interpolated
    const draft = instantiate(id, goodFields[id], { now: fixedNow });
    for (const option of draft.options) {
      assert.ok(option.consequence.trim().length > 0);
      assert.ok(!/\{[^}]+\}/.test(option.consequence), `option ${option.id} of ${id} has raw placeholders`);
    }
  }
});

test("optional fields are optional but still validated when present", () => {
  const draft = instantiate("money", { amount: "1 USDC", rail: "solana", recipient: "x" }, { now: fixedNow });
  assert.ok(draft.title.includes("1 USDC"));
  assert.throws(() => instantiate("money", { amount: "1", rail: "s", recipient: "x", reason: 7 }, { now: fixedNow }),
    err => err instanceof TemplateError && err.code === "template_field_invalid");
});

test("money deny consequence says nothing moves", () => {
  const draft = instantiate("money", goodFields.money, { now: fixedNow });
  const deny = draft.options.find(o => o.id === "deny");
  assert.ok(/nothing moves/i.test(deny.consequence), `deny consequence: ${deny.consequence}`);
  const approve = draft.options.find(o => o.id === "approve");
  assert.ok(/funds move/i.test(approve.consequence), `approve consequence: ${approve.consequence}`);
});

test("identity template covers rotation vs revoke as distinct decisions", () => {
  const template = getTemplate("identity");
  const ids = template.defaultOptions.map(o => o.id);
  assert.ok(ids.includes("rotate"), "identity has no rotate decision");
  assert.ok(ids.includes("revoke"), "identity has no revoke decision");
  const rotate = instantiate("identity", goodFields.identity, { now: fixedNow }).options.find(o => o.id === "rotate");
  assert.ok(/old/i.test(rotate.consequence) && /invalidat/i.test(rotate.consequence),
    `rotate consequence should say old credentials are invalidated: ${rotate.consequence}`);
});

test("deploy card requires a rollback plan", () => {
  const fields = { ...goodFields.deploy };
  delete fields.rollbackPlan;
  assert.throws(() => instantiate("deploy", fields, { now: fixedNow }),
    err => err instanceof TemplateError && err.code === "template_field_missing");
});

test("fields must be a plain object", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    assert.throws(() => instantiate("money", bad, { now: fixedNow }),
      err => err instanceof TemplateError && err.code === "template_field_invalid");
  }
});
