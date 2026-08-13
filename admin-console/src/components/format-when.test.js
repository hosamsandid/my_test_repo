import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, relativeWhen, absoluteWhen } from './format-when.js';

// A fixed "now" so every relativeWhen case is deterministic.
const NOW = Date.parse('2026-08-13T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

test('parseWhen: valid ISO parses, junk/empty/non-string → NaN', () => {
  assert.equal(parseWhen('2026-08-13T12:00:00Z'), NOW);
  assert.ok(Number.isNaN(parseWhen('not-a-date')));
  assert.ok(Number.isNaN(parseWhen('')));
  assert.ok(Number.isNaN(parseWhen(null)));
  assert.ok(Number.isNaN(parseWhen(undefined)));
  assert.ok(Number.isNaN(parseWhen(12345)));
});

test('relativeWhen: sub-minute → "just now"', () => {
  assert.equal(relativeWhen(ago(10 * SEC), NOW), 'just now');
  assert.equal(relativeWhen(ago(0), NOW), 'just now');
});

test('relativeWhen: minute granularity', () => {
  assert.equal(relativeWhen(ago(60 * SEC), NOW), 'a minute ago');
  assert.equal(relativeWhen(ago(5 * MIN), NOW), '5 minutes ago');
  assert.equal(relativeWhen(ago(44 * MIN), NOW), '44 minutes ago');
});

test('relativeWhen: hour granularity', () => {
  assert.equal(relativeWhen(ago(60 * MIN), NOW), 'an hour ago');
  assert.equal(relativeWhen(ago(3 * HOUR), NOW), '3 hours ago');
});

test('relativeWhen: yesterday and day granularity', () => {
  assert.equal(relativeWhen(ago(30 * HOUR), NOW), 'yesterday');
  assert.equal(relativeWhen(ago(3 * DAY), NOW), '3 days ago');
});

test('relativeWhen: week granularity', () => {
  assert.equal(relativeWhen(ago(9 * DAY), NOW), 'a week ago');
  assert.equal(relativeWhen(ago(20 * DAY), NOW), '3 weeks ago');
});

test('relativeWhen: month granularity', () => {
  assert.equal(relativeWhen(ago(50 * DAY), NOW), 'a month ago');
  assert.equal(relativeWhen(ago(90 * DAY), NOW), '3 months ago');
});

test('relativeWhen: year granularity', () => {
  assert.equal(relativeWhen(ago(400 * DAY), NOW), 'a year ago');
  assert.equal(relativeWhen(ago(800 * DAY), NOW), '2 years ago');
});

test('relativeWhen: fail-safe returns "" for future / invalid / bad now', () => {
  assert.equal(relativeWhen(new Date(NOW + 60 * SEC).toISOString(), NOW), ''); // future
  assert.equal(relativeWhen('not-a-date', NOW), '');
  assert.equal(relativeWhen('', NOW), '');
  assert.equal(relativeWhen(ago(DAY), NaN), '');
  assert.equal(relativeWhen(ago(DAY), undefined), '');
});

test('absoluteWhen: invalid → "", valid → a non-empty string', () => {
  assert.equal(absoluteWhen('not-a-date'), '');
  assert.equal(absoluteWhen(''), '');
  assert.equal(absoluteWhen(null), '');
  assert.ok(absoluteWhen('2026-08-13T12:00:00Z').length > 0);
});
