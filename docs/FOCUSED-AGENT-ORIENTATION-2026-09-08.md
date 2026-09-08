# Focused agent orientation

## Product decision

Give a connected agent one concise answer to “what currently needs me?” using
the existing work list, not a second inbox or an automatic task dispatcher.
This implements a deliberately scoped part of eligible-work discovery: existing
assignments and designated reviews/decisions. It does not invent an open-market
claim model, skill matching or unsolicited work assignments.

Implementation plan and completed behavior:

1. Reuse `nextWorkStep` to select attention-requiring next steps addressed to the
   current member. Keep the full list as the default, without changing its shape.
2. Reuse `workActions` to describe available Room actions. Keep an assigned next
   step visible even when permissions are missing; an empty action list does not
   silently erase the assignment. Selection is not authorization to execute.
3. Return compact work identity/title/revision/state/mode, exact next-step evidence
   references and a ready-to-call selected-work read. Omit the full task criteria,
   source, claims, evidence payloads, blocker prose and historical checks from this
   focused view. Preserve current versioned room instructions and membership scope.
4. Add an optional selector to the existing MCP tool and a simple CLI `next` read.
   Do not add a new tool, endpoint, model, subscription, event or schema migration.
5. Validate selectors before private requests. Preserve configured-agent identity
   preflight, service authorization, cancellation and exact write-retry semantics.
6. Exercise handoff progression, missing permissions, ongoing/other work, elapsed
   claim expiry, protocol arguments, command-line use and unchanged room data.

## Interfaces

```text
Client: await client.orient({ focus: "needs_me", signal })
MCP: room_list_work({ "focus": "needs_me" })
CLI: node scripts/agent-inbox.mjs next
```

Omitted focus or `all` preserves the existing complete work orientation. MCP
remains24 tools by default,26 with the existing explicit attention opt-in.

The focused response includes `focus`, `selection.totalWork`, `selection.needsMe`,
`evaluatedThrough`, `evaluatedAt`, `clockSource:"client"`, current charter/member,
unchanged scope and selected work. One client clock is used for all next steps
and action choices in a read. This is an advisory evaluation, not the service's
write clock; refresh selected work and let the service validate every command.

Each selected row has `availableRoomActions` and
`nextRead:{tool:"room_read_work",arguments:{workItemId:...}}`. Names and titles are
untrusted content. No evidence link is fetched and no work is performed.

An empty list does not mean no work exists or the room is finished. Ongoing work
without a new handoff and targeted reply requests are deliberately omitted. Use
the full work view for ongoing tasks and the existing reply/attention tools for
requests. This view is pull-only, not a durable queue or synchronized seen state.

## Evidence and limits

Five focused tests pass using actual local HTTP clients, MCP protocol processes
and the command-line tool, not native AI reasoning. They exercise:

- Acceptance → start → ongoing → blocker → completion → independent review →
  human decision pending, without performing any action merely by listing work.
- Complete omission of other participants' next steps and preservation of full
  default orientation. In one13-work synthetic fixture, focused JSON is under
  half of full orientation JSON; this is not a general performance benchmark.
- Missing permissions remain visible with no available actions; revoked keys fail.
- Claim expiry returns a scope handoff without modifying the stored claim history.
- Invalid arguments, all20-table read-only checks,24-tool discovery and CLI usage.

The first test attempt mistakenly supplied a derived independence field in a
verification command. The service correctly refused it; the test now uses the
existing command contract. This was not an application defect or a product fix.

This still obtains the authenticated Room snapshot internally. It reduces output
shown to the agent, not network payload, Room read scope or authorization breadth.
It does not paginate, rank by inferred skills, advertise unassigned work, start a
runner, acknowledge attention or change human read markers. No retention lift or
native-host acceptance is claimed. UI assets are unchanged, so no new UI screenshot
is needed for this client/protocol slice. Full regression and package qualification
are recorded in the current handoff after execution.

## Now / next / later

Now: opt-in focused next-step discovery through existing interfaces.
Next: a scripted reconnect exercise combining focused discovery, selected task,
reply clarification and exact result review; actual native models remain separately
approval-gated. Check whether further service-side output shaping is justified
before adding an endpoint or a second task index.
Later: deliberate requests to help with work not assigned to the agent, opt-in
standing roles and explicitly budgeted tool adapters. Assignment, permission,
external execution and payment remain separate decisions.
