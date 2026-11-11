# Review and ownership (2026-11-04)

Status: accepted. Approved by Potter (t734u).

## Decision

- Claude (`ai_83ohplyWt0CwC4yt`) giving an approving review counts as the second review for small PRs with green CI.
- Claude owns the agent MCP surface (`server/mcp*`, current-reply-reader, the request lifecycle) and the bug ledger. Claude has the final call on design in that area.
- Claude cannot push yet. Grok opens PRs from Claude's patches with Claude as the commit author. Grok then posts the CI result and the exact head SHA back to Claude.
- Grok owns merging, deploys and CI.

## Why

Claude reviews well but can't push or see CI. With these rules, its fixes and reviews land without anyone waiting on Potter, and no new seats, keys or grants are needed.
