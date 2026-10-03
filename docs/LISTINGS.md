# Directory listings

Room is listed, or waiting to be listed, in the directories below. The registry one-liner is the `description` field in [server.json](../server.json). The weekly check reads that field. Change the sentence there and the check follows it.

The canonical remote is `https://room.trydemigod.com/mcp`. `https://www.getdasha.com/room/mcp` is an alias of the same server.

## Weekly check

`.github/workflows/listing-check.yml` runs every Monday at 14:00 UTC, and when someone starts it by hand. It runs `node scripts/listing-check.mjs`, uploads `listing-check.json`, and writes a Markdown table to the job summary.

Each row is `listed`, `missing`, `stale`, or `unknown`.

- `listed` means the page or API shows the current text, the registry version matches `server.json`, or the awesome-list pull request is merged.
- `missing` means the page is HTTP 404 or the text is absent, or the pull request was closed without merging.
- `stale` means the listing is there and the text or version differs from `server.json`.
- `unknown` means the check could not tell. HTTP 429 and a bot wall are unknown. An open pull request is unknown, and the detail column says `pull request open`.

The job stays green when rows are missing or unknown. It fails when the checker crashes, or when `ROOM_OPS_POST_TOKEN` is set and the ops-room post does not succeed.

If `ROOM_OPS_POST_TOKEN` is set, and `ROOM_OPS_ROOM` names the ops room, the workflow posts the table with `POST /api/rooms/{roomId}/commands` as `message.posted`. If the token is absent, it skips the post and says so in the summary. This repo does not contain the token.

## Official registry publish

`.github/workflows/mcp-registry-publish.yml` publishes `server.json` with `mcp-publisher login github-oidc`. The registry accepts that GitHub Actions identity for `io.github.Uuriko/*`. The workflow's `id-token: write` permission is the credential. There is no registry token to add.

A merge to `main` publishes when that push changes `server.json`. A `v*` tag publishes and sets the version from the tag. `workflow_dispatch` publishes the file as it is. The version in the file must be greater than the latest version the registry already has. A re-run of the same version fails that check.

## Directories

| Directory | How it is updated | Who does the account step |
| --- | --- | --- |
| Official MCP Registry | CI publishes `server.json` on a merge that changes the file, and on a `v*` tag | This repository, with GitHub OIDC |
| Glama | Claim the indexed page so its text matches `server.json` | A maintainer, in a browser, signed in as the Uuriko GitHub account |
| PulseMCP | Ingests the official registry. The search API answers 401 without a key, and the check records unknown | No account step in this repo |
| Smithery | Submit the server | A maintainer with a Smithery account |
| cursor.directory | Submit the server | A maintainer signed in with GitHub |
| mcpservers.org | Submit the free listing | A maintainer, in a browser |
| mcp.so | A paid listing. It is not bought | A maintainer, after they approve the purchase |
| Cursor Marketplace | Publish the Cursor plugin | A maintainer with a Cursor publisher account |
| Claude connectors | Submit from a Team or Enterprise admin portal. Clients that need OAuth discovery wait on a later change | A maintainer with Claude admin access |
| Claude Code plugins | Add the plugin to the community directory | A maintainer |
| ChatGPT apps | Submit as a verified publisher. Clients that need OAuth discovery wait on a later change | A maintainer with a verified publisher account |
| GitHub MCP Registry / VS Code | Request onboarding. The check reads the public VS Code MCP page | A maintainer |
| Cline marketplace | Open the marketplace issue Cline documents, with a logo | A maintainer |
| punkpeye/awesome-mcp-servers #14997 | Update the open pull request until it merges | A maintainer |
| EvoMap/awesome-agent-swarm #20 | Update the open pull request until it merges | A maintainer |
| ARUNAGIRINATHAN-K/awesome-ai-agents-2026 #309 | Update the open pull request until it merges | A maintainer |
| awesome-ai-tools/curated-mcp-servers #30 | Update the open pull request until it merges | A maintainer |

## Room surfaces

The same check records three responses from `https://room.trydemigod.com`:

| Surface | Expected |
| --- | --- |
| `/.well-known/agent-card.json` | HTTP 200 |
| `/llms.txt` | HTTP 200 and the words Project Room |
| `/.well-known/oauth-protected-resource` | HTTP 200. The route is not served, so the row is missing until a later change serves it |

Machine-readable rows, including the URLs, are in [listings.json](listings.json).
