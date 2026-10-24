# Inbox and Rooms: first interactive comparison

Blueprint U04 · local design work only · follows runtime `2dc43d0`.

## Intention

Read and reply without creating a task. When help is useful, share only chosen
context with a room, talk there, and return to the same private reply draft.

This preview deliberately does not simulate work approval, payment or an agent
doing work. Those belong to the existing authoritative contracts. The next
integration must use the real room/result/review paths, not invent preview versions.

## Two structures, one interaction model

**List + detail:** quiet workspace navigation, a scannable conversation list,
and a persistent reading/composing region. On mobile, selecting a row opens a
restorable full-width conversation. The same inbox contains sample email and chat.

**Conversation first:** the list gives way to a focused conversation with a
visible back action. This has more breathing room but adds a return step when
moving among conversations. Mobile deliberately converges on the same pattern.

Both use the same sample data and actions. Changing the comparison does not
discard drafts. It is a developer comparison control, not a promised production
preference or a new top-level feature.

### Current design decision

Prefer list + detail as the wide-screen starting point. The visible list preserves
context when triaging several conversations. Keep focused detail on narrow screens.
This is a reasoned design choice after screenshot/interaction review, not a
measured usability or retention result.

Use aligned rows instead of nested cards. Keep the reader, header and composer
on one reading axis; the first screenshot review caught their initial drift.
One restrained green accent distinguishes interaction from surrounding structure.
Audience labels remain beside the source and the composer.

## Working preview flows

- Direct sample reply, including Enter inserting a newline in email.
- Casual room chat without work or agent setup; desktop Enter sends, touch retains
  a deliberate send control.
- Separate room and per-conversation reply drafts.
- Navigation restores reading position and drafts.
- Ask room opens an audience preview with no paragraphs selected initially.
- Only selected text enters the sample room view. Sender address, subject and
  excluded paragraphs do not travel automatically.
- Returning from a shared excerpt opens the original sample conversation.
- Source changes invalidate the open selection. Explicit refresh clears selected
  checkboxes so the user must choose again.
- Reply drafts retain their source revision. Changed context requires review
  before a new send attempt.
- Known connection refusal keeps editable text. Lost confirmation locks the
  original sample attempt; **Check status** reconciles instead of sending again.

## Important limits

All data and behavior are a client-side fixture. Every sample is downloadable in
the preview bundle. The labels illustrate intended audiences; this does **not**
enforce private-account access, prove service isolation or connect any mailbox.

Sample replies have a recorded fixture outcome, never delivery. The persistent
preview banner states that nothing is sent externally. The standalone server
only serves four allowlisted static assets on loopback; its content policy blocks
network connections. It is not exposed by the production room server or included
in the runtime package's allowlist.

Reload discards the entire preview. There is no durable private draft recovery,
provider connection, real identity, attachment handling, production source
provenance, worker activity or reviewed-result-to-reply binding here. U05/U06 must
implement and test those boundaries where required; no green preview test closes
their gates.

## Evidence

Four pure fixture checks and four browser journeys (both structures at desktop
and mobile sizes) cover the flows above. Screenshots include list, reading,
selected sharing, room conversation and uncertain sample reply.

Tests prohibit outgoing non-GET and off-origin browser requests. Shared fixture
projections omit the excluded budget paragraph and sender address. This establishes
the fixture's selection behavior only, not confidentiality against another user.

One intermediate mobile run failed because expanded **Preview controls** covered
the new Review update button. The journey now closes those developer-only controls
before continuing normal interaction. No forced clicks bypass that obstruction.
Original passing/failing logs are retained alongside final committed checks.

Full regression and exact-commit counts are recorded in the evidence manifest.
Screenshots were inspected on desktop and mobile. These are scripted simulations;
no human preference, independent model judgment or production readiness is claimed.

## Run locally

Run `node scripts/inbox-prototype-server.mjs` with the repository's supported
Node runtime. It prints an available loopback URL and never reuses a production
database or replaces a running preview. Stop that process to close the preview.
Run `node --test scripts/inbox-prototype-browser-check.mjs` for screenshots and
journey checks; artifacts go under the calling directory's `test-results/`.

## Implementation plan: U05, then U06

1. **Inspect account authority and migration boundaries.** Private inbox ownership
   must bind the existing account session and current account revision, not a
   room member name or room bearer token. Recheck current writers/backup contracts.
2. **Build the private domain with a synthetic adapter.** Store connection/source
   identities, immutable source versions, private draft revisions and send attempts
   outside the room event projection. Use the existing database transaction and
   recovery conventions. Add no real provider credentials or accounts.
3. **Enforce scoped reads first.** Test two accounts, a room peer, a room agent,
   revoked sessions, missing ownership, and search/export projections. Room access
   must not unlock a connected inbox. No authorization based on UI hiding.
4. **Share an explicit projection.** Bind chosen source version, selected text,
   destination audience and operation ID. The public room message contains only
   disclosed material. Keep the source-to-room mapping private unless deliberately
   disclosed; source updates do not silently expand the shared snapshot. Reconcile
   retries across the private record and the canonical room message.
5. **Replace the fixture transport, not the interaction design.** Keep the preview
   comparisons available while the chosen shell gains real account-scoped state.
   Preserve the existing production room UI until the replacement completes its
   verified journeys. No broad flag flip from a static preview.
6. **Use the existing work flow.** A shared message may optionally become existing
   work. Browser, direct/MCP and portable contributors post ordinary drafts/results.
   Reuse exact-version adoption, independent review and human decision. Casual
   chat and direct replies remain valid without that path.
7. **Return a reviewed result to a private draft.** Fetch and verify the exact
   stored result. Show source account, recipients and selected body before copying.
   Editing creates a distinct draft; its source review does not approve the edit.
   Human result acceptance does not authorize a send.
8. **Qualify durable sample send recovery.** Persist operation identity, input,
   uncertainty and lookup before a provider is connected. Test restart, source or
   recipient change, unknown outcome, revocation and replay without duplicates.
   Distinguish recorded, provider-accepted and delivered states.
9. **Repeat complete journeys and decide release readiness.** Include two-account
   exclusion tests, ordinary chat/direct reply, shared context, revisions, rejected
   work and a reviewed reply. Retain screenshots and exact-version evidence.
   Only then consider an explicitly authorized dedicated email-account trial.

The next implementation should begin with account/store inspection and a precise
private-domain contract. Do not deepen the throwaway fixture into a parallel
messaging backend or add another work-management panel.
