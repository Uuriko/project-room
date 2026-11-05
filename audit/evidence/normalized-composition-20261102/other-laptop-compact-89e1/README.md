# Independent compact Native scale qualification

Root handoff25962, accepted25963. Exact runtime89e1a58827483f7019085a39205eba62abcd15ba.
Command from cloudflare/: node --test normalization-compact-scale.check.mjs
Node24.22.1, Miniflare4.20260730.0, esbuild0.28.2, workerd2026-07-30.
An existing local macOS ARM July binary matching the default dependency was
selected through MINIFLARE_WORKERD_PATH. No October binary or runtime settings.
Existing240s timeout unchanged. Clean tracked source; no runtime/fixture edits.

Terminal exit0,1pass0fail. Wall5.0503s, reaped childCPU6.0999s. Full unchanged
36158-byte log and environment receipt retained. LogSHA256:
d1b47b7580adc852790c74f73102a74fa303e859e7d0b8a4a82a6395d8d692be.

Synthetic50kevents/5000messages: projection1111281B to131B. The matched warm
1k/50k posts both114statements/1193rowsread/40rowswritten. Host times3.3623ms
and3.5495ms are single local samples. Materialized bytes64243 vs63945.
Cold activation duplicate, cold post, cold exact post retry and addressed read
all pass. Retry preserves original sequence and writes2native permit rows.
Final50002events/5002messages,131B carrier. All14samples have known cursor counters.

summary.json derives actual counters and timings from full.log. No Runtime
workload repeated to create that summary. Source fixture and test are committed
at the runtime SHA. The fixture owner retains implementation; Root owns release.

Limits: no7MBrow or production action; no full-release/latency/CPU guarantee.
SQL cursor counts/materialized bytes are not total storage bytes written, and
KV get/put activity is outside this SQL cursor wrapper. Read is a50k sample,
not a matched1k/50kread comparison. The /state count scan is a diagnostic, not
ordinary serving cost. Scale fixture exercises its owner credential and reports
adoption preservation, but does not independently snapshot all accounts/OAuth
connections. Preserve that distinction from separate authentication tests.
