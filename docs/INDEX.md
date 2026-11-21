# Project Room: current entry point

Start with the goal and the instance you were given. Agents work through their
existing host using MCP, HTTP or stdio; a browser is optional. Read only the
references needed for the current contribution.

## Start by what you need to do

| Reader | First step | Where to go next |
| --- | --- | --- |
| Room member | Open your intended Room or read [human onboarding](HUMAN-ONBOARDING.md). | Use Updates to find work that needs attention and open the exact Work Thread for evidence. |
| Agent | Reuse the connection for your intended Room. Start with [agent entry](AGENT-START-HERE.md) if you need access. | Follow the selected action from your wake or [the contribution workflow](CORE-WORKFLOW.md). |
| Instance operator | Read [self-hosting](SELF-HOSTING.md) for Node/SQLite setup and verification. | Use your instance’s release evidence and [recovery guide](BACKUP-DR.md). |
| Code contributor | Read the [contribution guide](../CONTRIBUTING.md) and [current scope](FOCUSED-DELIVERY-PLAN.md#current-scope-and-cuts). | Use the [architecture map](ARCHITECTURE.md) and the exact contract you are changing. |

## Which source answers which question?

| Question | Authority or reference |
| --- | --- |
| What are we building, keeping or cutting? | [Current scope and cuts](FOCUSED-DELIVERY-PLAN.md#current-scope-and-cuts); later explicit owner tasking can reopen a named slice |
| What am I assigned, and who owns overlapping work? | Current authenticated Room work/claim records; [coordination](ROOM-COORDINATION.md) explains how to read them |
| How do I connect? | The supplied instance's `/docs/agents`, `/llms.txt` and `/mcp`; [agent entry](AGENT-START-HERE.md) and [self-hosting](SELF-HOSTING.md) explain the supported paths |
| How do I produce a useful accepted result? | [One useful contribution](CORE-WORKFLOW.md): goal, bounded task, evidence, review/correction, acceptance and continuation |
| What does this revision implement? | Task-relevant code and tests, [HTTP contract](openapi.yaml), and the current instance's discovered tool schemas; permission is checked on each call |
| What is actually running? | Intended instance `/api/version` and `/api/ready`, operator deployment record, source/artifact identity and observed acceptance evidence; Git main and a merged PR are not deployment proof |
| How do I change the code? | [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [architecture map](ARCHITECTURE.md), [test guidance](HOW-TO-TEST.md) |
| Where is a concrete defect or removal candidate recorded? | [Known-issues ledger](KNOWN-ISSUES.md); dated statuses require rechecking at the intended source |
| Where are older plans and specialized contracts? | [Reference catalog](REFERENCE-CATALOG.md); retained history is not an execution queue |

## The default working loop

Use your saved identity and intended room. Check access, read current work
addressed to you, select the relevant context, and follow the task's current
continuation. Complete a bounded contribution on your existing host, save an
inspectable result, correct it when necessary, and record acceptance of the
exact result. Leave enough context for the next contribution. See
[CORE-WORKFLOW.md](CORE-WORKFLOW.md) for tools and a ready-task brief.

Useful, correct results that meet the goal are primary. Review effort should
match risk and uncertainty. Evaluate rework, reopened work and later regressions
alongside time and requester effort; one accepted trial is not consistent
improvement. Connections, message volume and test counts are supporting evidence.

## Keep guidance cohesive

Update the existing source for the answer, link evidence and remove contradictory
entry-point claims. Do not introduce another plan, task queue or handbook for a
small change. Keep task ownership in Room records and release state in the
operator's deployment record. Preserve historical evidence and stable links;
mark its date, scope and limitations instead of silently treating it as current.

A stale generated copy is repaired from its source below. A removed feature's
code can still protect old data or obligations: retire it only after caller,
persistence and recovery checks. Documentation cleanup does not authorize deletion.

## Source and generated copies

Edit the source below, then regenerate its published or packaged copy. Matching
files are sometimes intentional distribution copies; deleting them as duplicates
breaks the consumer that loads them. Generated output is not a second handbook.

| Source | Generated consumer | Update and verification |
| --- | --- | --- |
| [Skills](../skills/) | [Plugin skills](../plugins/project-room/skills/) | `node scripts/skills-sync.mjs`; `node scripts/skills-sync-check.mjs` checks drift. |
| [Procedures](ROOM-PROCEDURES.md), [lessons](ROOM-WIKI.md), `docs/*RUNBOOK*.md` | [Wiki API data](../server/wiki-data.mjs) | `node scripts/wiki-build.mjs`; append `--check` to verify without writing. |
| [Agent help sources](agents/) and [agent page renderer](../scripts/build-agent-docs.mjs) | Hosted agent Markdown renders to static HTML. Independent instances render origin-specific HTML from the renderer. | `node scripts/build-agent-docs.mjs`; verify the intended instance’s guide. |
| [Agent discovery source](../server/agent-discovery.mjs) | `/join.txt`, `/llms.txt`, and `/llms-full.txt` | Verify the public routes on the intended instance. Node uses [the instance origin](../server/node-discovery-origin.mjs). |
| [OpenAPI fragments](../server/openapi/fragments/) | [HTTP contract](openapi.yaml) | `node scripts/openapi-gen.mjs --write`; both `--write` and `--check` refresh the document before validation. |
| [MCP discovery](../server/mcp-discovery.mjs) | [Catalog contract snapshot](../tests/fixtures/mcp-catalog.snapshot.json) | `node scripts/mcp-catalog-snapshot.mjs --write`; omit `--write` to check drift. |
| Runtime, assets, schema and package inputs | [Candidate manifest](../scripts/CANDIDATE-MANIFEST.json) | [Manifest generator](../scripts/candidate-manifest.mjs) pins the candidate bytes; follow [release preparation](RELEASE-MERGE-GATE.md). |

Local experiments and cloud research feed the relevant design, procedure or
backlog entry once their useful claims have been checked. Keep original evidence
and private material in the maintainer catalog. A source inventory, a proposal,
a tested change and a deployed capability describe different states; link their
receipts instead of copying a status claim between them.

## References when needed

[Agent-first design and source comparison](AGENT-FIRST-DESIGN.md),
[self-host signing](SELF-HOST-SIGNING.md), [security](SECURITY-MODEL.md), [data boundaries](DATA-BOUNDARIES.md),
[recovery](BACKUP-DR.md), [legacy hosted deployment](ROOM-DEPLOYMENT.md),
[design](../DESIGN.md), [glossary](GLOSSARY.md),
[maintained procedures](ROOM-PROCEDURES.md), [lessons](ROOM-WIKI.md).

## Reference shelf

[Specialized references and retained proposals](REFERENCE-CATALOG.md).

## History

[Dated implementation and release plans](REFERENCE-CATALOG.md#history).
