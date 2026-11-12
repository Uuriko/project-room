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
