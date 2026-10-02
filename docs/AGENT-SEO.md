# Assistant answers

The weekly check asks ChatGPT, Claude, Perplexity, and Grok the same questions and records whether the answer names Project Room. The questions, model ids, and sampling settings live in [answer-engine-prompts.json](answer-engine-prompts.json) so a model change does not require a code change. One call is made per prompt per engine. There are eight prompts, so a week with every engine configured is 32 calls.

## What the score means

An answer is **mentioned** when it names Project Room or cites a Project Room URL (`room.trydemigod.com`, `getdasha.com/room`, or `github.com/Uuriko/project-room`). It is **recommended** when that mention sits in a sentence or list item that presents it as something to use, and the same sentence does not reject it. **Position** is the 1-based order of Project Room among the tools named in that answer. **Competitors** are the other tools from the list in the prompt file, in the order they appear. **Cited URLs** are the Project Room URLs in the answer. Other cited URLs are kept beside them.

The mention rate for an engine is the number of scored answers that name Room divided by the number of answers that parsed. A failed or unrecognized response is not counted as a miss and is not given a rate of zero. An engine with no key has no rate.

Temperature is sent only when the prompt file sets a number for that engine. The current Claude and ChatGPT models reject a non-default temperature, so their entries leave it unset. Perplexity Sonar and Grok send 0.

## What to do with a miss

When an engine does not name Room, the job summary lists the competitors it named and the URLs it cited. That list is the next change to make: a compare page, a directory listing, or a docs page that answers the question the assistant actually cited. The raw answer text is uploaded as a workflow artifact for that audit and is not committed.

## Workflow

`.github/workflows/answer-engine-check.yml` runs Mondays at 15:00 UTC and on demand. Each engine reads its own secret:

| Engine | Secret | API |
| --- | --- | --- |
| ChatGPT | `OPENAI_API_KEY` | OpenAI Responses API with the `web_search` tool |
| Claude | `ANTHROPIC_API_KEY` | Anthropic Messages API with the web search tool |
| Perplexity | `PERPLEXITY_API_KEY` | Sonar API |
| Grok | `XAI_API_KEY` | xAI Responses API with the `web_search` tool |

A missing secret skips that engine. The log line is `skipped: <SECRET> not set`. The job still exits 0 when every secret is missing. When `ROOM_OPS_POST_TOKEN` and `ROOM_OPS_ROOM_ID` are set, the table is posted to that room. When `server/analytics-ingest.mjs` exports `INGEST_PATH` and `ANALYTICS_INGEST_TOKEN` is set, engines that ran are posted as an `answer_engine.snapshot` event. A skipped engine is not sent as a zero.
