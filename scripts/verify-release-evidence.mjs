import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { verifyCardJws } from "../server/agent-card-signing.mjs";

const stages = ["build", "browser", "deploy"];
const proofLabel = "Signed source-to-package proof (same-origin JWKS)";
const proofHashPattern = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function readEnvelope(selected, client) {
  const { body } = selected.result.text ?? {};
  if (typeof body !== "string") throw new Error("The selected result has no visible proof.");
  const section = body.split("\n\n").find(value => value.startsWith(proofLabel));
  if (!section) throw new Error("The selected result has no signed release proof.");
  const [header, ...lines] = section.split("\n");
  if (header === proofLabel + ".") return JSON.parse(lines.join("\n"));

  const digest = /^, SHA-256 ([a-f0-9]{64})\./.exec(header.slice(proofLabel.length))?.[1];
  const ids = lines.map(line => line.trim()).filter(Boolean);
  if (!digest || !ids.length || ids.some((id, index) => id !== `release-proof-${digest}-${index + 1}`)) {
    throw new Error("The selected result has an invalid proof index.");
  }

  const { workItemId } = selected;
  const { discussion } = await client.workDiscussion(workItemId, { limit: 50 });
  const byId = new Map(discussion.items.map(({ message }) => [message.id, message]));
  const parts = await Promise.all(ids.map(async (id, index) => {
    const message = byId.get(id) ?? (await client.messageThread(id)).thread;
    const prefix = `room-source-proof-part/1 ${index + 1}/${ids.length} sha256:${digest}\n`;
    if (message?.id !== id || message.workItemId !== workItemId
      || message.authorId !== selected.result.receipt.reportedById || !message.body?.startsWith(prefix)) {
      throw new Error("A proof part is missing or does not belong to the selected release.");
    }
    const chunk = message.body.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{1,3600}$/.test(chunk)) throw new Error("A proof part has invalid encoding.");
    return chunk;
  }));
  const encoded = parts.join("");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded || sha256(decoded) !== digest) {
    throw new Error("The proof parts do not match the selected result digest.");
  }
  return JSON.parse(decoded);
}

export async function verifyReleaseEvidence({ client, origin, roomId, workItemId, completionEventId, fetchImpl = fetch }) {
  if (!completionEventId) throw new Error("An exact completion ID is required.");
  const selected = await client.workResult(workItemId, { completionEventId });
  const release = selected.workThread?.releaseChecks;
  if (selected.roomId !== roomId || selected.workItemId !== workItemId
    || selected.result.receipt?.eventId !== completionEventId || release?.completionEventId !== completionEventId
    || release.evidenceVersion !== selected.result.receipt.evidenceVersion) {
    throw new Error("Release checks are unavailable for the exact selected completion.");
  }
  const keysUrl = new URL("/.well-known/jwks.json", origin).href;
  const [envelope, keys] = await Promise.all([
    readEnvelope(selected, client),
    fetchImpl(keysUrl, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000) }).then(response => {
      if (!response.ok) throw new Error("The serving origin's verification keys are unavailable.");
      return response.json();
    })
  ]);
  const { proof, signature } = envelope;
  const header = JSON.parse(Buffer.from(signature?.protected ?? "", "base64url").toString("utf8"));
  const key = keys.keys?.find(item => item.kid === header.kid && item.kty === "OKP" && item.crv === "Ed25519" && typeof item.x === "string");
  if (header.jku !== keysUrl || !key
    || !verifyCardJws({ card: proof, jws: signature, publicKey: Buffer.from(key.x, "base64url").toString("base64") })) {
    throw new Error("The release proof signature did not verify against the serving origin.");
  }
  if (proof.schema !== "project-room-batch-source-to-package/1" || proof.origin !== origin
    || proof.roomId !== roomId || proof.workItemId !== workItemId
    || proof.composition?.revision !== release.candidateRevision || !proofHashPattern.test(proof.package?.manifestSha256)) {
    throw new Error("The signed proof does not match this release.");
  }
  const checks = stages.map(stage => {
    const check = release.checks.find(item => item.stage === stage);
    const digest = proof.qualification?.[stage === "deploy" ? "deployment-result.json" : stage + ".json"];
    if (!proofHashPattern.test(digest) || check?.status !== "passed" || check.evidenceDigest !== "sha256:" + digest) {
      throw new Error(`The signed proof does not match the selected ${stage} receipt.`);
    }
    return { stage, evidenceDigest: check.evidenceDigest, evidenceMessageId: check.evidenceMessageId };
  });
  return {
    verification: "signed_proof_and_stage_binding_verified",
    roomId, workItemId, completionEventId, evidenceVersion: release.evidenceVersion,
    selection: selected.selection.status, candidateRevision: release.candidateRevision,
    manifestSha256: proof.package.manifestSha256, checks
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [workItemId, completionEventId, ...extra] = process.argv.slice(2);
    if (!workItemId || !completionEventId || extra.length) {
      throw new Error("Usage: node scripts/verify-release-evidence.mjs WORK_ITEM_ID COMPLETION_EVENT_ID");
    }
    const config = await agentConnectionFromEnvironment();
    console.log(JSON.stringify(await verifyReleaseEvidence({ ...config, client: new RoomAgentClient(config), workItemId, completionEventId })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
