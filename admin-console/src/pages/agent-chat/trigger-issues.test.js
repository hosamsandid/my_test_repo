import test from 'node:test';
import assert from 'node:assert/strict';

import { triggerIssue, triggerPath, triggerRowKey } from './trigger-issues.js';

test('#2626: triggerIssue surfaces the server annotation only', () => {
  assert.equal(triggerIssue({ id: 'a', invalid: ' Invalid cron expression "75 * * * *" ' }), 'Invalid cron expression "75 * * * *"');
  assert.equal(triggerIssue({ id: 'a' }), null);
  assert.equal(triggerIssue({ id: 'a', invalid: '' }), null);
  assert.equal(triggerIssue(null), null);
});

test('#2626: triggerPath addresses a duplicated row by position, others by id', () => {
  assert.equal(triggerPath('dev', 'x-dup'), '/api/agents/dev/triggers/x-dup');
  assert.equal(triggerPath('dev', 'x-dup', 3), '/api/agents/dev/triggers/x-dup?position=3');
  assert.equal(triggerPath('dev', 'x-dup', 0), '/api/agents/dev/triggers/x-dup?position=0');
  assert.equal(triggerPath('dev', 'x-dup', undefined), '/api/agents/dev/triggers/x-dup');
  assert.equal(triggerPath('dev', 'a b/c'), '/api/agents/dev/triggers/a%20b%2Fc', 'legacy ids with odd characters stay addressable');
});

test('#2626: triggerRowKey stays unique for rows sharing an id', () => {
  const rows = [{ id: 'x-dup', position: 1 }, { id: 'x-dup', position: 3 }, { id: 'ok' }, {}];
  const keys = rows.map(triggerRowKey);
  assert.deepEqual(keys, ['x-dup@1', 'x-dup@3', 'ok', '#3']);
  assert.equal(new Set(keys).size, keys.length);
});

// Review S2: edit-adapters.js cannot be imported under node:test (it pulls in
// hooks/useApi), so a source-reading guard pins that liveOps forwards `position`
// to triggerPath — dropping it would silently address the first duplicate.
test('#2626: liveOps update/delete forward position to triggerPath', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(path.join(import.meta.dirname, '../process/edit-adapters.js'), 'utf8');
  assert.match(src, /updateTrigger: \(roleId, tid, body, position\) => apiCall\('PUT', triggerPath\(roleId, tid, position\), body\)/);
  assert.match(src, /deleteTrigger: \(roleId, tid, position\) => apiCall\('DELETE', triggerPath\(roleId, tid, position\)\)/);
});
