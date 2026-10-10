// Pre-upload signed-artifact verification for the deploy pipeline
// (200-hard-tasks #171).
//
// Runs inside the wrangler `build.command` immediately after
// scripts/sign-agent-card.mjs, so every deploy that builds through wrangler
// (prod, entry, staging, local) verifies the signed artifacts BEFORE the
// bundle uploads. Post-deploy, scripts/prod-deploy-smoke.mjs re-verifies
// from the live doors; this is the pre-upload half that closes the
// build-time tamper window between signing and upload.
//
// Fail-closes (exit 1) when:
//   - server/version.mjs is not stamped (SOURCE_REVISION is not a full
//     commit SHA) or does not match the build checkout's `git rev-parse HEAD`
//   - the agent card is unsigned without an explicit opt-in reason
//     (AGENT_CARD_UNSIGNED_REASON empty) — the pipeline never opts in, so an
//     unsigned card in CI is always a failure
//   - the house signature does not verify against the pinned public key in
//     deploy/agent-card-key.mjs
//   - the signed revision does not match the stamped revision
//   - any A2A v1.0 JWS entry does not verify against the pinned public key
//
// Prints one JSON report to stdout. Exit 0 only when every check passes
// (or when the unsigned state is an explicit, recorded opt-in — local dev
// only; the deploy workflow never passes --allow-unsigned).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (check, detail) => failures.push({ check, detail });

function readStampedConstant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = ("(?:[^"\\\\]|\\\\.)*");`));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

const versionSource = readFileSync(join(ROOT, "server", "version.mjs"), "utf8");
const stampedRevision = readStampedConstant(versionSource, "SOURCE_REVISION");
const stampedBuildId = readStampedConstant(versionSource, "BUILD_ID");

let headRevision = null;
try {
  headRevision = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  fail("git-head", "could not read git rev-parse HEAD in the build checkout");
}

if (typeof stampedRevision !== "string" || !/^[0-9a-f]{40}$/.test(stampedRevision)) {
  fail("stamped-revision", `SOURCE_REVISION is not a full commit SHA: ${JSON.stringify(stampedRevision)}`);
} else if (headRevision && stampedRevision !== headRevision) {
  fail("stamped-revision", `stamped ${stampedRevision} does not match build checkout HEAD ${headRevision}`);
}
if (typeof stampedBuildId !== "string" || stampedBuildId.length === 0 || stampedBuildId === "unstamped") {
  fail("stamped-build-id", `BUILD_ID is not stamped: ${JSON.stringify(stampedBuildId)}`);
}

const signed = await import("../deploy/agent-card-signed.mjs");
const { AGENT_CARD_SIGNATURE, AGENT_CARD_SIGNED_REVISION, AGENT_CARD_UNSIGNED_REASON, AGENT_CARD_JWS_SIGNATURES } = signed;
const { AGENT_CARD_AGENT_ID, AGENT_CARD_KEY_ID, AGENT_CARD_PUBLIC_KEY } = await import("../deploy/agent-card-key.mjs");

let cardState = "unverified";
if (AGENT_CARD_SIGNATURE == null) {
  if (typeof AGENT_CARD_UNSIGNED_REASON === "string" && AGENT_CARD_UNSIGNED_REASON.length > 0) {
    cardState = "unsigned-opt-in";
    console.warn(`verify-build-artifacts: WARNING: agent card is UNSIGNED by explicit opt-in (${AGENT_CARD_UNSIGNED_REASON.slice(0, 120)}). The deploy pipeline must never do this.`);
  } else {
    fail("card-signed", "agent card is unsigned with no recorded opt-in reason; refusing to ship an accidentally-unsigned card");
  }
} else {
  if (AGENT_CARD_SIGNED_REVISION !== stampedRevision) {
    fail("card-revision-binding", `signed revision ${JSON.stringify(AGENT_CARD_SIGNED_REVISION)} does not match stamped revision ${JSON.stringify(stampedRevision)}`);
  }
  try {
    const { agentCard, attachCardSignatureEnvelope } = await import("../deploy/agent-discovery.mjs");
    const { verifyCardSignature, verifyCardJws } = await import("../server/agent-card-signing.mjs");
    const card = agentCard();
    const houseOk = verifyCardSignature({
      agentId: AGENT_CARD_AGENT_ID,
      card,
      publicKey: AGENT_CARD_PUBLIC_KEY,
      signature: AGENT_CARD_SIGNATURE,
    });
    if (!houseOk) {
      fail("card-house-signature", "house Ed25519 signature does not verify against the pinned public key");
    }
    const envelope = attachCardSignatureEnvelope({ ...card }, {
      signature: AGENT_CARD_SIGNATURE,
      jwsSignatures: null,
      revision: AGENT_CARD_SIGNED_REVISION,
    });
    const jwsList = Array.isArray(AGENT_CARD_JWS_SIGNATURES) ? AGENT_CARD_JWS_SIGNATURES : [];
    if (jwsList.length === 0) {
      fail("card-jws", "no A2A JWS signatures present on the signed card");
    }
    jwsList.forEach((jws, index) => {
      if (!verifyCardJws({ card: envelope, publicKey: AGENT_CARD_PUBLIC_KEY, jws })) {
        fail("card-jws", `JWS entry ${index} does not verify against the pinned public key`);
      }
    });
    if (!failures.some(f => f.check.startsWith("card-"))) cardState = "signed-verified";
  } catch (error) {
    fail("card-verify", `card verification threw: ${error?.message ?? String(error)}`);
  }
}

const report = {
  ok: failures.length === 0,
  stampedRevision,
  headRevision,
  buildId: typeof stampedBuildId === "string" ? stampedBuildId.slice(0, 64) : null,
  cardState,
  keyId: AGENT_CARD_KEY_ID,
  failures,
};
console.log(JSON.stringify(report));
if (!report.ok) {
  console.error(`verify-build-artifacts: FAILED (${failures.length} check(s)): ${failures.map(f => f.check).join(", ")}`);
  process.exit(1);
}
