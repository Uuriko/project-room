/**
 * bridge/lib/redact.mjs regression tests (F1W2-T6 cure).
 *
 * Covers the F1-Q4 adversarial battery classes that leaked through the
 * bridge redactor at e850efef (17/19 shapes), with the PEM body defect
 * first: the redactor used to strip only the -----BEGIN----- marker and
 * leave the base64 key body in pane output. All specimens are synthetic.
 *
 * Run: node --test tests/bridge-redact.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactValue, redactSecretShaped, looksSecretShaped } from '../bridge/lib/redact.mjs';

const KEY_BODY = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDSynth';
const KEY_BODY2 = '7f3aSynthSecondLineBodyAbCdEfGhIjKlMnOpQrStUv';

test('PEM block: markers AND body are redacted, context survives', () => {
  const out = redactSecretShaped(`before\n-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY2}\n-----END PRIVATE KEY-----\nafter`);
  assert.ok(!out.includes(KEY_BODY));
  assert.ok(!out.includes(KEY_BODY2));
  assert.ok(!out.includes('BEGIN PRIVATE KEY'));
  assert.ok(out.includes('before') && out.includes('after'));
});

test('PEM block: missing trailing newline, RSA/EC labels, CRLF, header lines', () => {
  assert.ok(!redactSecretShaped(`-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----`).includes(KEY_BODY));
  assert.ok(!redactSecretShaped(`-----BEGIN EC PRIVATE KEY-----\r\n${KEY_BODY}\r\n-----END EC PRIVATE KEY-----\r\n`).includes(KEY_BODY));
  const withHeaders = `-----BEGIN PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,SynthHeaderValue0123\n\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`;
  const out = redactSecretShaped(withHeaders);
  assert.ok(!out.includes(KEY_BODY));
  assert.ok(!out.includes('SynthHeaderValue0123'));
});

test('PEM block: unterminated block fails closed; JSON-escaped block is consumed whole', () => {
  assert.ok(!redactSecretShaped(`log\n-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY2}`).includes(KEY_BODY));
  const json = JSON.stringify({ private_key: `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`, client_email: 'svc@synthetic.example' });
  const out = redactSecretShaped(json);
  assert.ok(!out.includes(KEY_BODY));
  assert.ok(out.includes('svc@synthetic.example'));
});

test('PEM: looksSecretShaped and redactValue treat a PEM string as secret-bearing', () => {
  const pem = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`;
  assert.equal(looksSecretShaped(pem), true);
  assert.equal(redactValue({ field: pem }).field, '[redacted]');
  assert.equal(redactValue({ private_key: pem }).private_key, '[redacted]');
});

test('PEM block: PGP PRIVATE KEY BLOCK label variant is consumed whole (F1W2-T6b)', () => {
  const pgp = `before\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: SynthFixtureHeader0123\n\n${KEY_BODY}\n${KEY_BODY2}\n-----END PGP PRIVATE KEY BLOCK-----\nafter`;
  const out = redactSecretShaped(pgp);
  assert.ok(!out.includes(KEY_BODY));
  assert.ok(!out.includes(KEY_BODY2));
  assert.ok(!out.includes('SynthFixtureHeader0123'));
  assert.ok(!out.includes('PGP PRIVATE KEY BLOCK'));
  assert.ok(out.includes('before') && out.includes('after'));
  assert.equal(looksSecretShaped(pgp), true);
  assert.equal(redactValue({ field: pgp }).field, '[redacted]');
});

test('PEM block: other PRIVATE KEY BLOCK label variants; unterminated PGP fails closed (F1W2-T6b)', () => {
  assert.ok(!redactSecretShaped(`-----BEGIN RSA PRIVATE KEY BLOCK-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY BLOCK-----`).includes(KEY_BODY));
  assert.ok(!redactSecretShaped(`-----BEGIN PRIVATE KEY BLOCK-----\n${KEY_BODY}\n-----END PRIVATE KEY BLOCK-----\n`).includes(KEY_BODY));
  assert.ok(!redactSecretShaped(`log\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n${KEY_BODY}\n${KEY_BODY2}`).includes(KEY_BODY));
});

test('preservation: CERTIFICATE and PUBLIC KEY blocks are byte-identical (F1W2-T6b)', () => {
  const cert = `-----BEGIN CERTIFICATE-----\n${KEY_BODY}\n${KEY_BODY2}\n-----END CERTIFICATE-----\n`;
  assert.equal(redactSecretShaped(cert), cert);
  const pub = `-----BEGIN PUBLIC KEY-----\n${KEY_BODY}\n-----END PUBLIC KEY-----\n`;
  assert.equal(redactSecretShaped(pub), pub);
  assert.equal(redactValue({ field: cert }).field, cert);
});

test('vendor token prefixes: glpat-, pypi-, dckr_pat_ (text and value forms)', () => {
  const specimens = [
    'glpat-SynthGitLabTok0123456789ab',
    'pypi-AgEIcHlwaS5vcmcSynthMacaroon0123456789abcdef',
    'dckr_pat_SynthDockerPat0123456789ab',
  ];
  for (const s of specimens) {
    assert.ok(!redactSecretShaped(`token ${s} end`).includes(s), s);
    assert.equal(redactValue({ field: s }).field, '[redacted]', s);
  }
});

test('database and AMQP URI passwords are redacted, scheme/user/host survive', () => {
  const cases = [
    ['mongodb://appuser:M0ngoSynthPw99@db.example.invalid:27017/app', 'M0ngoSynthPw99'],
    ['mysql://svc:MysqlSynthPw88@db.example.invalid:3306/app', 'MysqlSynthPw88'],
    ['redis://:Red1sSynthPw77@cache.example.invalid:6379/0', 'Red1sSynthPw77'],
    ['amqp://guest:AmqpSynthPw66@mq.example.invalid:5672/vh', 'AmqpSynthPw66'],
  ];
  for (const [uri, pw] of cases) {
    const out = redactSecretShaped(`db ${uri} end`);
    assert.ok(!out.includes(pw), uri);
    assert.ok(out.includes('@'), uri);
    assert.equal(redactValue({ field: uri }).field, '[redacted]', uri);
  }
});

test('Azure connection-string AccountKey is redacted', () => {
  const key = 'SynthAzureKey0123456789abcdefABCDEF0123456789abcd==';
  const conn = `DefaultEndpointsProtocol=https;AccountName=synthstore;AccountKey=${key};EndpointSuffix=core.windows.net`;
  const out = redactSecretShaped(`conn ${conn} end`);
  assert.ok(!out.includes(key));
  assert.ok(out.includes('AccountName=synthstore'));
  assert.equal(redactValue({ field: conn }).field, '[redacted]');
});

test('credential assignments in free text: quoted, bare, prefixed and suffixed keys', () => {
  const cases = [
    ['"client_secret": "OAuthSynthSecret0123456789abcdef"', 'OAuthSynthSecret0123456789abcdef'],
    ['PASSWORD=MixedCasePwSynth12345', 'MixedCasePwSynth12345'],
    ['PassWord: SecondMixedPwSynth678', 'SecondMixedPwSynth678'],
    ['my_password_value: PrefixedKeyPwSynth123', 'PrefixedKeyPwSynth123'],
    ['passwordHash=SuffixedKeyPwSynth456', 'SuffixedKeyPwSynth456'],
  ];
  for (const [text, secret] of cases) {
    assert.ok(!redactSecretShaped(text).includes(secret), text);
  }
});

test('Basic auth and Discord bot tokens are redacted', () => {
  const basic = Buffer.from('deploy:p@ss:w0rd!#Synth2026', 'utf8').toString('base64');
  assert.ok(!redactSecretShaped(`Authorization: Basic ${basic}`).includes(basic));
  // Built from segments so the file itself carries no literal bot token.
  const discordHmac = 'DiscordSynthHmacValue0123456789abcdefAB';
  const discord = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OTA1', 'XyzAbc', discordHmac].join('.');
  assert.ok(!redactSecretShaped(`bot token ${discord} end`).includes(discordHmac));
});

test('known-prefix token split across a line break is redacted whole', () => {
  const out = redactSecretShaped('token ghp_SynthSplitHalfA0123456789\nHalfB9876543210zyxwv end');
  assert.ok(!out.includes('ghp_SynthSplitHalfA0123456789'));
  assert.ok(!out.includes('HalfB9876543210zyxwv'));
});

test('preservation: prose, plain URLs, SHAs, UUIDs and short assignments are untouched', () => {
  assert.equal(redactSecretShaped('plain prose, no secrets here'), 'plain prose, no secrets here');
  assert.equal(redactSecretShaped('see https://example.invalid/docs/page?q=1 end'), 'see https://example.invalid/docs/page?q=1 end');
  assert.equal(redactSecretShaped('commit e850efefee13d7db118a77cdca511b014837b4f0 landed'), 'commit e850efefee13d7db118a77cdca511b014837b4f0 landed');
  assert.equal(redactSecretShaped('id 123e4567-e89b-12d3-a456-426614174000 ok'), 'id 123e4567-e89b-12d3-a456-426614174000 ok');
  assert.equal(redactSecretShaped('token: abc'), 'token: abc');
  assert.equal(redactValue({ author: 'Jane Doe' }).author, 'Jane Doe');
  assert.equal(redactValue({ ok: 1 }).ok, 1);
});

test('pinned behaviour from tests/herdr-bridge.test.js still holds', () => {
  const out = redactSecretShaped('key=sk-abc123DEF456 and done');
  assert.ok(!out.includes('sk-abc123DEF456'));
  assert.ok(out.includes('[redacted]'));
  const v = redactValue({ a: { Authorization: 'Bearer whatever', nested: { password: 'pw' } }, ok: 1 });
  assert.equal(v.a.Authorization, '[redacted]');
  assert.equal(v.a.nested.password, '[redacted]');
  assert.equal(v.ok, 1);
});
