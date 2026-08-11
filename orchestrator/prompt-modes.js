'use strict';

// Team-member system-prompt modes (#1511).
//
// A team-member's system prompt has THREE modes, replacing the old two-state
// inherit/"Custom" model:
//
//   inherit    → the team's `systemPromptTemplate` only (unchanged legacy).
//   additional → the team template FOLLOWED BY the member's own text, appended
//                at the end in a clearly delimited section. Stays in sync with
//                team-prompt edits (the composition is re-derived every time).
//   exclusive  → the member's own text fully replaces the team template (the
//                renamed "Custom" — byte-identical effective prompt).
//
// SYNC NOTE: this module is duplicated BYTE-IDENTICALLY as
// `orchestrator/prompt-modes.js` (the orchestrator and admin-console images copy
// disjoint file sets, so a shared pure module lives in both — like
// context-mount.js / usage-log.js). Change both in one commit. The browser copy
// is `admin-console/src/pages/prompt-mode-view.js` (ESM, same logic).

const PROMPT_MODES = Object.freeze({
  INHERIT: 'inherit',
  ADDITIONAL: 'additional',
  EXCLUSIVE: 'exclusive',
});

const PROMPT_MODE_LABELS = Object.freeze({
  [PROMPT_MODES.INHERIT]: 'Inherit from team',
  [PROMPT_MODES.ADDITIONAL]: 'Additional input',
  [PROMPT_MODES.EXCLUSIVE]: 'Exclusive overriding input',
});

// The heading that labels the agent-specific addition inside the composed prompt
// (AC4 — a clearly delimited/labelled section a reader and the agent can tell
// apart from the team instructions).
const ADDITION_HEADING = '## Agent-specific instructions';

function isPromptMode(m) {
  return m === PROMPT_MODES.INHERIT
    || m === PROMPT_MODES.ADDITIONAL
    || m === PROMPT_MODES.EXCLUSIVE;
}

// Resolve a member config's three-way prompt mode. An explicit `promptMode`
// wins; otherwise the legacy two-state model is inferred exactly as the editor
// did before this feature — a non-empty `systemPrompt` string is the renamed
// "Custom" (→ exclusive), its absence (or an empty string) is inherit. This
// inference is what makes every existing agent open in the right mode with NO
// migration and NO change to its effective prompt (AC7). `promptMode` is
// persisted only for `additional` (the one state that cannot be inferred), so
// inherit/exclusive members keep their legacy byte-identical config shape.
function resolvePromptMode(cfg) {
  const m = cfg && cfg.promptMode;
  if (isPromptMode(m)) return m;
  return (cfg && typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0)
    ? PROMPT_MODES.EXCLUSIVE
    : PROMPT_MODES.INHERIT;
}

// Compose a member's effective base prompt from its mode, the resolved team
// template and the member's own authored text (the addition in `additional`,
// the full override in `exclusive`). The derived Outcomes/GitHub blocks (#380/
// #829) are applied ON TOP of this base by the caller — composition happens at
// resolution time, before assembly.
function composeMemberPrompt(mode, teamTemplate, ownText) {
  const team = typeof teamTemplate === 'string' ? teamTemplate : '';
  const own = typeof ownText === 'string' ? ownText : '';
  if (mode === PROMPT_MODES.EXCLUSIVE) return own;
  if (mode === PROMPT_MODES.ADDITIONAL) {
    const addition = own.trim();
    // AC8: an empty addition yields the same effective prompt as inherit — no
    // error, no stray separator or heading left behind.
    if (!addition) return team;
    const base = team.trimEnd();
    const prefix = base ? `${base}\n\n` : '';
    // AC3/AC4: team first, addition last, under a delimited labelled section.
    return `${prefix}---\n\n${ADDITION_HEADING}\n\n${addition}`;
  }
  return team; // inherit (AC2)
}

module.exports = {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  ADDITION_HEADING,
  isPromptMode,
  resolvePromptMode,
  composeMemberPrompt,
};
