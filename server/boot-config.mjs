// Boot-time validation for security/correctness-critical config
// (RC-2026-09-27-2732, UFO-steal slice 5: fail-loud config).
//
// Missing/invalid critical config must fail boot with a member-facing error
// naming what's missing and how to fix it — never silently degrade. The
// canonical bad example: the agent card shipped UNSIGNED in production
// because the build defaulted to unsigned with no record of the choice.
// Genuinely safe defaults (port numbers, stream intervals, optional
// feature flags like Telegram/Gmail/VAPID) are NOT gated here: only config
// whose absence silently degrades a security or correctness promise.
//
// Call from server.mjs (the node boot path) before listen(). The Cloudflare
// Worker entry is covered at build time by scripts/sign-agent-card.mjs,
// which fails closed without the signing key unless --allow-unsigned.
//
// `cardSignature` is agentCardSignatureState() from
// deploy/agent-discovery.mjs: { signed, signedRevision, unsignedReason }.
// `unsignedReason` is non-null only when scripts/sign-agent-card.mjs
// --allow-unsigned explicitly recorded the degraded choice at build time.
//
// Semantics:
//   production + unsigned            -> THROW (production must be signed;
//                                        --allow-unsigned is dev-only)
//   dev + unsigned, no opt-in record  -> loud member-facing WARNING naming
//                                        the fix; boot continues (dev
//                                        ergonomics), and the served card
//                                        carries signed:false.
//   dev + unsigned, explicit opt-in   -> loud warning; boot continues; the
//                                        served card carries signed:false
//                                        plus the recorded reason.
//   signed                           -> clean; no warnings.
export function validateCriticalConfig({ production = false, cardSignature = null } = {}) {
  const warnings = [];
  const card = cardSignature ?? { signed: false, unsignedReason: null };
  const reason = typeof card.unsignedReason === "string" && card.unsignedReason.length > 0
    ? card.unsignedReason
    : null;

  if (!card.signed) {
    if (production) {
      if (reason) {
        throw new Error(
          "Refusing to boot: the agent card was built with an explicit --allow-unsigned, " +
          "but production must ship a SIGNED card. Restore signing custody " +
          "(ROOM_AGENT_CARD_SIGNING_KEY or ~/.config/project-room/agent-card-signing.key), " +
          "re-run scripts/sign-agent-card.mjs without the flag, and rebuild."
        );
      }
      throw new Error(
        "Refusing to boot: agent card signing is not configured — this room would ship an " +
        "UNSIGNED agent card in production with no explicit opt-in on record. Set " +
        "ROOM_AGENT_CARD_SIGNING_KEY (or ~/.config/project-room/agent-card-signing.key) and " +
        "re-run scripts/sign-agent-card.mjs at build time. --allow-unsigned is for local/dev " +
        "builds only; it can never ship production."
      );
    }
    if (reason) {
      warnings.push(
        "WARNING: the agent card is UNSIGNED by explicit build opt-in " +
        `(${reason}); the served card is marked signed:false. ` +
        "Restore ROOM_AGENT_CARD_SIGNING_KEY and re-sign before any production release."
      );
    } else {
      warnings.push(
        "ERROR: the agent card is UNSIGNED and no explicit opt-in was recorded at build time — " +
        "members fetching /.well-known/agent-card.json will see an unsigned card (marked signed:false). " +
        "To fix: set ROOM_AGENT_CARD_SIGNING_KEY and re-run scripts/sign-agent-card.mjs, or pass " +
        "--allow-unsigned explicitly to record the choice."
      );
    }
  }
  return { warnings };
}
