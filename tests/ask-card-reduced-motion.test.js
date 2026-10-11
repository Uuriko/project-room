// WAVE-500 guild 8 (a11y), worker 4/50 — DESIGN SYNC seq 10497.
// Ask-card status transitions must be one-shot and INSTANT when
// prefers-reduced-motion is set. The status change itself is gated on an
// actual status CHANGE (human-experience.js only rewrites
// faceStatus.dataset.faceStatus when status.key differs), so a transition
// must never be keyed to card mount: folded updates re-mount cards
// constantly (panel.innerHTML, faceActions.replaceChildren), and a
// mount-gated transition becomes a loop in practice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cssUrl = new URL('../src/human-experience.css', import.meta.url);
const jsUrl = new URL('../src/human-experience.js', import.meta.url);
const css = () => readFileSync(cssUrl, 'utf8');

function reduceBlock(source) {
  const start = source.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
  assert.ok(start >= 0, 'human-experience.css has a prefers-reduced-motion: reduce block');
  return source.slice(start);
}

test('ask-card status is instant under prefers-reduced-motion: no animation or transition survives', () => {
  const block = reduceBlock(css());
  assert.match(block, /\.assistant-face-status/, 'the reduce block covers the face status');
  assert.match(block, /::before/, 'the reduce block covers the status dot');
  assert.match(block, /animation\s*:\s*none/, 'animations are killed under reduced motion');
  assert.match(block, /transition\s*:\s*none/, 'transitions are killed under reduced motion');
});

test('the reduce guard wins over any motion stylesheet, including ask-motion.css', () => {
  const block = reduceBlock(css());
  assert.match(block, /!important/, 'the reduce guard uses !important so it cannot be overridden by later stylesheets');
});

test('no keyframes are defined in the ask-card stylesheet: the file itself ships no motion to gate', () => {
  assert.doesNotMatch(css(), /@keyframes/, 'human-experience.css defines no keyframes');
});

test('the face status write is gated on an actual status CHANGE, never on repaint or re-mount', () => {
  const js = readFileSync(jsUrl, 'utf8');
  assert.match(
    js,
    /faceStatus\.dataset\.faceStatus\s*!==\s*status\.key/,
    'dataset.faceStatus is only rewritten when the status key actually changed'
  );
});
