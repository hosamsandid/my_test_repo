// Team-member system-prompt modes (#1511) — browser (ESM) copy.
//
// Same logic as the CJS twin `admin-console/api/prompt-modes.js` /
// `orchestrator/prompt-modes.js` (kept in sync; change together). The editor
// uses it to resolve the initial mode, render the mode labels, and preview the
// combined effective prompt (AC9). See the CJS module header for the full
// three-mode contract.

export const PROMPT_MODES = Object.freeze({
  INHERIT: 'inherit',
  ADDITIONAL: 'additional',
  EXCLUSIVE: 'exclusive',
});

export const PROMPT_MODE_LABELS = Object.freeze({
  [PROMPT_MODES.INHERIT]: 'Inherit from team',
  [PROMPT_MODES.ADDITIONAL]: 'Additional input',
  [PROMPT_MODES.EXCLUSIVE]: 'Exclusive overriding input',
});

export const ADDITION_HEADING = '## Agent-specific instructions';

export function isPromptMode(m) {
  return m === PROMPT_MODES.INHERIT
    || m === PROMPT_MODES.ADDITIONAL
    || m === PROMPT_MODES.EXCLUSIVE;
}

// Resolve a member config's three-way prompt mode. Explicit `promptMode` wins;
// otherwise the legacy two-state model is inferred (non-empty `systemPrompt` →
// exclusive, else inherit) so every existing agent opens in the right mode with
// no migration and no change to its effective prompt (AC7).
export function resolvePromptMode(cfg) {
  const m = cfg && cfg.promptMode;
  if (isPromptMode(m)) return m;
  return (cfg && typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0)
    ? PROMPT_MODES.EXCLUSIVE
    : PROMPT_MODES.INHERIT;
}

// Compose a member's effective base prompt from its mode, the resolved team
// template and the member's own authored text. Mirrors the CJS twin exactly.
export function composeMemberPrompt(mode, teamTemplate, ownText) {
  const team = typeof teamTemplate === 'string' ? teamTemplate : '';
  const own = typeof ownText === 'string' ? ownText : '';
  if (mode === PROMPT_MODES.EXCLUSIVE) return own;
  if (mode === PROMPT_MODES.ADDITIONAL) {
    const addition = own.trim();
    // AC8: empty addition ≡ inherit — no stray separator/heading.
    if (!addition) return team;
    const base = team.trimEnd();
    const prefix = base ? `${base}\n\n` : '';
    // AC3/AC4: team first, addition last, under a delimited labelled section.
    return `${prefix}---\n\n${ADDITION_HEADING}\n\n${addition}`;
  }
  return team; // inherit (AC2)
}
