#!/usr/bin/env node
// Generates a minimal valid WAV file (440 Hz sine wave, 2 seconds, 16 kHz, mono, 16-bit PCM)
// for use as the STT e2e test fixture.
//
// NOTE: This is a synthetic tone, not a real spoken-word recording. The Whisper model may
// transcribe it as empty, silence, or gibberish. The API-level test assertions that check for
// specific expected words ('hello', 'test', 'recording') will only pass against a real Whisper
// instance that receives a proper speech recording. For meaningful transcription testing,
// REPLACE this fixture with an actual spoken-word WAV of the phrase "Hello, this is a test
// recording" recorded at 16 kHz mono 16-bit PCM.
//
// The test suite's beforeAll health-check will skip the entire suite if the Whisper container
// is not reachable, so the synthetic tone is safe as a structural placeholder.

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const DURATION_SECONDS = 2;
const FREQUENCY_HZ = 440;

const numSamples = SAMPLE_RATE * DURATION_SECONDS;
const dataSize = numSamples * CHANNELS * (BIT_DEPTH / 8);
const headerSize = 44;
const totalSize = headerSize + dataSize;

const buf = Buffer.alloc(totalSize);
let offset = 0;

function writeStr(s) {
  buf.write(s, offset, 'ascii');
  offset += s.length;
}
function writeUInt32LE(n) {
  buf.writeUInt32LE(n, offset);
  offset += 4;
}
function writeUInt16LE(n) {
  buf.writeUInt16LE(n, offset);
  offset += 2;
}

// RIFF chunk
writeStr('RIFF');
writeUInt32LE(totalSize - 8); // file size minus RIFF header
writeStr('WAVE');

// fmt sub-chunk
writeStr('fmt ');
writeUInt32LE(16);           // sub-chunk size (PCM)
writeUInt16LE(1);            // audio format: PCM
writeUInt16LE(CHANNELS);
writeUInt32LE(SAMPLE_RATE);
writeUInt32LE(SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)); // byte rate
writeUInt16LE(CHANNELS * (BIT_DEPTH / 8));               // block align
writeUInt16LE(BIT_DEPTH);

// data sub-chunk
writeStr('data');
writeUInt32LE(dataSize);

// PCM samples: 440 Hz sine wave
for (let i = 0; i < numSamples; i++) {
  const t = i / SAMPLE_RATE;
  const sample = Math.round(32767 * Math.sin(2 * Math.PI * FREQUENCY_HZ * t));
  buf.writeInt16LE(sample, offset);
  offset += 2;
}

const outPath = path.resolve(__dirname, 'stt-test.wav');
fs.writeFileSync(outPath, buf);
console.log(`Written: ${outPath} (${buf.length} bytes, ${DURATION_SECONDS}s @ ${SAMPLE_RATE}Hz mono ${BIT_DEPTH}-bit PCM)`);
