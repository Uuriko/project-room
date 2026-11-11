// room-acp credential redaction — F1W2-T4 regression tests.
//
// The F1-Q4 adversarial battery leaked 19/19 credential shapes through
// room-acp/src/redact.mjs (38/38 text + object-as-text forms), the ghp_
// control included: the patterns covered only rak_/pri_/rk_ tokens, a
// two-letter-dash shape and Bearer headers. These tests pin the fleet
// pattern set the cure adds — token prefixes, URI passwords,
// assignment-form secrets including prefixed/suffixed key names, PEM
// bodies, spaced passwords and provider key shapes — and the behaviours
// the module already had (registered secrets, invite codes, short
// Bearer values after an Authorization header, the logger).
import test from "node:test";
import assert from "node:assert/strict";
import { logger, redact, registerSecret } from "../room-acp/src/redact.mjs";

const V = {
  gitlab: "glpat-SynthGitLabTok0123456789ab",
  pypi: "pypi-AgEIcHlwaS5vcmcSynthMacaroon0123456789abcdef",
  docker: "dckr_pat_SynthDockerPat0123456789ab",
  gcpKeyLine: "MIIESynthGcpKeyLine1AbCdEfGh",
  azureKey: "SynthAzureKey0123456789abcdefABCDEF0123456789abcd==",
  mongoPw: "M0ngoSynthPw99",
  mysqlPw: "MysqlSynthPw88",
  redisPw: "Red1sSynthPw77",
  amqpPw: "AmqpSynthPw66",
  oauthSecret: "OAuthSynthSecret0123456789abcdef",
  discordHmac: "DiscordSynthHmacValue0123456789abcdefAB",
  jwtSig: "SynthSignatureSegment0123456789abcdef",
  splitB: "HalfB9876543210zyxwv",
  prefixedPw: "PrefixedKeyPwSynth123",
  suffixedPw: "SuffixedKeyPwSynth456",
  controlGhp: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
};
const discord = `MTIzNDU2Nzg5MDEyMzQ1Njc4OTA1.XyzAbc.${V.discordHmac}`;
const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMiLCJpYXQiOjE3MDAwMDAwMDB9.${V.jwtSig}`;
const basicB64 = Buffer.from("deploy:p@ss:w0rd!#Synth2026", "utf8").toString("base64");
const azureConn = `DefaultEndpointsProtocol=https;AccountName=synthstore;AccountKey=${V.azureKey};EndpointSuffix=core.windows.net`;
const splitA = "ghp_SynthSplitHalfA0123456789";
const gcpObj = { type: "service_account", private_key: `-----BEGIN PRIVATE KEY-----\n${V.gcpKeyLine}\n-----END PRIVATE KEY-----\n` };

// room-acp has no value function: structured values reach it as JSON
// text, so each shape is probed in free text and in JSON text.
const SHAPES = [
  ["ghp_ control", `token is ${V.controlGhp} ok`, { field: V.controlGhp }, [V.controlGhp]],
  ["GitLab", `ci token ${V.gitlab} end`, { field: V.gitlab }, [V.gitlab]],
  ["PyPI", `pypi token ${V.pypi} end`, { field: V.pypi }, [V.pypi]],
  ["Docker", `docker pat ${V.docker} end`, { field: V.docker }, [V.docker]],
  ["GCP private_key", JSON.stringify(gcpObj), gcpObj, [V.gcpKeyLine]],
  ["Azure connection string", `conn ${azureConn} end`, { field: azureConn }, [V.azureKey]],
  ["MongoDB URI", `db mongodb://appuser:${V.mongoPw}@db.example.invalid:27017/app end`, { field: `mongodb://appuser:${V.mongoPw}@db.example.invalid:27017/app` }, [V.mongoPw]],
  ["MySQL URI", `db mysql://svc:${V.mysqlPw}@db.example.invalid:3306/app end`, { field: `mysql://svc:${V.mysqlPw}@db.example.invalid:3306/app` }, [V.mysqlPw]],
  ["Redis URI", `cache redis://:${V.redisPw}@cache.example.invalid:6379/0 end`, { field: `redis://:${V.redisPw}@cache.example.invalid:6379/0` }, [V.redisPw]],
  ["AMQP URI", `mq amqp://guest:${V.amqpPw}@mq.example.invalid:5672/vh end`, { field: `amqp://guest:${V.amqpPw}@mq.example.invalid:5672/vh` }, [V.amqpPw]],
  ["OAuth client_secret", `"client_secret": "${V.oauthSecret}"`, { client_secret: V.oauthSecret }, [V.oauthSecret]],
  ["Basic auth", `Authorization: Basic ${basicB64}`, { headers: { Authorization: `Basic ${basicB64}` } }, [basicB64]],
  ["Discord bot token", `bot token ${discord} end`, { field: discord }, [discord, V.discordHmac]],
  ["JWT in Cookie header", `Cookie: session=${jwt}; theme=dark`, { headers: { Cookie: `session=${jwt}; theme=dark` } }, [jwt, V.jwtSig]],
  ["split across line break", `token ${splitA}\n${V.splitB} end`, { field: `${splitA}\n${V.splitB}` }, [splitA, V.splitB]],
  ["PASSWORD key", `PASSWORD=MixedCasePwSynth12345`, { PASSWORD: "MixedCasePwSynth12345" }, ["MixedCasePwSynth12345"]],
  ["PassWord key", `PassWord: SecondMixedPwSynth678`, { PassWord: "SecondMixedPwSynth678" }, ["SecondMixedPwSynth678"]],
  ["my_password_value key", `my_password_value: ${V.prefixedPw}`, { my_password_value: V.prefixedPw }, [V.prefixedPw]],
  ["passwordHash key", `passwordHash=${V.suffixedPw}`, { passwordHash: V.suffixedPw }, [V.suffixedPw]],
];

test("the adversarial battery leaks no shape in text or JSON-text form", () => {
  for (const [name, text, obj, secrets] of SHAPES) {
    for (const secret of secrets) {
      assert.ok(!redact(text).includes(secret), `${name} leaked in text form`);
      assert.ok(!redact(JSON.stringify(obj)).includes(secret), `${name} leaked in JSON-text form`);
    }
  }
});

test("pre-existing behaviour is preserved", () => {
  registerSecret("s3cret-value-123");
  const out = redact(`rak_abcdefgh123 pri_zzzzzzzz9 RM-ABCDEFGHJKMNPQRS Authorization: Bearer xyz s3cret-value-123`);
  for (const leaked of ["rak_abcdefgh123", "pri_zzzzzzzz9", "RM-ABCDEFGHJKMNPQRS", "xyz", "s3cret-value-123"])
    assert.ok(!out.includes(leaked), leaked);
  assert.equal(redact("release notes for version 2"), "release notes for version 2");
  assert.equal(redact(42), "42");
});

test("the logger writes redacted lines and a spaced password is redacted whole", () => {
  const lines = [];
  logger(line => lines.push(line))("connect failed", `password=correct horse battery staple`);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("horse"), lines[0]);
});
