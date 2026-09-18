# T064 — PrismML Bonsai public ↔ vendor id map

18 September 2026. Short operator map. Docs only. Missing on main
(no prior box-receipt file). Not a picker rewrite and not a live
Provide lecture.

**T064** — one table: Dasha public id `ternary-bonsai-2-27b` ↔
PrismML Hugging Face packs (GGUF + MLX). Never invent Bonsai when
the network does not advertise it.

Companions:
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md)
(T060 + T065) ·
[ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md](ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md)
(T067) ·
[ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md](ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md)
(T068 + T069). Ask allowlist:
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md).

---

## 0. One line

Ask / network speak `ternary-bonsai-2-27b`; the Mac loads a PrismML
pack under that public id; `DASHA_MODEL_MAP` is `public=local`.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T060 / T065 | Cite. Soft 24GB; PQ2_0 ~7.21 GB weights. |
| T067 | Cite. OpenAI sidecar serves this public id. |
| T068 / T069 | Cite. Pause-on-battery / Prefer AC. |
| dasha-lobby [#248](https://github.com/Uuriko/dasha-lobby/pull/248) | Merged allowlist. Keep the public id. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** |

No `client/` · Worker · wrangler · Quill · Potter keys · vendoring
weights · listing Needle as chat.

---

## 2. Id map

| Public (Ask / `/compute/api/network` / `MODELS`) | Vendor repo | File / pack | On-disk | Community lane |
| --- | --- | --- | --- | --- |
| `ternary-bonsai-2-27b` | [prism-ml/Ternary-Bonsai-2-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) | `Ternary-Bonsai-2-27B-PQ2_0.gguf` | **7.21 GB** | **Quality.** Measured Provide pack (T060 ~13.3 tok/s). |
| `ternary-bonsai-2-27b` | same | `Ternary-Bonsai-2-27B-PTQ1_0.gguf` | 5.95 GB | Tighter RAM. Not our measured 13.3. |
| `ternary-bonsai-2-27b` | [prism-ml/Ternary-Bonsai-2-27B-mlx-2bit](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-mlx-2bit) | MLX 2-bit safetensors | 7.67 GB LM + 0.92 GB vision = **8.60 GB** | **Prefer MLX when you can.** |

`DASHA_MODEL_MAP` example (local tag is the sidecar / llama.cpp /
MLX name — not a second public id):

```
ternary-bonsai-2-27b=Ternary-Bonsai-2-27B-PQ2_0
```

Empty map still exits (kit). A kit-only Mac that never grew the
OpenAI helpers must **not** advertise `ternary-bonsai-2-27b` (T067).

---

## 3. Must not alias

| Do not map | Why |
| --- | --- |
| `gemma3-27b` → Bonsai | Different 27B. Demote is #258, not this table. |
| `needle-3` / Needle → Bonsai | Tools / extract. Not Ask chat. |
| `gpt-oss-20b` → Bonsai | Hosted floor. Unchanged. |
| Stock llama.cpp `Q2_0` | Fork required ([PrismML-Eng/llama.cpp](https://github.com/PrismML-Eng/llama.cpp)). Stock `Q2_0` is garbage, not a warn. |
| Stock MLX loader | mlx-2bit needs the bundled `runtime/` (`model_type: prism_hadamard_qwen35`). |
| Vendor TG128 (~18 / ~28 / ~47 tok/s) | **Not** Provide. Gauge is `measured_providers ≥ 1` on `/compute/api/network`. |

Never invent the public id when offline. Never advertise PQ2 and
`gemma3-27b` on the same ~24GB Mac (T060).

---

## 4. Acceptance / stay-outs

- [x] Public id `ternary-bonsai-2-27b` ↔ PQ2_0 / PTQ1_0 / MLX 2-bit
- [x] PQ2_0 named as the measured Community pack
- [x] No Needle / gemma / Hosted aliases
- [x] #258 cited, not edited / not undrafted
- [x] No wrangler, Quill, Worker, people-data, Designer, Potter keys

Quill · Muse UI · Instinct Phase 0 #8 / #9 · Designer-publish ·
people-data · `plugin.jup.ag` · direct wrangler · dasha-lobby #258
undraft · Mac Application Support paste · calling Second a Genie.

---

*End. Weights stay on Hugging Face. This repo keeps the id map only.*
