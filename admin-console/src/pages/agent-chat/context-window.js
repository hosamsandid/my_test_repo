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

// #490: with prompt caching active (every `--resume`d session), most of what
// actually occupies the context window shows up as `cacheCreationInput` /
// `cacheReadInput` on the result event, not `input` — counting `input` alone
// systematically understates the fill, down to a misleading "0%"/"0K" on a
// session with substantial history. The fill's numerator is therefore the
// sum of all three.
export function sumContextTokens(tokens) {
  if (!tokens || typeof tokens.input !== 'number') return null;
  const cacheCreation = typeof tokens.cacheCreationInput === 'number' ? tokens.cacheCreationInput : 0;
  const cacheRead = typeof tokens.cacheReadInput === 'number' ? tokens.cacheReadInput : 0;
  return tokens.input + cacheCreation + cacheRead;
}

// #509: a `result` event's own `tokens` is a turn-wide aggregate — the
// entrypoint's stream-json mapper sums/duplicates usage across every internal
// API round-trip in the agentic tool-call loop (one assistant message per
// tool call before the turn's final reply), not a snapshot of what the model
// held in context at any single point. It can therefore be a large multiple
// of the model's real context size once a turn makes several tool calls
// (e.g. the "2240K / 200K" report). `contextTokens` is the entrypoint's
// separate per-call usage snapshot (the last individual assistant message's
// usage this turn) and is the value that should drive the context-fill
// indicator; `tokens` remains correct for cumulative cost/spend tracking
// (#494's costTotals) and is used here only as a fallback for log entries
// written before this fix existed (no `contextTokens` field yet).
export function resolveContextTokensForResult(resultEvent) {
  if (!resultEvent) return null;
  return sumContextTokens(resultEvent.contextTokens) ?? sumContextTokens(resultEvent.tokens);
}

// Toolbar display format (#490): a raw token count rounded to whole
// thousands, e.g. 34_300 -> "34K". Deliberately no "M" abbreviation, even for
// six-figure-plus limits (1_000_000 -> "1000K") — the issue asks for a flat
// "K" scale. Anything under 1000 tokens shows as "0K" rather than rounding
// up to "1K".
export function formatTokenCountK(tokens) {
  if (typeof tokens !== 'number' || tokens < 0) return null;
  if (tokens < 1000) return '0K';
  return `${Math.round(tokens / 1000)}K`;
}
