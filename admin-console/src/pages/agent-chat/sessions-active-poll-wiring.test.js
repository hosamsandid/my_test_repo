import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #566 wiring guard — the JSX is uncovered by a renderer (#651), so check in
// the source that the sessions-active poll pauses in a hidden tab and refreshes
// once on return, using the roster poll's pure rules.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'SessionsActiveContext.jsx'), 'utf8');

test('the sessions-active poll skips ticks while the tab is hidden', () => {
  assert.match(src, /import \{ shouldTickPoll, shouldRefreshOnVisible, nextSnapshotStaleSince \} from '\.\.\/\.\.\/context\/agent-roster-poll\.js';/);
  assert.match(src, /if \(force \|\| shouldTickPoll\(hidden\)\) \{/);
});

test('one chain: the first load and the return refresh both go through tick, never a second fetch path', () => {
  assert.match(src, /\n    tick\(true\);\n/, 'the first load is a forced tick');
  // The return refresh pulls the pending tick forward instead of fetching beside it.
  assert.match(src, /if \(!shouldRefreshOnVisible\(prevHidden, hidden\)\) return;/);
  assert.match(src, /if \(inFlight\) return;\n      if \(timer\) clearTimeout\(timer\);\n      tick\(true\);/);
  assert.doesNotMatch(src, /\(async \(\) => \{\n      await load\(\);/, 'no separate first-load IIFE');
  assert.equal((src.match(/await load\(\)/g) || []).length, 1, 'load is awaited in exactly one place');
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(src, /document\.removeEventListener\('visibilitychange', onVisibilityChange\)/);
});

test('a hidden-tab snapshot is stamped stale until a fetch lands, and consumers can read its age', () => {
  assert.match(src, /if \(hidden\) setStaleSince\(\(prev\) => nextSnapshotStaleSince\(prev, 'hidden', true, Date\.now\(\)\)\);/);
  assert.match(src, /setStaleSince\(\(prev\) => nextSnapshotStaleSince\(prev, 'landed', /);
  assert.match(src, /\n    staleSince,\n/, 'exposed on the context value');
});

test('every fetch has a deadline, so a hung request can neither pin the snapshot stale nor stop the chain', () => {
  assert.match(src, /export const SESSIONS_FETCH_TIMEOUT_MS = 15_000;/);
  assert.match(src, /const deadline = setTimeout\(\(\) => controller\.abort\(\), SESSIONS_FETCH_TIMEOUT_MS\);/);
  assert.match(src, /apiCall\('GET', `\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}\/sessions\/active`, undefined, \{ signal: controller\.signal \}\)/);
  // The deadline must be cleared on every settle, and the stale stamp is
  // updated in the same finally — an aborted fetch still counts as landed.
  const finAt = src.indexOf('} finally {\n      clearTimeout(deadline);');
  assert.ok(finAt > 0, 'deadline cleared in finally');
  assert.ok(src.indexOf("nextSnapshotStaleSince(prev, 'landed'", finAt) > finAt);
  const api = readFileSync(join(here, '../../hooks/useApi.js'), 'utf8');
  assert.match(api, /export async function apiCall\(method, url, body, \{ signal \} = \{\}\) \{/);
  assert.match(api, /\n    signal,\n  \}\);/, 'the signal reaches fetch');
});

test('the statuses poll is deliberately NOT paused: the "agent is back" notification needs it in background tabs', () => {
  const statuses = readFileSync(join(here, '../../context/AgentStatusesContext.jsx'), 'utf8');
  assert.doesNotMatch(statuses, /shouldTickPoll/);
  const notify = readFileSync(join(here, '../../context/AgentBackNotificationContext.jsx'), 'utf8');
  assert.match(notify, /useAgentStatuses\(\)/);
});
