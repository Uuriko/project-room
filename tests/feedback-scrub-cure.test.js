// Regression tests for the feedback-scrub adversarial-battery cure.
// The battery (cohort F1, F1-Q4/Q15/Q26) executed 19 credential shapes
// against server/feedback-scrub.mjs at intake: 15 shapes (24/38 text and
// structured forms) survived verbatim into the stored record and were
// promoted verbatim to a reviewing lane. These tests own the cured
// classes; tests/feedback-scrub.test.js owns the pre-existing coverage
// and tests/feedback-store.test.js owns the ordering contract. All
// fixtures are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubString, scrubValue, scrubAttempt } from "../server/feedback-scrub.mjs";
import { createFeedbackStore } from "../server/feedback-store.mjs";

test("cure: PyPI and Docker tokens are redacted in text and structured values", () => {
  const pypi = "pypi-AgEIcHlwaS5vcmcSynthMacaroon0123456789abcdef";
  const docker = "dckr_pat_SynthDockerPat0123456789ab";
  for (const token of [pypi, docker]) {
    assert.ok(!scrubString(`upload failed with ${token} configured`).includes(token));
    assert.ok(!JSON.stringify(scrubValue({ field: token })).includes(token));
    assert.ok(!JSON.stringify(scrubValue({ field: `prefix ${token} suffix` })).includes(token));
  }
});

test("cure: database and broker URI passwords are redacted, passwordless URIs survive", () => {
  const cases = [
    ["mongodb://appuser:M0ngoSynthPw99@db.example.invalid:27017/app", "M0ngoSynthPw99"],
    ["mongodb+srv://appuser:M0ngoSynthPw99@db.example.invalid/app", "M0ngoSynthPw99"],
    ["postgres://svc:P0stgresSynthPw@db.example.invalid:5432/app", "P0stgresSynthPw"],
    ["mysql://svc:MysqlSynthPw88@db.example.invalid:3306/app", "MysqlSynthPw88"],
    ["redis://:Red1sSynthPw77@cache.example.invalid:6379/0", "Red1sSynthPw77"],
    ["amqp://guest:AmqpSynthPw66@mq.example.invalid:5672/vh", "AmqpSynthPw66"],
  ];
  for (const [uri, pw] of cases) {
    const out = scrubString(`connect failed: ${uri} retrying`);
    assert.ok(!out.includes(pw), `URI password must not survive: ${uri.split(":")[0]}`);
    assert.match(out, /\[REDACTED:credential\]@/);
    assert.ok(!JSON.stringify(scrubValue({ field: uri })).includes(pw));
  }
  // No password in the userinfo: nothing to redact, text survives verbatim.
  assert.equal(
    scrubString("db mongodb://appuser@db.example.invalid:27017/app end"),
    "db mongodb://appuser@db.example.invalid:27017/app end");
  assert.equal(
    scrubString("cache redis://cache.example.invalid:6379/0 end"),
    "cache redis://cache.example.invalid:6379/0 end");
});

test("cure: Azure AccountKey in a connection string is redacted", () => {
  const key = "SynthAzureKey0123456789abcdefABCDEF0123456789abcd==";
  const conn = `DefaultEndpointsProtocol=https;AccountName=synthstore;AccountKey=${key};EndpointSuffix=core.windows.net`;
  const out = scrubString(`conn ${conn} end`);
  assert.ok(!out.includes(key), "AccountKey value must not survive");
  assert.ok(out.includes("AccountName=synthstore"), "non-secret segments survive");
  assert.ok(out.includes("EndpointSuffix=core.windows.net"), "trailing segments survive");
  assert.ok(!JSON.stringify(scrubValue({ field: conn })).includes(key));
  assert.equal(scrubValue("anything", "AccountKey"), "[REDACTED:credential]");
});

test("cure: Discord bot tokens are redacted", () => {
  // Assembled from segments: the literal battery fixture trips hosted
  // secret-scanning on sight, which would block the file itself. The
  // runtime value is the exact synthetic shape from the battery.
  const discord = ["MTIzNDU2Nzg5MDEyMzQ1Njc4OTA1", "XyzAbc", "DiscordSynthHmacValue0123456789abcdefAB"].join(".");
  assert.ok(!scrubString(`bot token ${discord} end`).includes("DiscordSynthHmacValue"));
  assert.ok(!JSON.stringify(scrubValue({ field: discord })).includes("DiscordSynthHmacValue"));
});

test("cure: credentials split across a line break are redacted whole", () => {
  const a = "ghp_SynthSplitHalfA0123456789";
  const b = "HalfB9876543210zyxwv";
  const out = scrubString(`token ${a}\n${b} end`);
  assert.ok(!out.includes(a), "first half must not survive");
  assert.ok(!out.includes(b), "continuation half must not survive");
  assert.ok(!JSON.stringify(scrubValue({ field: `${a}\n${b}` })).includes(b));
});

test("cure: secret-shaped assignments in free text are redacted", () => {
  const cases = [
    [`"client_secret": "OAuthSynthSecret0123456789abcdef"`, "OAuthSynthSecret0123456789abcdef"],
    [`PASSWORD=MixedCasePwSynth12345`, "MixedCasePwSynth12345"],
    [`PassWord: SecondMixedPwSynth678`, "SecondMixedPwSynth678"],
    [`my_password_value: PrefixedKeyPwSynth123`, "PrefixedKeyPwSynth123"],
    [`passwordHash=SuffixedKeyPwSynth456`, "SuffixedKeyPwSynth456"],
    [`api_key=bareAssignmentValue99`, "bareAssignmentValue99"],
  ];
  for (const [text, secret] of cases) {
    assert.ok(!scrubString(text).includes(secret), `assignment value must not survive: ${text.slice(0, 24)}`);
  }
  // Prose about credentials is not an assignment and survives verbatim.
  assert.equal(
    scrubString("the password field rejects spaces and the token count is wrong"),
    "the password field rejects spaces and the token count is wrong");
  assert.equal(
    scrubString("call the thing and observe status: 422 in the response body"),
    "call the thing and observe status: 422 in the response body");
});

test("cure: Authorization Basic and Bearer scheme credentials in free text are redacted", () => {
  const basic = Buffer.from("deploy:p@ss:w0rd!#Synth2026", "utf8").toString("base64");
  assert.ok(!scrubString(`Authorization: Basic ${basic}`).includes(basic));
  const opaque = "OpaqueBearerValue0123456789abcdef";
  assert.ok(!scrubString(`Authorization: Bearer ${opaque}`).includes(opaque));
  assert.ok(!scrubString(`sent Bearer ${opaque} upstream`).includes(opaque));
});

test("cure: fine-grained GitHub PATs and Google API keys are redacted", () => {
  const pat = "github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789abcd";
  assert.ok(!scrubString(`pat ${pat} end`).includes(pat));
  const gkey = "AIzaSySynthGoogleKey0123456789abcde";
  assert.ok(!scrubString(`key ${gkey} end`).includes(gkey));
});

test("#3602: first-party credential prefixes (pri_/rak_/ga1.) are redacted", () => {
  for (const token of ["pri_abcdefgh12345678", "rak_abcdefgh12345678", "ga1.abcdefgh12345678"]) {
    for (const text of [`key ${token} stopped working`, `${token}-`, `${token} and ${token}`]) {
      const out = scrubString(text);
      assert.ok(!out.includes(token), `first-party token ${token.slice(0, 4)}… must not survive`);
      assert.match(out, /\[REDACTED:token\]/);
    }
  }
});

test("cure: one bad row in a batch does not disturb the good rows", () => {
  const rows = [
    { id: "fb-000123", note: "422 invalid_claim_input on a well-formed claim" },
    { id: "fb-000124", note: "db mysql://svc:MysqlSynthPw88@db.example.invalid:3306/app down" },
    { id: "fb-000125", note: "docs page renders fine" },
  ];
  const out = scrubValue(rows);
  assert.equal(out[0].note, rows[0].note);
  assert.equal(out[2].note, rows[2].note);
  assert.ok(!out[1].note.includes("MysqlSynthPw88"));
  assert.equal(rows[1].note.includes("MysqlSynthPw88"), true, "input must not be mutated");
});

test("cure (store level): previously-leaking shapes never reach the stored record or the promoted task", () => {
  const pypi = "pypi-AgEIcHlwaS5vcmcSynthMacaroon0123456789abcdef";
  const mongoPw = "M0ngoSynthPw99";
  const azureKey = "SynthAzureKey0123456789abcdefABCDEF0123456789abcd==";
  const docker = "dckr_pat_SynthDockerPat0123456789ab";
  const store = createFeedbackStore();
  const filing = {
    agent: { lane: "jill", card_uri: "https://muse-room.example/.well-known/agent-card.json" },
    endpoint: { method: "POST", path: "/api/rooms/abc123/work-claims" },
    attempt: {
      goal: `claim with token ${pypi} configured`,
      request: { method: "POST", path: "/api/rooms/abc123/work-claims", body: { id: "w-9" } },
      response: { status: 422, body: `db mongodb://appuser:${mongoPw}@db.example.invalid:27017/app unreachable` },
    },
    observed: `conn DefaultEndpointsProtocol=https;AccountName=synthstore;AccountKey=${azureKey};EndpointSuffix=core.windows.net`,
    expected: `201; the rejected credential was ${docker}`,
    severity: "bug",
  };
  const r = store.submit(filing);
  assert.equal(r.outcome, "accepted");
  const storedJson = JSON.stringify(store.get(r.item.id));
  for (const secret of [pypi, mongoPw, azureKey, docker]) {
    assert.ok(!storedJson.includes(secret), "stored record must not contain a previously-leaking shape");
  }
  assert.match(storedJson, /\[REDACTED/);
  const t = store.triage(r.item.id, "real", "reviewer-a");
  assert.ok(t.promotedTask, "triage-real must promote a task");
  const promotedJson = JSON.stringify(t.promotedTask);
  for (const secret of [pypi, mongoPw, azureKey, docker]) {
    assert.ok(!promotedJson.includes(secret), "promoted task must not contain a previously-leaking shape");
  }
});

test("cure: scrubAttempt covers goal, request path and response body together", () => {
  const attempt = {
    goal: "deploy with dckr_pat_SynthDockerPat0123456789ab",
    request: { method: "GET", path: "/api/things?accountkey=SynthAcctValue0123456789" },
    response: { status: 500, body: "amqp://guest:AmqpSynthPw66@mq.example.invalid:5672/vh refused" },
  };
  const out = scrubAttempt(attempt);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("dckr_pat_SynthDockerPat"));
  assert.ok(!json.includes("SynthAcctValue0123456789"));
  assert.ok(!json.includes("AmqpSynthPw66"));
  assert.equal(out.response.status, 500, "structure survives scrubbing");
});
