import test from 'node:test';
import assert from 'node:assert/strict';

import { describeAgentCreateAccess } from './agent-create-access.js';

test('a full-visibility admin may create and import (#1956 AC6)', () => {
  const verdict = describeAgentCreateAccess({ admin: true, teams: [] });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.hint, null);
});

test('a Team Admin of any team may create and import', () => {
  const verdict = describeAgentCreateAccess({
    admin: false,
    teams: [{ teamId: 'other', role: 'team-member' }, { teamId: 'alpha', role: 'team-admin' }],
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.hint, null);
});

test('a plain Team Member is refused with an honest reason, not silence', () => {
  const verdict = describeAgentCreateAccess({
    admin: false,
    teams: [{ teamId: 'alpha', role: 'team-member' }],
  });
  assert.equal(verdict.allowed, false);
  // The hint is what the disabled button's `title` shows, so it has to name the
  // role that is missing and who to ask — "forbidden" alone is not a reason.
  assert.match(verdict.hint, /Team Admin/i);
  assert.ok(verdict.hint.length > 20, 'the hint is a sentence, not a code');
});

test('a member of no team at all is refused (the fail-closed case)', () => {
  const verdict = describeAgentCreateAccess({ admin: false, teams: [] });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.hint);
  // `teams` absent entirely must behave like an empty list, never throw.
  assert.equal(describeAgentCreateAccess({ admin: false }).allowed, false);
});

test('no session is refused rather than optimistically allowed', () => {
  const verdict = describeAgentCreateAccess(null);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.hint, /sign in/i);
  assert.equal(describeAgentCreateAccess(undefined).allowed, false);
});

test('only the literal `admin: true` shortcut opens the gate', () => {
  // A payload where `admin` is a truthy non-boolean (an older/other shape) must
  // not widen the gate by accident — the membership check still decides.
  assert.equal(describeAgentCreateAccess({ admin: 'yes', teams: [] }).allowed, false);
  assert.equal(describeAgentCreateAccess({ admin: false, teams: [null] }).allowed, false);
});
