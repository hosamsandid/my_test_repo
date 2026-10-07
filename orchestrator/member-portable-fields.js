'use strict';

const { PROMPT_MODES, isPromptMode } = require('./prompt-modes');
const { normalizeMemoryLimit } = require('./memory-limit');

// #2813: the portable per-role settings a team member records verbatim from
// its add-member opts — own prompt text + `promptMode`, `modelOverride`,
// `memoryLimit`. Shared by addTeamMember's stub and materialised branches
// (and therefore by pool-instance spawns). Without an explicit promptMode the
// legacy shape is kept byte-identical: a non-empty override is the member's
// own (exclusive) prompt, its absence the inherit signal. An inherit-mode
// member never stores own text, so team-prompt edits keep reaching it.
function memberPortableFields(opts) {
  const promptMode = isPromptMode(opts.promptMode) ? opts.promptMode : null;
  const own = typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0
    ? opts.systemPromptOverride : null;
  const memoryLimit = normalizeMemoryLimit(opts.memoryLimit);
  return {
    ...(own && promptMode !== PROMPT_MODES.INHERIT ? { systemPrompt: own } : {}),
    ...(promptMode ? { promptMode } : {}),
    ...(typeof opts.modelOverride === 'string' && opts.modelOverride.trim() ? { modelOverride: opts.modelOverride.trim() } : {}),
    ...(memoryLimit ? { memoryLimit } : {}),
  };
}

module.exports = { memberPortableFields };
