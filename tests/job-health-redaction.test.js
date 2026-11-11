// Conformance pin for the two job-health error surfaces.
//
// GET /api/health/jobs is served unauthenticated on both runtimes. The
// Worker folds error text through redactError (cloudflare/job-heartbeat.mjs);
// the Node scheduler stores lastError through redactJobError
// (server/jobs.mjs). The modules cannot import each other — the heartbeat
// reads the jobs registry — so the redaction pattern set lives in two
// copies, and the failureDetail allowlist lives in two copies
// (sanitizeFailureDetail / failureDetailOf). This suite holds both copies
// to one battery so they cannot drift apart again: before this pin, the
// Worker redactor leaked URI passwords and a GCP key body (F1-Q4: 7/19
// shapes), the Node channel stored raw error text with no redactor at
// all and silently dropped the registry's redactErrors opt-in (F1-Q21:
// 9/9 in-cap shapes verbatim), and the Node allowlist admitted 42–64
// char class tokens the Worker copy dropped (F1-Q17).
//
// All fixtures are synthetic/fake credentials, assembled from fragments.
import test from "node:test";
import assert from "node:assert/strict";
import { redactError, sanitizeFailureDetail } from "../cloudflare/job-heartbeat.mjs";
import { JOBS, failureDetailOf, nodeJobErrorText, redactJobError } from "../server/jobs.mjs";

const V = {
  ghp: "ghp_" + "SynthControlToken" + "0123456789abcd",
  gitlab: "glpat-" + "SynthGitLabTok" + "0123456789ab",
  pypi: "pypi-" + "AgEIcHlwaS5vcmcSynthMacaroon" + "0123456789abcdef",
  docker: "dckr_pat_" + "SynthDockerPat" + "0123456789ab",
  gcpKeyLine: "MIIESynthGcpKeyLine" + "1AbCdEfGh",
  azureKey: "SynthAzureKey" + "0123456789abcdefABCDEF0123456789abcd" + "==",
  mongoPw: "M0ngoSynthPw99",
  mysqlPw: "MysqlSynthPw88",
  redisPw: "Red1sSynthPw77",
  amqpPw: "AmqpSynthPw66",
  oauthSecret: "OAuthSynthSecret" + "0123456789abcdef",
  discordHmac: "DiscordSynthHmacValue" + "0123456789abcdefAB",
  jwtSig: "SynthSignatureSegment" + "0123456789abcdef",
  splitA: "SplitHalfA" + "0123456789abcd",
  splitB: "HalfB" + "9876543210zyxwvuts",
  mixedPw: "MixedCasePwSynth12345",
  mixedPw2: "SecondMixedPwSynth678",
  prefixedPw: "PrefixedKeyPwSynth123",
  suffixedPw: "SuffixedKeyPwSynth456",
  urlPw: "Url1nfoSynthPw55",
  // Sub-32 vendor tokens (F1W2-T3b fixup, R3 finding R1): total lengths
  // 26 / 24 / 23 chars — below the 32-char long-run threshold, so these
  // are scrubbed by the explicit vendor-prefix rule or not at all.
  gitlabShort: "glpat-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn",
  dockerShort: "dckr_pat_" + "Ab1Cd2Ef3Gh4Ij5",
  pypiShort: "pypi-" + "Ab1Cd2Ef3Gh4Ij5Kl6"
};
V.discord = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OTA1", "XyzAbc", V.discordHmac].join(".");
V.jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiJzeW50aCJ9", V.jwtSig].join(".");
const basicB64 = Buffer.from("deploy:p@ss:w0rd!#Synth2026", "utf8").toString("base64");
const azureConn = `DefaultEndpointsProtocol=https;AccountName=synthstore;AccountKey=${V.azureKey};EndpointSuffix=core.windows.net`;
const gcpObj = { type: "service_account", private_key: `-----BEGIN PRIVATE KEY-----\n${V.gcpKeyLine}\n-----END PRIVATE KEY-----\n`, client_email: "svc@synthetic.example" };
const J = value => JSON.stringify(value);

// Each shape: free text, an object form (fed to the text functions as JSON
// text, the way error channels receive objects), and the secret substrings
// that must not survive in either form.
const SHAPES = [
  { id: "C0-control-ghp", text: `token is ${V.ghp} ok`, obj: { field: V.ghp }, secrets: [V.ghp] },
  { id: "N1-gitlab-glpat", text: `ci token ${V.gitlab} end`, obj: { field: V.gitlab }, secrets: [V.gitlab] },
  { id: "N2-pypi", text: `pypi token ${V.pypi} end`, obj: { field: V.pypi }, secrets: [V.pypi] },
  { id: "N3-docker-dckr_pat", text: `docker pat ${V.docker} end`, obj: { field: V.docker }, secrets: [V.docker] },
  { id: "N4-gcp-sa-json-private_key", text: J(gcpObj), obj: gcpObj, secrets: [V.gcpKeyLine] },
  { id: "N5-azure-conn-string", text: `conn ${azureConn} end`, obj: { field: azureConn }, secrets: [V.azureKey] },
  { id: "N6a-mongodb-uri", text: `db mongodb://appuser:${V.mongoPw}@db.example.invalid:27017/app end`, obj: { field: `mongodb://appuser:${V.mongoPw}@db.example.invalid:27017/app` }, secrets: [V.mongoPw] },
  { id: "N6b-mysql-uri", text: `db mysql://svc:${V.mysqlPw}@db.example.invalid:3306/app end`, obj: { field: `mysql://svc:${V.mysqlPw}@db.example.invalid:3306/app` }, secrets: [V.mysqlPw] },
  { id: "N6c-redis-uri", text: `cache redis://:${V.redisPw}@cache.example.invalid:6379/0 end`, obj: { field: `redis://:${V.redisPw}@cache.example.invalid:6379/0` }, secrets: [V.redisPw] },
  { id: "N6d-amqp-uri", text: `mq amqp://guest:${V.amqpPw}@mq.example.invalid:5672/vh end`, obj: { field: `amqp://guest:${V.amqpPw}@mq.example.invalid:5672/vh` }, secrets: [V.amqpPw] },
  { id: "N7-oauth-client_secret-json", text: `"client_secret": "${V.oauthSecret}"`, obj: { client_id: "synth-client", client_secret: V.oauthSecret }, secrets: [V.oauthSecret] },
  { id: "N8-basic-auth-special-chars", text: `Authorization: Basic ${basicB64}`, obj: { headers: { Authorization: `Basic ${basicB64}` } }, secrets: [basicB64] },
  { id: "N9-discord-bot-token", text: `bot token ${V.discord} end`, obj: { field: V.discord }, secrets: [V.discord, V.discordHmac] },
  { id: "N10-jwt-in-cookie-header", text: `Cookie: session=${V.jwt}; theme=dark`, obj: { headers: { Cookie: `session=${V.jwt}; theme=dark` } }, secrets: [V.jwt, V.jwtSig] },
  { id: "N11-credential-split-linebreak", text: `token ${V.splitA}\n${V.splitB} end`, obj: { field: `${V.splitA}\n${V.splitB}` }, secrets: [V.splitA, V.splitB] },
  { id: "N12a-key-PASSWORD", text: `PASSWORD=${V.mixedPw}`, obj: { PASSWORD: V.mixedPw }, secrets: [V.mixedPw] },
  { id: "N12b-key-PassWord", text: `PassWord: ${V.mixedPw2}`, obj: { PassWord: V.mixedPw2 }, secrets: [V.mixedPw2] },
  { id: "N13a-key-my_password_value", text: `my_password_value: ${V.prefixedPw}`, obj: { my_password_value: V.prefixedPw }, secrets: [V.prefixedPw] },
  { id: "N13b-key-passwordHash", text: `passwordHash=${V.suffixedPw}`, obj: { passwordHash: V.suffixedPw }, secrets: [V.suffixedPw] },
  { id: "X1-https-url-userinfo", text: `fetch https://deploy:${V.urlPw}@host.example.invalid/x failed`, obj: { field: `https://deploy:${V.urlPw}@host.example.invalid/x` }, secrets: [V.urlPw] },
  { id: "N1s-gitlab-glpat-sub32", text: `ci failed: ${V.gitlabShort} (exit 1)`, obj: { field: V.gitlabShort }, secrets: [V.gitlabShort] },
  { id: "N3s-docker-dckr_pat-sub32", text: `docker login failed for ${V.dockerShort} retry`, obj: { field: V.dockerShort }, secrets: [V.dockerShort] },
  { id: "N2s-pypi-sub32", text: `upload failed for ${V.pypiShort} retry`, obj: { field: V.pypiShort }, secrets: [V.pypiShort] }
];

const REDACTORS = [["worker redactError", redactError], ["node redactJobError", redactJobError]];

test("job-health redaction battery: no shape survives on either surface", () => {
  for (const shape of SHAPES) {
    for (const form of [shape.text, J(shape.obj)]) {
      for (const [name, redact] of REDACTORS) {
        const out = redact(form);
        for (const secret of shape.secrets) {
          assert.ok(!out.includes(secret), `${shape.id} survived via ${name}`);
        }
      }
    }
  }
});

test("job-health redaction conformance: both copies return identical text", () => {
  for (const shape of SHAPES) {
    for (const form of [shape.text, J(shape.obj)]) {
      assert.equal(redactJobError(form), redactError(form), shape.id);
    }
  }
  // Benign diagnostics keep their text on both surfaces.
  for (const benign of ["1 error(s) in tick", "integrity messages_parity failed (messages_parity_failed)",
    "connection reset by peer", "no such table: messages", "github_rate_limited"]) {
    assert.equal(redactError(benign), benign, benign);
    assert.equal(redactJobError(benign), benign, benign);
  }
});

test("job-health redaction is idempotent (record() re-redacts stored text)", () => {
  for (const shape of SHAPES) {
    assert.equal(redactError(redactError(shape.text)), redactError(shape.text), shape.id);
    assert.equal(redactJobError(redactJobError(shape.text)), redactJobError(shape.text), shape.id);
  }
});

test("job-health redaction caps: worker 240, node 200", () => {
  assert.ok(redactError("x".repeat(1000)).length <= 240);
  assert.ok(redactJobError("x".repeat(1000)).length <= 200);
  // A credential at the end of an over-cap message is still gone and the
  // stored text still fits the cap.
  const padded = `${"lorem ipsum dolor sit amet ".repeat(10)}mongodb://appuser:${V.mongoPw}@db.example.invalid`;
  const out = redactJobError(padded);
  assert.ok(out.length <= 200);
  assert.ok(!out.includes(V.mongoPw));
});

test("redactErrors flag: nodeJobErrorText collapses flagged jobs to a stable code", () => {
  const gmail = JOBS.find(job => job.name === "gmail-sync");
  assert.equal(gmail.redactErrors, true, "gmail-sync keeps its registry opt-in");
  const withCode = new Error(`sync failed for mongodb://appuser:${V.mongoPw}@db.example.invalid`);
  withCode.code = "gmail_unavailable";
  assert.equal(nodeJobErrorText(gmail, withCode), "gmail_unavailable");
  const bare = new Error(`sync failed for mongodb://appuser:${V.mongoPw}@db.example.invalid`);
  assert.equal(nodeJobErrorText(gmail, bare), "gmail-sync tick failed");
  // An unflagged job gets the full redaction treatment, never the raw text.
  const other = nodeJobErrorText({ name: "integrity", redactErrors: false }, bare);
  assert.ok(!other.includes(V.mongoPw));
  assert.ok(other.includes("[redacted]"));
});

test("vendor-prefix rule: benign prefix mentions are not scrubbed", () => {
  // Ordinary prose/code contexts the vendor rule excludes: the prefix
  // standing alone, or followed by a short non-token word (<6 token
  // chars). Both copies must leave every one byte-identical.
  for (const benign of ["the glpat- prefix marks a gitlab token",
    "pypi-based tooling is disabled here", "a glpat-like failure mode",
    "dckr_pat_ is the docker pat prefix", 'const prefix = "pypi-";',
    "upload to pypi.org failed with a network error"]) {
    assert.equal(redactError(benign), benign, benign);
    assert.equal(redactJobError(benign), benign, benign);
  }
});

test("failureDetail allowlists agree field-for-field, including the length window", () => {
  const viaNode = detail => failureDetailOf({ failureDetail: detail });
  const cases = [
    { code: "integrity_check_failed", subcheck: "messages_parity", errorClass: "storage", recordClass: "message", reason: "backfill_blocked", component: "store", recordId: "room-123_abc" },
    // Context strings are dropped whole by both allowlists (allowlist
    // rebuild, not a free-text redactor): nothing embedded survives.
    { code: `mongodb://appuser:${V.mongoPw}@db.example.invalid`, subcheck: V.ghp, errorClass: "has space", recordId: "bad id!" },
    { subcheck: "token with spaces and mongodb://appuser:" + V.mongoPw + "@db.example.invalid" },
    {},
    { unknownKey: "short_token" }
  ];
  for (const length of [40, 41, 42, 50, 64, 65]) {
    const token = "a".repeat(length);
    cases.push({ subcheck: token }, { errorClass: token }, { recordClass: token },
      { code: token }, { reason: token }, { component: token }, { recordId: token });
  }
  for (const detail of cases) {
    assert.deepEqual(viaNode(detail), sanitizeFailureDetail(detail), J(detail).slice(0, 80));
  }
  assert.equal(failureDetailOf(null), null);
  assert.equal(failureDetailOf({}), null);
  assert.equal(failureDetailOf({ failureDetail: "nope" }), null);
  assert.equal(sanitizeFailureDetail(null), null);
  // The channel's producers are stable codes: a well-formed detail passes
  // identically on both surfaces.
  const good = { code: "messages_backfill_failed", subcheck: "messages_backfill", errorClass: "storage", recordClass: "message" };
  assert.deepEqual(viaNode(good), good);
  assert.deepEqual(sanitizeFailureDetail(good), good);
});
