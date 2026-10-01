import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_FORMAT_HINT,
  deriveIdFromName,
  sanitizeId,
  describeIdAdjustment,
  idFieldNotice,
} from './id-field-view.js';

test('deriveIdFromName slugs a display name (spaces → hyphens)', () => {
  assert.equal(deriveIdFromName('Release Manager'), 'release-manager');
  assert.equal(deriveIdFromName('  COBOL  Agent  '), 'cobol-agent');
  assert.equal(deriveIdFromName('Team A/B!'), 'team-ab');
  assert.equal(deriveIdFromName(''), '');
  assert.equal(deriveIdFromName(null), '');
});

test('deriveIdFromName transliterates letters instead of dropping them (#2686)', () => {
  assert.equal(deriveIdFromName('Übersetzer Agent'), 'uebersetzer-agent');
  assert.equal(deriveIdFromName('Größe Ärger Öl'), 'groesse-aerger-oel');
  assert.equal(deriveIdFromName('Café Señor Žluť'), 'cafe-senor-zlut');
  assert.equal(deriveIdFromName('uitest Q02 Gen Ä!'), 'uitest-q02-gen-ae');
});

test('deriveIdFromName never leaves edge or doubled hyphens (#2654)', () => {
  assert.equal(deriveIdFromName('uitest Q02 Gen €!'), 'uitest-q02-gen');
  assert.equal(deriveIdFromName('! leading'), 'leading');
  assert.equal(deriveIdFromName('a - b'), 'a-b');
  assert.equal(deriveIdFromName('-'), '');
  assert.equal(deriveIdFromName('€ ©'), '');
});

test('sanitizeId drops disallowed chars without hyphenating spaces', () => {
  assert.equal(sanitizeId('litellm-prod'), 'litellm-prod');
  assert.equal(sanitizeId('LiteLLM Prod'), 'litellmprod'); // spaces dropped, not hyphenated
  assert.equal(sanitizeId('foo!@#bar'), 'foobar');
  assert.equal(sanitizeId('Already-Good-9'), 'already-good-9');
});

test('describeIdAdjustment returns null when the input is already a clean id', () => {
  assert.equal(describeIdAdjustment('cobol-agent'), null);
  assert.equal(describeIdAdjustment('abc-123'), null);
  assert.equal(describeIdAdjustment(''), null);
  assert.equal(describeIdAdjustment(null), null);
});

test('describeIdAdjustment names only the categories actually present', () => {
  assert.equal(describeIdAdjustment('Cobol'), 'Adjusted to a valid id: capitals became lowercase.');
  assert.match(describeIdAdjustment('cobol agent'), /^Adjusted to a valid id: spaces were removed/);
  assert.equal(describeIdAdjustment('cobol!'), 'Adjusted to a valid id: symbols were removed.');
});

test('describeIdAdjustment joins multiple categories with commas + and', () => {
  const msg = describeIdAdjustment('My Cool Agent!');
  assert.equal(
    msg,
    'Adjusted to a valid id: capitals became lowercase, spaces were removed (type a hyphen instead) and symbols were removed.',
  );
});

test('idFieldNotice shows the adjustment only for the value the keystrokes produced', () => {
  // raw typed "Foo!" → sanitized field value "foo" → notice explains it
  assert.equal(idFieldNotice('Foo!', 'foo'), 'Adjusted to a valid id: capitals became lowercase and symbols were removed.');
  // clean typing → no notice
  assert.equal(idFieldNotice('foo', 'foo'), '');
  // no raw yet (prefilled / edit mode) → no notice
  assert.equal(idFieldNotice('', 'foo'), '');
});

test('idFieldNotice suppresses a stale raw after the value was re-derived elsewhere', () => {
  // operator had typed "Foo!" (would sanitize to "foo"), but then edited the
  // Name field which re-derived the id to "release-manager" → stale raw must
  // NOT surface a false notice.
  assert.equal(idFieldNotice('Foo!', 'release-manager'), '');
});

test('ID_FORMAT_HINT is a single consistent non-empty phrasing', () => {
  assert.equal(typeof ID_FORMAT_HINT, 'string');
  assert.ok(ID_FORMAT_HINT.length > 0);
});
