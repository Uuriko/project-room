# Project knowledge: shared documents for people and agents

Status: proposed product contract, not a shipped capability. Source inventory
checked at main `69149bcab` on 2026-11-12. The UI label is **Docs**; “project
knowledge” describes the system. This document owns the proposed integration
contract, not a second handbook or execution queue.

## One place to find an answer

An agent joining a project should find its purpose, current decisions, relevant
source, and available actions without cloning an unrelated maintainer repo or
reading every historical conversation. A person should see and edit the same
permitted document revision. Every interface uses the same authorization and
write-conflict rules.

Unify discovery and navigation, while retaining authoritative sources:

| Existing source | Role in Docs | Ownership and reconciliation |
| --- | --- | --- |
| [Repository handbook](INDEX.md) and [public wiki API](WIKI-API.md) | Linked product help and maintainer reference | Public build-time repo content. Preserve procedure owners and append-only [lessons](ROOM-WIKI.md). Never import private room bodies into this public embed. |
| [Room documents PR #5927](https://github.com/Uuriko/project-room/pull/5927) and [bounded follow-up #6130](https://github.com/Uuriko/project-room/pull/6130) | Candidate room-owned Markdown document store | Draft foundation, not production proof. Compose and qualify storage, export/restore, purge, Worker flags and authorization before activation. |
| [Work context](WORK-CONTEXT.md), work records and requests | Related work and evidence links | Live status belongs to work/request APIs; documents explain decisions rather than copying a second task board. |
| [Project map](PROJECT-MAP.md) | Source/dependency navigation | Derived data with repository, revision, engine and coverage. Rebuildable, not authority over source. |
| Linked GitHub Markdown, issues and PRs | Source-backed document and evidence views | Keep repo/path/commit or issue/PR identity, observed time and source link. Repository-owned edits go through a PR. |
| Local experiments, research and old plans | Selected evidence links | Review relevance and visibility before publishing. Preserve original evidence; do not bulk-upload local folders or declare all historical material current. |

For each candidate document record its source, intended audience, canonical
owner, revision, current/proposed/historical status and replacement link. Exact
duplicates may become aliases only after checking inbound links. Conflicting
guidance remains a visible reconciliation task until its owner resolves it.
Generated copies remain generated, with their existing drift checks. Importing
all content into a new database is not a prerequisite for unified navigation.

## Shared operation contract

These are proposed operation names, not commands available today. Add their
schemas to the existing action discovery and CLI help when implemented; do not
build a competing tool catalog. Discovery must reflect feature availability.

| Intent | Tool operation | CLI shape | UI operation |
| --- | --- | --- | --- |
| Orient | `docs.index` | `room docs list --json` | Open Docs, see entry links and metadata |
| Find | `docs.search` | `room docs search QUERY --json` | Search, then choose a result |
| Read | `docs.read` | `room docs read ID --rev REV` | Direct page or revision link |
| Create | `docs.create` | `room docs create --file PATH` | New document |
| Update | `docs.update` | `room docs update ID --base-rev REV --file PATH` | Edit, Save, verify saved revision |
| Inspect history | `docs.history` | `room docs history ID --json` | Revision history |
| Link source | `docs.source` | `room docs source ID --json` | Source and freshness detail |

Stable document IDs are independent of titles; a title edit must not break links.
List/search returns bounded metadata and explicit continuation, not every body.
Search must state scope and incomplete coverage; zero hits in a partial search
does not mean no document exists. Selected reads return Markdown, revision,
source provenance and permitted next actions. Section reads can follow once
anchors and rename behavior have a defined contract.

Writes require the last-read revision. A stale write returns a conflict and
preserves the unsaved draft. Creation and retried mutations need stable operation
IDs and readback reconciliation; a lost response is not permission to create
again. A saved receipt contains the persisted document ID and revision.
Permission changes apply to history, search snippets, suggestions, backlinks,
exports and caches, not just the full-document route. Authorization is checked
before retrieving or indexing protected content. Cached copies are invalidated
when membership changes; previously disclosed data cannot be “unread.”

Use existing credentials outside command arguments. Structured errors distinguish
not found, denied, conflict, unavailable and partial coverage. Text inside a
document is content, never a grant to execute commands or change permissions.

## Computer-use and keyboard interface

One Docs entry opens a compact navigation column and document. Use ordinary
links, headings, labeled form controls and disclosure buttons. Keep the visible
actions to Search, New and Edit where permitted; contextual actions appear when
needed. No canvas-only reader, hover-only control or drag-only organization.

- Search is visible and also opens with Cmd/Ctrl+K where that shortcut does not
  conflict with the application's existing command surface. Typing finds titles
  and snippets; Enter opens, Escape closes and restores focus. Navigation results
  never execute a mutation. Use the existing command surface if one is available.
- Every document has a deep link. Back/Forward restores navigation and relevant
  scroll position. A visible breadcrumb and current title establish location.
- The document is semantic HTML. Copy/export returns canonical Markdown without
  layout text. Rendered Markdown is sanitized; embedded scripts/JSX do not run.
- Editing exposes a labeled Markdown field, Save and Cancel. Save state says
  unsaved, saving, saved revision, conflict or failed. Do not show saved on dispatch.
- A conflict preserves the draft and offers the current revision for comparison.
  Retrying an unknown save first reconciles its operation ID or reads the result.
- Focus is visible; dialogs do not trap users; controls work at 200% zoom and narrow
  widths. Computer-use tests use accessible names and visible content, not hidden
  selectors or a fixed screen coordinate recipe.

Use [W3C disclosure navigation guidance](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/)
for ordinary link navigation rather than imposing application-menu roles. Its
examples are illustrative, not tested production components to paste blindly.

## GitHub and freshness

Start with source references and bounded reads. Store repository, path, immutable
commit, content digest and observed time. Display “observed at” separately from
“matches current branch.” A webhook is a refresh hint; verify the new source and
permissions before updating the view. Deleted, inaccessible and stale sources
remain distinct. Do not silently replace room-owned text with upstream changes.

Repository-owned Markdown changes create a proposed PR against a known base;
room-owned documents use document revisions. Bidirectional automatic sync is
deferred until ownership and conflict resolution are proven. Reuse existing
GitHub authentication, bounded fetching and origin restrictions. Public upstream
content linked from a private room does not make private annotations public.

## Reuse rather than rebuild

Source inspection on 2026-11-12 supports these candidates; no speed benchmark or
complete transitive license audit has been performed. Pin the actual selected
version, retain notices, and inspect included packages before adopting code.

| Project | Reuse decision |
| --- | --- |
| [SilverBullet](https://github.com/silverbulletmd/silverbullet), [MIT license](https://raw.githubusercontent.com/silverbulletmd/silverbullet/main/LICENSE.md) | Strong reference for Markdown, links/backlinks and command-driven navigation. Inspect selected components, not a wholesale second application or embedded scripting runtime. |
| [CodeMirror](https://github.com/codemirror/view), [MIT license](https://raw.githubusercontent.com/codemirror/view/main/LICENSE) | Preferred editor candidate for vanilla JS: lazy-load on Edit with a textarea fallback. Keep document format independent of editor internals. |
| [MiniSearch](https://github.com/lucaong/minisearch), [MIT license](https://raw.githubusercontent.com/lucaong/minisearch/master/LICENSE.txt) | Candidate for bounded authorized in-memory corpora. Not an authorization layer or a reason to download an entire private workspace. |
| [ProseMirror](https://github.com/ProseMirror/prosemirror-view), [MIT license](https://raw.githubusercontent.com/ProseMirror/prosemirror-view/master/LICENSE) | Rich-text alternative if editing trials justify the larger assembly work. |
| [MDXEditor](https://github.com/mdx-editor/editor), [MIT license](https://raw.githubusercontent.com/mdx-editor/editor/main/LICENSE) | Ready-made React editor; adopting React solely for this needs evidence. No arbitrary MDX execution. |
| [BlockNote license](https://raw.githubusercontent.com/TypeCellOS/BlockNote/main/LICENSE.txt) | Core MPL-2.0 and separate XL terms; not uniformly permissive. Review package boundaries before reuse. |
| [Outline license](https://raw.githubusercontent.com/outline/outline/main/LICENSE) | Current BSL grant excludes a commercial Document Service. Study product patterns; do not transplant its code into this feature under that grant. |
| [Docmost license](https://raw.githubusercontent.com/docmost/docmost/main/LICENSE) | AGPL-3.0 core with separate enterprise components. Not a drop-in Apache-2.0 code source; inspect terms and integration boundary first. |

Start with existing Room Markdown rendering and semantic HTML. A library earns
adoption by reducing implementation and maintenance cost on a real acceptance
task, not by supplying more toolbar buttons.

## Delivery and evidence

1. Reconcile the source inventory and ownership above with other active agents.
   Retain existing document/history IDs and links; no mass closure or deletion.
2. Finish the default-off room document foundation on current main. Qualify Node
   and Workers, actual membership/scopes, concurrent writes, >500-page traversal,
   cold storage, backup/restore and deletion. Check reply/storage compatibility.
3. Expose read/list through existing tool discovery and CLI using the same service.
   Build the minimal semantic reader with direct links. Verify the same ID and
   revision across all three interfaces.
4. Add bounded search and editing; adopt an editor only after comparing the simple
   baseline. Keep draft/conflict recovery and sanitized rendering in the first
   usable edit flow.
5. Add GitHub source references, then explicit PR proposals. Qualify private-repo
   access revocation and upstream changes before offering refresh automation.
6. Publish a compact project entry document and optional templates for brief,
   decision and runbook. Do not auto-generate a large mandatory wiki. Keep current
   work in the work system and expose it through links.

Acceptance uses identical fixtures through tools, CLI, keyboard and computer use:

| Task | Required evidence |
| --- | --- |
| Find a decision among 100 pages | Correct source/revision in first five results; record elapsed time, calls, bytes and wrong-page opens, including typo/partial-title queries. |
| Follow three links and return | Stable destinations, working Back/Forward, no hidden interaction requirement. |
| Agent A edits; human and agent B read | Same persisted ID/revision/body through all interfaces. |
| Two writers edit the same base | One accepted update, one explicit conflict; both drafts recoverable. |
| Traverse 501 documents | Complete unique traversal with explicit end; live versus snapshot semantics documented. |
| Access changes | No forbidden title, snippet, count, backlink or history disclosure; stale caches tested. |
| Rename or move a document | Existing stable links still resolve; source ownership remains clear. |
| Interrupt a save | No false success or duplicate document; result reconciled before retry. |
| Source changes or disappears | Staleness/access failure visible; no silent overwrite or unsupported freshness claim. |
| Restore and remove a project | Content/revisions survive supported restore; deletion removes all protected copies and search entries in scope. |

Track successful verified tasks first, then latency, calls, bytes, corrections
and lost edits. Report model, device, corpus size, warm/cold state and sample size.
Compare against the same baseline tasks; product descriptions and synthetic
benchmarks do not prove that agents are faster in real use.
