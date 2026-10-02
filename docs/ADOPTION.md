# Snippet adoption

The weekly count is how many public repositories carry the Project Room coordination marker, or the hosted MCP URL, on the default branch. GitHub code search is the source. The job does not invent a count when the search is unavailable.

## What is counted

A repository is counted once. Forks are dropped. Repositories under `Uuriko/` are dropped, including this one. For each remaining repository the report records the full name, star count, `pushed_at`, the file path, and the marker version when the search fragment contains `project-room:coordination vN`. A fragment with no version is recorded as no version. Star count and `pushed_at` come from the code-search repository object. When either field is missing, the job reads `GET /repos/{owner}/{repo}` and uses that payload. A failed repo read leaves the field empty and does not treat the repository as having 100 stars.

These are the queries:

- `"project-room:coordination" filename:AGENTS.md`
- `"project-room:coordination" filename:CLAUDE.md`
- `"project-room:coordination" filename:CONVENTIONS.md`
- `"project-room:coordination" filename:.cursorrules`
- `"room.trydemigod.com/mcp"`

Code search returns at most 1,000 results for each query. The job pages with 100 results per page and stops at that ceiling. A query that reports more than 1,000 matches is marked capped: the repo total is then a lower bound for that query. A page with `incomplete_results` is marked incomplete. Code search indexes the default branch only, so a marker that exists only on another branch is not in the count.

The code-search endpoint allows 10 authenticated requests per minute. The job waits 6.5 seconds between search requests.

## Week to week

The report is `adoption-YYYY-MM-DD.json`, uploaded as a workflow artifact of the same name. The next run downloads the latest earlier `adoption-YYYY-MM-DD` artifact with the workflow `GITHUB_TOKEN` and diffs repository names. New and lost are filled only when that artifact is present. The first run, or a run that cannot read artifacts, leaves both empty and says there is no previous artifact.

## Workflow

`.github/workflows/snippet-adoption.yml` runs Mondays at 13:00 UTC and on demand. Code search needs a user token. The job uses the `ADOPTION_SEARCH_TOKEN` secret when it is set: a fine-grained personal access token limited to public repositories, with no write permission. When that secret is unset, the job tries the workflow `GITHUB_TOKEN`. If that token cannot search public code, the job exits 0 and prints `skipped: ADOPTION_SEARCH_TOKEN not set`.

When `ROOM_OPS_POST_TOKEN` and `ROOM_OPS_ROOM_ID` are set, the summary is posted to that room. When `server/analytics-ingest.mjs` exports `INGEST_PATH` and `ANALYTICS_INGEST_TOKEN` is set, the same totals are posted as an `adoption.snapshot` event. Until that module exists, the snapshot is not sent.
