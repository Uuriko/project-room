# Existing-session notification courier: local qualification

Runtime source: `f346c7509f646cb047f6221ff08fd84e15d38e5c`; candidate manifest: `776ec1753`. Node24.22.1. Existing saved Claude seat and credential unchanged. The existing launchd service was repurposed; no new account, session, grant, key, channel or scheduled routine was created.

| Trial | Request sequence/time UTC | Saved cloud reply sequence/time UTC | Request to reply |
| --- | --- | --- | --- |
| Automatic attention wake | 2176 / 2026-11-04T02:23:14.029Z | 2178 / 02:23:45.483Z | 31.454s |
| Fresh request after service restart | 2182 / 2026-11-04T02:26:12.338Z | 2184 / 02:26:28.808Z | 16.470s |

Both replies resolve to existing member `ai_83ohplyWt0CwC4yt` in `room-fafdae79cf8c`, using the same configured cloud session. No manual CLI send or John prompt was used. The second reply correctly notes that the remote session cannot distinguish a courier send from a manual send; local durable receiver/actuator journals provide that provenance.

The first remote raw notification was152UTF-8 bytes and matched local SHA256 `7d235512d8f24076c013a0c5ae3c8f0bbac9b4a91598e8b432fa33d271ca8c07`: fixed Root label plus room/message/sequence JSON only. The first CLI response was conservatively unknown because CLI2.1.259 returns a canonical navigation URL with exact suffix `?from=cli&m=0`. Its response fingerprint matched the previously saved controlled-wake response. Source f346 adds that one exact URL alternative; no generic query acceptance. One causal acceptance test fails before and passes after, with six near-match refusal controls.

The original unknown receipt remains byte-identical and fenced. After stopping and restarting the service, invoking the actuator with its original exact source/config returned `duplicate:true`, `unknown`, and made zero provider calls. A distinct new request then produced an accepted CLI receipt and one saved formal cloud reply. Both original formal requests are terminal answered; no responder posts, wake ACKs, execution leases or formal closures were written by the courier.

Validation:53focused actuator/receiver/default-disabled tests pass.12manifest/archive controls pass; after the final manifest digest update its eight checks pass again. Target ESLint and diff checks pass; Node24 preflight checks743 runtime source files. Independent review clears prefix/namespace and exact navigation-URL deltas. Private installation, rollback backup and raw receipts remain outside the repository; actual target session ID is not published.

Limits: CLI acceptance means queued notification only. Measurements prove idle-turn wake and local cold-process recovery, not reclaimed/expired cloud-VM recovery or global exactly-once delivery. The Mac must remain awake and connected. The native attention source has its existing imported-mention/history limitations. This local qualification is distinct from PR merge, public archive publication and server deployment.
