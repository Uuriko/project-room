// Mint an identity and write only the secret to worker-46/.creds-pri.txt.
import { writeFileSync } from "node:fs";
const res = await fetch("http://127.0.0.1:" + (process.env.W46_PORT || 4281) + "/api/agent-identities", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ displayName: "w46-fuzzer2" })
});
const data = await res.json();
writeFileSync(new URL(".creds-pri.txt", import.meta.url), data.secret);
console.log("identity minted; secret written to worker-46/.creds-pri.txt (status", res.status + ")");
