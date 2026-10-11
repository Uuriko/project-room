#!/usr/bin/env node
// Render the Room sound recipes (src/room-sounds.js) to 16-bit mono WAV
// previews, so people can hear a cue without opening the app.
//   node scripts/render-room-sounds.mjs [outDir]   (default: ./sound-previews)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOUND_RECIPES, sampleCue, cueDuration } from "../src/room-sounds.js";

export function renderCue(recipe, rate = 44100) {
  const frames = Math.ceil((cueDuration(recipe) + 0.05) * rate), data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) data[i] = sampleCue(recipe, i / rate);
  return data;
}

export function wav(samples, rate = 44100) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buffer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "sound-previews";
  mkdirSync(out, { recursive: true });
  for (const [name, recipe] of Object.entries(SOUND_RECIPES)) {
    const file = join(out, `${name}.wav`);
    writeFileSync(file, wav(renderCue(recipe)));
    console.log(file);
  }
}
