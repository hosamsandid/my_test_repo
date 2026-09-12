'use strict';

/*
 * Pure decision core for the LLM-only QuickStart path (#1624): create a single
 * standalone chat agent from nothing more than a display name + a Model Provider
 * — no GitHub URL, SSH key, or token. The sibling of the repo-first
 * POST /api/quickstart. Kept as a pure module (no fs / no express) so the input
 * validation and id derivation are unit-testable without an HTTP harness (the
 * #651 convention); api.js is the thin adapter that resolves the live registry
 * and writes the env / agent.
 */

// Mirrors slugifyRepoSegment in api.js (linear trim, no anchored regex backtrack).
function slugifyName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// System prompt for a repo-less chat agent — deliberately says nothing about a
// repository or GitHub, since this agent has neither.
function quickstartLlmSystemPrompt(displayName) {
  const name = String(displayName || 'Assistant').trim() || 'Assistant';
  return [
    `You are **${name}**, a helpful AI assistant.`,
    ``,
    `You chat directly with the user — answer questions, think through problems, and draft or revise text. You have no repository or GitHub access, so keep your help conversational and grounded in what the user tells you.`,
  ].join('\n');
}

// Validate the LLM-only QuickStart input. Pure: the caller resolves the model
// binding against the live registry (resolveLlmBinding) and passes the result
// plus the provider count in.
//   - endpointCount 0            → guided "no provider" error (AC5)
//   - no / empty provider choice → "select a provider" error (blocks submit)
//   - binding.error              → surfaced verbatim
// Returns { error, code? } on rejection, else { name, llmEndpointId, defaultModelId }.
function validateQuickstartLlmInput({ displayName, binding, endpointCount }) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) return { error: 'A display name is required.', code: 'no_name' };
  if (!endpointCount) {
    return {
      error: 'No model provider configured. Add one under "Model Providers" first.',
      code: 'no_llm_endpoint',
    };
  }
  if (binding && binding.error) return { error: binding.error };
  if (!binding || !binding.llmEndpointId) {
    return { error: 'Select a model provider.', code: 'no_llm_endpoint' };
  }
  return {
    name,
    llmEndpointId: binding.llmEndpointId,
    defaultModelId: binding.defaultModelId || null,
  };
}

// Return `base`, or `base-2`, `base-3`, … — the first id `exists(id)` reports free.
function nextUniqueId(base, exists) {
  const stem = base || 'x';
  let id = stem;
  let n = 2;
  while (exists(id)) id = `${stem}-${n++}`;
  return id;
}

// One repo-less environment per agent (recommendation #2: isolation, matching the
// per-repo QuickStart), keyed off the display-name slug.
function llmEnvId(name, exists) {
  const slug = slugifyName(name) || 'agent';
  return nextUniqueId(`llm-${slug}`, exists);
}

function llmAgentBaseId(name) {
  const slug = slugifyName(name) || 'agent';
  return slug === 'agent' ? 'agent' : `${slug}-agent`;
}

function llmAgentId(name, exists) {
  return nextUniqueId(llmAgentBaseId(name), exists);
}

module.exports = {
  slugifyName,
  quickstartLlmSystemPrompt,
  validateQuickstartLlmInput,
  nextUniqueId,
  llmEnvId,
  llmAgentId,
  llmAgentBaseId,
};
