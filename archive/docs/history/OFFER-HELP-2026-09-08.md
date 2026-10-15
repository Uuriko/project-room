# Offer useful help without taking over work

## Decision and sources

Every existing work record has an accountable member. A null or expired claim
is not an unassigned job. Adding a second job pool would obscure that distinction.
The first complete collaboration slice should instead make voluntary help on
selected work easy to discover, discuss, contribute and explicitly adopt.

[GitHub contribution guidance](https://docs.github.com/en/get-started/exploring-projects-on-github/finding-ways-to-contribute-to-open-source-on-github)
recommends discussing a proposed approach before substantial work and using
maintainer signals such as help-wanted labels. Borrow the coordination-before-work
pattern, not a claim that every Room task requests volunteers.
[Paperclip issues](https://docs.paperclip.ing/guides/day-to-day/issues/) connects
assignment to agent work and wake behavior. Room deliberately keeps a conversational
answer, accountable assignment and execution permission separate. No source code
is copied; these primary documents inform the design, not prove our implementation.

## Bounded implementation

1. Add optional versioned collaboration guidance to the existing selected-work
   response. Compute it from the same committed work/member facts, without another
   database read or a new MCP tool. A helper gets the accountable recipient and
   existing request/discussion path, not an assignment or execution grant.
2. Offer this path only for active nonaccountable members on unfinished work with
   an active accountable member. A designated independent verifier should review,
   not be steered into producing the same result. Closed/completed work and missing
   participants return a clear non-offer reason. Capability fitness is not inferred.
3. Validate provided guidance against consumed work/participants in the client.
   An older service without it remains supported as unavailable; never invent
   an offer route or perform a weaker retry after invalid data.
4. Describe the operator-enabled recipe: search, read selected task and existing
   discussion/own requests, offer a specific bounded contribution, inspect the
   answer, post a work-linked draft with current basis. Do not bulk-request help,
   repeatedly solicit after decline, or interpret prose as external permission.
5. Run a full synthetic human/actual scripted MCP journey: helper offers to a
   human accountable person, human replies, helper contributes exact native text,
   accountable human explicitly adopts it with attribution, separate reviewer
   checks exact bytes, final human approval remains pending. No duplicate task.
6. Verify nonowner acceptance/completion refusal, inactive/terminal/reviewer paths,
   read-only audits, stale basis, original retries, small-screen/keyboard behavior
   and retained fallback compatibility. Inspect screenshots and simplify.

No new human menu is required for this slice: the accountable person uses the
existing request and result controls. A future human helper shortcut and explicit
help-wanted opt-in can follow evidence; this is not an open bounty marketplace.

Previous goal turn was progress: deployed nowhere, but changed qualified local
runtime and added inspected simultaneous-attention evidence. The broad goal stays
active; this plan does not redefine completion around one feature.

## Agent recipe: one existing task

1. Under your operator's instructions, use `room_list_work` with a relevant query.
   Read the selected match with `room_read_work`. Search is not capability matching
   and this is not a help-wanted listing. An existing assignee remains accountable.
2. Inspect `collaboration`. Its optional version-1 `may_offer` status describes a
   conversational route, not permission to execute. Missing guidance means the
   service does not supply it. `accountable`, `independent_reviewer`, `closed` and
   `unavailable` provide no offer shortcut; retain the normal work/review path.
3. Read `offer.checkExisting` and `offer.readDiscussion`. Match your own previous
   requests by work ID and recipient, then inspect relevant exchanges completely.
   Continue an existing offer rather than submitting a duplicate. A declined
   offer is not an invitation to keep asking. These are room-visible messages.
4. If appropriate, use `offer.request`: copy its exact work/recipient arguments,
   add your own stable `requestId` and a specific `body` explaining the proposed
   contribution, output and limits. Nothing is sent by reading this metadata.
5. On reconnect, read your saved request ID or your outgoing requests. Inspect
   the actual answer; `status: answered` alone does not mean yes. Retain exact
   unknown request input for retry. No answer grants tools, payment, repository
   access, claim ownership or authority outside the operator's instructions.
6. For an agreed in-room draft, reread current work and use `room_post_draft`
   with that `basisRevision`, a stable request ID and explicit packet correlation.
   Do not accept, claim or complete another member's assignment. Do not silently
   retry an old draft under a newer revision. The returned message is conversation,
   not a completion receipt.
7. The accountable person uses **View latest draft → Save as result**, inspects
   the exact body and explicitly reports its producer. Posting identity is stored
   separately from reported producer and completion reporter. Do not attribute a
   copied or jointly authored artifact to one person without evidence.
   With multiple proposals, use **View drafts / Drafts (n)** to inspect alternatives
   and open the chosen message. Canonical order is not a ranking; a nonlatest draft
   can be explicitly adopted with its own posting identity and exact text.
8. The designated distinct reviewer reads the exact result version and records
   its own finding. The human decision remains separate. If a verifier contributes
   to production, resolve the independence conflict rather than passing its own work.

This recipe supports contributing to one shared work record without reassigning
it or creating a duplicate. It does not automate discovery, sending, acceptance,
execution, adoption, review or approval. Human-only helper shortcuts, explicit
help-wanted settings and standing roles are future work, not claimed here.

## Implemented and verified

Runtime `856940ce590678e986df30338ecb47bc45e016e1` implements this slice.
`workCollaboration` is a shared pure derivation used by the selected-work service
and strict Node client validation. Provided hints must exactly match consumed
work/member facts; invalid hints fail without a weaker read. Absent hints from
the retained older service remain absent. No new endpoint, tool, schema, writer,
permission, event or additional service read was introduced.

Desktop and touch journeys exercise real scripted MCP processes and a simulated
human browser. The helper reconnects, reads the actual answer, posts a current-basis
draft, and retries its exact offer/draft without duplicate changes. Unauthorized
acceptance/completion and a stale draft are refused without mutation. The human
adopts the exact text on the original task, explicitly naming the contributor.
Posting identity, reported producer, completion reporter and accountable member
remain distinct. A separate scripted reviewer passes the same exact text; final
human approval remains pending. Read markers remain zero for all three roles.

### Friction found and corrected

- Initial test navigation looked for a top-level draft while still inside the
  request thread. The journey now uses the existing **View latest draft** link.
  This was a test correction, not a product defect.
- Mobile **Open request** could show only the bottom of a tall message. The new
  assertion reproduced this. Preserve nearest outer-page scrolling and align the
  message beginning within the conversation pane when the message exceeds its
  height. No extra label, control or CSS change was needed.
- A first broad scroll-to-start fix moved the outer page and failed the existing
  crowded mobile arrival test (60-pixel reading-position change). It was replaced
  with the narrower inner-pane adjustment; both help modes and the crowded mobile
  case pass, followed by the complete browser suite.
- Visual review caught a screenshot taken before exact review text loaded. The
  test now waits for the exact body, and both journeys were rerun. This strengthens
  the evidence capture without changing runtime bytes.

### Qualification and retained evidence

- 584 core/API/package tests pass, with five new collaboration tests and extended
  actual retained-fallback and Workers response coverage.
- All 182 full browser tests pass on the frozen runtime. After adding only the
  screenshot readiness assertion, both helper journeys pass again.
- 14 local Workers tests pass, including browser and exact schema-12 candidate →
  pause → fallback → candidate switching on populated disposable storage.
- Two exact-commit desktop/touch fallback browser tests pass.
- Candidate package verifies: 65 runtime files, 19 public assets, schema/writer 12.
  Source tree `9d1c16c82a070faee4bd236682098134d2eb1cbc`;
  manifest SHA256 `78dc3a8267138886b5bfc9b5252c436830fd4f44cd5d036e513dc9f5ce4c0a85`.
  Candidate directory: `../project-room-runtime-packages-20260908/candidate-856940c`
  relative to the repository root. Fallback `4d22189` is unchanged.
- Six runtime files differ from candidate `e1a3ae4`: client MCP descriptions,
  client selected-context validation, package test registration, server selected
  context, app navigation and shared workflow derivation. Two public assets change.
- Six inspected final screenshots, two validated journey JSON records and three
  successful verification logs are retained at
  `../project-room-runtime-packages-20260908/evidence-offer-help` relative to root.
  Review screenshots use 200% text; mobile review continues vertically. Full-suite
  browser completion was observed from process 97877 (182/182, exit 0), not retained
  as a full log. No before screenshot is claimed.

Final core/Workers/fallback outputs were truncated during context rollover. A
verification retry first hit loopback `listen EPERM` under the sandbox, then passed
with approved local server access and retained logs. Those failed runs are not
counted as successful product qualification.

These are simulated human journeys and actual scripted MCP operations, not native
model reasoning, real-user research or hosted recovery certification. No push,
deployment, paid model/service, live data mutation, new automation or existing
preview restart occurred. The broader goal remains active and incomplete.

## Next priorities

1. Test returning to a contributed draft: the accountable person should discover
   a useful existing draft without mistaking a draft for completion. Measure the
   current work-card/catch-up route before adding a new shortcut or more copy.
2. Specify explicit **help wanted** opt-in, contribution scope and decline handling
   before room-wide agent discovery or automatic volunteering. `may_offer` is not
   an eligibility, capability-match or paid-job signal.
3. Test alternate contributors and revision changes while an offer is outstanding;
   preserve one accountable record and fresh draft basis, with understandable
   return/recovery behavior for humans and agents.
4. Keep native-host acceptance and independent hosted recovery as separate release
   gates. Do not infer those from local scripted success or mark the goal complete.
