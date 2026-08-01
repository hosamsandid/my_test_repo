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
// step that carries a slide VISUAL (a captured screenshot, or a concept step's
// static `visual` asset). `manifestsById` maps journeyId → its run manifest (or
// null); it resolves a step's `screenshot: <name>` to the captured file, exactly
// as render.js does for the Markdown page.
//
// Speaker text is never its own slide. A step's narrative goes verbatim into the
// speaker notes of a screenshot slide — its own, preceded by any narrative from
// prose-only steps that ran before it (intros lead into the visual they set up).
// Narrative left over at the end of a journey (trailing recaps, or a whole
// journey that captured no screenshot) is folded onto the last visual slide, or
// — when the journey has no visual at all — onto the section divider's notes. So
// every authored word survives in the notes and the deck carries no prose-only
// body slides (§3.2: "narrative goes into speaker notes").
function buildDeckModel(journeys, manifestsById = {}) {
  const slides = [];
  for (const journey of journeys) {
    const section = { type: 'section', journeyId: journey.id, title: journey.title, notes: '' };
    slides.push(section);

    const shots = screenshotIndex(manifestsById[journey.id]);
    let pending = []; // rendered narrative from prose-only steps awaiting a visual slide
    let lastVisual = null; // the most recent visual slide, for the end-of-journey flush

    for (const step of journey.steps || []) {
      const narrative = step.narrative ? renderNarrative(step.narrative) : '';
      const isConcept = step.kind === 'narrative-only';

      // Resolve the slide visual. A concept (narrative-only) slide may carry a
      // static `visual` asset (§2.1); a normal step shows its captured screenshot,
      // but only when the run actually produced it (same guard as render.js — a
      // step whose capture is missing contributes its narrative to notes, never a
      // broken image).
      let image = null;
      if (isConcept) {
        if (step.visual) image = { kind: 'visual', src: step.visual };
      } else if (step.screenshot && shots.has(step.screenshot)) {
        image = { kind: 'screenshot', journeyId: journey.id, file: shots.get(step.screenshot) };
      }

      if (image) {
        // A visual is a slide. Its notes are the buffered lead-in narrative plus
        // this step's own, in order — the words and paragraph breaks the author
        // wrote survive unchanged (renderNarrative only normalises blank runs).
        const slide = {
          type: isConcept ? 'concept' : 'step',
          journeyId: journey.id,
          stepId: step.id || step.screenshot || null,
          title: journey.title,
          notes: [...pending, narrative].filter(Boolean).join('\n\n'),
          image,
        };
        slides.push(slide);
        lastVisual = slide;
        pending = [];
      } else if (narrative) {
        // No visual: buffer the speaker text onto the next visual slide's notes
        // rather than emitting a standalone prose slide.
        pending.push(narrative);
      }
      // A step with neither visual nor narrative is pure plumbing (e.g. logging
      // in) — it contributes nothing, just as it produces no doc output (§2.1).
    }

    // Flush any narrative with no visual after it: onto the journey's last visual
    // slide, or — if the journey produced none — onto the section divider's notes,
    // so no authored word is lost yet no prose-only content slide is emitted.
    if (pending.length) {
      const tail = pending.join('\n\n');
      if (lastVisual) lastVisual.notes = [lastVisual.notes, tail].filter(Boolean).join('\n\n');
      else section.notes = tail;
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
      // Section divider: the journey title, centred. A journey that captured no
      // screenshot parks its speaker text in the divider's notes (buildDeckModel).
      if (slide.notes) s.addNotes(slide.notes);
      s.addText(slide.title, {
        x: 0.5, y: SLIDE_H / 2 - 0.9, w: SLIDE_W - 1, h: 1.8,
        fontSize: 40, bold: true, align: 'center', valign: 'middle',
      });
      continue;
    }

    if (slide.notes) s.addNotes(slide.notes);

    // resolveImage returns either a bare path (legacy) or { path, w, h } with the
    // source pixel dimensions; support both.
    const resolved = slide.image && resolveImage ? resolveImage(slide.image) : null;
    let imgPath = null;
    let pxW = null;
    let pxH = null;
    if (typeof resolved === 'string') imgPath = resolved;
    else if (resolved && resolved.path) ({ path: imgPath, w: pxW, h: pxH } = resolved);

    // The content box the screenshot is fitted into (16:9 canvas, small margins).
    const BOX_X = 0.3;
    const BOX_Y = 0.4;
    const BOX_W = SLIDE_W - 0.6;
    const BOX_H = SLIDE_H - 0.8;

    if (imgPath && pxW && pxH) {
      // Fit the image inside the box at its OWN aspect ratio and centre it.
      // Passing exact w/h derived from the source pixels — not a `sizing` box —
      // guarantees pptxgenjs never stretches a screenshot whose capture aspect
      // differs from the frame (screenshots vary: full page vs. element).
      const imgAspect = pxW / pxH;
      const boxAspect = BOX_W / BOX_H;
      let w;
      let h;
      if (imgAspect >= boxAspect) {
        w = BOX_W;
        h = BOX_W / imgAspect;
      } else {
        h = BOX_H;
        w = BOX_H * imgAspect;
      }
      s.addImage({ path: imgPath, x: BOX_X + (BOX_W - w) / 2, y: BOX_Y + (BOX_H - h) / 2, w, h });
    } else if (imgPath) {
      // Dimensions unknown (non-PNG or unreadable) → aspect-preserving `contain`
      // fallback, still never a stretch.
      s.addImage({ path: imgPath, x: BOX_X, y: BOX_Y, w: BOX_W, h: BOX_H, sizing: { type: 'contain', w: BOX_W, h: BOX_H } });
    } else if (slide.notes) {
      // Visual expected but its file is missing (e.g. a concept slide whose static
      // asset isn't on disk): show the narrative on the slide body so it carries
      // content, not a blank canvas.
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
