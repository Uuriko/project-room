#!/usr/bin/env python3
"""Generate guild-10 family doc pages from module summaries + caller greps.
Writes findings/guild-10/docs/*.md"""
import json, re, pathlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
S = json.load(open(ROOT / ".guild10/module-summaries.json"))
D = ROOT / "findings" / "guild-10" / "docs"
D.mkdir(parents=True, exist_ok=True)

FAMILIES = {
 "server-inbox-family.md": ("The inbox/* subsystem", [m for m in S if m.startswith("server/inbox")]),
 "server-work-public-family.md": ("Work + public-work modules", [m for m in S if re.match(r"server/(work|public-work)", m)]),
 "server-guard-economy-family.md": ("Guards, budgets and the spend primitive",
    ["server/room-flood-guard.mjs","server/abuse-rate-buckets.mjs","server/ip-blocklist.mjs",
     "server/wake-queue-limits.mjs","server/channel-send-budgets.mjs","server/spend-pricing.mjs",
     "server/fee-credit-ledger.mjs","server/settlement-router.mjs","server/buyer-signoff.mjs",
     "server/work-claim-mirror.mjs","server/work-claim-sqlite.mjs","server/public-work-claim-fence.mjs",
     "server/public-work-reviews.mjs","server/public-work-successors.mjs"]),
 "server-membership-family.md": ("Membership, delegation, identity and visibility",
    ["server/membership-delegation.mjs","server/membership-delegation-journal.mjs",
     "server/member-permission-requests.mjs","server/owner-delegates.mjs",
     "server/identity-verification.mjs","server/agent-key-registry.mjs",
     "server/display-name-guard.mjs","server/members-directory.mjs",
     "server/dm-event-visibility.mjs","server/history-visibility.mjs",
     "server/capability-visibility.mjs","server/agent-fleet.mjs",
     "server/work-declarations.mjs","server/work-duplicates.mjs","server/work-help.mjs","server/work-wants.mjs"]),
 "server-offers-demigod-family.md": ("Offers, Demigod contracts, trials, next-actions",
    ["server/demigod-contracts.mjs","server/demigod-offers.mjs","server/demigod-policy-adapter.mjs",
     "server/project-offers.mjs","server/trial-tasks.mjs","server/trial-task-store.mjs",
     "server/next-actions-routes.mjs","server/handoff-case.mjs","server/matchmaking-routes.mjs"]),
 "server-notify-legal-ops-family.md": ("Notify, legal, ops and boot",
    ["server/notify-policy.mjs","server/web-push.mjs","server/conversation-sync.mjs",
     "server/graph-reply-update-review.mjs","server/legal-pages.mjs","server/legal-routes.mjs",
     "server/legal-store.mjs","server/operator-routes.mjs","server/operator-status.mjs",
     "server/operator-purge.mjs","server/boot-options.mjs","server/instance-lock.mjs",
     "server/persisted-row.mjs","server/projection-at-rest.mjs","server/purge-registry.mjs",
     "server/retention-response.mjs","server/required-reading.mjs","server/room-assistant.mjs",
     "server/room-key-presence.mjs","server/og-render.mjs","server/connect-snippets.mjs",
     "server/handoff-case.mjs","server/feedback-store.mjs","server/attachment-schema.mjs",
     "server/mcp-arg-errors.mjs","server/mcp-identity-mint.mjs","server/mcp-public-work.mjs"]),
 "scripts-browser-check-suite.md": ("The *-browser-check.mjs suite",
    [m for m in S if "browser-check" in m]),
 "scripts-build-suite.md": ("Build scripts",
    [m for m in S if re.match(r"scripts/build-", m)]),
 "scripts-fixture-suite.md": ("Fixture scripts",
    [m for m in S if "fixture" in m and "browser-check" not in m]),
 "scripts-check-lint-ops.md": ("Check / lint / ops scripts",
    [m for m in S if m.startswith("scripts/") and "browser-check" not in m
     and not re.match(r"scripts/build-", m) and "fixture" not in m]),
}

def callers(mod):
    base = pathlib.Path(mod).name
    try:
        r = subprocess.run(["git", "-C", str(ROOT), "grep", "-l", "--", base, "HEAD", "--",
                            "*.mjs", "*.js", "*.ts", "*.json"],
                           capture_output=True, text=True, timeout=60)
        hits = [h for h in r.stdout.splitlines()
                if h != mod and "/.guild10/" not in h and "findings/" not in h]
        return sorted(set(hits))[:10]
    except Exception:
        return []

covered = set()
for fname, (title, mods) in FAMILIES.items():
    mods = [m for m in mods if m in S]
    covered |= set(mods)
    lines = [f"# {title}", "",
             f"_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,",
             "export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.",
             "Purpose/invariants/gotchas are quoted from the module's own header comment where present._", ""]
    for m in sorted(mods):
        d = S[m]
        lines.append(f"## `{m}`  ({d.get('loc')} lines)")
        h = (d.get("header") or "").strip()
        if h:
            paras = [p for p in h.split("\n\n") if p.strip()]
            lines.append("")
            lines.append("**Purpose.** " + paras[0].replace("\n", " ")[:900])
            if len(paras) > 1:
                rest = " ".join(" ".join(paras[1:]).split())[:1400]
                lines.append("")
                lines.append("**Invariants / gotchas.** " + rest)
        else:
            lines.append("")
            lines.append("_No header comment — purpose inferred from exports below._")
        exp = d.get("exports") or []
        if exp:
            lines.append("")
            lines.append("**Exports:** " + ", ".join(f"`{e}`" for e in exp))
        if d.get("cli"):
            lines.append("")
            lines.append("**CLI:** runnable directly (`" + d["cli"] + "`).")
        cs = callers(m)
        if cs:
            lines.append("")
            lines.append("**Callers/importers (git grep HEAD):** " + ", ".join(f"`{c}`" for c in cs))
        lines.append("")
    (D / fname).write_text("\n".join(lines))
    print(fname, len(mods))

missing = [m for m in S if m not in covered]
print("UNCOVERED:", missing)
