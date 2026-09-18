# T068 + T069 — Pause-on-battery Provide + Prefer AC copy

18 September 2026. Short research note. Docs only. Not a live Provide
lecture and not a dasha-lobby / kit rewrite.

**T068** — Community Provide **pause-on-battery** behavior (soft).
**T069** — **Prefer AC** whisper copy. One clause. No lecture.

Companions (cite only):
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md)
(T060 + T065) ·
[ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md](ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md)
(T067) ·
[ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md](ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md)
(T064) ·
[ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md](ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md)
(T083 runtime copy; no blocking Ask). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

On battery (or Low Power), a Community Mac **pauses advertise** and
does not take a new lease — especially Quality Bonsai — then resumes
on AC; live Setup copy adds **Prefer AC.** next to Prefer MLX, nothing
longer.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T060 / T065 Bonsai RAM + gemma ladder | **Cite only.** Soft 24GB, thinking off, prefer 8B/12B. |
| T067 OpenAI error paths | **Cite only.** Abort the Bonsai socket on cancel; no silent Ollama fallback. |
| T064 PrismML id map | **Cite only.** Public `ternary-bonsai-2-27b` ↔ vendor packs. |
| T042 / T043 Ask regen + Continue | **Not** this path. |
| T044–T046 export / receipt / tok/s | **Not** this path. |
| T032 / T033 ⌘K model menu | Cite only. Do not restyle `#ask-model`. |
| T083 runtime copy | **Sibling.** Quiet `On battery · paused`. No lecture. No blocking Ask. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** |

Paths this fold owns:

- `research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md` (this file)
- `tests/provide-battery-soft-docs.test.js`
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · Mac Application Support edit · dasha-desk kit rewrite.

---

## 2. What live Provide already says (2026-09-18)

Fresh `/compute` Setup whisper (not rewritten here):

> Prefer MLX when you can · Ollama ≥0.33.1 · models on internal SSD.

> Doctor soft-warns · battery / Low Power / thermal / SIP · never
> fails solely · not attestation.

> Offline: drop from advertise. No penalty. Earn only for served jobs.

Kit doctor (dasha-desk v0.3) **warns** on those signals. It does **not**
pause poll. T068 names the missing behavior. T069 names the one extra
clause.

---

## 3. T068 — Pause-on-battery (behavior)

Same **soft** class as T060 RAM and the live doctor warn. Not a
hard-fail. Not attestation. Not a Register → Setup block.

| Signal | Provide does | Provide does not |
| --- | --- | --- |
| On battery | Pause **advertise**. Omit models from poll `available`. Take **no new lease**. | Fail doctor. Unregister. Lecture Ask. |
| Low Power Mode | Same as battery. Thermal throttle is the cousin. | Fail solely on the warn. |
| In-flight lease | Finish **or** cancel cleanly. Bonsai OpenAI lane **closes the HTTP request** (T067). | Start a new Quality Bonsai job. Swallow cancel as `stop`. |
| Back on AC | Resume advertise. No re-Register. | Demand a new token. |
| Desktop / always-AC | No-op. `IOPowerSources` / AC present. | Fake a battery pause. |
| SIP / thermal warn only | Keep current soft-warn. Pause only if the box is also on battery / Low Power. | Treat SIP as pause-on-battery. |

Quality (`ternary-bonsai-2-27b`) is the expensive pause: 24GB working
set + thinking-off speed profile (T060) + OpenAI sidecar (T067).
Mid / Speed Ollama (`qwen3-8b`, `gemma3-12b`, `qwen3-4b`) pause
**advertise** the same way so the Mac is not earning while the lid is
unplugged. Do not keep Mid warm “because it is smaller.”

Earn copy already says earn only for served jobs. A paused Mac is
**offline for advertise**, same as a closed lid. No penalty.

Implement later on the Mac / kit (not this repo). Public kit contrast
only: dasha-desk `compute/provider/agent.py` is Ollama-only and has
no battery pause today.

---

## 4. T069 — Prefer AC copy (no lecture)

One clause on the **existing** Setup whisper row. Same voice as
Prefer MLX.

**Ship later (dasha-lobby, not here):**

> Prefer MLX when you can · **Prefer AC.** · Ollama ≥0.33.1 · models
> on internal SSD.

That is the whole copy. **Prefer AC.** — period inside the row, not a
new sentence, not a tooltip essay.

| Surface | Prefer AC? |
| --- | --- |
| Provide Setup whisper (next to Prefer MLX) | **Yes.** One clause. |
| Doctor soft-warn line (battery / Low Power / …) | Unchanged. Already names battery. |
| “Is hosting safe?” FAQ | **No.** Do not rewrite. |
| Ask empty canvas / mid-stream / `#ask-model` | **No.** |
| Honesty / tok/s / earn receipt | **No.** |

Do not add a third accent, a permanent chip, a “battery lecture”
block, or a Hosted-vs-Community sermon. T046 already bans mid-stream
kit lectures; this is the same diet on Provide. Runtime paused
line (`On battery · paused`) and the no-block-Ask rule are **T083**,
not a second Prefer AC sentence.

---

## 5. Acceptance checks

- [x] T068 is **soft** pause-on-battery: drop advertise, no new lease,
      resume on AC; not a doctor hard-fail
- [x] In-flight cancel cites T067 abort (no empty successful `stop`)
- [x] Quality Bonsai is not started on battery; Mid/Speed also pause
      advertise
- [x] T069 is one **Prefer AC.** clause next to Prefer MLX; no lecture
- [x] Links T060 (RAM / thinking off) and T067 (OpenAI error paths)
- [x] #258 cited, not edited / not undrafted
- [x] No wrangler, Quill, Worker, people-data, Designer, Potter keys

---

## 6. Stay-outs

Quill login · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · direct wrangler ·
dasha-lobby HTML / Worker · dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258)
undraft · dasha-desk kit rewrite · Mac Application Support edit ·
Ask regen / Continue (T042 / T043) · Artifacts-lite · `#ask-model`
cmdk implement · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Companion RAM: `research/ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md`.
Companion T067: `research/ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md`.
Companion T064 id map: `research/ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md`.
Companion T083 runtime copy: `research/ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md`.*
