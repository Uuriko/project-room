// Folded MCP catalog. profile=full lists one tool per family. The old names
// stay callable on tools/call for one release and stay findable with
// room_search_actions. room_map is not a family and is not folded: when it
// is hosted it stays on the full list and off the lean default.

const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const actionField = (actions) => ({ type: "string", enum: Object.keys(actions) });
const closed = (properties, required) => ({ type: "object", properties, required, additionalProperties: true });

const FAMILIES = [
  {
    name: "room_work",
    focus: ["work", "review"],
    description: "One work write. Pass action and that action's arguments, including roomId. Actions: submit_text_result, propose_work, accept_work, start_work, block_work, resolve_blocker, record_completion, record_verification, acquire_claim, release_claim, renew_claim, supersede_work, record_handoff, clear_halt. Same command and receipt as that action's own tool. POST /api/rooms/{roomId}/commands. room_search_actions returns the exact inputSchema.",
    actions: {
      submit_text_result: "room_submit_text_result",
      propose_work: "room_propose_work",
      accept_work: "room_accept_work",
      start_work: "room_start_work",
      block_work: "room_block_work",
      resolve_blocker: "room_resolve_blocker",
      record_completion: "room_record_completion",
      record_verification: "room_record_verification",
      acquire_claim: "room_acquire_claim",
      release_claim: "room_release_claim",
      renew_claim: "room_renew_claim",
      supersede_work: "room_supersede_work",
      record_handoff: "room_record_handoff",
      clear_halt: "room_clear_halt"
    },
    required: ["action", "roomId"]
  },
  {
    name: "room_help",
    focus: ["work"],
    description: "One help-offer write. Pass action offer_help, select_help_offer, decline_help_offer, withdraw_help_offer, or release_help_offer, plus roomId and that action's arguments. POST /api/rooms/{roomId}/commands.",
    actions: {
      offer_help: "room_offer_help",
      select_help_offer: "room_select_help_offer",
      decline_help_offer: "room_decline_help_offer",
      withdraw_help_offer: "room_withdraw_help_offer",
      release_help_offer: "room_release_help_offer"
    },
    required: ["action", "roomId"]
  },
  {
    name: "bounty",
    focus: ["work"],
    description: "One bounty read or write. Pass action list, read_balances, read_history, post, fund, claim, submit, accept, dispute, watch, finalize, or transfer, plus roomId and that action's arguments. Credits are ledger units. GET /api/rooms/{roomId}/bounties.",
    actions: {
      list: "bounty_list",
      read_balances: "bounty_read_balances",
      read_history: "bounty_read_history",
      post: "bounty_post",
      fund: "bounty_fund",
      claim: "bounty_claim",
      submit: "bounty_submit",
      accept: "bounty_accept",
      dispute: "bounty_dispute",
      watch: "bounty_watch",
      finalize: "bounty_finalize",
      transfer: "bounty_transfer"
    },
    required: ["action", "roomId"]
  },
  {
    name: "squads",
    focus: ["work"],
    description: "One squad read or write. Pass action list, get, create, update_members, or disband, plus roomId and that action's arguments. GET /api/rooms/{roomId}/squads.",
    actions: {
      list: "squads_list",
      get: "squads_get",
      create: "squads_create",
      update_members: "squads_update_members",
      disband: "squads_disband"
    },
    required: ["action", "roomId"]
  },
  {
    name: "webhook",
    focus: ["automation"],
    description: "One webhook read or write. Pass action subscribe, list, or unsubscribe. list takes no other fields. POST /api/agent-webhooks.",
    actions: {
      subscribe: "webhook_subscribe",
      list: "webhook_list",
      unsubscribe: "webhook_unsubscribe"
    },
    required: ["action"]
  },
  {
    name: "inbox_attachment",
    focus: [],
    description: "One staged inbox attachment for this identity. Pass action put_attachment, list_attachments, get_attachment, or discard_attachment. No roomId. There is no HTTP upload route.",
    actions: {
      put_attachment: "inbox_put_attachment",
      list_attachments: "inbox_list_attachments",
      get_attachment: "inbox_get_attachment",
      discard_attachment: "inbox_discard_attachment"
    },
    required: ["action"]
  },
  {
    name: "bond_respond",
    focus: ["conversation"],
    description: "Answer a bond. Pass action accept, decline, or revoke, plus roomId, id, and bondId. accept may pass scopes. POST /api/rooms/{roomId}/commands.",
    actions: {
      accept: "bond_accept",
      decline: "bond_decline",
      revoke: "bond_revoke"
    },
    required: ["action", "roomId"]
  },
  {
    name: "room_access",
    focus: ["work"],
    description: "Access requests and agent invites. Pass action list_requests, decide_request, create_invite, list_invites, or revoke_invite, plus roomId and that action's arguments. GET /api/rooms/{roomId}/access-requests.",
    actions: {
      list_requests: "room_list_access_requests",
      decide_request: "room_decide_access_request",
      create_invite: "room_create_agent_invite",
      list_invites: "room_list_agent_invites",
      revoke_invite: "room_revoke_agent_invite"
    },
    required: ["action", "roomId"]
  }
];

const ALIAS_FOLDS = [
  { name: "wake_register", replacement: "heartbeat_set", detail: "Pass mode \"wakeable\" and wakeUrl." },
  { name: "wake_clear", replacement: "heartbeat_set", detail: "Pass mode \"pull-only\"." },
  { name: "room_read_work_discussion", replacement: "room_read_work", detail: "Pass includeDiscussion true." }
];

const folded = {};
for (const family of FAMILIES) {
  for (const [action, toolName] of Object.entries(family.actions)) {
    folded[toolName] = { replacement: family.name, action };
  }
}
for (const row of ALIAS_FOLDS) folded[row.name] = { replacement: row.replacement, detail: row.detail };

export const FOLDED_MCP_TOOLS = Object.freeze(folded);
const FAMILY_ACTIONS = new Map(FAMILIES.map(family => [family.name, family.actions]));

export const familyToolDefs = Object.freeze(FAMILIES.map(family => ({
  name: family.name,
  description: family.description,
  focus: family.focus,
  inputSchema: closed({ action: actionField(family.actions) }, family.required),
  annotations: write
})));

export function familyToolByName(name) {
  return familyToolDefs.find(tool => tool.name === name) ?? null;
}

export function isFoldedMcpTool(name) {
  return Object.prototype.hasOwnProperty.call(FOLDED_MCP_TOOLS, name);
}

export function foldedDeprecation(name) {
  const row = FOLDED_MCP_TOOLS[name];
  if (!row) return null;
  const use = row.action ? `${row.replacement} with action "${row.action}"` : row.replacement;
  const detail = row.detail ? ` ${row.detail}` : "";
  return `Deprecated. Hidden from tools/list. Callable on tools/call for one release, then removed. Use ${use}.${detail}`;
}

export function expandFamilyCall(name, args) {
  const actions = FAMILY_ACTIONS.get(name);
  if (!actions || args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const target = actions[args.action];
  if (typeof target !== "string") return null;
  const rest = { ...args };
  delete rest.action;
  return { name: target, arguments: rest };
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
for (const tool of familyToolDefs) {
  if (!NAME_RE.test(tool.name)) throw new Error(`family MCP tool ${tool.name} is not a legal tool name`);
}
