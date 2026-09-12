# Agent and result journey qualification

## Verified candidate

`4e64dfc` (`codex/project-room-integration`), clean before and after execution.
Three browser suites ran together against disposable local SQLite rooms and
Chromium using the existing bundled browser dependency. No external services,
paid models, deployments or canonical edits were used.

- `scripts/agent-connect-browser-check.mjs`
- `scripts/work-reuse-browser-check.mjs`
- `scripts/native-result-browser-check.mjs`

Result: **30 passed, zero failures/skips**, 38,773 ms.

## What the checks establish

Agent setup exercises a real local HTTP client importing private configuration,
0600 configuration-file permissions, read-only context, key replacement and old
key rejection, disconnection, failed enrollment retries, delayed receipts after
owner access ends, expiry and concealed secrets. Roster selection is tested but
does not prove integration with the named commercial host products.

Work reuse exercises desktop/mobile definition-only previews, fresh proposals,
draft/focus preservation and exact retries after committed or uncommitted lost
responses. Malformed receipts, first refusals, oversized Unicode proposals and
replacement-session isolation are covered.

Native result checks cover desktop/mobile selection of exact prior message
text, evidence-version validation, uncertain save retry, stale-work refresh,
independent review without implied owner approval, large text, keyboard focus
and clearing visible text when access ends.

## Limits and next work

These are synthetic checks of existing journeys, not human usability research,
physical-device qualification, hosted-runtime parity or proof of external
agent execution. File sharing is missing entirely; email attachment metadata
does not fill that gap. The next feature contract is in
[Attachment build contract](ATTACHMENT-BUILD-CONTRACT-2026-09-12.md).
