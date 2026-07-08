// context-window.js — pure helpers for the context-window fill indicator
// (#471). Kept dependency-free so they can be unit tested with node --test.
//
// A model's context-window limit is resolved in two steps:
//   1. An explicit `contextWindow` configured on the model entry (custom LLM
//      endpoints already support this field) always wins.
//   2. Otherwise, fall back to a small table of known Claude model families —
//      every currently released Claude 4.x model shares the same 200k-token
//      window. Anything not covered by either resolves to `null`, and the
//      caller must hide the indicator rather than show a misleading value.

const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

const KNOWN_MODEL_CONTEXT_WINDOWS = [
  { pattern: /^claude-/i, tokens: CLAUDE_CONTEXT_WINDOW_TOKENS },
];

export function resolveContextWindowTokens(model) {
  const explicit = model?.contextWindow;
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const id = model?.id;
  if (typeof id !== 'string' || !id) return null;
  const known = KNOWN_MODEL_CONTEXT_WINDOWS.find(({ pattern }) => pattern.test(id));
  return known ? known.tokens : null;
}

// Thresholds are an implementation choice (the issue leaves them open):
// unobtrusive below 70%, warning from 70%, critical from 90%.
const WARNING_THRESHOLD_PCT = 70;
const CRITICAL_THRESHOLD_PCT = 90;

export function computeContextFillLevel(inputTokens, contextWindowTokens) {
  if (typeof inputTokens !== 'number' || inputTokens < 0) return null;
  if (typeof contextWindowTokens !== 'number' || contextWindowTokens <= 0) return null;
  const pct = Math.min(100, Math.round((inputTokens / contextWindowTokens) * 100));
  const level =
    pct >= CRITICAL_THRESHOLD_PCT ? 'critical' :
    pct >= WARNING_THRESHOLD_PCT ? 'warning' :
    'normal';
  return { pct, level };
}
