# Find existing work without another screen

## Problem and decision

The existing search scans message text and message authors only. A returning
participant cannot find a work title, done criteria or reported result unless
matching wording also happens to appear in a message. That weakens reuse and
encourages duplicate work. The first step is findability, not another task feed.

Extend that same search with bounded work hits linked to the original record.
Keep discussion hits unchanged. Do not advertise unassigned opportunities or
imply that finding someone else's work permits taking it over.

## Research, September 8

[Linear search](https://linear.app/docs/search) combines issues, projects and
documents and includes titles, descriptions and comments. Its default relevance
order puts ongoing issues before completed or archived ones. Borrow one search
entry and discoverable older outcomes, not its full filters and command language.

[GitHub contribution guidance](https://docs.github.com/en/get-started/exploring-projects-on-github/finding-ways-to-contribute-to-open-source-on-github)
distinguishes finding helpful work from agreeing a contribution approach with
maintainers. Inference for Room: discovery should expose the existing record and
accountability, not start or reassign work. Neither source proves retention lift
or preference for our specific interface. No source code is copied.

## Implementation plan

1. Add a pure selector over the current authenticated snapshot. Case-insensitive
   literal substring matching, trimmed and bounded to 200 characters, just like
   message search; no regular expressions, fuzzy ranking or external queries.
2. Match work title, ID, done criteria, current reported completion summary and
   next handoff, plus current named accountable/reviewer/decision participants.
   Exclude credentials, private reminders, external evidence contents, previous
   event versions and hidden browser drafts. Search is not verification.
3. Rank nonterminal work before resolved/superseded work, then recorded update
   recency and stable ID. Cap work results at25 and retain message search's50 cap.
   Display the actual aggregate count and an explicit shown count when truncated.
   Empty query stays quiet. Completed work must remain findable.
4. Show a compact title, matching excerpt and existing work status for each work
   hit. Reuse original work anchors and details navigation. No copied record,
   automatic action, read acknowledgement or second screen.
5. Preserve focused result by kind plus exact ID across live updates, including
   equal work/message IDs. If an owned focused hit disappears, return focus to
   search; never steal focus from a draft or another control. Escape all text.
6. Preserve sign-out/revocation clearing and current-room scope. No query history,
   server indexing, analytics provider, dependency, schema or API change.
7. Test literal/Unicode matching, bounds/counts/order, current-only fields,
   immutability, cross-kind IDs and desktop/touch browsing. Exercise live updates,
   preserved drafts/read markers, terminal record navigation, keyboard, enlarged
   text, and session clearing. Inspect screenshots before the local checkpoint.

## Boundaries

This finds records in the already loaded room, not other rooms or linked websites.
It does not search inside every evidence file, version history or private draft.
Work status is a recorded workflow state, not live execution. Agent tools remain
unchanged: this slice addresses a human return/use gap; a shared selector is
available if a later bounded agent query contract is justified.

Now: implement and verify the existing search extension.
Next: use actual contributor feedback, when authorized, to test whether discovery
leads to useful coordination and reuse rather than duplicate work.
Later: consider explicit help offers or richer search only from observed needs.
Native models and hosted recovery remain separate approval gates; goal incomplete.

## Implementation and initial evidence

The selector and existing-search integration are implemented. A title match
previews the current reported result when present, otherwise its done criteria.
Long matched text gets a bounded excerpt around the term, without splitting a
surrogate pair. Both search and work cards share the same clock when the existing
return view refreshes, including claim expiry without a new event.

Four selector tests and both desktop/touch browser journeys pass. The browser
journeys test mixed results, exact work/message ID collisions, opening original
terminal and nonterminal records, literal markup, input/focus preservation across
live updates, removed-result focus recovery, accurate truncation, 200% text,
touch targets and sign-out clearing. Navigation preserves the full all-table
audit; the human read marker stays zero. All556 core/API/package checks pass.
The first browser fixture used an unsupported Unicode work ID and was correctly
refused. The fixture now uses a supported colon ID shared across record kinds;
the product validation was not changed.

Initial mixed and enlarged touch screenshots were inspected. Evidence uses
`test-results/work-search-{desktop,touch}-{mixed,large}.png`. These are synthetic
usability checks, not human preference or retention findings. Full browser and
exact-package qualification remain to be recorded after completion.
