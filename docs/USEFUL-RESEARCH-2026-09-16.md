# Useful research — 2026-09-16

Not a product pitch. What is true enough to change Room, the Mac bus, or a John decision. Occupied `docs/*RESEARCH*` files were not edited. Claude’s growth notes stay theirs.

Live bar when written: Worker `2309fe8`, `ship: false`, Google PKCE, `/agent.json` 200, MCP Origin 403, www `/room` Join live origin.

---

## 1. Muse did not hear Grok because of polling, not because of Room

**Fact.** `dg-bus.py status` lists 1:1 roles `claude | codex | grok | cursor | instinct | jill | claude-tag` with alias `muse → jill`. Channel is `~/src/agent-bus/channel.jsonl` + `AGENT-CHANNEL.md`. TUIs **do not auto-read**. `say --from grok` is channel, not Jill’s inbox.

**Fact.** Jill already had unread 1:1 from Grok (through 2026-09-15). If her session never runs `inbox jill --unread`, those messages are invisible. Instinct same with `inbox instinct`.

**Useful.** Room is not yet “the place” (`AGENT-CHANNEL.md`: until Project Room). The Mac JSONL is the fleet’s actual coordination layer — Claude’s growth note said the same. Do **not** put Room keys in WhatsApp/Muse app (`docs/AGENT-HOSTS.md`). Packet route stays: Use my AI → human sends → Paste AI draft.

**Do not.** Scan WhatsApp or the Muse app for a thread. Do not invent an Instinct iMessage API; public Instinct pages still do not document MCP or a Messages inbox API.

**Next that would actually close the loop:** a Room **member** named Muse/Instinct with a guest-agent or Max connect, **or** a tiny TUI hook that runs `inbox jill` on session start. That is product, not email. Email to potter@trydemigod.com was only so John can start those sessions.

---

## 2. Discovery is the open gap; our card already behaves like A2A-lite

**Fact.** Linux Foundation now hosts MCP (tools), A2A (agent-to-agent), ACP. Industry default is MCP for tools + A2A for coordination. A2A agent cards commonly live at `/.well-known/agent.json` (and synonyms).

**Fact on this host.** Room serves `/.well-known/agent.json`, `/agent.json`, `/room/agent.json` as the **same** card. `llms.txt` / `skill.md` name first tools and what is **not** implemented. MCP Streamable HTTP: Origin present and not the Room host → 403 (`live-audit` now POSTs that). Unpublished walk-in: `ship: false`.

**Claude flagged** `a2a: false` on the card as a John decision, not a Grok code slice. Research agrees: opting out is defensible; silently hardening the default is the mistake.

**Useful decision (John, not this lane to flip):** keep `a2a: false` **written down** with a date, or schedule a copy-first experiment on a **non-live** object. Do not first-write A2A onto schema-26.

**Useful code (already true):** origin `/agent.json` must stay 200 and equal well-known. `live-audit` checks the name. Do not point the card at Compute (`getdasha.com`).

---

## 3. Google sign-in: In production ≠ verified

**Fact.** OAuth **userinfo** scopes (`openid email profile`) are non-sensitive. Publishing Testing → In production lets any Google account sign in. A **logo**, extra domains, or sensitive/restricted scopes trigger verification. Unverified apps show a warning; they still work for those who Continue.

**Fact on this host.** Branding: app name Project Room, home + privacy on `trydemigod.com`, External / In production. No mailbox scope. PKCE. Callback is HTML interstitial because `SameSite=Strict` cookies are not sent on the Google 302 (classic OAuth + Strict). Identity is Google `sub` → `idp-` hash, not email.

**Useful.** Do not add an app logo unless we want a verification queue. Do not add `gmail.readonly` to “feel like Gmail.” Privacy URL must stay origin-open (`Origin: accounts.google.com` → 200). First Google human in empty Welcome can invite; later Google users must not.

---

## 4. Durable Objects: PITR is not a clone

**Fact.** Cloudflare SQLite Durable Objects: one Worker version per object class; rollback restores **code**, not SQLite. PITR is **in-place** restore (last ~30 days), not a fork. Copy-first to a **new** object is the only safe 26→33/34 move.

**Useful.** Never treat git SHA `a5f2dca` as a DO id (it was staging **git**). Never first-write Schema 34 `main` onto live `invite-only-pilot`. `live-audit` staying green is cheaper than a restore drill.

---

## 5. What is useful vs costume

| Useful | Costume |
|---|---|
| Correspondence: README, `/api/version`, `/api/open.ship` match | Tree-of-Life **router** |
| Solve et coagula: new vessel, not in-place transmute | Hebrew with no control |
| Tzimtzum: `ship: false` until abuse controls | Mystical chrome on Google gate |
| Receipts as conversation closure | Chat spam / Room key in WhatsApp |
| 1:1 `send jill` if Muse must hear Grok | Assuming channel = inbox |
| Asset allowlist = `app.js` imports | Hope the module graph 404s loudly |

---

## 6. What I will not do from this note

- Flip `a2a` on the live card.
- Merge `main` onto `production`.
- `ship: true`.
- Instinct #197 store fence.
- Claude `docs/growth/*`.
- Occupied `docs/*RESEARCH*`.
- Muse/Instinct WhatsApp relay.

## 7. Smallest follow-ups (if John says go)

1. Document `a2a: false` as an explicit decision in a one-line ROOM decision file (John).
2. Session-start snippet for Jill/Instinct TUIs: `inbox jill --unread` (their owners, not Room source).
3. Keep `live-audit` the algedonic channel; do not replace it with a dashboard.
