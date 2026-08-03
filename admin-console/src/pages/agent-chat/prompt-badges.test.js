import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_POLICY_HELP,
  sessionPolicyLabel,
  autonomyLabel,
  autonomyHelp,
  buildBadges,
  buildSettingRows,
} from './prompt-badges.js';

/* ── sessionPolicyLabel ───────────────────────────────────────────────── */

test('sessionPolicyLabel gives plain wording for the two known policies', () => {
  assert.equal(sessionPolicyLabel('per-invocation'), 'per-invocation (fresh context)');
  assert.equal(sessionPolicyLabel('persistent'), 'persistent (continued context)');
});

test('sessionPolicyLabel defaults empty to persistent but passes unknown tokens through', () => {
  assert.equal(sessionPolicyLabel(''), 'persistent');
  assert.equal(sessionPolicyLabel(undefined), 'persistent');
  assert.equal(sessionPolicyLabel('experimental'), 'experimental');
});

/* ── autonomy wording ─────────────────────────────────────────────────── */

test('autonomyLabel / autonomyHelp branch on the boolean', () => {
  assert.equal(autonomyLabel(true), 'Autonomous');
  assert.equal(autonomyLabel(false), 'Interactive');
  assert.match(autonomyHelp(true), /unattended/i);
  assert.match(autonomyHelp(false), /Chat-driven/i);
});

/* ── buildBadges ──────────────────────────────────────────────────────── */

test('every badge carries a non-empty title tooltip (AC #1)', () => {
  const badges = buildBadges('developer', {
    sessionPolicy: 'per-invocation',
    autonomous: true,
    hasRepository: true,
    hasSkills: true,
    blueprintInstance: true,
  });
  assert.ok(badges.length > 0);
  for (const b of badges) {
    assert.equal(typeof b.label, 'string');
    assert.ok(b.label.length > 0);
    assert.equal(typeof b.title, 'string');
    assert.ok(b.title.length > 0, `badge "${b.label}" must have a tooltip`);
  }
});

test('badge order and set mirror the previous bare-string builder', () => {
  const badges = buildBadges('developer', {
    sessionPolicy: 'per-invocation',
    autonomous: true,
    hasRepository: true,
    hasSkills: true,
    blueprintInstance: true,
  });
  assert.deepEqual(
    badges.map(b => b.label),
    ['developer', 'per-invocation', 'autonomous', 'repo', 'skills', 'from template'],
  );
});

test('the legacy "blueprint" pill is relabelled "from template" (AC #3)', () => {
  const badges = buildBadges('agent', { blueprintInstance: true });
  const labels = badges.map(b => b.label);
  assert.ok(!labels.includes('blueprint'), 'no bare "blueprint" token should surface');
  const fromTemplate = badges.find(b => b.label === 'from template');
  assert.ok(fromTemplate, 'a "from template" pill replaces it');
  assert.match(fromTemplate.title, /template/i);
});

test('non-autonomous agent shows the interactive pill and no optional pills when flags are off', () => {
  const badges = buildBadges('agent', { sessionPolicy: 'persistent', autonomous: false });
  assert.deepEqual(badges.map(b => b.label), ['agent', 'persistent', 'interactive']);
});

test('a null role is omitted', () => {
  const badges = buildBadges(null, { autonomous: false });
  assert.deepEqual(badges.map(b => b.label), ['interactive']);
});

test('an unknown sessionPolicy still gets a fallback tooltip', () => {
  const badges = buildBadges('agent', { sessionPolicy: 'experimental' });
  const pill = badges.find(b => b.label === 'experimental');
  assert.ok(pill);
  assert.ok(pill.title.length > 0);
});

/* ── buildSettingRows ─────────────────────────────────────────────────── */

test('buildSettingRows surfaces sessionPolicy + autonomy with help text (AC #2)', () => {
  const rows = buildSettingRows({ sessionPolicy: 'per-invocation', autonomous: true });
  assert.deepEqual(rows.map(r => r.key), ['sessionPolicy', 'autonomy']);
  const sp = rows.find(r => r.key === 'sessionPolicy');
  assert.equal(sp.label, 'Session policy');
  assert.equal(sp.value, 'per-invocation (fresh context)');
  assert.equal(sp.help, SESSION_POLICY_HELP['per-invocation']);
  const au = rows.find(r => r.key === 'autonomy');
  assert.equal(au.value, 'Autonomous');
  assert.match(au.help, /unattended/i);
});

test('buildSettingRows defaults a missing sessionPolicy to the persistent help', () => {
  const rows = buildSettingRows({ autonomous: false });
  const sp = rows.find(r => r.key === 'sessionPolicy');
  assert.equal(sp.value, 'persistent');
  assert.equal(sp.help, SESSION_POLICY_HELP.persistent);
});
