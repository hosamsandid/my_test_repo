'use strict';

// The contract the trigger form shows users: every payload key the manifest
// declares for an event kind is present — and a string — on a representative
// event of that kind. Each fixture is a raw issue as Jira's /search/jql returns
// it; it goes through the real shapeIssue + the real extractors, the path the
// poller takes (docs/jira-plugin-events-implementation.md §5).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { shapeIssue } = require('./jira-client');
const {
  KNOWN_EVENTS, EVENT_ID_RE,
  extractStatusChangeEvents, extractIssueCreatedEvents, extractFieldChangeEvents, extractCommentEvents,
} = require('./event-extract');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
const OPTS = { projectKey: 'KAN', siteBase: 'https://acme.atlassian.net', windowStartIso: '2026-01-01T11:50:00Z', ownWrites: null };
const EXTRACT = {
  status_changed: extractStatusChangeEvents,
  issue_created: extractIssueCreatedEvents,
  field_changed: extractFieldChangeEvents,
  comment_added: extractCommentEvents,
};

test('manifest events[] and KNOWN_EVENTS name the same kinds, in both directions', () => {
  assert.deepEqual(manifest.events.map((e) => e.name).sort(), KNOWN_EVENTS.slice().sort());
  assert.deepEqual(Object.keys(EXTRACT).sort(), KNOWN_EVENTS.slice().sort(), 'every kind has an extractor under test');
});

for (const decl of manifest.events) {
  test(`${decl.name}: the fixture yields one event carrying every declared payload key as a string`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${decl.name}.json`), 'utf8'));
    const events = EXTRACT[decl.name](shapeIssue(raw), OPTS);
    assert.equal(events.length, 1, `${decl.name} fixture → exactly one event`);
    const [ev] = events;
    assert.equal(ev.event, decl.name);
    assert.ok(EVENT_ID_RE.test(ev.id), `id ${ev.id} is consumable`);
    for (const { key } of decl.payload) {
      assert.equal(typeof ev[key], 'string', `${decl.name}.${key} must be a string (got ${JSON.stringify(ev[key])})`);
      assert.ok(ev[key].length, `${decl.name}.${key} must not be empty on the representative event`);
    }
    // and no OTHER kind's extractor claims this fixture — kinds do not overlap
    for (const [other, fn] of Object.entries(EXTRACT)) {
      if (other !== decl.name) assert.deepEqual(fn(shapeIssue(raw), OPTS), [], `${other} must not fire on the ${decl.name} fixture`);
    }
  });
}
