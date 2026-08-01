// PPTX deck generation — filesystem orchestration (#708, docs/journey-spec-concept.md
// §3.2 item 2).
//
// The fs-facing sibling of pptx.js, mirroring how index.js wires render.js: load
// every journey, pair each with the manifest a green run left under the artifacts
// dir, build the pure slide model, render it to a .pptx buffer (resolving each
// image ref to an on-disk path), structurally validate the buffer, then write it
// to `artifacts/agent-studio-walkthrough.pptx`. The artifacts dir is
// parameterisable (E2E_ARTIFACTS_DIR / opts.artifactsDir) so it runs identically
// on a local run's e2e/artifacts and on CI-downloaded artifacts.
'use strict';

const fs = require('fs');
const path = require('path');

const { loadJourneysDir, JOURNEYS_DIR } = require('../journey-runner/loader');
const { buildDeckModel, buildDeckBuffer, validateDeck, DECK_TITLE } = require('./pptx');
const { readManifest, REPO_ROOT, DEFAULT_ARTIFACTS } = require('./index');

// Concept §3.2: `artifacts/agent-studio-walkthrough.pptx`, at the repo root. The
// binary deck is a build artifact (CI-uploaded, human visual-QA'd), never
// committed — see .gitignore (`/artifacts/*.pptx`).
const DEFAULT_DECK = path.resolve(REPO_ROOT, 'artifacts', 'agent-studio-walkthrough.pptx');

// Read a PNG's intrinsic pixel dimensions from its IHDR header (width at byte
// offset 16, height at 20, both big-endian). Returns {w, h} or {w:null, h:null}
// for a non-PNG or unreadable file — the caller then falls back to `contain`
// sizing. Screenshots are always PNG (the Playwright recorder), so this is the
// hot path that lets the deck fit each shot at its true aspect ratio.
function pngSize(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      if (buf.readUInt32BE(0) !== 0x89504e47) return { w: null, h: null };
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { w: null, h: null };
  }
}

// Turn a logical image ref from the model into { path, w, h } (absolute path +
// source pixel dimensions), or null when the file is absent (the slide then
// degrades to a text slide). Screenshots live at <artifactsDir>/<journeyId>/
// <file>; a concept slide's static `visual` is resolved relative to the journeys
// dir (where `visual: diagrams/x.png` sits). The dimensions let buildDeckBuffer
// place each image at its own aspect ratio instead of stretching it.
function resolveImagePath(ref, { artifactsDir, journeysDir }) {
  if (!ref) return null;
  let abs = null;
  if (ref.kind === 'screenshot') abs = path.join(artifactsDir, ref.journeyId, ref.file);
  else if (ref.kind === 'visual') abs = path.resolve(journeysDir, ref.src);
  if (!abs || !fs.existsSync(abs)) return null;
  return { path: abs, ...pngSize(abs) };
}

// Generate the walkthrough deck. Returns a summary the CLI logs, including the
// structural validation result (never throws on an invalid deck — the caller
// decides how to react, so the file is still written for inspection).
async function generateDeck(opts = {}) {
  const journeysDir = opts.journeysDir || JOURNEYS_DIR;
  const artifactsDir = opts.artifactsDir || process.env.E2E_ARTIFACTS_DIR || DEFAULT_ARTIFACTS;
  const outFile = opts.outFile || DEFAULT_DECK;

  const journeys = loadJourneysDir(journeysDir);
  const manifestsById = {};
  for (const journey of journeys) manifestsById[journey.id] = readManifest(artifactsDir, journey.id);

  const model = buildDeckModel(journeys, manifestsById);
  const buffer = await buildDeckBuffer(model, {
    resolveImage: (ref) => resolveImagePath(ref, { artifactsDir, journeysDir }),
  });

  // Structural validation on the in-memory buffer before it hits disk: slide count
  // matches the model, and every step's narrative made it into the speaker notes.
  const expectedNotes = model.slides.filter((s) => s.notes).map((s) => s.notes);
  const validation = await validateDeck(buffer, {
    expectedSlides: model.slides.length,
    expectedNotes,
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buffer);

  return {
    outFile,
    title: DECK_TITLE,
    journeyCount: model.journeyCount,
    slideCount: model.slides.length,
    validation,
    model,
  };
}

module.exports = { generateDeck, resolveImagePath, DEFAULT_DECK };
