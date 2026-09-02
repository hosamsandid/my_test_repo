import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_LAUNCHER_PATH,
  LEGACY_CREATE_PATHS,
  AGENTS_PAGE_COPY,
  EMPTY_STATE_PRIMARY_CTA,
  ctaAvoidsLegacyCreatePages,
  ctaUsesLauncher,
  isManageFramed,
} from './agents-view.js';

// AC1 — the page presents managing as its primary purpose.
test('AC1: page copy is manage-framed (subtitle leads with Manage)', () => {
  assert.ok(isManageFramed());
  assert.match(AGENTS_PAGE_COPY.subtitle, /^Manage\b/);
  assert.match(AGENTS_PAGE_COPY.emptyLead, /manage/i);
});

test('AC1: manage framing is falsified by create-led copy', () => {
  assert.equal(
    isManageFramed({
      subtitle: 'Create agents and teams here.',
      emptyLead: 'No agents yet.',
    }),
    false,
  );
});

// AC3 — empty-state / primary create CTA routes through the launcher, not the
// individual /quickstart or /team-setup pages.
test('AC3: empty-state primary CTA targets the Create launcher', () => {
  assert.equal(EMPTY_STATE_PRIMARY_CTA.to, CREATE_LAUNCHER_PATH);
  assert.ok(ctaUsesLauncher(EMPTY_STATE_PRIMARY_CTA));
});

// The informational role table that used to carry its own launcher link was
// moved into the page help topic (#1875), so AGENT_ROLE_CREATE_LINK is gone —
// the empty-state CTA above is the page's remaining primary create door.

test('AC3: legacy create pages are rejected as primary create CTAs', () => {
  for (const legacy of LEGACY_CREATE_PATHS) {
    assert.equal(ctaAvoidsLegacyCreatePages(legacy), false);
    assert.equal(ctaUsesLauncher({ to: legacy }), false);
  }
  assert.deepEqual(LEGACY_CREATE_PATHS, ['/quickstart', '/team-setup']);
});

// AC3 — the launcher path itself is the single front door.
test('launcher path is /create', () => {
  assert.equal(CREATE_LAUNCHER_PATH, '/create');
});
