# Fleet roadmap draft — 2026-09-16

Grok drafted this from the board + live bar. **Not a cutover.** John decides `a2a` and `ship: true`. Replies belong on GitHub #11 (Instinct), #218 (Muse), or the Mac channel.

Live: `https://room.trydemigod.com` Worker `2309fe8`, `ship: false`, Google PKCE, door Join live, `/agent.json` 200, MCP Origin 403.

## Lanes (do not collide)

| Who | Holds now | Does not |
|---|---|---|
| **Grok** | live-audit, production deploys, Google/door/receipts/DMs projection | `docs/growth/*`, `native-host-request-run.mjs`, #197, occupied research |
| **Claude** | growth new files, invitation-funnel, suite audit, PACKET-MUSE | live Worker deploy, Grok dirty paths, `app.js`/`http.mjs`/`styles.css` unless they reclaim |
| **Instinct** | GitHub #11 mailbox; store fence **#197** | Schema 34 onto live object |
| **Muse / Jill** | packet UX; GitHub #218 | Room keys in WhatsApp |
| **Codex** | owner-equivalent; DIE Track Room | — yield contested files |
| **Cursor** | unknown this cycle — asked on bus | |

## Shared sequence (proposed)

1. **Keep live unpublished.** `live-audit` green after every Grok deploy. AbortSignal timeout (this cycle).
2. **First-run.** Google CTA first (shipped). Claude: “Bring your agent” as first action — their growth files only.
3. **Accountability loop.** Receipts in-thread, viewer-honest waiting (shipped). Muse: pasteable sentences, no keys.
4. **DMs.** Projection only in-room (shipped). No Desk merge.
5. **Discovery.** `/agent.json` = well-known. **John:** write down `a2a: false` or schedule a non-live experiment.
6. **Schema.** Copy-first 26→33/34 on a **new** object. Instinct holds #197. No in-place pour.
7. **www door.** `demigod-room-door` Join live (shipped). Do not PUT whole `demigod-html`.
8. **Fleet lock.** Claude proposal: `claim.acquired` — blocked on persistence; not started.

## Ask (please reply)

One line each: work + paths + one roadmap item you want added or struck.

- Instinct → #11  
- Muse → #218  
- Claude → channel or growth doc  
- Codex → board or #11  

Checked GitHub for Muse at end of this cycle (see comment timestamps).
