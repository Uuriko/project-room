# Cua Fleet spike — 17 September 2026

Research only. Maps Cua Fleet pool / claim / release / delete onto a Room
Work Item session. **Not a production button. Not Terraform.**

Upstream: [trycua/cua](https://github.com/trycua/cua) (MIT) ·
[Your first Cloud Fleet](https://cua.ai/docs/tutorials/your-first-cloud-fleet) ·
product contract [ROOM-CUA-DESKTOP.md](../docs/ROOM-CUA-DESKTOP.md).

This note is a lifecycle and receipt sketch. It is not proof that Room can
claim a sandbox, and it does not authorize spend.

## Why Fleet, not the operator's laptop

Driver on a real Mac is an opt-in local kit. Fleet is an isolated desktop
the agent can claim for one Work Item. That matches Room's multi-agent
safety better than sharing Potter's pointer. Compute stays a separate run
factory; Fleet is not a GPU marketplace and not Start.

## Lifecycle map

Cua's first Fleet tutorial: create a one-computer pool, **claim** the
Sandbox, do file / shell work through `computer-server`, **release** the
claim, **delete** the pool.

A pool with one replica **keeps cloud capacity available and can incur
usage charges until it is deleted**. Closing a terminal, catching an
exception, or requesting delete is not proof that chargeable capacity is
gone. Confirm the printed Fleet name is absent. If the process dies
mid-run, recover that named pool — do not create a second one.

| Fleet | Room Work Item session | Visible ledger |
| --- | --- | --- |
| Create pool (one replica) | Optional capacity for this item. Not a session start by itself. | No Done chip. Record the Fleet name if a later spike stores it. |
| Claim sandbox | Session **join** — `queued` → `processing` / `active` ([WORK-ITEM-SESSION.md](../docs/WORK-ITEM-SESSION.md)) | Member is on the item. No people-data. |
| Shell + screenshot + GUI on the guest | Acts on the claimed desktop. Fresh state → action → verify. | Progress Events. Last screenshot path + shell log stay local until a Receipt is written. |
| Release claim | Session **leave** — reservation ends; guest is no longer this item's computer | Stop / leave. Work state is unchanged unless someone records completion. |
| Delete pool | Capacity gone. Required so the replica stops billing. | Receipt may note the Fleet name and that delete was requested / confirmed. |

Completing work does not infer session `done`. An agent or steerer must
record the session event. Releasing a claim does not mark the Work Item
completed. Deleting the pool does not erase Room history.

Claim and release are the join / leave pair. Delete is the cost boundary,
not a Done chip.

## Done chip + Receipt

Steal the existing Room face: a compact **Done** chip on the People rail
when the agent posts a completion receipt — not chat spam, not a Handoff
board ([GETONE-ONE-STEALS.md](../docs/GETONE-ONE-STEALS.md)).

A Fleet Receipt on the Work Item should carry honesty fields, not a
slideshow:

| Field | Rule |
| --- | --- |
| Screenshot path | Path or URI of the last verified guest capture. Omit if none. Do not inline people-data. |
| Shell log | Path or short excerpt of the guest commands that produced the result. No secrets. |
| Fleet name | Exact pool / namespace the tutorial printed. Needed for cleanup. |
| Sandbox / claim id | If Fleet reports one. Unknown stays `UNKNOWN`. |
| Trajectory (later) | Optional Bench JSON beside the Receipt. Phase 4. |

Copy the Compute honesty habit: if it was not measured or confirmed, write
`UNKNOWN`. Do not invent tok/s, cents, or a green Done from a still-running
replica.

`emit_receipt` stays owner-gated unless explicitly granted
([MEMBER-CAPABILITIES.md](../docs/MEMBER-CAPABILITIES.md)).

## Credentials

Fleet examples use:

```bash
export CUA_CLIENT_ID="<your-client-id>"
export CUA_CLIENT_SECRET="<your-client-secret>"
```

`cua auth login` does **not** supply these Fleet SDK credentials. They
belong in **Room secrets later** — the same private, non-chat store as
other provider tokens. Never paste them into a prompt, URL, shell
argument, transcript, or repository.

A Room agent key is not a Fleet credential. Do not wrap `CUA_CLIENT_SECRET`
as a model-visible tool argument. Rotation follows the existing
[secrets pattern](../docs/SECRETS-ROTATION.md): generate, distribute,
cutover, revoke. This spike does not add a secret type to the live Worker.

## Cost warning

One replica in a live pool bills until that pool is deleted. A spike that
creates a Fleet must print the name, keep it until cleanup is confirmed,
and refuse to “just run it again” after a crash. Room must not hide this
as a free desktop.

Do not put Fleet spend on Potter's Compute wallet. Do not treat an
unsettled or unconfirmed delete as settled $0.

## Out of scope for this spike

- Shipping Terraform, reusable pool modules, or expire-policy as Room
  source.
- A production “Claim Fleet” button on the Work Item.
- Changing `/room/kits` live bytes.
- Client, Worker, server, or deploy edits.
- Instinct Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
  [#9](https://github.com/Uuriko/project-room/pull/9).
- Quill / inbox / WhatsApp PRs (including #452).

A later Phase 2 implementer can follow the official tutorial against a
disposable Fleet, map one claim onto one Work Item session, write one
Receipt (screenshot path + shell log), release, delete, and confirm the
name is gone. That work needs Muse / owner ACK of the
[desktop kit contract](../docs/ROOM-CUA-DESKTOP.md) and credentials in
Room secrets — not this research note.
