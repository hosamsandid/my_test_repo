// Journey → PPTX deck builder (docs/journey-spec-concept.md §3.2 item 2, §10
// decision 3, #708).
//
// Three pieces, layered like the Markdown target (render.js / index.js):
//
//   buildDeckModel(journeys, manifests)  — PURE. Journeys + run manifests in,
//     an ordered list of slide descriptors out. No filesystem, no pptxgenjs, no
//     date/git access — so the same inputs always describe the same deck and the
//     model is unit-testable without a rendering engine.
//   buildDeckBuffer(model, {resolveImage}) — renders the model to a .pptx byte
//     buffer via pptxgenjs. The only impurity is the caller-supplied resolveImage
//     hook, which turns a logical image ref into an on-disk path (or null); all fs
//     concerns stay in deck.js, mirroring the render.js↔index.js split.
//   validateDeck(buffer, expectations) — structural check of the produced deck by
//     reading it back as an OOXML zip (§3.2, "there is no PowerPoint in CI or agent
//     containers, so validation must be scriptable"): required parts present, slide
//     count matches, and the speaker notes carry each step's narrative verbatim.
'use strict';

const { renderNarrative, screenshotIndex } = require('./render');

// Deck-level title (presentation metadata + reused by the CLI banner). The deck
// reproduces the hand-authored walkthrough, so it carries the same product name.
const DECK_TITLE = 'Agent Studio — Walkthrough';

// 16:9 widescreen canvas, in inches (pptxgenjs LAYOUT_WIDE). Kept here so the
// layout maths below reads against named constants instead of magic numbers.
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

// Build the ordered slide model. For each journey (already sorted by the loader
// on `order` then id): one section slide (its title), then one content slide per
// step that has narrative and/or a slide visual. `manifestsById` maps journeyId →
// its run manifest (or null); it resolves a step's `screenshot: <name>` to the
// captured file, exactly as render.js does for the Markdown page.
function buildDeckModel(journeys, manifestsById = {}) {
  const slides = [];
  for (const journey of journeys) {
    slides.push({ type: 'section', journeyId: journey.id, title: journey.title });

    const shots = screenshotIndex(manifestsById[journey.id]);
    for (const step of journey.steps || []) {
      const narrative = step.narrative ? renderNarrative(step.narrative) : '';
      const isConcept = step.kind === 'narrative-only';

      // Resolve the slide visual. A concept (narrative-only) slide may carry a
      // static `visual` asset (§2.1); a normal step shows its captured screenshot,
      // but only when the run actually produced it (same guard as render.js — a
      // step whose capture is missing degrades to a text slide, never a broken
      // image).
      let image = null;
      if (isConcept) {
        if (step.visual) image = { kind: 'visual', src: step.visual };
      } else if (step.screenshot && shots.has(step.screenshot)) {
        image = { kind: 'screenshot', journeyId: journey.id, file: shots.get(step.screenshot) };
      }

      // A step with neither narrative nor a visual is pure plumbing (e.g. logging
      // in) — it produces no slide, just as it produces no doc output (§2.1).
      if (!narrative && !image) continue;

      slides.push({
        type: isConcept ? 'concept' : 'step',
        journeyId: journey.id,
        stepId: step.id || step.screenshot || null,
        title: journey.title,
        // Narrative goes verbatim into the speaker notes (§3.2: "narrative goes
        // into speaker notes"). renderNarrative only normalises blank-line runs;
        // the words and paragraph breaks the author wrote survive unchanged.
        notes: narrative,
        image,
      });
    }
  }
  return { title: DECK_TITLE, journeyCount: journeys.length, slides };
}

// Render the model to a .pptx byte buffer. `resolveImage(ref)` returns an absolute
// path for a screenshot/visual ref, or null when the file is absent (the slide
// then falls back to showing the narrative as body text so it is never blank).
async function buildDeckBuffer(model, { resolveImage } = {}) {
  // Required lazily so the pure model path (and its tests) need neither pptxgenjs
  // nor its native-ish zip machinery loaded.
  const Pptx = require('pptxgenjs');
  const pres = new Pptx();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = model.title;
  pres.author = 'e2e/docgen';
  pres.subject = 'Agent Studio journey walkthrough (generated — do not hand-edit)';

  for (const slide of model.slides) {
    const s = pres.addSlide();

    if (slide.type === 'section') {
      // Section divider: the journey title, centred.
      s.addText(slide.title, {
        x: 0.5, y: SLIDE_H / 2 - 0.9, w: SLIDE_W - 1, h: 1.8,
        fontSize: 40, bold: true, align: 'center', valign: 'middle',
      });
      continue;
    }

    if (slide.notes) s.addNotes(slide.notes);

    const imgPath = slide.image && resolveImage ? resolveImage(slide.image) : null;
    if (imgPath) {
      // The screenshot/visual is the slide. `contain` keeps its aspect ratio
      // inside the frame regardless of the captured viewport.
      s.addImage({
        path: imgPath,
        x: 0.3, y: 0.4, w: SLIDE_W - 0.6, h: SLIDE_H - 0.8,
        sizing: { type: 'contain', w: SLIDE_W - 0.6, h: SLIDE_H - 0.8 },
      });
    } else if (slide.notes) {
      // No visual (concept slide, or a narrative step whose capture is missing):
      // show the narrative on the slide body so it carries content, not just a
      // blank canvas with notes.
      s.addText(slide.notes, {
        x: 0.8, y: 0.7, w: SLIDE_W - 1.6, h: SLIDE_H - 1.4,
        fontSize: 18, align: 'left', valign: 'top',
      });
    }
  }

  return pres.write({ outputType: 'nodebuffer' });
}

// Pull the concatenated text runs (<a:t>…</a:t>) out of an OOXML part, XML-
// unescaped, so the notes text can be compared against the source narrative.
// pptxgenjs serialises the `\n` line breaks it is handed as CRLF (`\r\n`); the CR
// is a serialisation artifact, not part of the narrative, so it is normalised
// away here — the narrative's own words and blank-line breaks are preserved.
function extractRunText(xml) {
  const runs = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml))) runs.push(unescapeXml(m[1]));
  return runs.join('\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Structural validation of a generated deck buffer — the scriptable stand-in for
// opening it in PowerPoint (§3.2). Reads the .pptx back as an OOXML zip and checks
// the required parts exist, the slide count is what the model produced and the
// presentation lists exactly that many slides, and (when `expectedNotes` is given)
// each narrative appears verbatim in the speaker notes. Returns
// { ok, slideCount, noteCount, notesText, errors }.
async function validateDeck(buffer, { expectedSlides, expectedNotes } = {}) {
  const JSZip = require('jszip');
  const errors = [];

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    return { ok: false, slideCount: 0, noteCount: 0, notesText: '', errors: [`not a valid OOXML/zip container: ${err.message}`] };
  }

  const names = Object.keys(zip.files);
  for (const req of ['[Content_Types].xml', 'ppt/presentation.xml']) {
    if (!zip.file(req)) errors.push(`missing required part: ${req}`);
  }

  const slideParts = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const noteParts = names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const slideCount = slideParts.length;

  if (slideCount === 0) errors.push('deck has no slides');
  if (expectedSlides != null && slideCount !== expectedSlides) {
    errors.push(`slide count ${slideCount} does not match expected ${expectedSlides}`);
  }

  // The presentation part must reference exactly as many slides as there are slide
  // parts — a mismatch means a dangling or orphaned slide (structurally broken).
  const presPart = zip.file('ppt/presentation.xml');
  if (presPart) {
    const presXml = await presPart.async('string');
    const listed = (presXml.match(/<p:sldId\b/g) || []).length;
    if (listed !== slideCount) {
      errors.push(`presentation.xml lists ${listed} slide(s) but ${slideCount} slide part(s) exist`);
    }
  }

  // Speaker-notes verbatim check.
  let notesText = '';
  for (const n of noteParts.sort()) {
    notesText += `${extractRunText(await zip.file(n).async('string'))}\n`;
  }
  for (const want of expectedNotes || []) {
    if (want && !notesText.includes(want)) {
      const preview = want.length > 60 ? `${want.slice(0, 60)}…` : want;
      errors.push(`speaker notes missing narrative verbatim: ${JSON.stringify(preview)}`);
    }
  }

  return { ok: errors.length === 0, slideCount, noteCount: noteParts.length, notesText, errors };
}

module.exports = {
  buildDeckModel,
  buildDeckBuffer,
  validateDeck,
  extractRunText,
  DECK_TITLE,
  SLIDE_W,
  SLIDE_H,
};
