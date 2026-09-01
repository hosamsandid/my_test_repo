import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_HINT,
  authTypeLabel,
  buildChatGroups,
  chatSelection,
  chatSelectable,
  chatTrigger,
  chatNotice,
  effectiveModelLabel,
  resolveChatSelectAction,
  chatResetAction,
} from './chat-model-selector.js';

const OPTIONS = {
  endpointId: 'ep1',
  endpointName: 'Acme',
  authType: 'api-key',
  baseUrl: 'https://acme.example',
  endpointOverride: null,
  envEndpointId: 'ep1',
  defaultModelId: 'm1',
  override: null,
  models: [{ id: 'm1', displayName: 'Opus 4.8', kind: 'opus' }, { id: 'm2', displayName: 'Haiku', kind: 'haiku' }],
  endpoints: [
    { id: 'ep1', name: 'Acme', scope: 'team', authType: 'api-key', baseUrl: 'https://acme.example', defaultModelId: 'm1', models: [{ id: 'm1', displayName: 'Opus 4.8', kind: 'opus' }, { id: 'm2', displayName: 'Haiku', kind: 'haiku' }] },
    { id: 'ep2', name: 'Globex', scope: 'system', authType: 'oauth-token', baseUrl: '', defaultModelId: 'g1', models: [{ id: 'g1', displayName: 'Sonnet 5', kind: 'sonnet' }] },
  ],
  canSwitch: true,
  teamId: 'default',
};

test('authTypeLabel maps auth types', () => {
  assert.equal(authTypeLabel('oauth-token'), 'Subscription');
  assert.equal(authTypeLabel('api-key'), 'API key');
  assert.equal(authTypeLabel(null), 'Default (.env)');
});

test('buildChatGroups carries scope badge, detail rows and plain (no-kind) model labels', () => {
  const groups = buildChatGroups(OPTIONS);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].scope, 'team');
  assert.equal(groups[1].scope, 'system');
  // AC4: provider detail rows present.
  assert.deepEqual(groups[0].details[0], { label: 'Auth', value: 'API key' });
  assert.equal(groups[0].details[1].label, 'Endpoint');
  // oauth provider with no baseUrl → only the auth row.
  assert.equal(groups[1].details.length, 1);
  assert.equal(groups[1].details[0].value, 'Subscription');
  // AC9: labels have no "· kind" suffix.
  assert.equal(groups[0].models[0].label, 'Opus 4.8');
  assert.ok(!groups[0].models[0].label.includes('·'));
  assert.equal(groups[0].models[0].isDefault, true);
  assert.equal(groups[0].models[1].isDefault, false);
});

test('buildChatGroups adds a context-window caption per model, omitted when unknown (#1718 AC1 / #1717)', () => {
  const groups = buildChatGroups({
    endpoints: [{
      id: 'ep1', name: 'Acme', scope: 'team', authType: 'api-key', baseUrl: 'https://acme.example',
      defaultModelId: 'big',
      models: [
        { id: 'big', displayName: 'Big', contextWindow: 1_000_000 },              // explicit 1M window
        { id: 'claude-sonnet-4-5', displayName: 'Sonnet', contextWindow: 200_000 }, // explicit 200K window
        { id: 'claude-opus-4-8', displayName: 'Opus' },                           // #1717: Claude family, no
                                                                                  // discovered window → no caption
                                                                                  // (never the old 200K guess)
        { id: 'mystery', displayName: 'Mystery' },                                // unknown → no caption
      ],
    }],
  });
  assert.equal(groups[0].models[0].meta, '1M context');
  assert.equal(groups[0].models[1].meta, '200K context');
  assert.equal('meta' in groups[0].models[2], false);
  assert.equal('meta' in groups[0].models[3], false);
});

test('buildChatGroups tolerates missing options', () => {
  assert.deepEqual(buildChatGroups(null), []);
  assert.deepEqual(buildChatGroups({}), []);
});

test('chatSelection resolves effective endpoint + model', () => {
  assert.deepEqual(chatSelection(OPTIONS), { endpointId: 'ep1', modelId: 'm1' });
  assert.deepEqual(chatSelection({ ...OPTIONS, override: 'm2' }), { endpointId: 'ep1', modelId: 'm2' });
  assert.deepEqual(chatSelection({ ...OPTIONS, endpointId: null, defaultModelId: null }), { endpointId: null, modelId: null });
});

test('chatSelectable follows canSwitch + available providers', () => {
  assert.equal(chatSelectable(OPTIONS), true);
  assert.equal(chatSelectable({ ...OPTIONS, canSwitch: false }), false);
  assert.equal(chatSelectable({ ...OPTIONS, endpoints: [] }), false);
});

test('chatTrigger reflects override state', () => {
  assert.deepEqual(chatTrigger(OPTIONS).tone, 'default');
  assert.equal(chatTrigger(OPTIONS).showOverrideDot, false);
  const ov = chatTrigger({ ...OPTIONS, override: 'm2' });
  assert.equal(ov.tone, 'override');
  assert.equal(ov.showOverrideDot, true);
  const noEp = chatTrigger({ ...OPTIONS, endpointId: null });
  assert.equal(noEp.label, 'Default (.env)');
});

test('effectiveModelLabel resolves override-then-default against the catalogue (#1704)', () => {
  // Default in effect → the env default model's display name.
  assert.equal(effectiveModelLabel(OPTIONS), 'Opus 4.8');
  // Per-agent override wins over the default.
  assert.equal(effectiveModelLabel({ ...OPTIONS, override: 'm2' }), 'Haiku');
  // No catalogue → no model segment (never a dangling "· ").
  assert.equal(effectiveModelLabel({ ...OPTIONS, models: [] }), null);
  // No effective model id → null.
  assert.equal(effectiveModelLabel({ ...OPTIONS, defaultModelId: null }), null);
  // Effective id not present in the catalogue → fall back to the raw id.
  assert.equal(effectiveModelLabel({ ...OPTIONS, override: 'gone' }), 'gone');
  assert.equal(effectiveModelLabel(null), null);
});

test('chatTrigger shows "<model> · <provider>" on the closed button — model first (#1845)', () => {
  // Default selection: effective (default) model FIRST, then provider.
  assert.equal(chatTrigger(OPTIONS).label, 'Opus 4.8 · Acme');
  // labelParts drives the two-span trigger: lead (model) never truncates, tail
  // (provider) ellipsises (AC4).
  assert.deepEqual(chatTrigger(OPTIONS).labelParts, { lead: 'Opus 4.8', tail: 'Acme' });
  // Title reflects the same model-first ordering (AC7).
  assert.match(chatTrigger(OPTIONS).title, /Opus 4\.8 · Acme/);
  // Override changes the model shown immediately, dot still set.
  const ov = chatTrigger({ ...OPTIONS, override: 'm2' });
  assert.equal(ov.label, 'Haiku · Acme');
  assert.deepEqual(ov.labelParts, { lead: 'Haiku', tail: 'Acme' });
  assert.equal(ov.showOverrideDot, true);
  // Degraded — no provider bound: provider label only, no model segment, no parts (AC6).
  const noEp = chatTrigger({ ...OPTIONS, endpointId: null });
  assert.equal(noEp.label, 'Default (.env)');
  assert.equal(noEp.labelParts, null);
  // Degraded — provider bound, empty catalogue: provider only, no "· ", no parts (AC6).
  const empty = chatTrigger({ ...OPTIONS, models: [] });
  assert.equal(empty.label, 'Acme');
  assert.equal(empty.labelParts, null);
  assert.ok(!empty.label.includes('·'));
  assert.equal(empty.title, 'Model provider: Acme');
});

test('chatNotice explains the read-only / disabled reasons', () => {
  assert.equal(chatNotice(OPTIONS), null);
  assert.match(chatNotice({ ...OPTIONS, canSwitch: false }), /permission/);
  assert.match(chatNotice({ ...OPTIONS, canSwitch: false, endpoints: [] }), /No model providers/);
  assert.match(chatNotice({ ...OPTIONS, endpointId: null }), /No model provider is bound/);
  assert.match(chatNotice({ ...OPTIONS, models: [] }), /no models/i);
});

test('resolveChatSelectAction: same provider → live model change', () => {
  // pick m2 under the current provider ep1
  assert.deepEqual(resolveChatSelectAction(OPTIONS, 'ep1', 'm2'), { kind: 'model', modelId: 'm2' });
  // pick the current provider's default → clears the override
  assert.deepEqual(resolveChatSelectAction({ ...OPTIONS, override: 'm2' }, 'ep1', 'm1'), { kind: 'model', modelId: null });
});

test('resolveChatSelectAction: other provider → provider switch needing confirm', () => {
  const act = resolveChatSelectAction(OPTIONS, 'ep2', 'g1');
  assert.equal(act.kind, 'provider');
  assert.equal(act.endpointId, 'ep2');
  assert.equal(act.needsConfirm, true);
  assert.equal(act.providerName, 'Globex');
  // g1 is ep2's default → no model pin, just the provider switch
  assert.equal(act.modelId, null);
});

test('resolveChatSelectAction: other provider, non-default model → carries the model pin', () => {
  const opts = {
    ...OPTIONS,
    endpoints: [
      OPTIONS.endpoints[0],
      { id: 'ep2', name: 'Globex', scope: 'system', defaultModelId: 'g1', models: [{ id: 'g1' }, { id: 'g2' }] },
    ],
  };
  const act = resolveChatSelectAction(opts, 'ep2', 'g2');
  assert.equal(act.kind, 'provider');
  assert.equal(act.modelId, 'g2');
});

test('chatResetAction picks the right clear path', () => {
  assert.deepEqual(chatResetAction({ ...OPTIONS, endpointOverride: 'ep2' }), { kind: 'provider' });
  assert.deepEqual(chatResetAction({ ...OPTIONS, override: 'm2' }), { kind: 'model' });
  assert.deepEqual(chatResetAction(OPTIONS), { kind: 'none' });
});

test('CHAT_HINT distinguishes the chat surface from assist billing', () => {
  assert.match(CHAT_HINT, /runs on/);
  assert.doesNotMatch(CHAT_HINT, /bill against/);
});
