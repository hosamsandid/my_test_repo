'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  TEMPLATE_ID_RE,
  validateTemplate,
  validateTriggers,
  validatePorts,
  safeTemplateFile,
  templateOrigin,
  hasPrompt,
} = require('./agent-templates-store');

const minimal = { id: 'my-role', displayName: 'My Role', prompt: 'Do the thing.' };

test('TEMPLATE_ID_RE accepts slugs and rejects bad ids', () => {
  assert.ok(TEMPLATE_ID_RE.test('developer'));
  assert.ok(TEMPLATE_ID_RE.test('code-reviewer'));
  assert.ok(TEMPLATE_ID_RE.test('role2'));
  assert.ok(!TEMPLATE_ID_RE.test('-lead'));
  assert.ok(!TEMPLATE_ID_RE.test('My-Role'));
  assert.ok(!TEMPLATE_ID_RE.test('a b'));
  assert.ok(!TEMPLATE_ID_RE.test('a_b'));
  assert.ok(!TEMPLATE_ID_RE.test('../etc'));
});

test('hasPrompt honours prompt and promptTemplate', () => {
  assert.ok(hasPrompt({ prompt: 'x' }));
  assert.ok(hasPrompt({ promptTemplate: 'x' }));
  assert.ok(!hasPrompt({}));
  assert.ok(!hasPrompt({ prompt: '   ' }));
});

test('validateTemplate: minimal create payload is valid', () => {
  const r = validateTemplate(minimal, { requireId: true });
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.equal(r.value.id, 'my-role');
});

test('validateTemplate: promptTemplate satisfies the prompt requirement', () => {
  const r = validateTemplate({ id: 'r', displayName: 'R', promptTemplate: 'Hi {{teamName}}' }, { requireId: true });
  assert.ok(r.valid, JSON.stringify(r.errors));
});

test('validateTemplate: create requires id', () => {
  const r = validateTemplate({ displayName: 'X', prompt: 'p' }, { requireId: true });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => /id is required/.test(e)));
});

test('validateTemplate: invalid slug id rejected', () => {
  const r = validateTemplate({ id: 'Bad Id', displayName: 'X', prompt: 'p' }, { requireId: true });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => /slug/.test(e)));
});

test('validateTemplate: missing displayName and prompt rejected', () => {
  const r = validateTemplate({ id: 'r' }, { requireId: true });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => /displayName/.test(e)));
  assert.ok(r.errors.some(e => /prompt/.test(e)));
});

test('validateTemplate: PUT expectId mismatch rejected', () => {
  const r = validateTemplate({ id: 'other', displayName: 'X', prompt: 'p' }, { expectId: 'mine' });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => /does not match/.test(e)));
});

test('validateTemplate: PUT with matching id (or no id) is fine', () => {
  assert.ok(validateTemplate({ id: 'mine', displayName: 'X', prompt: 'p' }, { expectId: 'mine' }).valid);
  assert.ok(validateTemplate({ displayName: 'X', prompt: 'p' }, { expectId: 'mine' }).valid);
});

test('validateTemplate: non-object body rejected', () => {
  assert.ok(!validateTemplate(null).valid);
  assert.ok(!validateTemplate('x').valid);
  assert.ok(!validateTemplate([]).valid);
});

test('validateTriggers: well-formed triggers pass', () => {
  assert.deepEqual(validateTriggers(undefined), []);
  assert.deepEqual(validateTriggers([
    { id: 't1', type: 'cron', cron: '0 3 * * 1' },
    { id: 't2', type: 'github-event', events: ['issues.labeled'], emits: ['started'] },
  ]), []);
});

test('validateTriggers: malformed triggers rejected', () => {
  assert.ok(validateTriggers('nope').length > 0);
  assert.ok(validateTriggers([{ type: 'cron' }]).some(e => /id is required/.test(e)));
  assert.ok(validateTriggers([{ id: 'x', type: 'bogus' }]).some(e => /type must be/.test(e)));
  assert.ok(validateTriggers([{ id: 'x', type: 'cron', events: 'no' }]).some(e => /events must be/.test(e)));
  assert.ok(validateTriggers([{ id: 'x', type: 'cron', emits: [1] }]).some(e => /emits must be/.test(e)));
});

test('validatePorts: valid ports pass', () => {
  assert.deepEqual(validatePorts({}), []);
  assert.deepEqual(validatePorts({
    patternRole: 'author',
    stageAffinity: ['Build'],
    github: { producesPr: true },
    ports: { consumes: [{ artifact: 'issue', fromSlot: 'stage-entry' }], produces: { pr: true } },
  }), []);
});

test('validatePorts: malformed ports rejected', () => {
  assert.ok(validatePorts({ patternRole: 'wizard' }).some(e => /patternRole/.test(e)));
  assert.ok(validatePorts({ stageAffinity: 'Build' }).some(e => /stageAffinity/.test(e)));
  assert.ok(validatePorts({ ports: [] }).some(e => /ports must be an object/.test(e)));
  assert.ok(validatePorts({ ports: { consumes: 'x' } }).some(e => /consumes must be an array/.test(e)));
  assert.ok(validatePorts({ ports: { consumes: [{ artifact: 'nope' }] } }).some(e => /artifact must be/.test(e)));
  assert.ok(validatePorts({ ports: { produces: [] } }).some(e => /produces must be an object/.test(e)));
  assert.ok(validatePorts({ github: [] }).some(e => /github must be an object/.test(e)));
});

test('validateTemplate: malformed triggers/ports bubble up', () => {
  const r = validateTemplate({ ...minimal, triggers: [{ type: 'x' }], ports: 5 }, { requireId: true });
  assert.ok(!r.valid);
  assert.ok(r.errors.some(e => /triggers/.test(e)));
  assert.ok(r.errors.some(e => /ports must be an object/.test(e)));
});

test('safeTemplateFile: resolves valid ids under base', () => {
  const base = '/workspace/agent-templates';
  assert.equal(safeTemplateFile(base, 'developer'), path.join(base, 'developer.json'));
});

test('safeTemplateFile: rejects traversal and invalid ids', () => {
  const base = '/workspace/agent-templates';
  assert.equal(safeTemplateFile(base, '../secrets'), null);
  assert.equal(safeTemplateFile(base, 'a/b'), null);
  assert.equal(safeTemplateFile(base, 'Bad'), null);
  assert.equal(safeTemplateFile(base, ''), null);
});

test('templateOrigin: classifies the three tiers', () => {
  assert.equal(templateOrigin(true, true), 'override');
  assert.equal(templateOrigin(false, true), 'user');
  assert.equal(templateOrigin(true, false), 'default');
});
