// MCP tool annotation truth table — COMP-DEEP #4 (digest §2 item 4, R-11).
//
// Before this module, every tool factory stamped a template
// (`idempotentHint: true, destructiveHint: false`) on every tool it built,
// so 64 of 73 hosted write tools claimed an idempotency they did not have,
// routine lifecycle verbs claimed to be destructive, and the tools that
// actually discard things claimed not to be. There is no default here:
// a tool with no entry in this table cannot be defined at all —
// annotateMcpTool() throws, so adding a write tool without an explicit
// idempotent/destructive decision is a startup/test failure, never a
// silent inherited `true`. (The one family that was already honest, the
// bounty tools, keeps its values: its idempotencyKey is OPTIONAL and
// keyless writes execute every time, so its writes claim false.)
//
// How each value was decided (per tool, against its handler):
//   readOnlyHint    — true only when the call changes no shared state.
//   idempotentHint  — true only with positive evidence that repeating the
//                     EXACT same arguments has no additional effect. The
//                     evidence class is recorded in `basis`:
//                       read             a read; reads have no effect
//                       command-id       schema REQUIRES a stable caller id
//                                        (requestId / command id) and the
//                                        handler dispatches through
//                                        RoomStore.command, which dedups by
//                                        (room, actor, command id) and
//                                        returns the duplicate receipt
//                       request-journal  schema requires requestId and the
//                                        public-work journal replays the
//                                        stored outcome for that id
//                       single-use-id    schema requires a single-use id;
//                                        an exact retry returns duplicate:true
//                       terminal-id      the target id names a terminal
//                                        transition; an already-applied
//                                        target is refused / not found and
//                                        nothing more can happen to it
//                       state-set        the call sets keyed state to the
//                                        given values (host heartbeat,
//                                        claim caps, wake pause/resume)
//                       deterministic-key room_create: roomId (or its slug
//                                        default) / requestId is the create
//                                        key and replays duplicate:true
//                       deterministic-stage room_begin_work: stage request
//                                        ids are hash-derived from the exact
//                                        inputs, so an exact retry re-derives
//                                        the same command ids and dedups
//                       revision-fence   expectedRevision is required; a
//                                        retry of an applied call conflicts
//                                        on revision and applies nothing
//                       documented-noop  the handler documents an existing
//                                        link/state as a no-op (claim PR link)
//                       ack              acknowledgement by exact id; ids
//                                        already delivered are reported and
//                                        not applied again
//                       local-observer   only private local observer state
//                                        moves; no shared effect to repeat
//                       optional-key     an idempotency key EXISTS but is
//                                        optional; keyless calls execute
//                                        every time, so the honest claim
//                                        is false
//                       none             no dedup evidence; claim is false
//                     A write whose key is merely OPTIONAL (room_post_message,
//                     the land-queue trio, every bounty write) claims false:
//                     a retry that omits the key must not be auto-approved
//                     as safe by a client reading the hint.
//   destructiveHint — true only when the tool deletes stored content or
//                     terminally retires / revokes / disbands an existing
//                     object or access path so it cannot be used again
//                     (discard a file's bytes, disband a squad, revoke an
//                     invite or a bond, unsubscribe a webhook, close a
//                     work claim, cancel a request, supersede work).
//                     Routine lifecycle transitions (begin, submit, accept,
//                     record, renew, release, offer, reply, …) are NOT
//                     destructive however the old templates stamped them.
//   openWorldHint   — the served value. Tools whose output surfaces
//                     member-authored text carry true, matching the
//                     listing-time overlay in server/content-trust.mjs
//                     (MEMBER_TEXT_TOOLS); room_run_action wraps arbitrary
//                     actions and carries true. Everything else false.
//   title           — a human title for client approval UIs, on every tool.
//
// tests/mcp-annotation-truth.test.js is the gate: it cross-checks this
// table against the served catalogs, the input schemas (a command-id
// claim must have its key in `required`), and the family write/read
// classifiers, and it scans the definition sites so no literal annotation
// stamp can return outside this module.

const A = (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint, basis) =>
  Object.freeze({
    title,
    basis,
    annotations: Object.freeze({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint })
  });
const R = (title, openWorldHint = false) => A(title, true, false, true, openWorldHint, "read");
const W = (title, destructiveHint, idempotentHint, basis, openWorldHint = false) =>
  A(title, false, destructiveHint, idempotentHint, openWorldHint, basis);

export const MCP_TOOL_ANNOTATIONS = Object.freeze({
  // Join door (server/mcp-http.mjs) — all reads.
  room_join_packet: R("Read the join packet"),
  room_join_kits: R("Browse the join kits"),
  room_join_prompt: R("Read the join prompt"),
  room_mcp_snippet: R("Read MCP connection snippets"),
  // Identity mint (server/mcp-identity-mint.mjs) — every call mints a new
  // identity and a new one-time secret; not idempotent, not destructive.
  room_identity_mint: W("Mint an agent identity", false, false, "none"),

  // Hosted room tools (server/mcp-hosted-tools.mjs).
  room_check_access: R("Check room access"),
  room_needs_me: R("Read what needs me", true),
  room_create: W("Create a room", false, true, "deterministic-key"),
  room_join: W("Join a room", false, false, "none"),
  room_activation_pack: R("Read the room activation pack", true),
  room_member_card: R("Read a member card"),
  get_room_context: R("Read room context", true),
  room_list_events: R("List room events", true),
  // id is optional and server-minted when omitted: a keyless retry posts twice.
  room_post_message: W("Post a room message", false, false, "optional-key"),
  room_list_work: R("List room work", true),
  bond_propose: W("Propose a bond", false, true, "command-id"),
  bond_accept: W("Accept a bond", false, true, "command-id"),
  bond_decline: W("Decline a bond", false, true, "command-id"),
  bond_revoke: W("Revoke a bond", true, true, "command-id"),
  bond_list: R("List bonds"),
  dm_posted: W("Send a peer DM", false, true, "command-id"),
  room_list_peer_dms: R("List peer DM threads", true),
  room_put_file: W("Stage a room file", false, true, "single-use-id"),
  room_list_files: R("List room files"),
  room_get_file: R("Download a room file", true),
  room_discard_file: W("Discard a staged file", true, true, "terminal-id"),
  room_commit_file: W("Commit a staged file", false, true, "single-use-id"),
  room_list_access_requests: R("List access requests", true),
  room_decide_access_request: W("Decide an access request", false, false, "none"),
  room_create_agent_invite: W("Create an agent invite", false, false, "none"),
  room_list_agent_invites: R("List agent invites"),
  room_revoke_agent_invite: W("Revoke an agent invite", true, true, "terminal-id"),
  add_land_item: W("Add a pull request to the land queue", false, false, "optional-key"),
  list_land_queue: R("List the land queue"),
  remove_land_item: W("Remove a land queue item", false, false, "optional-key"),
  report_tip: W("Report a land queue tip", false, false, "optional-key"),
  room_work_claim_provenance: R("Read work claim provenance"),
  squads_list: R("List squads"),
  squads_get: R("Read a squad"),
  squads_create: W("Create a squad", false, false, "none"),
  squads_update_members: W("Update squad members", false, false, "none"),
  squads_disband: W("Disband a squad", true, false, "none"),
  inbox_put_attachment: W("Stage an inbox attachment", false, true, "single-use-id"),
  inbox_list_attachments: R("List inbox attachments"),
  inbox_get_attachment: R("Download an inbox attachment", true),
  inbox_discard_attachment: W("Discard an inbox attachment", true, true, "terminal-id"),
  wake_register: W("Register a wakeable host", false, true, "state-set"),
  wake_clear: W("Clear a host wake URL", false, true, "state-set"),
  heartbeat_set: W("Report a host heartbeat", false, true, "state-set"),
  heartbeat_get: R("Read host presence"),
  heartbeat_ack: W("Acknowledge wake signals", false, true, "ack"),
  wake_pause: W("Pause queued wakes", false, true, "state-set"),
  wake_resume: W("Resume queued wakes", false, true, "state-set"),
  webhook_subscribe: W("Subscribe a webhook", false, false, "none"),
  webhook_list: R("List webhook subscriptions"),
  webhook_unsubscribe: W("Delete a webhook subscription", true, true, "terminal-id"),

  // Stdio room tools (client/mcp-stdio.mjs and its families).
  room_assistant_context: R("Read assistant context", true),
  room_assistant_action: W("Act on an assistant request", false, true, "revision-fence", true),
  room_list_outside_agents: R("List outside agent cards"),
  room_introduce_outside_agent: W("Record an outside agent card", false, false, "none"),
  room_read_result: R("Read a stored result", true),
  room_read_board: R("Read the work board", true),
  room_read_work: R("Read a work item", true),
  room_read_work_discussion: R("Read work discussion", true),
  room_post_draft: W("Post a draft for review", false, true, "command-id"),
  room_read_inbox: R("Read the agent inbox", true),
  room_read_messages: R("Read room messages", true),
  room_link_work_claim_pr: W("Link a pull request to a claim", false, true, "documented-noop"),
  room_close_work_claim: W("Close a work claim", true, true, "terminal-id"),
  room_set_member_claim_cap: W("Set member claim caps", false, true, "state-set"),
  room_begin_work: W("Begin selected work", false, true, "deterministic-stage"),
  room_read_attention: A("Read attention notices", false, false, true, false, "local-observer"),
  room_acknowledge_attention: W("Acknowledge an attention notice", false, true, "local-observer"),
  room_acknowledge_wake: W("Acknowledge wake signals", false, true, "ack"),

  // Work lifecycle (client/work-actions.mjs) — requestId is required and
  // deduped by RoomStore.command; none of these deletes anything except
  // supersede, which terminally retires the original work item.
  room_submit_text_result: W("Save room text as result", false, true, "command-id"),
  room_propose_work: W("Propose work", false, true, "command-id"),
  room_accept_work: W("Accept assignment", false, true, "command-id"),
  room_start_work: W("Record work started", false, true, "command-id"),
  room_block_work: W("Report blocker", false, true, "command-id"),
  room_resolve_blocker: W("Resolve blocker", false, true, "command-id"),
  room_record_completion: W("Submit result", false, true, "command-id"),
  room_record_verification: W("Record evidence review", false, true, "command-id"),
  room_acquire_claim: W("Reserve work scope", false, true, "command-id"),
  room_release_claim: W("Release work scope", false, true, "command-id"),
  room_renew_claim: W("Renew work scope", false, true, "command-id"),
  room_supersede_work: W("Replace work", true, true, "command-id"),
  room_record_handoff: W("Record handoff receipt", false, true, "command-id"),
  room_clear_halt: W("Clear a member halt", false, true, "command-id"),

  // Help offers (client/help-actions.mjs) — same command-id dedup.
  room_offer_help: W("Offer help", false, true, "command-id"),
  room_select_help_offer: W("Select helper", false, true, "command-id"),
  room_decline_help_offer: W("Decline offer", false, true, "command-id"),
  room_withdraw_help_offer: W("Withdraw offer", false, true, "command-id"),
  room_release_help_offer: W("Release helper", false, true, "command-id"),

  // Reply requests (client/reply-actions.mjs) — reads route to reads;
  // writes carry a required requestId through the same command dedup.
  // Cancelling a request terminally closes it: destructive.
  room_list_requests: R("List reply requests"),
  room_read_request: R("Read a reply request", true),
  room_request_history: R("Read reply request history", true),
  room_request_reply: W("Ask for a reply", false, true, "command-id"),
  room_reply: W("Reply under a message", false, true, "command-id"),
  room_respond_to_request: W("Respond to a request", false, true, "command-id"),
  room_cancel_request: W("Cancel a reply request", true, true, "command-id"),

  // Bounty (client/bounty-tools.mjs) — the honest pattern, unchanged:
  // idempotencyKey is optional and keyless writes execute every time.
  bounty_list: R("List bounties"),
  bounty_read_balances: R("Read credit balances"),
  bounty_read_history: R("Read credit history"),
  bounty_post: W("Post a bounty", false, false, "optional-key"),
  bounty_fund: W("Fund a bounty", false, false, "optional-key"),
  bounty_claim: W("Claim a bounty", false, false, "optional-key"),
  bounty_submit: W("Submit bounty work", false, false, "optional-key"),
  bounty_accept: W("Accept bounty work", false, false, "optional-key"),
  bounty_dispute: W("Dispute a bounty", false, false, "optional-key"),
  bounty_watch: W("Watch a bounty", false, false, "optional-key"),
  bounty_finalize: W("Finalize a bounty", false, false, "optional-key"),
  bounty_transfer: W("Transfer credits", false, false, "optional-key"),

  // Trust reads (client/trust-tools.mjs).
  identity_read_verification: R("Read identity verification"),
  identity_list_verified: R("List verified identities"),

  // Public work (server/mcp-public-work.mjs) — requestId is required and
  // the public-work request journal replays the stored outcome. Releasing
  // a claim frees a lease; the task and any receipt persist, so it is not
  // destructive (the old stamp said it was).
  public_work_recommend: R("Recommend public work", true),
  public_work_read_task: R("Read a public work task", true),
  public_work_claim: W("Claim public work", false, true, "request-journal"),
  public_work_renew: W("Renew a public work claim", false, true, "request-journal"),
  public_work_release: W("Release a public work claim", false, true, "request-journal"),
  public_work_finish: W("Finish public work", false, true, "request-journal"),
  public_work_my_review: R("Read my public work review", true),

  // Meta tools (server/mcp-action-search.mjs). room_run_action wraps an
  // arbitrary action, including destructive ones, and a wrapped keyless
  // write executes on every call: destructive true, idempotent false.
  room_search_actions: R("Search room actions"),
  room_run_action: W("Run a room action", true, false, "none", true)
});

// The refusal at the heart of the truth pass: no entry, no tool. Every
// definition factory routes through here, so an omitted annotation
// decision fails at module load / first listing, not in a client's
// approval prompt.
export function mcpToolAnnotation(name) {
  const entry = MCP_TOOL_ANNOTATIONS[name];
  if (!entry) {
    throw new Error(
      `MCP tool "${name}" has no annotation entry: add a deliberate title + `
      + "annotations + idempotency basis to src/mcp-tool-annotations.mjs "
      + "(a write tool must not inherit a default hint)");
  }
  return entry;
}

export function annotateMcpTool(tool) {
  const entry = mcpToolAnnotation(tool?.name);
  return { ...tool, title: entry.title, annotations: { ...entry.annotations } };
}

export function hasMcpToolAnnotation(name) {
  return Object.hasOwn(MCP_TOOL_ANNOTATIONS, name);
}
