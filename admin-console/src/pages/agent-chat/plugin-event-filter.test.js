import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANY_EVENT_LABEL,
  UNDECLARED_EVENT_SUFFIX,
  pluginEvents,
  eventChoices,
  payloadKeyChoices,
  conditionsFromFilter,
  conditionsToFilter,
  payloadFilterSummary,
  conditionsHeading,
} from './plugin-event-filter.js';

const JIRA = {
  id: 'jira',
  ok: true,
  manifest: {
    name: 'Jira',
    events: [
      {
        name: 'status_changed',
        description: 'A watched issue moved to another status',
        payload: [
          { key: 'toStatus', description: 'the status the issue moved into', example: 'Ready for Dev' },
          { key: 'author', description: 'who moved it' },
        ],
      },
      { name: 'comment_added', payload: [{ key: 'author' }, { key: 'issueKey', example: 'KAN-10' }] },
    ],
  },
};
const ECHO = { id: 'dummy-echo', ok: true, manifest: { name: 'Echo' } };

test('pluginEvents: the declared vocabulary of one installed plugin, [] when it declares none or is unknown', () => {
  assert.equal(pluginEvents([JIRA, ECHO], 'jira').length, 2);
  assert.deepEqual(pluginEvents([JIRA, ECHO], 'dummy-echo'), []);
  assert.deepEqual(pluginEvents([JIRA], 'nope'), []);
  assert.deepEqual(pluginEvents(null, 'jira'), []);
  assert.deepEqual(pluginEvents([{ id: 'jira', ok: false, manifest: null }], 'jira'), []);
});

test('eventChoices: "any event" first, then each declared event labelled name — description', () => {
  assert.deepEqual(eventChoices(pluginEvents([JIRA], 'jira'), ''), [
    { value: '', label: ANY_EVENT_LABEL },
    { value: 'status_changed', label: 'status_changed — A watched issue moved to another status' },
    { value: 'comment_added', label: 'comment_added' },
  ]);
});

test('eventChoices: a stored value the plugin does not declare stays selectable, flagged', () => {
  const choices = eventChoices(pluginEvents([JIRA], 'jira'), 'Ready for Dev');
  assert.deepEqual(choices[choices.length - 1], { value: 'Ready for Dev', label: `Ready for Dev${UNDECLARED_EVENT_SUFFIX}` });
  // …but a declared one is not duplicated
  assert.equal(eventChoices(pluginEvents([JIRA], 'jira'), 'status_changed').length, 3);
});

test('payloadKeyChoices: the chosen event\'s fields; "any event" → the union across events, first description/example wins', () => {
  assert.deepEqual(payloadKeyChoices(pluginEvents([JIRA], 'jira'), 'status_changed'), [
    { key: 'toStatus', description: 'the status the issue moved into', example: 'Ready for Dev' },
    { key: 'author', description: 'who moved it' },
  ]);
  assert.deepEqual(payloadKeyChoices(pluginEvents([JIRA], 'jira'), ''), [
    { key: 'toStatus', description: 'the status the issue moved into', example: 'Ready for Dev' },
    { key: 'author', description: 'who moved it' },
    { key: 'issueKey', example: 'KAN-10' },
  ]);
  assert.deepEqual(payloadKeyChoices(pluginEvents([JIRA], 'jira'), 'unknown_event'), []);
  assert.deepEqual(payloadKeyChoices([], ''), []);
});

test('conditionsFromFilter: wire object → editable rows; nothing → one empty row', () => {
  assert.deepEqual(conditionsFromFilter({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), [
    { key: 'toStatus', value: 'Ready for Dev' },
    { key: 'projectKey', value: 'KAN' },
  ]);
  assert.deepEqual(conditionsFromFilter(null), [{ key: '', value: '' }]);
  assert.deepEqual(conditionsFromFilter(undefined), [{ key: '', value: '' }]);
  assert.deepEqual(conditionsFromFilter('junk'), [{ key: '', value: '' }]);
  assert.deepEqual(conditionsFromFilter({ a: 5, b: '' }), [{ key: '', value: '' }]); // non-string / blank values are not a filter
});

test('conditionsToFilter: rows → wire object; all-empty rows → null (no filter); trims', () => {
  assert.deepEqual(conditionsToFilter([{ key: ' toStatus ', value: ' Ready for Dev ' }]), { ok: true, value: { toStatus: 'Ready for Dev' } });
  assert.deepEqual(conditionsToFilter([{ key: '', value: '' }]), { ok: true, value: null });
  assert.deepEqual(conditionsToFilter([]), { ok: true, value: null });
  assert.deepEqual(conditionsToFilter([{ key: 'a', value: '1' }, { key: '', value: '' }, { key: 'b', value: '2' }]), { ok: true, value: { a: '1', b: '2' } });
});

test('conditionsToFilter: a half-filled row is an error naming the row', () => {
  assert.deepEqual(conditionsToFilter([{ key: 'toStatus', value: '' }]), { ok: false, error: 'Condition 1 needs a value' });
  assert.deepEqual(conditionsToFilter([{ key: 'a', value: '1' }, { key: '', value: 'x' }]), { ok: false, error: 'Condition 2 needs a field' });
});

test('conditionsToFilter: a repeated key keeps the last value', () => {
  assert.deepEqual(conditionsToFilter([{ key: 'a', value: '1' }, { key: 'a', value: '2' }]), { ok: true, value: { a: '2' } });
});

test('payloadFilterSummary: the trigger row copy — "key=value" pairs joined by " · ", or ""', () => {
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev' }), 'toStatus=Ready for Dev');
  assert.equal(payloadFilterSummary({ toStatus: 'Ready for Dev', projectKey: 'KAN' }), 'toStatus=Ready for Dev · projectKey=KAN');
  assert.equal(payloadFilterSummary(null), '');
  assert.equal(payloadFilterSummary({}), '');
});

test('conditionsHeading: names the event whose fields the conditions apply to', () => {
  assert.equal(conditionsHeading('status_changed'), 'fields of status_changed');
  assert.equal(conditionsHeading(' comment_added '), 'fields of comment_added');
  assert.equal(conditionsHeading(''), 'fields of any event this plugin sends');
  assert.equal(conditionsHeading(undefined), 'fields of any event this plugin sends');
});
