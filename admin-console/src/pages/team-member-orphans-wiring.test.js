import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the team-member half of #1960.
//
// Two properties lived only in JSX, which the pure tests cannot load (#651):
//
//  1. The Agents page no longer lists team-member orphans. #1930 has since
//     removed the page itself, so this half is now covered — more strongly —
//     by `agents-page-removal-guard.test.js`, and what remains to guard is that
//     the block did not migrate: no SURVIVING surface may list orphans, because
//     that would put back a permanent UI for a state the cascade no longer
//     produces and quietly contradict the help topic saying there is none.
//  2. The delete surface runs the shared `cascadeResidueNotice`. A team delete
//     that could not remove every member must not be reported as a clean one.
//
// Each assertion is paired with a POSITIVE one over the same file, so a renamed
// or moved file cannot make the absence checks pass vacuously.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

/**
 * Strip WHOLE-LINE comments only. A trailing comment is deliberately left in
 * place: in an absence guard a false negative (missing a real revival) is worse
 * than a false positive, and this PR's own explanatory comments name exactly the
 * symbols being asserted absent.
 */
function code(src) {
  return src
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

test('the orphan block did not migrate to the surviving agent surfaces', () => {
  // The page that hosted it is gone (#1930). The failure this now guards is the
  // block reappearing on whichever surface inherited the page's job, which is
  // where a future author would naturally put it back.
  for (const rel of [
    'agent-chat/RailLifecycleHost.jsx',
    'agent-chat/AgentList.jsx',
    'agent-chat/rail-lifecycle.js',
    'AgentChat.jsx',
  ]) {
    const src = code(read(rel));
    // Positive first: the file is real and still does its job, so the three
    // absence checks below cannot pass by reading an empty string.
    assert.ok(src.length > 200, `${rel} must exist and be non-trivial`);
    assert.ok(!/\bOrphanCard\b/.test(src), `${rel} must not render an orphan card`);
    assert.ok(!/\borphans?\b/i.test(src), `${rel} must not derive or list orphans (#1960)`);
    // The page's guard also banned a bare `parentTeamId`. That token cannot be
    // the signal on these surfaces: the rail's Clone and Import dialogs both
    // carry a legitimate `parentTeamId` field. The two above are orphan-specific
    // and are what an actual revival would have to reintroduce.
  }
});

test('the delete surface reports cascade residue through the one shared helper', () => {
  const rel = 'agent-chat/RailLifecycleHost.jsx';
  const src = code(read(rel));
  assert.ok(
    src.includes('cascadeResidueNotice'),
    `${rel} must run the shared residue helper on a delete response`,
  );
  assert.ok(
    /agent-lifecycle-menu\.js/.test(src),
    `${rel} must import it from the shared lifecycle module, not re-implement it`,
  );
  // The helper only ever sees the response if the delete's result is captured
  // — a bare `await apiCall('DELETE', …)` would discard it and silently
  // restore the pre-#1960 "always looks clean" behaviour.
  assert.ok(
    /=\s*await apiCall\('DELETE', `\/api\/agents\//.test(src),
    `${rel} must capture the DELETE response, not discard it`,
  );
  assert.ok(
    src.includes('setActionError(residue)'),
    `${rel} must surface the residue instead of swallowing it`,
  );
});
