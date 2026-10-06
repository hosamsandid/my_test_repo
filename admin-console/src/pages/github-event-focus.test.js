import test from 'node:test';
import assert from 'node:assert/strict';

import { eventLogHref, focusedEventRows, focusNotice, EVENT_PARAM, FOCUS_RANGE_KEY } from './github-event-focus.js';

test('eventLogHref: one event row, URL-encoded; null when nothing was logged (#2872)', () => {
  assert.equal(EVENT_PARAM, 'event');
  assert.equal(eventLogHref('12345'), '/github-events?event=12345');
  assert.equal(eventLogHref('intlbl:ab cd'), '/github-events?event=intlbl%3Aab%20cd');
  assert.equal(eventLogHref(42), '/github-events?event=42');
  assert.equal(eventLogHref(null), null);
  assert.equal(eventLogHref(''), null);
});

test('focusedEventRows: only the named event, else every row (#2872)', () => {
  const rows = [{ eventId: '1' }, { eventId: '2' }, { eventId: 3 }];
  assert.deepEqual(focusedEventRows(rows, '2'), [{ eventId: '2' }]);
  assert.deepEqual(focusedEventRows(rows, '3'), [{ eventId: 3 }]);
  assert.equal(focusedEventRows(rows, null), rows);
  assert.deepEqual(focusedEventRows(null, '1'), []);
});

test('focusNotice: says what is shown, or that the event aged out; the focus widens the range to the log retention (#2872)', () => {
  assert.equal(FOCUS_RANGE_KEY, '7d');
  assert.equal(focusNotice('9', 1), 'Showing one event (9).');
  assert.equal(focusNotice('9', 0), 'Event 9 is not in the last 7 days of the log.');
  assert.equal(focusNotice(null, 0), null);
});
