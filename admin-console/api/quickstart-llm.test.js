'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  slugifyName,
  quickstartLlmSystemPrompt,
  validateQuickstartLlmInput,
  nextUniqueId,
  llmEnvId,
  llmAgentId,
} = require('./quickstart-llm');

test('slugifyName: lowercases, hyphenates, trims edge separators', () => {
  assert.equal(slugifyName('My Assistant'), 'my-assistant');
  assert.equal(slugifyName('  Hello!!World  '), 'hello-world');
  assert.equal(slugifyName('---edge---'), 'edge');
  assert.equal(slugifyName(''), '');
  assert.equal(slugifyName(null), '');
});

test('quickstartLlmSystemPrompt: names the agent and never mentions a repository', () => {
  const p = quickstartLlmSystemPrompt('Research Buddy');
  assert.match(p, /Research Buddy/);
  // Must not instruct the agent to work against a cloned repo (it has none),
  // though it may state plainly that it has *no* repository.
  assert.doesNotMatch(p, /cloned into your workspace|the repository is|explore and modify the code/i);
  assert.match(p, /no repository/i);
  // falls back to a safe default when blank
  assert.match(quickstartLlmSystemPrompt('   '), /Assistant/);
});

test('validateQuickstartLlmInput: requires a display name', () => {
  const r = validateQuickstartLlmInput({ displayName: '   ', binding: { llmEndpointId: 'ep1' }, endpointCount: 1 });
  assert.equal(r.code, 'no_name');
  assert.ok(r.error);
});

test('validateQuickstartLlmInput: no provider registered → guided no_llm_endpoint (AC5)', () => {
  const r = validateQuickstartLlmInput({ displayName: 'Bot', binding: { llmEndpointId: null }, endpointCount: 0 });
  assert.equal(r.code, 'no_llm_endpoint');
  assert.match(r.error, /Model Providers/);
});

test('validateQuickstartLlmInput: provider exists but none selected → blocks with no_llm_endpoint', () => {
  const r = validateQuickstartLlmInput({ displayName: 'Bot', binding: { llmEndpointId: null }, endpointCount: 2 });
  assert.equal(r.code, 'no_llm_endpoint');
  assert.match(r.error, /Select a model provider/);
});

test('validateQuickstartLlmInput: surfaces a binding resolution error verbatim', () => {
  const r = validateQuickstartLlmInput({
    displayName: 'Bot',
    binding: { error: "LLM endpoint 'ghost' not found" },
    endpointCount: 1,
  });
  assert.equal(r.error, "LLM endpoint 'ghost' not found");
  assert.equal(r.code, undefined);
});

test('validateQuickstartLlmInput: valid input returns trimmed name + binding', () => {
  const r = validateQuickstartLlmInput({
    displayName: '  Helper  ',
    binding: { llmEndpointId: 'ep1', defaultModelId: 'sonnet' },
    endpointCount: 1,
  });
  assert.deepEqual(r, { name: 'Helper', llmEndpointId: 'ep1', defaultModelId: 'sonnet' });
});

test('validateQuickstartLlmInput: missing defaultModelId normalizes to null', () => {
  const r = validateQuickstartLlmInput({
    displayName: 'Helper',
    binding: { llmEndpointId: 'ep1' },
    endpointCount: 1,
  });
  assert.equal(r.defaultModelId, null);
});

test('nextUniqueId: returns the base when free, else the first open suffix', () => {
  assert.equal(nextUniqueId('agent', () => false), 'agent');
  const taken = new Set(['agent', 'agent-2', 'agent-3']);
  assert.equal(nextUniqueId('agent', id => taken.has(id)), 'agent-4');
});

test('llmEnvId / llmAgentId: derive stable ids from the display name (dup edge case)', () => {
  const none = () => false;
  assert.equal(llmEnvId('My Assistant', none), 'llm-my-assistant');
  assert.equal(llmAgentId('My Assistant', none), 'my-assistant-agent');

  // Duplicate handling stays consistent with the repo-first flow: bump a suffix.
  const takenEnv = new Set(['llm-bot']);
  assert.equal(llmEnvId('Bot', id => takenEnv.has(id)), 'llm-bot-2');
  const takenAgent = new Set(['bot-agent', 'bot-agent-2']);
  assert.equal(llmAgentId('Bot', id => takenAgent.has(id)), 'bot-agent-3');
});

test('llmAgentId: name that slugs to empty falls back to a safe id', () => {
  const none = () => false;
  assert.equal(llmEnvId('!!!', none), 'llm-agent');
  assert.equal(llmAgentId('!!!', none), 'agent');
});
