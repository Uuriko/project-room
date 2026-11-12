# Source library

Reusable source is part of project knowledge. Keep a small, actionable inventory
of components we might adopt and the components we actually maintain. The
machine-readable source is [source-library.json](source-library.json); this page
explains its use. Existing [third-party attribution](../THIRD_PARTY.md) and
[notices](../THIRD_PARTY_NOTICES.md) remain authoritative, not duplicated here.

## Use it now

From a checkout, these read-only commands emit JSON:

```sh
node scripts/source-library.mjs list
node scripts/source-library.mjs show buzz-canvas-save
node scripts/source-library.mjs next
node scripts/source-library.mjs check
```

This is an initial repo-backed reference implementation. It does not yet expose
hosted Room tools or a Docs view, and it does not inventory all existing imports.
It never downloads, installs or executes upstream code. The initial adapter
supports public GitHub sources only. Private source metadata must remain private
when the model is integrated into customer projects.

## From discovery to actual use

1. **Candidate:** record a concrete product problem, immutable upstream commit,
   selected files, license evidence, intended integration point, owner and next
   experiment. A bookmark without an intended use belongs outside this queue.
2. **Trial:** use an isolated branch. Prefer a maintained package over copying a
   whole application. For an adaptation, retain upstream originals or reproducible
   retrieval pins, record local changes and required notices. Run a relevant task
   against our current implementation; include failure and maintenance costs.
3. **Adopted:** link the integration PR/commit, actual local files, test evidence,
   license/NOTICE locations and a named maintenance owner. A copied unused file
   is not adoption. The checker requires these fields and checks local paths;
   reviewers still verify the integration and evidence are real.
4. **Rejected or retired:** retain the reason and replacement so agents do not
   repeat abandoned research. Remove unused imported code through normal review,
   preserving provenance needed for releases that shipped it.

Every entry has a review trigger: an upstream security advisory, new relevant
release, changed consuming code, or a planned periodic review. This field does
not create a schedule. Upgrades compare the pinned upstream with the proposed
revision and our local patch; never overwrite local changes or auto-execute a
repository's setup scripts. Track the latest revision checked separately from
the version adopted. Inspect per-file and dependency licenses, not only a root
license badge. Preserve required notices and mark modified imported files.

## Buzz: first concrete intake

Inspected [Block Buzz](https://github.com/block/buzz) at commit
`27f0fe75276f93d56cdf878643a4d676f99dc618`. Its root
[Apache-2.0 license](https://github.com/block/buzz/blob/27f0fe75276f93d56cdf878643a4d676f99dc618/LICENSE)
permits reuse under its terms; selected dependencies/assets still need review.
The complete Git tree at that revision contains no root NOTICE file. No Buzz
code is copied or executed by this intake.

The canvas save contract is particularly relevant: its types and conflict helper
distinguish pre-write rejection, a published save with unavailable verification,
and a published save superseded by another edit. Its comments explicitly describe
client-side checking as best-effort, not relay-side linearization. Room must keep
its server-side revision check rather than copying that weaker guarantee.

Its canvas ingress also tests existence separately from content: an empty saved
page remains navigable to a reader. The desktop renderer depends on React/Tauri
and Buzz's event model. Reuse targeted interaction behavior and test cases before
considering a wholesale component transplant. The registry links exact files and
gives each candidate an acceptance task.

## Inside Project Room Docs

Add a **Sources** view backed by this record type, not another independent wiki.
Search by problem, component, upstream and consuming project. A source detail
shows what we use, where, why, the pinned upstream, local changes, evidence and
the next action. Link to existing work items and PRs; do not copy their status.

The same service should support tool/CLI/UI list, read, propose-trial and record-
adoption operations with project permissions and revision conflicts. Proposed
actions create or link normal work; cataloging a source never authorizes running
it. Dependency lockfiles and SBOMs cover installed dependencies; the source
library adds rationale, vendored/adapted code, rejected alternatives and usage.

Measure trials that become useful integrations, time from discovery to verified
use, unused imports, stale pinned versions and update effort. Do not optimize
for links collected or lines copied. Start by finishing the two Buzz trials
before collecting dozens more candidates.
