import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import installed from 'sanitize-html';
import bundled from '../server/vendor/gmail-html-sanitizer.mjs';
import { safeGmailHtml } from '../server/gmail-content.mjs';

// A manifest-only dependency update must not leave the deployed artifact behind.
test('vendored sanitizer license version matches the locked package', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  const version = lock.packages['node_modules/sanitize-html'].version;
  const licenses = readFileSync(new URL('../server/vendor/gmail-html-LICENSES.txt', import.meta.url), 'utf8');
  assert.ok(licenses.split('\n').includes(`sanitize-html@${version}`));
});

const cases = [
  ['safe formatting', '<p>Hello <strong>world</strong> <a href="https://example.test/">link</a></p>', {}],
  ['refresh script URL', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    { allowedTags: ['meta'], allowedAttributes: { meta: ['http-equiv', 'content'] } }],
  ['refresh data URL', '<meta http-equiv="refresh" content="0;url=data:text/html,test">',
    { allowedTags: ['meta'], allowedAttributes: { meta: ['http-equiv', 'content'] } }],
  ['implied noscript close', '<div><noscript></div><img src="https://example.test/beacon"></noscript>',
    { allowedTags: ['div', 'img'], allowedAttributes: { img: ['src'] }, nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'] }],
  ['malformed comment', '<p>Hello</p><![CDATA[ x > <noscript>]]><a href="https://example.test/">hidden</a></noscript>', {}],
];
for (const [name, input, options] of cases) {
  test(`vendored sanitizer matches pinned package: ${name}`, () => {
    assert.equal(bundled(input, options), installed(input, options));
  });
}
test('Room HTML policy removes active elements and keeps safe links protected', () => {
  const value = safeGmailHtml('<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><svg><animate attributeName="href" values="javascript:alert(1)" /></svg><script>alert(1)</script><p>Readable <a href="https://example.test/">link</a><a href="javascript:alert(1)">unsafe</a></p>');
  assert.doesNotMatch(value, /<(?:meta|svg|animate|script)\b|javascript:/i);
  assert.match(value, /Readable/);
  assert.match(value, /rel="noopener noreferrer"/);
  assert.match(value, /href="https:\/\/example.test\/"/);
});
