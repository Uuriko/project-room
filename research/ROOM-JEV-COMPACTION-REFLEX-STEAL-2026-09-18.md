# Steal: Jev compaction + Reflex on-device (2026-09-18)

**Sources (Potter forwarded both):**

1. [altryne / @altryne](https://x.com/altryne/status/2100739055923425589)
   (18 Sep 2026). TypeSafe Jev as a Claude Code plugin via
   [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
   (MIT; npm `fast-jev-compaction`; ~349★ at fold). Quoted origin:
   [tamarajtran](https://x.com/tamarajtran/status/2100694549362553153).
2. [kshetrajna / @kshetrajna](https://x.com/kshetrajna/status/2100739853101195744)
   (18 Sep 2026). Reflex demo
   [kshetrajna12.github.io/reflex](https://kshetrajna12.github.io/reflex/)
   · repo [kshetrajna12/reflex](https://github.com/kshetrajna12/reflex)
   (MIT). Qwen3.5-0.8B (~650 MB) on WebGPU.

Sibling of [#477](https://github.com/Uuriko/project-room/pull/477)
[ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md)
(Jev as closed-set **scorer / router** + Codex same-rung spawn). This
note is Jev as **tool-trace compaction** (`noul` keepCall / keepResult)
plus Reflex as an **on-device** System One shape. Do not rewrite that
spawn / scorer fold. Do not rewrite Room Phase 0.

Fold lock: [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md)
(**Compute ≠ Room**). Needle stays a tools-edge specialist, not an Ask
chat model
([ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md](ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md)
· [ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md)).
Jev contract (recommend / scorer / pre-Ask):
[ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md).

Parallel Ask docs landing now are **different paths** — do not edit
them from this fold: Artifacts-lite, T042 regen-with-model, T043
Continue-after-Stop (and any T060 cousin).

Docs only. No runtime. No Muse UI. No
Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9).

---

## What each steal is (honest)

### 1. fast-jev-compaction — prune tools, do not summarize

Most compaction asks a chat model to **summarize** old turns. That is
lossy: a path, error, constraint, or command can vanish. This library
never rewrites user or assistant text. It scores every
`tool_use` / `tool_result` with TypeSafe Jev (`noul` keepCall /
keepResult), then **drops or truncates stale tools**. Kept text stays
verbatim and in order.

The altryne post claims a Claude session went **~1M → 86K tokens in
~1s**. That is a public claim, not a measurement we ran. Treat it as
inspiration for *score-then-drop*, not a Room SLA.

How the library actually works (README, not the tweet):

1. Pair each `tool_use` with its `tool_result` by `tool_use_id`. The
   first message and the newest `preserveRecentMessages` messages are
   **pinned** and never touched.
2. The **state** sent to Jev is the whole conversation, oldest first,
   with tool results replaced by a short note
   (`ok, 4213 chars (omitted)`). Tool inputs and texts stay; nothing
   is summarized for the model’s sake except that omission note.
3. State is fitted into `maxStateTokens` (25k default) in stages,
   each only if the previous stage was not enough: truncate tool
   inputs (1000 → 200 → 60 chars); abridge long texts head+tail;
   collapse old non-pinned messages to a char-count note; reduce old
   tool calls to one line; drop old call-less messages; fold runs of
   old call-only messages. If it still does not fit, compaction
   **throws**. Token sizes are character estimates, not a tokenizer.
4. Each non-pinned call gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and
   should the **result** stay verbatim (contents still needed;
   re-running would not do).
5. Questions batch so state + questions stay under
   `maxRequestTokens` (30k default; under Jev’s 32k request limit).
   Same full state is resent per batch; batches run concurrently.
6. Against `keepThreshold` (default 0.5):
   - `keepResult ≥ threshold` → keep call and result
   - else `keepCall ≥ threshold` → keep the call, truncate the result
     to `truncateHeadChars` (default 300) plus a one-line note
   - else → remove the call and its result
7. Rebuild the message list. A message that loses all content is
   removed. No result is left without its call.

Jev failures, a missing key, malformed answers, or a history that
cannot be fitted throw. The Claude Code hook falls back to the
built-in summary. Room must **not** take that fallback as a product
default — a lossy summary is exactly what this steal refuses.

`noul` is TypeSafe / Reflex yes/no (the `#477` docs said `boolean`).
Same closed-set family as `choice` / `score`. Jev still has **no text
generation**. Do not replace Ask chat.

| Option | Default | Meaning |
| --- | --- | --- |
| `keepThreshold` | `0.5` | Minimum keep probability |
| `preserveRecentMessages` | `6` | Newest messages never touched (first is always kept) |
| `maxStateTokens` | `25000` | Estimated ceiling for the Jev state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state + one question batch |
| `truncateHeadChars` | `300` | Head of a dropped result kept before its note |
| `model` | `jev-latest` | TypeSafe model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `apiKey` | `TYPESAFE_API_KEY` | Operator key. Do not invent. Do not put in chat. |

The repo is both an npm library (`compactMessages` / `compact` +
`JevAsker`) and a Claude Code function-hook plugin
(`hooks/`, `.claude-plugin/`). Function hooks need Claude Code
2.1.274+ and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. **Do not fork that
plugin into Room.**

Limitations the README already admits: only tools are candidates;
calibration is request-level (a probability is not proof a result is
safe to delete); the assistant can always re-run the tool; a history
near the state ceiling costs one request per handful of questions.

### 2. Reflex — same question shape, on-device

Reflex is an open re-creation of TypeSafe System One / Jev on Qwen.
**State + typed questions → probability distributions in one pass.**
No free-form text. Same JSON shape as the Python server / TypeSafe
`/v1/systemone`, so a client written for Jev can point at a local
endpoint.

The browser demo runs **Qwen3.5-0.8B (~650 MB)** on WebGPU. Nothing
is uploaded. Load once, then ask `noul` / `choice` (≤26 options) /
`score` (2–10 ordered levels). An image can replace a
`{"type":"image"}` state slot. The 0.8B demo answers one question per
forward pass and does not share the state cache between questions —
fine for a handful of questions, not hundreds.

Calibration note (their README, not ours): raw 0.8B percentages are
**only roughly honest**. Nudge temperature above 1 to soften
over-confidence. The Python package can fit temperature from labelled
data; they report Qwen3.5-4B ECE **0.090 → 0.039** (Jev reports
0.031) and “within noise of TypeSafe’s Jev on MMLU with a 4B model.”
Do not treat the WebGPU demo as a calibrated ship gate.

Python default is Qwen3.5-4B on a local NVIDIA GPU; `reflex-serve`
speaks the same `/v1/systemone` shape. MIT. Not affiliated with
TypeSafe.

---

## Steal for Project Room

**Job:** receipt graph / tool-call history compaction **before**
context blowup. Second and Connect-harness agents (CUA / Codex /
Claude under Connect) accumulate long tool traces. A Done receipt
that dumps every `Read` / `Bash` / screenshot is honest and also
unreadable. Summarizing that ledger into an essay is the wrong fix.

| Take | Room mapping | Don’t |
| --- | --- | --- |
| Score tools, keep text verbatim | Compact the **tool-call ledger** on a Work Item / Second / Connect seat. User + assistant + receipt prose stay as written. | LLM-summarize the receipt graph |
| `noul` keepCall / keepResult | Store each decision as a citable receipt (below). Orphan compact = fail. | Silent delete with no receipt |
| Pin first + recent N | `preserveRecentMessages` 6 (tunable). First envelope / Mission always kept. | Compact the live turn mid-stream |
| Truncate, don’t rewrite | Dropped result → head (`truncateHeadChars`) + note. Call can stay when the fact of the call still matters. | Invent a “what the tools said” paragraph |
| Throw / inert on miss | No TypeSafe key, unfit state, or Jev error → **inert + reason**. Keep the full ledger. | Fall back to a lossy summary |
| Same-rung children | Long specialist traces (review / implement) compact **their** tools; spawn still cites parent ([#477](https://github.com/Uuriko/project-room/pull/477)). | Compact away `delegation.spawn` / `parentReceiptId` |

This is a **ledger** problem, not a Compute Start blob and not Ask
chrome. Room owns the receipt graph. Compute Ask may optionally reuse
the *shape* (next section) without writing Room receipts.

### `ledger.compact` (research shape)

Sibling of `delegation.spawn`. Cites the parent Done / session
receipt. Scorers append only. No people-data.

```json
{
  "kind": "ledger.compact",
  "version": 1,
  "parentReceiptId": "rcp_…",
  "seatId": "seat_…",
  "workItemId": "wi_…",
  "asker": "jev|reflex|inert",
  "keepThreshold": 0.5,
  "preserveRecentMessages": 6,
  "truncateHeadChars": 300,
  "fitStage": "inputs-200|texts-abridged|…|unfit",
  "decisions": [
    {
      "toolUseId": "toolu_…",
      "tool": "Read",
      "keepCall": 0.81,
      "keepResult": 0.12,
      "action": "keep|truncate|drop"
    }
  ],
  "stats": {
    "callsBefore": 0,
    "callsAfter": 0,
    "charsBefore": 0,
    "charsAfter": 0
  },
  "inertReason": null,
  "completedAt": "ISO-8601"
}
```

| Field | Rule |
| --- | --- |
| `parentReceiptId` | Session / Done receipt whose tool ledger was scored. Required. |
| `asker` | `jev` (TypeSafe / Gateway), `reflex` (on-device / local `/v1/systemone`), or `inert` (no key / throw). |
| `action` | Derived from keepCall / keepResult vs `keepThreshold`. Record the probabilities, not just the verb. |
| `inertReason` | Honest when compaction did not run. Do not invent a TypeSafe key to avoid this. |
| `decisions[].tool` | Tool name only. No file bodies, emails, or people-data. |

The compacted **view** is what a later seat is allowed to load into
context. The original tool receipts stay on the graph unless a human
deletes them. Compaction is a **projection + receipt**, not erasure.

---

## Steal for Dasha Compute Ask

**Job (optional):** collapse **stale tool receipts** in a long Ask
session so the next turn is not a 1M-token tool dump. Quiet. Not a
mid-stream essay. Not Artifacts-lite (that is long **fences** in the
bubble). Not T042 / T043 (regen / continue).

| Take | Ask mapping | Don’t |
| --- | --- | --- |
| Score-then-drop tools | After a long tool-using Ask, prune stale `tool_use` / `tool_result` before the next request. User + assistant text stay. | Summarize the thread into a hidden recap |
| Quiet | No “Compacting…” essay in `#ask-thread`. Optional hover / export after the fact. | Mid-stream toast, tok/s lecture, Typeform `Start.` |
| Export after prune | **P0:** export the transcript *after* a Jev-style prune (download / copy). Original stays until the user asks. | Silent rewrite of the live thread |
| Needle stays tools-edge | Needle is not the Ask chat model and not the compact asker. Compact the **tool receipts** Needle (or any tool) left behind. | List Needle next to Bonsai / Qwen; use Needle as Jev |

Compute Ask lives on getdasha. Room does not absorb it. Implement
later on `Uuriko/dasha-lobby` if Potter says go — **not** this repo,
not wrangler, not Worker HTML.

When no TypeSafe key exists, Ask compaction is **inert + reason**.
Do not invent keys. A Community Mac may use Reflex (next section)
instead of calling `api.typesafe.ai`.

---

## Steal for local Mac Community Provide

Prefer **documenting**, not inventing an API path.

| Path | When | Don’t |
| --- | --- | --- |
| **Reflex-like on-device** (`noul` / `choice` / `score`) | Community Provide Mac already runs local weights (Qwen-class). Same System One JSON as the Python server. Nothing uploaded without consent. WebGPU demo is a cousin, not a ship target. | Upload Ask / Room transcripts off-box to try the demo |
| **TypeSafe Jev** | **Only if** an operator TypeSafe / Vercel Gateway key **already** exists. Same inert+reason honesty as kit recommend / scorer. `TYPESAFE_API_KEY` / `api.typesafe.ai` — do not invent, do not paste in chat, do not commit. | Stand up Jev SaaS as a Room requirement |
| **Needle** | Still the tools-edge / extract specialist on tiny devices. Not the compact asker. Not Ask chat. | Collapse Needle + Jev + Reflex into one model pill |

This repo has **no** TypeSafe key and no System One client. The
`JevAsker` interface in `fast-jev-compaction` is the right seam
(`ask(state, questions)`): point it at Reflex `reflex-serve` on the
Mac, or at TypeSafe when a key is already present. Do not fork the
Claude plugin. Do not put Potter keys in the Worker.

Calibrate on labeled Room / Ask tool traces before treating
`probability` as a delete gate. The 0.8B WebGPU demo is a rough
cousin of Jev, not a replacement.

---

## Non-goals

- Do not fork the Claude Code plugin (`hooks/`, marketplace install,
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`) into Room or dasha-lobby.
- Do not upload transcripts off-box without consent (Reflex demo and
  TypeSafe both send *state*; Room / Ask default is local or
  inert+reason).
- Do not replace honesty receipts with lossy summaries — including
  Claude Code’s built-in compaction fallback.
- Do not rewrite Room Phase 0, Instinct
  [#8](https://github.com/Uuriko/project-room/pull/8) /
  [#9](https://github.com/Uuriko/project-room/pull/9), or
  [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).
- Do not collapse Compute Ask into Room receipts, or Room ledger
  compact into Compute Start.
- Do not touch parallel Ask Artifacts-lite / T042 / T043 / T060 docs.
- Do not list Needle as an Ask chat model.
- No people-data, Designer, `plugin.jup.ag`, Potter keys, Muse UI,
  Connect door HTML, People-rail, wrangler, or Worker HTML.
- Do not confuse TypeSafe Jev with Browser Use “Jev Ultrafast”.
- Do not replace Ask chat with Jev / Reflex (no text generation).

---

## P0 / P1 next builds

Docs-only this PR. Runtime later, after Muse / kit ACK and (for Ask)
dasha-lobby quiet-shell live. No collide with Artifacts-lite / T042.

### P0 — Room

1. **`ledger.compact` receipt** — keepCall / keepResult / action
   stored on the graph; cites `parentReceiptId`. Compact the tool-call
   ledger; leave user + assistant + receipt prose verbatim.
2. **Pin + threshold defaults** — first message + recent 6; threshold
   0.5; truncate-head 300. Inert+reason when no asker.
3. **View ≠ erase** — compacted projection for the next seat’s
   context; originals remain citable.

### P0 — Compute Ask (research; implement on dasha-lobby later)

4. **Export after prune** — download / copy the transcript once
   Jev-style tool prune has run. Quiet. Not mid-stream. Not a recap
   bubble.
5. **Optional stale-tool collapse** before the next Ask request on a
   long tool-using session. Same keepCall / keepResult rules. Does
   not rewrite fences (Artifacts-lite) or regen/continue (T042/T043).

### P1

6. **Community Mac asker** — Reflex-like `noul` / `choice` / `score`
   on-device (or `reflex-serve` as `/v1/systemone`). Wire TypeSafe
   Jev only when a key already exists.
7. **Calibrate** — score keep/drop against labeled Room receipts and
   Ask tool traces before using threshold as a ship gate.
8. **Connect / Second long traces** — apply the same compact view to
   CUA / Codex / Claude seats under Connect. Spawn receipts stay.

---

## Related

| Path | Role |
| --- | --- |
| [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md) | Sibling: Jev scorer/router + `delegation.spawn` ([#477](https://github.com/Uuriko/project-room/pull/477)) |
| [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md) | Jev recommend / scorer / pre-Ask; compaction pointer |
| [ROOM-SCORER.md](../docs/ROOM-SCORER.md) | Closed-set Jev rung (not this compact path) |
| [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md) | DAG; compact cites parent |
| [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) | Done receipt the ledger hangs on |
| [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md) | Compute ≠ Room |
| [ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md](ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md) | Needle = tools-edge, not Ask chat |
| [ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md) | Ask quiet chrome (do not mid-stream-essay compact) |
| [ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md) | Master plan index |

---

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Instinct Phase 0 #8 / #9
· Quill trees · Compute Start · people-data · Designer ·
`plugin.jup.ag` · Potter keys · wrangler · Worker HTML · Ask
Artifacts-lite / T042 / T043 / T060 files · Claude plugin fork ·
lossy summary fallback as the Room default.
