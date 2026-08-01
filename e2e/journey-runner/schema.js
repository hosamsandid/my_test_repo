// Journey schema v1 validator (docs/journey-spec-concept.md §2.1, #705).
//
// Pure and dependency-free (no Playwright, no js-yaml) so it can be unit-tested
// with plain `node --test`. It validates STRUCTURE only. The hard rule from the
// concept (§2.1, §9) is enforced here structurally: `action`/`assert` are opaque
// `{do, ...params}` pairs — the schema deliberately knows nothing about
// selectors, waits, or control flow, and never will. Step *names* are resolved
// against the step library separately (see step-registry.js / validateStepNames)
// so a hallucinated step can't ship, while the schema stays vocabulary-free.

const JOURNEY_VERSION = 1;

// id / screenshot slugs: lowercase alnum + dashes, matching the artifact
// directory / filename they become (§2.3).
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class JourneyValidationError extends Error {}

function fail(source, msg) {
  throw new JourneyValidationError(`${source}: ${msg}`);
}

// Validate an `action`/`assert` block: must be `{ do: <step-name>, ...params }`.
// params are opaque — we only require `do` to be a non-empty string.
function validateCall(source, where, call) {
  if (call == null) return;
  if (typeof call !== 'object' || Array.isArray(call)) {
    fail(source, `${where} must be a mapping with a "do" key`);
  }
  if (typeof call.do !== 'string' || !call.do.trim()) {
    fail(source, `${where}.do must be a non-empty step name (e.g. "wizard.selectProcessTemplate")`);
  }
}

function validateStep(source, step, i) {
  const at = `steps[${i}]`;
  if (step == null || typeof step !== 'object' || Array.isArray(step)) {
    fail(source, `${at} must be a mapping`);
  }

  const isNarrativeOnly = step.kind === 'narrative-only';
  if (step.kind != null && step.kind !== 'narrative-only') {
    fail(source, `${at}.kind — the only recognised kind is "narrative-only" (got "${step.kind}")`);
  }

  if (step.id != null && (typeof step.id !== 'string' || !SLUG_RE.test(step.id))) {
    fail(source, `${at}.id "${step.id}" must be a slug (lowercase alnum + dashes)`);
  }
  if (step.narrative != null && typeof step.narrative !== 'string') {
    fail(source, `${at}.narrative must be a string`);
  }
  // `voiceover` is the compact narration read aloud in the walkthrough video
  // (epic #741) — distinct from the fuller `narrative` that feeds the deck. It
  // is optional on any step (narrative-only title cards included). Its audio is
  // keyed by the step's screenshot slug, or its id when there is no screenshot,
  // so a narrated step must carry one of the two (see narration.js/stepAudioId).
  if (step.voiceover != null) {
    if (typeof step.voiceover !== 'string' || !step.voiceover.trim()) {
      fail(source, `${at}.voiceover must be a non-empty string when present`);
    }
    if (!step.screenshot && !step.id) {
      fail(source, `${at} carries a voiceover but has no id or screenshot to key its audio — add an "id"`);
    }
  }
  if (step.screenshot != null) {
    if (typeof step.screenshot !== 'string' || !SLUG_RE.test(step.screenshot)) {
      fail(source, `${at}.screenshot "${step.screenshot}" must be a slug (lowercase alnum + dashes)`);
    }
    if (isNarrativeOnly) {
      fail(source, `${at} is narrative-only and cannot carry a screenshot (nothing is rendered to capture)`);
    }
  }

  validateCall(source, `${at}.action`, step.action);
  validateCall(source, `${at}.assert`, step.assert);

  if (isNarrativeOnly) {
    if (step.action || step.assert) {
      fail(source, `${at} is narrative-only and cannot carry an action/assert`);
    }
    if (typeof step.narrative !== 'string' || !step.narrative.trim()) {
      fail(source, `${at} is narrative-only and must carry narrative prose`);
    }
    return;
  }

  // A non-narrative step must DO something observable: run an action, assert, or
  // capture a screenshot. A bare step with only prose should be narrative-only.
  if (!step.action && !step.assert && !step.screenshot) {
    fail(source, `${at} has no action, assert or screenshot — mark it "kind: narrative-only" if it is prose only`);
  }
}

// Validate + normalise a parsed journey document. Returns the document (frozen
// steps) or throws JourneyValidationError with a source-qualified message.
function validateJourney(doc, { source = 'journey' } = {}) {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(source, 'journey must be a top-level mapping');
  }
  if (doc.journeyVersion !== JOURNEY_VERSION) {
    fail(source, `journeyVersion must be ${JOURNEY_VERSION} (got ${JSON.stringify(doc.journeyVersion)})`);
  }
  if (typeof doc.id !== 'string' || !SLUG_RE.test(doc.id)) {
    fail(source, `id "${doc.id}" must be a slug (lowercase alnum + dashes) — it doubles as the artifact directory`);
  }
  if (typeof doc.title !== 'string' || !doc.title.trim()) {
    fail(source, 'title must be a non-empty string');
  }
  if (doc.order != null && typeof doc.order !== 'number') {
    fail(source, 'order must be a number when present');
  }
  if (doc.lanes != null && (!Array.isArray(doc.lanes) || doc.lanes.some((l) => typeof l !== 'string'))) {
    fail(source, 'lanes must be a list of strings when present');
  }
  // Optional per-journey Playwright test budget (ms). Most journeys inherit the
  // project default; a long end-to-end journey (e.g. the IBAN label chain, which
  // materialises a team and crosses two poll boundaries) sets its own ceiling.
  // A journey-level knob, not a step — it does not touch the action/assert
  // vocabulary, so it does not breach the §9 anti-DSL rule.
  if (doc.timeoutMs != null && (typeof doc.timeoutMs !== 'number' || !Number.isFinite(doc.timeoutMs) || doc.timeoutMs <= 0)) {
    fail(source, 'timeoutMs must be a positive number of milliseconds when present');
  }
  if (doc.fixtures != null) {
    if (!Array.isArray(doc.fixtures)) fail(source, 'fixtures must be a list when present');
    doc.fixtures.forEach((fx, i) => {
      if (fx == null || typeof fx !== 'object' || Array.isArray(fx) || typeof fx.fixture !== 'string' || !fx.fixture.trim()) {
        fail(source, `fixtures[${i}] must be a mapping with a "fixture" name (e.g. { fixture: teamEnv, params: {…} })`);
      }
      if (fx.params != null && (typeof fx.params !== 'object' || Array.isArray(fx.params))) {
        fail(source, `fixtures[${i}].params must be a mapping when present`);
      }
    });
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    fail(source, 'steps must be a non-empty list');
  }
  doc.steps.forEach((step, i) => validateStep(source, step, i));

  // Screenshot ids must be unique — they are filenames under the artifact dir.
  const shots = doc.steps.map((s) => s.screenshot).filter(Boolean);
  const dupe = shots.find((s, i) => shots.indexOf(s) !== i);
  if (dupe) fail(source, `duplicate screenshot id "${dupe}" — every capture point must be unique`);

  // Voiceover audio keys (screenshot ?? id) must be unique too — they name the
  // generated MP3s in the shared audio manifest (narration.js/stepAudioId).
  const voKeys = doc.steps.filter((s) => s.voiceover != null).map((s) => s.screenshot || s.id);
  const dupeVo = voKeys.find((k, i) => voKeys.indexOf(k) !== i);
  if (dupeVo) fail(source, `duplicate voiceover key "${dupeVo}" — each narrated step needs a unique id/screenshot`);

  return doc;
}

// Collect the step-library names a journey references (action + assert `do`s),
// deduplicated, in document order. Used to validate names against the registry.
function referencedStepNames(doc) {
  const names = [];
  for (const step of doc.steps || []) {
    for (const call of [step.action, step.assert]) {
      if (call && typeof call.do === 'string' && !names.includes(call.do)) names.push(call.do);
    }
  }
  return names;
}

// Reject any referenced step name that is not in `available` (a Set of the
// registry's known names). This is the AC "runner rejects unknown step names
// with a clear error" — kept pure (takes a name set) so it unit-tests without
// Playwright. The message names the offending step and lists the valid ones.
function validateStepNames(doc, available, { source = 'journey' } = {}) {
  const known = available instanceof Set ? available : new Set(available);
  for (const name of referencedStepNames(doc)) {
    if (!known.has(name)) {
      const list = [...known].sort().join(', ') || '(none registered)';
      fail(source, `unknown step "${name}" — not found in the step library. Known steps: ${list}`);
    }
  }
  return doc;
}

module.exports = {
  JOURNEY_VERSION,
  SLUG_RE,
  JourneyValidationError,
  validateJourney,
  validateStepNames,
  referencedStepNames,
};
