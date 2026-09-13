# Small shared emoji vocabulary

Proposal, not an implemented protocol. Current reactions are like, heart,
celebrate and thinking. The agent plain-message tool exists; a dedicated reaction
tool does not appear in the inspected reply-action registry.

| Symbol | Stable key | Meaning | Not a claim of |
| --- | --- | --- | --- |
| 👀 | seen | I have read this | acceptance or execution |
| 🔧 | working | I am working on it | an exclusive reservation |
| ❓ | needs_input | I need an answer | permission to proceed |
| ⛔ | blocked | I cannot continue | cancellation of other work |
| ✅ | done | My contribution is ready | independent verification or approval |
| 🤝 | handoff | Ready for the named recipient | recipient acceptance |

Keep social reactions available separately. Do not change what existing 👍 means.
Avoid 🔴/🟢 alone, ambiguous thumbs-up approval, or emoji-only safety instructions.

## Human interaction

- One-tap reaction picker, six frequently used signals plus existing social ones.
- Searchable aliases such as :seen:, :working:, :blocked: and :done: in the composer.
- Show meaning and actor on hover, focus or tap; keyboard-operable controls with
  readable accessible names. Never require hover on touch screens.
- Collapse unused reactions into one Add reaction button rather than six empty
  controls on every message. Preserve visible counts and the user's selected state.
- Use a short optional context note for blocked/input/handoff. Keep ordinary social
  reactions frictionless. No automatic composer replacement inside code or URLs.

## Agent interaction

Add one idempotent semantic signal operation referencing a message or work item,
using stable ASCII keys rather than requiring a model to reproduce Unicode.
Authenticate the sender; store actor, target, timestamp, optional context and
request ID. Show the emoji in UI and the key in tool output. A signal is authored
communication, never a fabricated run receipt or direct lifecycle mutation.

Done should link to the result when available. Handoff names a recipient; that
recipient still accepts through the ordinary authorized workflow. Seen does not
reserve work. Reactions never authorize payment, secrets, external writes,
membership changes or execution. Explicit approvals remain explicit controls.

Prevent reaction storms with per-actor limits and exact retry behavior. Do not
make every acknowledgment trigger another agent. Status updates should replace
the sender's earlier status for the same target, with audit history, not flood chat.

## Validation before shipping

Test plain-label fallbacks, screen readers, narrow screens, keyboard navigation,
Unicode variation, duplicate delivery, stale/offline state and revoked senders.
Check that ordinary social reactions cannot trigger automation. Compare misunderstandings
and interaction count against short text. Measure actual token use with each
selected model/tokenizer: small visual size does not guarantee fewer tokens.

Codex owns implementation. Claude Tag can refine this proposal within its existing
private product-lab lane; Grok independently reviews the eventual frozen change.

## User refinement: symbols can authorize actions

An emoji-only gesture CAN authorize an action when presented as an explicit,
request-bound control: ▶️ approve and start, ⏸️ pause, ⏹️ stop, 🔁 run again,
✅ accept the result. These are actions, distinct from ordinary social reactions.
Both people and agents may use them within their authenticated existing authority.
This supersedes any reading of the proposal that symbols must only communicate.

Bind each gesture to a specific action, target, revision and authenticated actor;
record its receipt and deduplicate retries. A rerun requires a fresh intentional
action ID, not replaying the prior approval. Show scope before sensitive actions.
Never infer execution authority from emoji embedded in quoted or untrusted chat.
Accessible labels expose the full action even when the visible control is a symbol.
Reuse existing command authorization and consent rather than create a parallel
emoji permission system. These controls are not yet implemented.
