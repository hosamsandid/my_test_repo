'use strict';

// ─── emits derivation (Process Canvas, #328) ─────────────────────────────────
//
// Outbound label emission — which labels an agent *sets* when it runs — is not
// structured data today: it lives in the natural-language prompt prose ("Add
// `started:<agent>`", "apply the label `dispatch`", "set `stage:td`"). The
// Process Canvas needs that set to draw "emitter → label → listener" edges.
//
// The hybrid approach (epic #335): we never silently author `emits`. This module
// only *suggests* a draft set heuristically from the prompt text; an operator
// confirms/corrects it, and the confirmed set is persisted as a declarative
// `emits[]` field on the trigger. The graph is deterministic from `emits`
// thereafter; this heuristic is just the seed.
//
// A "label" in this codebase is a GitHub label token: a bare word (`ready`,
// `hold`, `dispatch`) or a `namespace:value` token (`stage:td`, `needs:human`,
// `human:fdd-approved`, `started:{{agentId}}`). Template placeholders
// (`{{readyLabel}}`, `{{agentId}}`) are preserved verbatim — they are resolved
// to concrete labels later, at graph-build time, not here.

// A backtick-quoted token that looks like a label. We only mine backticked
// tokens to keep precision high (prose is full of non-label words). The token
// may itself be, or contain, a `{{var}}` placeholder.
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

// Validates the *shape* of a candidate label token (with placeholders allowed).
// Bare: `ready`. Namespaced: `stage:td`. Templated: `{{readyLabel}}`,
// `started:{{agentId}}`. Rejects sentences, paths, code, gh commands, URLs.
const LABEL_SHAPE_RE = /^(?:\{\{[a-z0-9_]+\}\}|[a-z][a-z0-9._-]*)(?::(?:\{\{[a-z0-9_]+\}\}|[a-z0-9._-]+))?$/i;

// Verbs that, appearing shortly before a label token, indicate the agent *sets*
// that label (an outbound emission that can wake another agent). We deliberately
// exclude the bare noun/verb "label" — it collides with the consume phrase
// "with label `X`" — and rely on the unambiguous action verbs below.
const EMIT_CUES = [
  'add', 'adds', 'added', 'adding',
  'set', 'sets', 'setting',
  'apply', 'applies', 'applied', 'applying',
  'attach', 'attaches', 'attached',
  'put', 'puts', 'place', 'places', 'placed',
  'mark', 'marks', 'marked',
  'create', 'creates', 'created',
];

// Prohibitions: if any appears anywhere in the lookback window the candidate
// fails closed regardless of distance ("You never set the `ready` label",
// "NEVER apply `human:*`"). These are unambiguous and common in role prompts.
const PROHIBITION_CUES = [
  'never', "don't", 'do not', 'cannot', "can't", 'must not', 'forbidden',
  'without', 'no longer',
];

// Soft negatives: removals (cleanup, not a wake signal) and listen/trigger
// context. These compete with emit cues by *proximity* — the nearest cue wins —
// so "remove `X` then add `Y`" still attributes Y, not X.
const SOFT_NEGATIVE_CUES = [
  'remove', 'removes', 'removed', 'removing',
  'fires', 'fire', 'wakes', 'wake', 'triggered',
  'listen', 'listens', 'when', 'waits', 'wait', 'labeled', 'labelled',
  'pick up', 'picks up', 'picked up', 'candidate', 'candidates', 'with label',
];

// How many characters before a token we scan for a cue word.
const LOOKBACK = 64;

// Compile a cue list into a word-boundary regex so "set" doesn't match inside
// "reset" / "offset", "add" inside "address", "put" inside "output", etc.
function cuesToRegex(cues) {
  const escaped = cues.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(?:' + escaped.join('|') + ')', 'g');
}
const EMIT_RE = cuesToRegex(EMIT_CUES);
const PROHIBITION_RE = cuesToRegex(PROHIBITION_CUES);
const SOFT_NEGATIVE_RE = cuesToRegex(SOFT_NEGATIVE_CUES);

// Index of the last (rightmost) match of a compiled cue regex in `s`, or -1.
function lastMatchIndex(re, s) {
  let best = -1, m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    best = m.index;
    if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width (none here)
  }
  return best;
}

// Build a short, human-readable context snippet around a match so the operator
// can judge the suggestion ("…then `gh issue edit <n> --add-label dispatch`…").
function snippetAround(text, start, end) {
  const from = Math.max(0, start - 48);
  const to = Math.min(text.length, end + 48);
  let s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) s = '…' + s;
  if (to < text.length) s = s + '…';
  return s;
}

/**
 * Derive candidate emitted labels from a block of prompt text.
 *
 * @param {string} text - prompt / promptTemplate / system-prompt text.
 * @returns {Array<{label: string, sourceSnippet: string, confidence: 'high'|'medium'|'low'}>}
 *   One entry per distinct label, ordered high→low confidence then by first
 *   appearance. Never throws; non-string input yields [].
 */
function deriveEmits(text) {
  if (typeof text !== 'string' || !text) return [];

  const order = ['high', 'medium', 'low'];
  const byLabel = new Map(); // label -> { label, sourceSnippet, confidence }

  let m;
  let prevEnd = 0; // end of the previous backtick token, so a verb from an
                   // earlier labeled clause doesn't bleed onto this token.
  BACKTICK_TOKEN_RE.lastIndex = 0;
  while ((m = BACKTICK_TOKEN_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const raw = m[1].trim();
    if (!LABEL_SHAPE_RE.test(raw)) { prevEnd = end; continue; }

    // Cue window: bounded by the lookback distance AND the previous token, then
    // trimmed to the current sentence/clause (verbs don't cross . ; ! ? newline).
    let before = text.slice(Math.max(prevEnd, start - LOOKBACK), start);
    const boundary = Math.max(
      before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n'),
      before.lastIndexOf('!'), before.lastIndexOf('?'),
    );
    if (boundary >= 0) before = before.slice(boundary + 1);
    before = before.toLowerCase();
    prevEnd = end;

    // Hard gate: an explicit prohibition anywhere in the window kills it.
    if (lastMatchIndex(PROHIBITION_RE, before) >= 0) continue;

    const emitAt = lastMatchIndex(EMIT_RE, before);
    const negAt = lastMatchIndex(SOFT_NEGATIVE_RE, before);

    let confidence;
    if (negAt > emitAt) {
      // The closest cue is a removal/listen context → not an emission.
      continue;
    } else if (emitAt >= 0) {
      // An emit verb is the nearest cue, with no closer soft negative.
      confidence = 'high';
    } else {
      // No cue either way — backticked label-shaped token, ambiguous. Surface it
      // at low confidence so the operator can promote it rather than miss it.
      confidence = 'low';
    }

    const existing = byLabel.get(raw);
    if (!existing || order.indexOf(confidence) < order.indexOf(existing.confidence)) {
      byLabel.set(raw, { label: raw, sourceSnippet: snippetAround(text, start, end), confidence });
    }
  }

  return [...byLabel.values()].sort(
    (a, b) => order.indexOf(a.confidence) - order.indexOf(b.confidence),
  );
}

/**
 * Convenience: derive emits for one trigger, optionally folding in the agent's
 * system prompt (labels are frequently set from the trigger prompt, but the
 * standing system prompt can carry them too — e.g. the Dispatcher). Trigger
 * text wins on snippet/confidence ties because it is the more specific context.
 *
 * @param {{prompt?: string, promptTemplate?: string}} trigger
 * @param {string} [systemPrompt]
 */
function deriveEmitsForTrigger(trigger, systemPrompt) {
  const triggerText = (trigger && (trigger.prompt || trigger.promptTemplate)) || '';
  const order = ['high', 'medium', 'low'];
  const merged = new Map();
  // Trigger first so it takes precedence on equal confidence.
  for (const part of [triggerText, systemPrompt || '']) {
    for (const sug of deriveEmits(part)) {
      const cur = merged.get(sug.label);
      if (!cur || order.indexOf(sug.confidence) < order.indexOf(cur.confidence)) {
        merged.set(sug.label, sug);
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) => order.indexOf(a.confidence) - order.indexOf(b.confidence),
  );
}

module.exports = { deriveEmits, deriveEmitsForTrigger };
