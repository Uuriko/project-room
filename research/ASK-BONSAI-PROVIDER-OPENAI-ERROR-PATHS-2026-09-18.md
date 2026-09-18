# T067 — Bonsai Mac provider OpenAI error paths

18 September 2026. Operator note. Docs only. Not a live Provide
lecture, not a dasha-lobby picker rewrite, and not a paste of the
installed Mac `agent.py`.

**T067** — the live Mac Community provider now has an OpenAI-compatible
local backend lane (`openai_payload` / `run_openai` / `stream_openai`)
for `ternary-bonsai-2-27b`. Thinking is **off by default**. This note
names the five error paths that lane must fail **loudly** and **without
secrets**: bad backend URL, model not ready, timeout, `enable_thinking`
opt-in, and the obsolete public-kit Stop.

Companion RAM / ladder note (do not restyle here):
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md)
(T060 + T065). Fold lock: [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).
Ask Continue-after-Stop (T043, different noun):
[ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md](../docs/ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

On the live Mac provider, Bonsai jobs go through a loopback
OpenAI-shaped backend; thinking stays off unless opted in; a bad URL,
an unloaded model, a hung generate, or a kit-era Stop must surface as
a typed failure — never a silent Ollama fallback and never a leaked
provider token.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T060 / T065 Bonsai RAM + gemma ladder | **Cite only.** Soft 24GB, thinking off, prefer 8B/12B interactive. |
| T042 / T043 Ask regen + Continue | **Not** this path. Those are Ask chrome after Stop. |
| T044–T046 export / receipt / tok/s | **Not** this path. |
| T032 / T033 ⌘K model menu | Cite only. Do not restyle `#ask-model`. |
| dasha-lobby [#143](https://github.com/Uuriko/dasha-lobby/pull/143) | Gateway `error` + `hint`/`next` for **clients**. This note is the **provider** side. |
| dasha-desk public kit `compute/provider/agent.py` | Contrast only. Kit is Ollama-only (v0.3). Do not “fix” the kit from here. |
| Mac Application Support `agent.py` | **Cite, do not paste, do not edit.** Secrets live next to that file. |

Paths this fold owns:

- `research/ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md` (this file)
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · vendoring the installed Mac agent.

No pytest in this repo: there is **no safe vendored copy** of the live
Mac `agent.py` here. Box-side stubs belong next to a redacted fixture
on the Mac or in dasha-desk later — not a secret-bearing paste.

---

## 2. Two `agent.py` copies (do not confuse them)

| Copy | Where | What it actually runs |
| --- | --- | --- |
| **Public kit (v0.3)** | [dasha-desk `compute/provider/agent.py`](https://github.com/Uuriko/dasha-desk/blob/main/compute/provider/agent.py) (`0ea8c130`, inspected 2026-09-18) | Ollama only. `run_ollama` / `stream_ollama`. Default `OLLAMA_URL=http://127.0.0.1:11434`. No `openai_payload`. |
| **Live Mac Provide** | `~/Library/Application Support/Dasha Compute/agent.py` (Potter Mac; **not opened here**) | Adds `openai_payload` / `run_openai` / `stream_openai` for `ternary-bonsai-2-27b`. Loopback OpenAI-compat (llama.cpp / MLX sidecar), **not** `api.openai.com`. |

This note never pastes the Application Support file. That tree sits
next to Keychain-backed provider tokens (`DASHA_PROVIDER_KEY` /
launchd). Cite **behaviors and function names** only.

Public kit doctor / poll still prove the Ollama Mid/Speed lane
(`qwen3-8b`, `gemma3-12b`). Bonsai Quality is the **new** backend.
A kit-only Mac that never grew the OpenAI helpers must not advertise
`ternary-bonsai-2-27b`.

---

## 3. What the kit already does (verified)

Read from dasha-desk `compute/provider/agent.py` + `compute/README.md`
+ `compute/THREAT_MODEL.md` (v0.3). No secrets in those files.

| Behavior | Kit fact |
| --- | --- |
| Model map | `DASHA_MODEL_MAP` (`public=local`). Empty map exits. |
| Doctor | Nonzero if coordinator, Ollama, or any mapped local tag is missing. Prints `ollama pull …` for gaps. |
| Complete job | `run_ollama` → `POST {OLLAMA_URL}/api/chat` `stream: false`, timeout **600s**. |
| Stream job | `stream_ollama` → same URL `stream: true`; `report_chunk` per delta. |
| Inference failure | Logs `failed {job_id}: {error}`; reports `provider inference failed: {type(error).__name__}` (type name only — good). |
| Live cancel | Heartbeat `POST /providers/jobs/{id}/heartbeat` may return `{cancelled: true}`. |
| **Stop (obsolete for Bonsai)** | Stream checks `cancelled` **between** SSE lines; it does not abort the Ollama `urlopen`. Non-stream runs `run_ollama` **to completion**, then checks cancel. Kit README already lists “hard Ollama request aborts” as a later local-coordinator item. |

[DARKBLOOM-COMPUTE-ROOM-2026-09-07.md](../docs/DARKBLOOM-COMPUTE-ROOM-2026-09-07.md)
already recorded the same kit limit: cancellation may suppress a
non-stream result **only after inference finishes**. That is the
**kit obsolete Stop** T067 names. The OpenAI lane must do better.

---

## 4. Live Mac OpenAI lane (cited, not pasted)

T067 brief + T060 speed profile. Function names are the contract:

| Helper | Job |
| --- | --- |
| `openai_payload(job)` | Build `POST /v1/chat/completions` JSON: model id, messages, temperature / max_tokens, `stream`, and **`enable_thinking` default false**. |
| `run_openai(job)` | Complete (non-stream) generate against the loopback OpenAI base. |
| `stream_openai(job, cancelled)` | SSE / chunked generate; honor `cancelled` by **closing the HTTP request**, not by waiting for `[DONE]`. |

Backend is a **local** OpenAI-compatible server (llama.cpp-style
`/v1/chat/completions` or the Mac sidecar). It is not Hosted
`gpt-oss-20b` and not a Potter OpenAI cloud key.

T060 already fixed the generate posture for ~24GB Community Provide:

- **8k ctx**
- **mmproj on CPU**
- **thinking off**
- **`-np 1`**
- measured **~13.3 tok/s** (13.52 on `/compute/api/network` 2026-09-17)

Thinking on is extra decode + KV. On a ~24GB Mac that is the swap
path T060 named. T067’s job is to keep that default **in the payload**,
not only in operator prose.

---

## 5. Error paths (T067)

Fail **typed**. Do not invent Bonsai. Do not fall back to Ollama under
the Bonsai public id. Do not put `Authorization`, Keychain material,
or the raw provider token in `error` / logs.

Gateway clients already get OpenAI `{error:{message,type,code}}` plus
`hint`/`next` ([dasha-lobby #143](https://github.com/Uuriko/dasha-lobby/pull/143)).
Provider reports stay short: `provider inference failed: {Type}` plus
a **reason token** the Worker can map. No lecture on Ask.

### 5.1 Bad OpenAI backend URL

| | |
| --- | --- |
| **Trigger** | Loopback base missing, refused, wrong scheme, or missing `/v1` (e.g. `http://127.0.0.1:9/`, `https://` to a plain server, path `/chat/completions` without `v1`). |
| **Kit today** | No OpenAI URL. Doctor only probes `OLLAMA_URL`. A bad Ollama URL is `ollama failed · {error}`. |
| **Mac must** | Doctor grows an **openai / bonsai** row. Connection errors (`URLError`, `ConnectionRefusedError`, HTTP 404 on the health/models probe) fail doctor **and** refuse to list `ternary-bonsai-2-27b` on poll. A leased Bonsai job reports a typed failure (`URLError` / `HTTPError`) — **not** `run_ollama` under the same public id. |
| **Must not** | Rewrite the public model to `qwen3-8b`. Hit `api.openai.com`. Print the bearer. |

### 5.2 Model not ready

| | |
| --- | --- |
| **Trigger** | Sidecar up, weights not loaded / still mmaping / unknown id. Compat servers usually answer **404** (unknown model) or **503** (loading). |
| **Kit today** | `installed_models()` reads Ollama `/api/tags`. Unready mapped tags fail doctor (`models failed · missing: …`) and are omitted from `available` on poll. |
| **Mac must** | Same honesty for Bonsai: probe the OpenAI `/v1/models` (or the sidecar ready flag) **before** advertising `ternary-bonsai-2-27b`. A 404/503 mid-job is `model_not_ready`, not a hang. |
| **Must not** | Invent Bonsai on live `/compute/api/network` when the sidecar is cold (T060 / T033: never invent when offline). |

### 5.3 Timeout

| | |
| --- | --- |
| **Trigger** | Connect stall, or generate longer than the lease / urllib timeout. |
| **Kit today** | Coordinator poll timeout **35s**; heartbeat **10s**; Ollama generate **600s**; default `request_json` **90s**. Heartbeat thread renews the live lease. |
| **Mac must** | Split **connect** (short, doctor-class) from **generate** (lease-bounded, on the order of kit 600s — not unbounded). `TimeoutError` / `socket.timeout` → typed report; stop the heartbeat; do not retry the same job as a new lease from the provider. |
| **Must not** | Swallow timeout and return empty `content` as `finish_reason=stop`. That would look like a successful short answer. |

### 5.4 `enable_thinking` opt-in (default off)

| | |
| --- | --- |
| **Trigger** | Bonsai / Qwen-family templates honor `enable_thinking` / `chat_template_kwargs`. On = reasoning tokens + KV. |
| **T060** | Speed profile is **thinking off**. On is the 24GB swap path next to long ctx / mmproj GPU / `-np`>1 / a second 27B. |
| **`openai_payload` must** | Default **`enable_thinking: false`** (or omit so the sidecar default is off — prefer an explicit false so a server default cannot flip it). Set true **only** when the leased job / request opts in. |
| **Must not** | A live Ask chrome “Think” toggle in this fold. A hidden always-on. Shipping thinking-on as the Community Quality default. |

Opt-in is a **job field** (or coordinator-passed extra), not Potter
turning a plist by hand. Until Ask grows an explicit control, Quality
Bonsai stays thinking-off.

### 5.5 Kit obsolete Stop

| | |
| --- | --- |
| **Kit** | Stream: read next Ollama line, *then* notice cancel. Complete: finish `run_ollama` (up to 600s), *then* heartbeat-check cancel and skip `report`. |
| **Live queue** | Heartbeat cancel **clears the queued prompt immediately** (kit README). The provider process can still be generating. |
| **Mac OpenAI must** | `stream_openai` / `run_openai` watch the same `cancelled` event the kit heartbeat sets, and **close the backend HTTP request** so llama.cpp/MLX abort. Report cancel, not a late `stop` completion. |
| **Not T043** | Ask **Continue** after the user hits Stop is thread chrome (`#ask-send`). This path is provider-side abort so the Mac stops burning the 24GB working set. |

Until the OpenAI helpers abort the socket, treat kit Stop as
**obsolete for Bonsai**. Mid/Speed Ollama jobs may keep kit behavior;
do not document that as the Quality contract.

---

## 6. Report shape (no secrets)

Keep the kit’s type-name report. Add a stable reason the Worker can
map to #143 `hint`/`next` later (implement on dasha-lobby, not here):

| Reason | Typical exception / HTTP | Operator next (short) |
| --- | --- | --- |
| `backend_url` | `URLError`, `ConnectionRefusedError`, HTTP 404 on the base | Fix loopback OpenAI URL; rerun doctor |
| `model_not_ready` | HTTP 404 / 503 from `/v1/models` or chat | Load Bonsai; do not advertise until ready |
| `timeout` | `TimeoutError`, `socket.timeout` | Check sidecar; prefer 8B/12B if 24GB is swapping (T060) |
| `thinking_rejected` | Payload sent `enable_thinking` true without opt-in | Leave default off |
| `cancelled` | Heartbeat `{cancelled: true}` or closed stream | Stop; do not report a successful `stop` finish |

Log `failed {job_id}: {error}` like the kit. Truncate body text
(kit already slices HTTP detail to 300 chars). Never echo
`Authorization`, Keychain dump, or the one-time Provide token file.

---

## 7. Doctor / poll honesty

Extend the kit doctor mentally (do **not** ship a Mac patch from this
repo):

```
Dasha Compute provider doctor
hardware  Darwin arm64 · …
gateway   ok · … · https://lobby.getdasha.com/compute/api
ollama    ok · ready: qwen3-8b→qwen3:8b, …
openai    ok · ternary-bonsai-2-27b · thinking off
```

or `openai    failed · backend_url|model_not_ready|timeout`.

Poll `models` lists Bonsai **only** when that row is ok. Mid/Speed
Ollama tags stay independent: a cold Bonsai sidecar must not take
`qwen3-8b` offline.

---

## 8. Acceptance checks

- [x] Names the five T067 paths: bad URL, model not ready, timeout,
      `enable_thinking` opt-in, kit obsolete Stop
- [x] Cites public-kit `run_ollama` / `stream_ollama` / heartbeat
      cancel without pasting Application Support or keys
- [x] Cites live helpers `openai_payload` / `run_openai` /
      `stream_openai`; thinking **off** by default
- [x] Links T060 RAM / thinking-off / 8B-12B interactive note
- [x] Distinguishes provider abort from Ask T043 Continue
- [x] No silent Ollama fallback under the Bonsai id
- [x] No wrangler, Worker, people-data, Designer, `plugin.jup.ag`,
      Quill, or Potter keys
- [x] No vendored Mac `agent.py` / no invented pytest against secrets

---

## 9. Stay-outs

Quill login · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · direct wrangler ·
dasha-lobby edits · dasha-desk kit rewrite · Mac Application Support
edit · Ask regen / Continue implement (T042 / T043) · Artifacts-lite
· `#ask-model` cmdk implement · listing Needle as chat · calling
Second a Genie · `client/` `cloudflare/` `server/` `src/` `deploy/`
in this fold.

---

*End. Companion RAM note:
`research/ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md`.
Companion T068/T069 pause-on-battery + Prefer AC:
`research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md`.
Companion T064 PrismML id map:
`research/ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md`.
Public kit contrast: dasha-desk `compute/provider/agent.py` (Ollama
v0.3). Live OpenAI helpers stay on the Mac; this repo keeps the
error-path contract only.*
