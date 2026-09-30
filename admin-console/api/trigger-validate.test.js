'use strict';

// #2626: server-side cron validation and unique trigger ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  cronExpressionError, triggerIdError, newTriggerIdError, annotateTriggerList,
  stripTriggerAnnotations, resolveTriggerIndex,
} = require('./trigger-validate');
const { rawTriggerError, validateProcessTemplate } = require('./process-template');

test('cronExpressionError: the acceptance-criteria expressions and common shapes are valid', () => {
  for (const ok of [
    '0 9 * * 1-5', '*/15 8-18 * * *', '0 9 1,15 * *', '0 0 * * 0',
    '* * * * *', '0 0 * * 7', '5/15 * * * *', '1-5/2 * * * *', '*/59 * * * *',
    '0 0 * JAN-MAR MON-FRI', '0 0 * jan sun', '0 0 * * mon-fri/2', '0 0 L * *', '0 0 * * 1#2',
    '0 0 29 2 *', ' 0 9 * * * ', '00 09 * * *', '0 0 30,31 1-2 *', '0 0 31 2 1',
    '@daily', '@hourly', '@weekly', '@monthly', '@yearly', '@annually', '@midnight', '@DAILY',
  ]) {
    assert.equal(cronExpressionError(ok), null, ok);
  }
});

test('cronExpressionError: the expressions the UI test stored are rejected', () => {
  const cases = {
    '75 * * * *': /^Invalid cron expression "75 \* \* \* \*": minute must be 0–59/,
    '*/60 * * * *': /minute step "\/60" is wider than the field — use 1–59/,
    '*/100 * * * *': /minute step "\/100"/,
    '*/-5 * * * *': /minute step "\/-5" must be a whole number of at least 1/,
    '-1 * * * *': /minute "-1" .*negative values are not allowed/,
    '0 0 40 * *': /day of month must be 1–31 \(got 40\)/,
    '0 0 -3 * *': /day of month "-3"/,
    'abc': /expected 5 fields .* got 1/,
  };
  for (const [expr, re] of Object.entries(cases)) assert.match(cronExpressionError(expr), re, expr);
});

test('cronExpressionError: range, step, field-count and macro violations', () => {
  const cases = {
    '0 24 * * *': /hour must be 0–23/,
    '0 0 0 * *': /day of month must be 1–31/,
    '0 0 * 13 *': /month must be 1–12 or JAN–DEC/,
    '0 0 * 0 *': /month must be 1–12/,
    '0 0 * * 8': /day of week must be 0–7 or SUN–SAT/,
    '0 0 * FOO *': /month "FOO" is not a valid value/,
    '5-2 * * * *': /range "5-2" runs backwards/,
    '*/0 * * * *': /at least 1/,
    '0,,5 * * * *': /empty list entry/,
    '0/5/2 * * * *': /more than one "\/"/,
    '0 0 * * */7': /day of week step "\/7" is wider than the field — use 1–6/,
    '0 0 * * 1#6': /<weekday>#<1–5>/,
    '* * * *': /got 4/,
    '* * * * * *': /got 6/,
    '@reboot': /unknown macro/,
  };
  for (const [expr, re] of Object.entries(cases)) assert.match(cronExpressionError(expr), re, expr);
  for (const empty of [undefined, null, '', '   ', 42]) {
    assert.match(cronExpressionError(empty), /needs a cron expression/, String(empty));
  }
});

// Review B2/S1: croniter rejects a day-of-week list mixing `d#n` with other
// entries, and never fires `d#n` with a restricted day-of-month.
test('cronExpressionError: <weekday>#<n> only in an all-# list with day of month *', () => {
  for (const expr of ['0 9 * * 2,1#2', '0 9 * * MON#2,FRI', '0 9 * * 1-5,1#2', '0 9 * * 1#1,2']) {
    assert.match(cronExpressionError(expr), /mixes <weekday>#<n> with other entries/, expr);
  }
  for (const expr of ['0 9 15 * 1#2', '0 9 L * 1#2', '0 9 1-30 * 1#2', '0 9 15 * 1#2,3#1']) {
    assert.match(cronExpressionError(expr), /cannot be combined with a restricted day of month/, expr);
  }
  for (const expr of ['0 9 * * 1#2,3#4', '0 9 * * MON#2', '0 9 */1 * 1#2', '0 9 1-31 * 1#2']) {
    assert.equal(cronExpressionError(expr), null, expr);
  }
});

test('cronExpressionError: a day-of-month no selected month has can never fire', () => {
  assert.match(cronExpressionError('0 9 30 2 *'), /day 30 never occurs .* can never fire/);
  assert.match(cronExpressionError('0 9 31 4 *'), /day 31 never occurs/);
  assert.match(cronExpressionError('0 9 31 APR,JUN *'), /day 31 never occurs/);
  // One listed month that has the day is enough; a restricted weekday ORs in.
  assert.equal(cronExpressionError('0 9 31 4,5 *'), null);
  assert.equal(cronExpressionError('0 9 30 2 1'), null);
  // #2661: more never-fire shapes the console refuses too.
  assert.match(cronExpressionError('0 9 31 9,11 *'), /day 31 never occurs/);
  assert.match(cronExpressionError('0 9 30,31 FEB *'), /day 30 never occurs/);
  assert.ok(cronExpressionError('0 9 30-L 2 *'));
});

// #2661: the console validator (src/pages/agent-chat/cron-format.js) refuses
// the same never-fire expressions and keeps the fireable neighbours valid.
test('cronExpressionError: console and server agree on never-fire expressions', async () => {
  const client = await import('../src/pages/agent-chat/cron-format.js');
  for (const expr of [
    '0 9 30 2 *', '0 9 31 2 *', '0 9 31 4 *', '0 9 31 APR,JUN *', '0 9 30,31 FEB *',
    '0 9 15 * 1#2', '0 9 8 * 1#1', '0 9 L * 1#2', '0 9 1-30 * 1#2',
  ]) {
    assert.ok(cronExpressionError(expr), `server should reject ${expr}`);
    assert.ok(client.cronExpressionError(expr), `console should reject ${expr}`);
  }
  for (const expr of ['0 9 29 2 *', '0 9 31 4,5 *', '0 9 30 2 1', '0 9 * * 1#2', '0 9 1-31 * 1#2', '0 9 L 2 *']) {
    assert.equal(cronExpressionError(expr), null, `server should accept ${expr}`);
    assert.equal(client.cronExpressionError(expr), null, `console should accept ${expr}`);
  }
});

test('rawTriggerError: cron triggers are validated; an unchanged legacy expression passes an update', () => {
  assert.match(rawTriggerError({ type: 'cron', cron: '75 * * * *', prompt: 'x' }), /minute must be 0–59/);
  assert.match(rawTriggerError({ type: 'cron', prompt: 'x' }), /needs a cron expression/);
  assert.equal(rawTriggerError({ type: 'cron', cron: '0 9 * * 1-5', prompt: 'x' }), null);
  const legacy = { id: 'old', type: 'cron', cron: '75 * * * *', prompt: 'x' };
  assert.equal(rawTriggerError({ ...legacy, enabled: false }, legacy), null, 'toggling a legacy entry stays possible');
  assert.match(rawTriggerError({ ...legacy, cron: '76 * * * *' }, legacy), /minute must be 0–59/);
  // Other types never get a cron check.
  assert.equal(rawTriggerError({ type: 'once', cron: 'garbage', at: '2026-10-01T09:00:00' }), null);
});

test('the bundle validator rejects a template role with an invalid cron trigger', () => {
  const bundle = (cron) => ({
    processTemplateVersion: 1,
    roles: [{ id: 'dev', triggers: [{ id: 'nightly', type: 'cron', cron, prompt: 'x' }] }],
  });
  const r = validateProcessTemplate(bundle('0 0 40 * *'));
  assert.equal(r.ok, false);
  assert.match(r.error, /role dev: trigger nightly: .*day of month must be 1–31/);
  assert.doesNotMatch(String(validateProcessTemplate(bundle('0 0 1 * *')).error || ''), /cron/);
});

test('triggerIdError / newTriggerIdError: shape → 400, taken id → 409', () => {
  for (const ok of ['t1727712000000', 'x-dup', 'nightly.review_2', 'A', 'a'.repeat(64)]) {
    assert.equal(triggerIdError(ok), null, ok);
  }
  for (const bad of ['', ' x', 'has space', 'a/b', '-lead', '.lead', 'ümlaut', 'a:b', 'a'.repeat(65), 7, null, undefined]) {
    assert.match(triggerIdError(bad), /Invalid trigger id/, String(bad));
  }
  const existing = [{ id: 'x-dup', type: 'cron' }];
  assert.deepEqual(newTriggerIdError(existing, 'fresh'), null);
  assert.equal(newTriggerIdError(existing, 'x-dup').status, 409);
  assert.match(newTriggerIdError(existing, 'x-dup').error, /"x-dup" already exists/);
  assert.equal(newTriggerIdError(existing, 'a b').status, 400);
});

test('annotateTriggerList: flags invalid crons and shared ids without touching clean entries', () => {
  const clean = { id: 'ok', type: 'cron', cron: '0 9 * * *' };
  const stored = [
    clean,
    { id: 'x-dup', type: 'cron', cron: '0 9 * * *' },
    { id: 'bad', type: 'cron', cron: '75 * * * *' },
    { id: 'x-dup', type: 'cron', cron: '0 9 * * 1' },
    { id: 'gh', type: 'github-event', events: ['push'] },
  ];
  const before = JSON.stringify(stored);
  const out = annotateTriggerList(stored);
  assert.equal(JSON.stringify(stored), before, 'the stored array is never mutated');
  assert.equal(out[0], clean);
  assert.equal(out[4], stored[4]);
  assert.match(out[1].invalid, /Duplicate trigger id "x-dup" — 2 triggers share it/);
  assert.equal(out[1].position, 1);
  assert.equal(out[3].position, 3);
  assert.match(out[2].invalid, /minute must be 0–59 \(got 75\) — the agent skips this trigger/);
  assert.equal('position' in out[2], false, 'a unique id needs no position');
  assert.deepEqual(annotateTriggerList(null), []);
});

test('stripTriggerAnnotations drops the view-only GET fields', () => {
  assert.deepEqual(stripTriggerAnnotations({ id: 'a', invalid: 'x', position: 3, cron: '* * * * *' }), { id: 'a', cron: '* * * * *' });
});

test('resolveTriggerIndex: first match by default, an exact row with ?position=', () => {
  const list = [{ id: 'a' }, { id: 'x-dup' }, { id: 'x-dup' }];
  assert.deepEqual(resolveTriggerIndex(list, 'x-dup'), { index: 1 });
  assert.deepEqual(resolveTriggerIndex(list, 'x-dup', '2'), { index: 2 });
  assert.deepEqual(resolveTriggerIndex(list, 'x-dup', 2), { index: 2 });
  assert.equal(resolveTriggerIndex(list, 'nope').status, 404);
  assert.equal(resolveTriggerIndex(list, 'x-dup', '0').status, 404, 'position must hold that id');
  assert.equal(resolveTriggerIndex(list, 'x-dup', '9').status, 404);
  assert.equal(resolveTriggerIndex(list, 'x-dup', '-1').status, 400);
  assert.equal(resolveTriggerIndex(list, 'x-dup', 'abc').status, 400);
});

// api.js cannot be imported in a unit test (see pool-control-routes.test.js);
// the route wiring is read off the source, comments stripped.
const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
function routeBody(marker, nextMarker) {
  const start = SRC.indexOf(marker);
  assert.ok(start >= 0, `api.js should contain ${marker}`);
  const end = SRC.indexOf(nextMarker, start + marker.length);
  assert.ok(end > start, `could not bound ${marker}`);
  return SRC.slice(start, end);
}

test('wiring: GET annotates, POST checks id shape/uniqueness and rawTriggerError before writing', () => {
  const get = routeBody("app.get('/api/agents/:id/triggers'", "app.get('/api/scripts/:name'");
  assert.match(get, /res\.json\(annotateTriggerList\(/);
  const post = routeBody("app.post('/api/agents/:id/triggers'", "app.put('/api/agents/:id/triggers/:triggerId'");
  const idCheck = post.indexOf('newTriggerIdError(triggers, newTrigger.id)');
  const guard = post.indexOf('rawTriggerError(newTrigger)');
  const write = post.indexOf('putTriggers(id, triggers)');
  assert.ok(idCheck > 0 && guard > 0 && write > idCheck && write > guard, 'both guards run before the write');
  assert.match(post, /res\.status\(ide\.status\)/);
  assert.match(post, /stripTriggerAnnotations\(\{ id: `t\$\{Date\.now\(\)\}`, \.\.\.req\.body \}\)/);
});

test('wiring: PUT and DELETE address one row (first match or ?position=)', () => {
  const put = routeBody("app.put('/api/agents/:id/triggers/:triggerId'", 'async function deleteAgentTrigger');
  assert.match(put, /resolveTriggerIndex\(triggers, triggerId, req\.query\.position\)/);
  assert.match(put, /rawTriggerError\(merged, prev\)/);
  assert.match(put, /id: triggerId \}\)/, 'the body can never rename the trigger');
  assert.doesNotMatch(put, /findIndex/);
  const del = routeBody('async function deleteAgentTrigger', 'async function restoreAgentTrigger');
  assert.match(del, /triggers\.splice\(at\.index, 1\)/);
  assert.doesNotMatch(del, /\.filter\(/, 'a delete must never remove every entry sharing the id');
  const route = routeBody("app.delete('/api/agents/:id/triggers/:triggerId'", 'async function reconcileTeamOutcomesForAgent');
  assert.match(route, /deleteAgentTrigger\(id, triggerId, position\)/);
});
