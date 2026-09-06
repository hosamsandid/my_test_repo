import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard for the team-member half of #1960.
//
// Two properties live only in JSX, which the pure tests cannot load (#651):
//
//  1. The Agents page no longer lists team-member orphans. That is a *deletion*
//     guard — the risk is a later change reviving the block piecemeal, which
//     would put back a permanent UI for a state the cascade no longer produces
//     and quietly contradict the help topic that says there is no such surface.
//  2. Both delete surfaces run the shared `cascadeResidueNotice`. A team delete
//     that could not remove every member must not be reported as a clean one, and
//     the two surfaces must word the same residue identically.
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

test('the Agents page derives orphans from bp-instances only', () => {
  const src = code(read('Agents.jsx'));
  const derivation = src.slice(src.indexOf('const orphans ='), src.indexOf('function openPanel'));
  assert.ok(derivation.length > 0, 'the orphans derivation must still exist (for bp-instances)');
  assert.ok(
    derivation.includes('bpInstances'),
    'the bp-instance arm stays — those orphans belong to the separate BriefingPack removal',
  );
  assert.ok(
    !derivation.includes('teamMembers'),
    'team-member orphans must not be listed on the page any more (#1960)',
  );
  assert.ok(
    !derivation.includes('parentTeamId'),
    'no parentTeamId-based orphan filter may come back',
  );
});

test('OrphanCard has no team-member branch left', () => {
  const src = code(read('Agents.jsx'));
  // Bound the slice on CODE, not on a section banner — `code()` strips those.
  const start = src.indexOf('function OrphanCard');
  const end = src.indexOf('export default function Agents');
  assert.ok(start >= 0 && end > start, 'OrphanCard must still exist, above the page component');
  const card = src.slice(start, end);
  assert.ok(card.includes('parentOrchestratorId'), 'the bp-instance reason must survive');
  assert.ok(
    !card.includes("'team-member'"),
    'OrphanCard must not describe a team-member orphan any more (#1960)',
  );
  assert.ok(
    !card.includes('parent team'),
    'the "parent team is gone" wording must be gone with the branch',
  );
});

test('both delete surfaces report cascade residue through the one shared helper', () => {
  for (const rel of ['Agents.jsx', 'agent-chat/RailLifecycleHost.jsx']) {
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
  }
});
