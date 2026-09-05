# Event fixtures (public-safe)

Drafts only. Authoritative handoff is the #167 [Grok Bot] comment that posts these.

Every Event below shows: **actor**, **Policy decision** (allow/deny + rule), **causal parent**, **exact evidence reference**.

## Normative transition table (v0) — authorization + recovery

| From | To | Who may transition | Required evidence |
|------|-----|--------------------|-------------------|
| (new) | proposed | human (steer) | outcome statement + owner gates enumerated |
| proposed | accepted | accountable agent | ledger check for existing/superseding work; ownership accepted |
| accepted | working | claim holder | claim Event (resource/scope, holder, acquisition, lease/expiry) |
| working | blocked | claim holder | blocker reason + remaining action |
| blocked | working | claim holder | unblock Event (blocker cleared + causal parent) |
| working | completed | **accountable agent or Policy-authorized reducer only** (not “any satisfying executor”) | receipt Event: executor evidence (may be relayed) + exact immutable ref + checks *claimed* + required/designated verifier + remaining gate. Execution evidence ≠ transition authority. |
| completed | independently_verified | designated verifier | independent fetch of exact immutable ref + **PASS** only. Verifier identity, check, and result live on this Event — not on the completion receipt. |
| completed / independently_verified | working \| blocked | designated verifier or Policy | verification **FAIL** Event: findings + causal link to receipt |
| independently_verified | owner_decided | owner human | one owner-decision Event: `approved` \| `changes_requested` \| `rejected`. `changes_requested` / `rejected` returns Work Item to `working` \| `blocked` with reason. |
| *outcome* → | superseded | Policy-capable actor | `superseded_by` + reason/evidence (outcome replaced/moot only) |
| claim `expired` / `released` / `superseded` → | acquired (new holder) | new holder under Policy | new claim Event citing prior claim as causal parent + Policy allow |
| *claim attempt* → | claim_released / claim_superseded / claim_expired | holder or Policy | release, lease expiry, or superseded_by pointing at winning attempt |

Guards: completion ≠ verification; replay rebuilds ledger + causality only; durable ownership ≠ write claim.

## (a) #134 already-done-work path

1. **proposed** — actor=owner human; Policy=steer allow; parent=null; evidence=Prefer-MLX kit / PR terms statement + gates (merge).
2. **accepted** — actor=Codex (accountable); Policy=accept after ledger audit; parent=proposed; evidence=work already at `70053cc6cf9d86f3a43220dcfbb0af05797380c0` (no redundant rewrite).
3. **completed** — actor=Codex (accountable reducer); Policy=complete allow (accountable); parent=accepted; evidence=receipt citing PR #134 + SHA `70053cc6cf9d86f3a43220dcfbb0af05797380c0` + checks *claimed* + designated verifier=Instinct + remaining gate=owner merge. (Executor may equal accountable agent here.)
4. **independently_verified** — actor=Instinct; Policy=verify allow; parent=completed receipt; evidence=independent fetch of exact SHA + 28/28 PASS + invariant diff.
5. **owner_decided: approved** — actor=owner; Policy=owner decision; parent=independently_verified; evidence=explicit merge approval — **PENDING**.

## (b) Faucet competing-executor path

1. **proposed → accepted** — actor=Codex; Policy=accept; parent=proposed; evidence=faucet no-JS H1 outcome + gates.
2. **working** — actor=Codex; Policy=claim acquire allow; parent=accepted; evidence=claim Event (scope=faucet worker paths, holder=Codex, lease/expiry).
3. **external execution Event** — actor=Grok Bot (executor); Policy=emit evidence allow (not complete); parent=working/claim; evidence=source-linked live Worker deploy ref (verifier-resolvable). Does **not** move Work Item state.
4. **completed** — actor=Codex (accountable) **or** Policy-authorized reducer; Policy=complete allow citing external evidence; parent=external execution Event; evidence=receipt: Grok deploy ref + checks claimed + designated verifier + remaining gate. Codex claim attempt → `claim_superseded` (abandoned attempt), **not** outcome superseded.
5. **independently_verified** — actor=designated verifier; Policy=verify; parent=completed; evidence=independent live faucet H1 fetch → PASS.
6. **owner_decided** — n/a / already live; owner glance shows no merge pending for this outcome.

## Negative-path sketches (for Instinct to pressure-test)

### Verification FAIL
After step (a)3 or (b)4: verifier Event FAIL (findings + causal link) → Work Item `working` or `blocked`; completion receipt remains in history; no `independently_verified`.

### Expired claim → re-acquire
After (b)2: lease expires → claim `expired`; new holder acquires under Policy with causal parent=expired claim; prior holder cannot mutate ledger without new Policy allow.
