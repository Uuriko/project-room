// Credential redaction (relay/src/redact.mjs) — F1W2-T4 regression checks.
//
// The F1-Q4 adversarial battery leaked 19/19 credential shapes through
// this redactor (32/38 text+value forms), the ghp_ control included:
// the text path caught only Bearer headers and pri_/rak_ tokens. These
// checks pin the fleet pattern set the cure adds — token prefixes, URI
// passwords, assignment-form secrets including prefixed/suffixed key
// names, PEM bodies, spaced passwords and provider key shapes — in both
// the text form and the structured value form, plus the behaviours the
// module already had (sensitive keys, Bearer format, scalar passthrough).

import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../src/redact.mjs";

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

const SHAPES = [
  ["ghp_ control", `token is ${V.controlGhp} ok`, { field: V.controlGhp }, [V.controlGhp]],
  ["GitLab", `ci token ${V.gitlab} end`, { field: V.gitlab }, [V.gitlab]],
  ["PyPI", `pypi token ${V.pypi} end`, { field: V.pypi }, [V.pypi]],
  ["Docker", `docker pat ${V.docker} end`, { field: V.docker }, [V.docker]],
  ["GCP private_key", JSON.stringify({ private_key: `-----BEGIN PRIVATE KEY-----\n${V.gcpKeyLine}\n-----END PRIVATE KEY-----\n` }), { private_key: `-----BEGIN PRIVATE KEY-----\n${V.gcpKeyLine}\n-----END PRIVATE KEY-----\n` }, [V.gcpKeyLine]],
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

test("the adversarial battery leaks no shape in text or value form", () => {
  for (const [name, text, obj, secrets] of SHAPES) {
    const textOut = redact(text);
    const valueOut = JSON.stringify(redact(structuredClone(obj)));
    for (const secret of secrets) {
      assert.ok(!textOut.includes(secret), `${name} leaked in text form`);
      assert.ok(!valueOut.includes(secret), `${name} leaked in value form`);
    }
  }
});

test("pre-existing behaviour is preserved", () => {
  assert.equal(redact("Bearer abcdefgh12345678"), "Bearer [redacted]");
  assert.equal(redact("some pri_abcdefgh1234 token"), "some [redacted] token");
  assert.equal(redact({ token: "anything at all" }).token, "[redacted]");
  assert.equal(redact({ count: 3, ok: true, missing: null }).count, 3);
  assert.deepEqual(redact(["plain", 7]), ["plain", 7]);
  assert.equal(redact("release notes for version 2"), "release notes for version 2");
  assert.equal(redact("the author field names the member"), "the author field names the member");
});

test("a spaced password assignment is redacted whole", () => {
  assert.ok(!redact("password=correct horse battery staple").includes("horse"));
});
