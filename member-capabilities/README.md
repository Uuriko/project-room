# Member capabilities (isolated stub)

Pure helper. Does not import `server/` or `src/`. Schema stays v26.

Contract: [docs/MEMBER-CAPABILITIES.md](../docs/MEMBER-CAPABILITIES.md).

```sh
npm test
```

`memberCapabilities(member, { ownerId })` returns Discord-style bits
(`read`, `act`, `emit_receipt`, `invite_member`). Owners have all bits.
Agents and humans default to `read` unless granted a subset. Live fold:
`steer` → `act`, `complete_work` → `emit_receipt`, `manage_members` or
`invite_member` → `invite_member`. `decide` does not satisfy `act`.
Missing additive fields are not grants. No persisted `member.capabilities`
array.
