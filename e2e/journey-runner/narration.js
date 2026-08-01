// Journey → walkthrough-video narration (epic #741, T4/#744).
//
// Pure and dependency-free (no js-yaml, no Playwright) so it unit-tests with
// plain `node --test`. It turns a validated journey doc into the ordered list of
// voiceover entries the video lane feeds to Edge-TTS (scripts/generate-tts.py)
// and, in beat order, to the muxer (scripts/mux-narration.mjs). The same
// stepAudioId is reused by the T5 (#745) generator to line up each beat's
// screenshot with its generated MP3, so the mapping lives in exactly one place.

// The per-step audio key: the screenshot slug when the step captures one,
// otherwise the step id. Both are §2.3 slugs; the schema guarantees screenshot
// ids are unique per journey and that a voiceover-bearing step has one of the
// two, so this is defined and unique for every narrated step.
function stepKey(step) {
  return (step && (step.screenshot || step.id)) || null;
}

// Namespaced audio id `<journeyId>-<stepKey>` — namespacing by journey lets one
// audio manifest hold several chapters without id collisions. Returns null when
// the step has no key (nothing to narrate).
function stepAudioId(journeyId, step) {
  const key = stepKey(step);
  return key ? `${journeyId}-${key}` : null;
}

// Ordered [{ id, text }] narration entries for a validated journey doc — one per
// step that carries a (non-empty) `voiceover`, in document order. Shape matches
// what generate-tts.py and mux-narration.mjs consume.
function journeyNarration(doc) {
  const journeyId = doc && doc.id;
  const entries = [];
  for (const step of (doc && doc.steps) || []) {
    if (typeof step.voiceover !== 'string' || !step.voiceover.trim()) continue;
    const id = stepAudioId(journeyId, step);
    if (!id) continue; // schema forbids this, but stay defensive.
    entries.push({ id, text: step.voiceover.trim() });
  }
  return entries;
}

module.exports = { stepKey, stepAudioId, journeyNarration };
