// Room automations admin (owner only). OFF unless ROOM_AUTOMATIONS=1.
// POST /api/rooms/{roomId}/automations with exactly one of:
//   {list: true} | {template: "post-deploy-check", member?} |
//   {create: {name, trigger, action}} | {enable: ruleId} | {disable: ruleId} | {delete: ruleId}
// Created rules start disabled. See server/event-automations.mjs.
import { automationsEnabled, AUTOMATION_TEMPLATES, createRule, setRuleEnabled, deleteRule, listRules, validTrigger, validAction } from "../event-automations.mjs";
import { ownMember } from "../../src/events.js";

export async function postAutomationsAdmin(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  let auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*"))
    ctx.reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  if (!automationsEnabled()) ctx.reject(404, "not_found", "Not found");
  let authority = ctx.store.roomAuthority(roomId);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_only", "Only the room owner can manage automations");
  const startingMemberId = auth.member.id;
  const data = await ctx.body(ctx.req, { fields: ["list", "template", "member", "create", "enable", "disable", "delete"], unknownCode: "invalid_body" });
  // Body reads yield: credentials and ownership must still authorize this write.
  auth = ctx.roomAuth(selected, roomId, fence);
  if (auth?.member?.id !== startingMemberId) ctx.reject(403, "access_denied", "Room identity changed while reading the request");
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*"))
    ctx.reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  authority = ctx.store.roomAuthority(roomId);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_only", "Only the room owner can manage integrations");
  const db = ctx.store.db, members = authority.members ?? {};
  if (data.list === true) return ctx.json(ctx.res, 200, { ok: true, rules: listRules(db, { roomId }), templates: Object.keys(AUTOMATION_TEMPLATES) });
  for (const verb of ["enable", "disable", "delete"]) {
    if (typeof data[verb] !== "string") continue;
    const changed = verb === "delete" ? deleteRule(db, { roomId, ruleId: data[verb] }) : setRuleEnabled(db, { roomId, ruleId: data[verb], enabled: verb === "enable" });
    if (!changed) ctx.reject(404, "unknown_rule", "No such automation in this room");
    return ctx.json(ctx.res, 200, { ok: true, ruleId: data[verb], [verb === "delete" ? "deleted" : "enabled"]: verb === "delete" ? true : verb === "enable" });
  }
  let rule;
  if (typeof data.template === "string") {
    const template = AUTOMATION_TEMPLATES[data.template];
    if (!template) ctx.reject(422, "unknown_template", `template must be one of ${Object.keys(AUTOMATION_TEMPLATES).join(", ")}`);
    const member = ownMember(members, typeof data.member === "string" ? data.member : auth.member.id);
    if (!member || member.active === false) ctx.reject(422, "unknown_member", "member must be an active room member");
    rule = { name: template.name, trigger: template.trigger, action: template.action(member.id), template: data.template };
  } else if (data.create && typeof data.create === "object") {
    const { name, trigger, action } = data.create;
    if (typeof name !== "string" || name.trim().length === 0) ctx.reject(422, "invalid_name", "name must be a non-empty string");
    if (!validTrigger(trigger)) ctx.reject(422, "invalid_trigger", "trigger needs at least one of actions, kinds, states, tags with known values");
    if (!validAction(action, members)) ctx.reject(422, "invalid_action", "action must be {type:'wake', member, brief} or {type:'open_task', title, assignee?} naming active members");
    rule = { name: name.trim(), trigger, action };
  } else ctx.reject(422, "invalid_body", "Pass one of list, template, create, enable, disable, delete");
  const made = createRule(db, { roomId, ...rule, createdBy: auth.member.id });
  if (made.error) ctx.reject(409, made.error, "This room has the maximum number of automations");
  return ctx.json(ctx.res, 201, { ok: true, rule: made.rule });
}

export const AUTOMATION_ROUTES = Object.freeze([
  Object.freeze({ id: "automations.admin", method: "POST", path: "/api/rooms/{roomId}/automations",
    auth: "room", capability: null, scope: "room", handler: postAutomationsAdmin,
    parity: "exempt:owner-only room configuration; agents receive its effects as wakes and Board tasks, not as a tool",
    schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: ["work_claim.updated"] }),
]);
