# Project knowledge

Docs stores room-owned Markdown that people and agents can read and change
through the same revision and authorization rules. This branch composes the
implementation; production availability requires a verified enabled release.

## One workflow

Find a document, read it, change it without losing work, and let another agent
continue from the saved revision. Use the existing room identity and permissions.
A room does not need a second task board or a mandatory generated handbook.

| Intent | Command | Result |
| --- | --- | --- |
| List | `room docs list [--limit N] [--after ID]` | Metadata with explicit continuation |
| Read | `room docs read ID [--rev REV]` | Current or selected historical revision |
| Create or update | `room docs write ID --title TITLE --file PATH --base-rev REV` | Revision 0 creates; current revision updates |

Commands return JSON. MCP uses `room_docs` for reads and `room_write_doc` for
writes through the same service. OAuth editing needs explicit `docs:write`
consent; existing grants are not widened. Disabled Docs stays out of discovery.
See [Room documents](ROOM-DOCS.md) for exact API limits and operational behavior.

The UI should expose one Docs entry, document links and contextual New/Edit/Save
controls. Use semantic HTML, visible focus, labeled fields and stable deep links.
Render Markdown safely with the existing renderer. A simple textarea is adequate
until a measured editing task justifies another dependency. Keep unsaved drafts
across conflicts; never show saved before server confirmation. A late response
must not erase a newer draft or replace a different document's screen.

## Keep each source authoritative

- Room documents own shared project notes and decisions.
- Work/request APIs own live task state; documents link to them.
- GitHub owns repository files and PRs. Link immutable source revisions; do not
  silently copy over room-owned text or claim automatic synchronization.
- The [handbook](INDEX.md) and [public wiki API](WIKI-API.md) are public product
  references. Never put private room documents into their generated embed.
- The [project map](PROJECT-MAP.md) is derived source navigation with revision and
  coverage, not authority over code.
- The [source library](SOURCE-LIBRARY.md) records reusable implementations, actual
  adoption, attribution and maintenance. It is not a second execution queue.

## Correctness

Writes carry the last-read revision. A stale write fails explicitly; read current
content before choosing another edit. Unknown save outcomes require readback,
not an automatic new write. Stable IDs survive title edits. Listing is bounded
and live: a partial list is not proof that another document does not exist.

Current membership protects both bodies and history. Archived rooms refuse
writes. Account deletion revokes access; existing retention policy 1.9 retains
shared document text, revisions and member author IDs for remaining members.
Personal-room purge erases documents/history. This is not per-author erasure of
shared content. Backup/restore and rollback compatibility remain release checks.

## Keep or remove

Judge changes by [verified completion, elapsed time and human intervention](AGENT-UTILITY-TRIALS.md#measurement-and-decisions).
Keep failures in the denominator. Draft loss and unauthorized disclosure are
correctness failures. Compare simpler versions before adding controls or systems.

Full-text search, backlinks, a separate history browser, source dashboards,
automatic GitHub synchronization and rich-text editor dependencies are not part
of this slice. They need evidence from a task the current workflow cannot handle.
The broader [product trials](AGENT-UTILITY-TRIALS.md) remain hypotheses, not a
commitment to make Project Room a particular kind of product.


## Reconciliation audit — 2026-11-12

The document foundation is implemented in this candidate. A fully reconciled,
production-qualified project memory is not finished. This is an inventory and
next-step decision, not an enabled-feature announcement.

| Capability | Evidence at this candidate | Remaining boundary |
| --- | --- | --- |
| Shared project Markdown | `server/room-docs.mjs`, HTTP/MCP service and CLI; current/history reads and base-revision writes | `ROOM_DOCS` defaults off; current production enablement not verified here. |
| Human document workflow | `src/room-docs-ui.js`; read/create/edit, conflict-preserved drafts, session fencing | Reader displays escaped Markdown text; rich rendering, stable selected-document links and broader navigation need separate qualification. |
| Maintainer knowledge | Handbook index, procedures, historical lessons and generated public wiki API | Public repository references are not private room Docs; no automatic migration is demonstrated. |
| Task continuation | Existing selected-work context, brief builder and generated continuation | Carries source observations, omissions and evidence references; does not retrieve every linked document or external artifact. |
| Code and review evidence | GitHub files/PRs and exact-head checks | Automatic document synchronization and complete cross-source reconciliation are absent. |
| Reusable upstream code | Source-library contract and pinned intake records | Product Sources view and automated adoption/update workflow remain proposed. |
| End-to-end usefulness | Synthetic continuation fixtures and outcome-trial tools | No participant trials recorded in the current prepared trial set; tests do not establish productivity improvement. |

### One project record, several authoritative sources

Give contributors one navigable project entry with current objective, available
work, decisions and relevant references. Do not require them to read every
conversation or local handoff. One entry need not mean one database: existing
systems retain ownership of their facts, and the project view resolves links.

| Information | Authority | Derived presentation |
| --- | --- | --- |
| Accepted scope, assignments, attempts, results and review decisions | Existing Room work/request records | Current work list, selected-work brief, next action |
| Shared rationale, project notes, decisions and design constraints | Revisioned room Docs; repository-owned guidance stays in Git | Task-linked excerpts with document id and revision |
| Code, pull requests and checks | Linked repository and exact commit/check run | Source links and observed status with read time |
| Historical evidence and lessons | Original result/trace and reviewed procedure change | Selective reusable guidance with evidence links |
| Current agent working context | Generated from authorized selected records | Bounded continuation export; never a new execution authority |
| Private session notes or local execution journal | The relevant client/runtime | Explicitly local recovery, not silently shared project knowledge |

A useful working packet contains the objective, current source revision,
constraints, assignment, relevant decisions, latest result and verification,
unresolved questions, next action and links for deeper reading. Every included
item needs its source/version or an explicit unknown. Prefer extracting existing
structured facts to asking a model to rewrite them. This packet is a view of
project records; do not introduce a second manually maintained status sheet.

### Lifecycle and reconciliation

1. On entry, authenticate, discover enabled actions and read bounded current work.
   Selecting work supplies its existing brief and linked references. Follow
   pagination and report missing sources; incomplete context stays incomplete.
2. Read relevant Docs and source files on demand. Keep permission checks at the
   source; public wiki search must never ingest private room text. A future
   cross-source index is derived and must filter authorized results before
   exposing titles, snippets or counts.
3. Persist results through existing work actions. Write a Doc only when it adds
   durable rationale or a reusable decision. Ordinary checks and status changes
   should update their structured owner rather than generate more prose.
4. Reconcile concurrent edits with the existing revision conflict. Preserve both
   conflicting claims until resolved; timestamp recency alone does not establish
   truth. Distinguish a proposal, accepted decision and superseded decision.
5. Refresh derived context when its referenced revision changes. Unknown outcomes
   require readback using the original operation id. Permission revocation must
   prevent future reads and inclusion; downloaded/exported copies have separate
   retention limits and cannot be promised remotely erased.
6. Leave a continuation generated from saved records. On return, reread those
   records before acting. A historical success is not a current check, and a
   copied prompt cannot grant permissions or resume an unknown external effect.

### Research and what to adopt

- [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
  supports small, relevant context and on-demand exploration. Adopt progressive
  disclosure and measure retrieval failures rather than loading the entire wiki.
- [Anthropic long-running harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)
  describes incremental work and clear artifacts between sessions. Reuse our
  existing results/continuation path and test fresh-agent recovery.
- [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory)
  separates thread checkpoints from cross-thread memory. Preserve that distinction:
  a runtime checkpoint is not a shared project decision.
- [Letta context repositories](https://www.letta.com/blog/context-repositories/)
  uses versioned files and progressively disclosed context. Git export/import is
  a useful future portable interface, but it needs explicit source ownership and
  conflict handling; it is not automatic bidirectional synchronization.
- [Graphiti](https://github.com/getzep/graphiti) models temporal facts with source
  provenance and invalidation. Evaluate that pattern for demonstrated relational
  retrieval failures; adding its graph database, extraction models and operations
  is not yet justified. No code was copied or executed for this review.
- [Anthropic multi-agent research](https://www.anthropic.com/research/multi-agent-research-system)
  reports gains for parallel research alongside substantial token cost and limits
  for tightly coupled coding. Optimize accepted outcomes and recovery effort,
  not agent count or keeping devices busy.
- [Lost in the Middle](https://arxiv.org/abs/2307.03172) demonstrates positional
  retrieval failures in the models tested. It motivates our context-retrieval
  experiment; its 2023 results are not a benchmark of today's specific agents.

### Smallest next implementation and acceptance gate

First qualify the existing Docs journey end to end and its release/restore
boundary. Next connect a selected task to selected document revisions through
the existing brief/context service. Keep larger search, graph memory and GitHub
write synchronization conditional on measured failures. The other desktop owns
human journey/keyboard experiments; this runtime owns composition and structured
context qualification. No competing listener or second task store is needed.

Test a fresh contributor, a returning contributor after a source change, and two
contributors editing related material. Each must find the correct task and
relevant decision, identify stale/conflicting evidence, make one accepted change,
and leave the next contributor able to continue. Include permission loss,
incomplete lists, failed/unknown saves and interruption. A successful local
fixture does not establish hosted rollout or native-host behavior.

Use the existing [trial protocol](AGENT-UTILITY-TRIALS.md) and
[scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md): accepted task completion,
elapsed time, human reconstruction effort and cost per accepted outcome. Record
context-specific diagnostics: relevant-source retrieval success, stale-fact use,
missing-context reopens and unnecessary direct clarification. Keep failures in
the denominator and unknown costs unknown. Privacy, draft preservation and
source correctness are guardrails. Compare against competent repository/GitHub
work without Room; preserve an added mechanism only if its benefit justifies it.


### Recent evidence on memory — 2026-11-12

[MemDev-Bench (Oct 20)](https://arxiv.org/abs/2610.27524) finds benefits in
localization/editing alongside harmful reuse when agents fail to reassess old
experience. [VibeMemBench (Sep 20)](https://arxiv.org/abs/2609.23570) distinguishes
useful repository experience from memory systems' ability to retrieve it: 11 of 12
system/solver pairings did not beat their matched memory-off baseline.
These are preprints, not measurements of Room.

The [October 21 shared-memory report](https://nevolin.be/assets/blog/coding-agents-shared-team-memory/report.pdf)
provides a counterpoint: useful cross-agent lessons helped knowledge-dependent
synthetic tasks, while easy code-solvable tasks incurred extra cost. Its lean
three-tool surface was much smaller than its default schema. Simulated machines,
small task families and author-built tasks limit transfer to our setup.

The [recent HN memory debate](https://news.ycombinator.com/item?id=50411467)
questions whether another memory format improves outcomes at all. The older
[docs-versus-memory debate](https://news.ycombinator.com/item?id=49945933)
contrasts useful compact reference with stale generated prose. These are valuable
counterarguments, not controlled experiments.

Test selected source-linked knowledge against competent source search, including
stale, conflicting and irrelevant notes. Keep useful raw investigation evidence
reachable rather than forcing all knowledge into summaries. Existing revision,
author, source and permission boundaries are prerequisites; adding a memory
server is conditional on a demonstrated retrieval/continuation benefit.


### Human and agent boundary qualification — 2026-11-12

Human account sessions and agent identity/OAuth credentials are separate
principals, even though both can participate in the same project. Browser
presentation follows member kind; authority is enforced by current server
credentials, membership and scope. A human owner can authorize a distinct agent
connection without turning that agent into the human account. Agent tools remain
structured interfaces; browser compatibility is optional and not their primary
workflow.

Selected existing account/session, identity-holder-proof, MCP authentication,
OAuth scope/revocation and account-owned agent tests passed 80/80 locally.
The explicit conversion regression additionally verifies agent membership cannot
bind to a human account, an agent key cannot create a human browser session,
an agent compatibility session cannot access human account-session inventory,
and a human account key is not an MCP agent identity bearer. Failed conversion
leaves the real agent credential usable. See `tests/room-mcp-auth.test.js`.

Four actual account-session browser fixtures cover desktop/phone and both themes:
open the account's room, get the human presentation, open selected work and
return. The existing agent browser compatibility case asserts human presentation
stays off. `human-work` in the design gallery captures these real-account states.
Fixture setup is not a real external-provider login, production configuration
review or a proof that the human design is good. These boundaries must survive
an ambitious interface redesign; passing them does not approve the interface.
