import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pluginEventOptions,
  defaultPluginId,
  PLACEHOLDER_LABEL,
  NOT_GRANTED_SUFFIX,
  NOT_INSTALLED_SUFFIX,
  NO_PLUGINS_NOTICE,
  DRAFT_NOTICE,
  GRANT_UNKNOWN_NOTICE,
} from './plugin-event-options.js';

const plugin = (id, name, extra = {}) => ({ id, ok: true, installed: true, sidecarRunning: true, manifest: { id, name }, ...extra });
const INSTALLED = [plugin('jira', 'Jira'), plugin('dummy-echo', 'Dummy echo'), plugin('netzplan', 'Network plan')];

test('placeholder is always the first option and is selectable', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '' });
  assert.deepEqual(options[0], { value: '', label: PLACEHOLDER_LABEL, disabled: false });
});

test('granted plugins come first and are enabled; ungranted are disabled with the reason in the label', () => {
  const { options, notice } = pluginEventOptions({
    installed: INSTALLED, grant: [{ id: 'netzplan', scopeGranularity: 'team' }], currentId: '',
  });
  const [, first, ...rest] = options;
  assert.equal(first.value, 'netzplan');
  assert.equal(first.disabled, false);
  assert.equal(first.label, 'Network plan (netzplan)');
  for (const o of rest) {
    assert.equal(o.disabled, true, `${o.value} must be disabled`);
    assert.ok(o.label.endsWith(NOT_GRANTED_SUFFIX), `${o.value} must say why`);
  }
  assert.equal(notice, null);
});

test('label is the manifest name with the id in parentheses; id alone when they coincide or the name is missing', () => {
  const installed = [plugin('jira', 'jira'), { id: 'bare', ok: true, installed: true, manifest: {} }];
  const { options } = pluginEventOptions({ installed, grant: null, currentId: '' });
  assert.equal(options.find(o => o.value === 'jira').label, 'jira');
  assert.equal(options.find(o => o.value === 'bare').label, 'bare');
});

test('grant null (unknown) offers every installed plugin un-marked and says so', () => {
  const { options, notice } = pluginEventOptions({ installed: INSTALLED, grant: null, currentId: '' });
  assert.equal(options.length, 1 + INSTALLED.length);
  assert.ok(options.slice(1).every(o => o.disabled === false));
  assert.ok(options.slice(1).every(o => !o.label.endsWith(NOT_GRANTED_SUFFIX)));
  assert.equal(notice, GRANT_UNKNOWN_NOTICE);
});

test('draft mode offers every installed plugin and carries the draft notice, whatever the grant', () => {
  const { options, notice } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '', draft: true });
  assert.equal(options.length, 1 + INSTALLED.length);
  assert.ok(options.slice(1).every(o => o.disabled === false));
  assert.equal(notice, DRAFT_NOTICE);
});

test('a plugin whose manifest is broken is not offered', () => {
  const installed = [plugin('jira', 'Jira'), { id: 'broken', ok: false, installed: true, manifest: null, errors: ['x'] }];
  const { options } = pluginEventOptions({ installed, grant: null, currentId: '' });
  assert.ok(!options.some(o => o.value === 'broken'));
});

test('a stored id that is not installed is retained as a selectable option that says so', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }], currentId: 'gone' });
  const retained = options.find(o => o.value === 'gone');
  assert.ok(retained, 'the stored value must still be offered');
  assert.equal(retained.disabled, false);
  assert.equal(retained.label, `gone${NOT_INSTALLED_SUFFIX}`);
  assert.equal(options[1].value, 'gone', 'retained value sits right after the placeholder so the select shows it');
});

test('a stored id that IS installed is not duplicated', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: 'jira' });
  assert.equal(options.filter(o => o.value === 'jira').length, 1);
});

test('a stored id that is installed but ungranted stays selectable (editing must round-trip), still labelled ungranted', () => {
  const { options } = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'netzplan' }], currentId: 'jira' });
  const jira = options.find(o => o.value === 'jira');
  assert.equal(jira.disabled, false);
  assert.ok(jira.label.endsWith(NOT_GRANTED_SUFFIX));
});

test('no installed plugins → placeholder only and the no-plugins notice', () => {
  const { options, notice } = pluginEventOptions({ installed: [], grant: [], currentId: '' });
  assert.equal(options.length, 1);
  assert.equal(notice, NO_PLUGINS_NOTICE);
});

test('tolerates non-array inputs', () => {
  const { options } = pluginEventOptions({ installed: undefined, grant: 'nope', currentId: undefined });
  assert.equal(options.length, 1);
});

test('defaultPluginId: exactly one selectable non-retained plugin → its id; otherwise empty', () => {
  const one = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }], currentId: '' }).options;
  assert.equal(defaultPluginId(one), 'jira');
  const two = pluginEventOptions({ installed: INSTALLED, grant: [{ id: 'jira' }, { id: 'netzplan' }], currentId: '' }).options;
  assert.equal(defaultPluginId(two), '');
  const none = pluginEventOptions({ installed: INSTALLED, grant: [], currentId: '' }).options;
  assert.equal(defaultPluginId(none), '');
  // A retained (uninstalled) value never counts as the "one" — it is a leftover, not a choice.
  const retainedOnly = pluginEventOptions({ installed: [], grant: [], currentId: 'gone' }).options;
  assert.equal(defaultPluginId(retainedOnly), '');
  // Unknown grant: every installed plugin is selectable, so only a single install auto-picks.
  const single = pluginEventOptions({ installed: [plugin('jira', 'Jira')], grant: null, currentId: '' }).options;
  assert.equal(defaultPluginId(single), 'jira');
});
