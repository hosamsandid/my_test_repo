import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard (no pure module — the columns are inline component config). Locks
// in the usability consistency fix: the GitHub Events log renders its "Time" and
// "Received" timestamps via the shared WhenCell (a scannable "2 minutes ago"
// phrase with the exact local time on hover), like the credential/connection
// "Added" columns — NOT a raw machine timestamp a new user has to decode.
const src = readFileSync(
  fileURLToPath(new URL('./GithubEventLog.jsx', import.meta.url)),
  'utf8',
);

test('GithubEventLog imports the shared WhenCell', () => {
  assert.match(src, /import WhenCell from '\.\.\/components\/WhenCell'/);
});

test('both timestamp columns render via WhenCell', () => {
  // The two date-bearing columns key on `ts` and `receivedAt`.
  assert.match(src, /key: 'ts'[\s\S]*?render: v => <WhenCell iso={v} \/>/);
  assert.match(src, /key: 'receivedAt', label: 'Received', render: v => <WhenCell iso={v} \/>/);
});

test('no raw machine timestamp render remains', () => {
  // A relative phrase (WhenCell) replaces the old locale-string render; the only
  // remaining Date use is the `since` range boundary, which stays an ISO string.
  assert.doesNotMatch(src, /toLocaleString/);
});
