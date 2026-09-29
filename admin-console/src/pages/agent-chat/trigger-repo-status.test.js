// #2528: the Triggers tab's repository picker offers agent-scoped repositories,
// and each github-event trigger row carries the Repositories status verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseRepoFullName, triggerRepoOptions, environmentRepoOptions, triggerRepoWarning,
} from './trigger-repo-status.js';
import { statusMeta, describeRow } from '../github-repo-status-view.js';

const ENV = [{ url: 'git@github.com:acme/team.git' }, { url: 'https://github.com/acme/shared.git' }];
const OWN = [{ url: 'git@github.com:acme/own.git' }, { url: 'git@github.com:acme/shared.git' }, { url: 'git@gitlab.com:x/y.git' }];

test('parseRepoFullName reads SSH and HTTPS GitHub URLs only', () => {
  assert.equal(parseRepoFullName('git@github.com:a/b.git'), 'a/b');
  assert.equal(parseRepoFullName('https://github.com/a/b'), 'a/b');
  assert.equal(parseRepoFullName('git@gitlab.com:a/b.git'), null);
  assert.equal(parseRepoFullName(''), null);
});

test('AC4: the picker offers env repos, then agent-scoped ones marked "this agent only"; a repo in both is an env repo', () => {
  const opts = triggerRepoOptions({ envRepositories: ENV, agentRepositories: OWN });
  assert.deepEqual(opts.map((o) => [o.fullName, o.scope]), [
    ['acme/team', 'environment'], ['acme/shared', 'environment'], ['acme/own', 'agent'],
  ]);
  assert.equal(opts[2].label, 'acme/own — this agent only');
  assert.equal(opts[0].label, 'acme/team');
});

test('AC4: agent-scoped repos alone are enough (no environment repos)', () => {
  const opts = triggerRepoOptions({ envRepositories: [], agentRepositories: OWN.slice(0, 1) });
  assert.deepEqual(opts.map((o) => o.fullName), ['acme/own']);
});

test('a saved repo no longer attached stays selectable and says so', () => {
  const opts = triggerRepoOptions({ envRepositories: ENV, agentRepositories: [], currentRepo: 'acme/gone' });
  const last = opts[opts.length - 1];
  assert.deepEqual([last.fullName, last.scope], ['acme/gone', 'unattached']);
  assert.match(last.label, /not attached to this agent/);
  assert.equal(triggerRepoOptions({ envRepositories: ENV, currentRepo: 'acme/team' }).length, 2);
});

test('data-flow keeps offering environment repositories only', () => {
  const opts = triggerRepoOptions({ envRepositories: ENV, agentRepositories: OWN, currentRepo: 'acme/gone' });
  assert.deepEqual(environmentRepoOptions(opts).map((o) => o.fullName), ['acme/team', 'acme/shared']);
});

const trig = (over = {}) => ({ id: 't', type: 'github-event', enabled: true, events: ['push'], repo: 'acme/own', ...over });
const noToken = {
  repo: 'acme/own', status: 'no-token', group: 'not-listening', tokenEnvironment: null, environments: [],
  agentRepositoryAgents: [{ id: 'dev', name: 'Dev', environment: { id: 'env-x', name: 'Env X', tokenId: null, tokenState: 'none', teamId: 'team-x' } }],
  triggers: [{ agentId: 'dev', agentName: 'Dev', counted: true }],
};
const notAttached = {
  repo: 'acme/gone', status: 'not-in-environment', group: 'not-listening', environments: [], agentRepositoryAgents: [],
  triggers: [{ agentId: 'dev', agentName: 'Dev' }, { agentId: 'other', agentName: 'Other' }],
};
const listening = { repo: 'acme/team', status: 'listening', group: 'listening', environments: [], triggers: [] };
const failing = { repo: 'acme/failing', status: 'failing', group: 'failing', environments: [], triggers: [] };
const ROWS = [noToken, notAttached, listening, failing];

test('AC5: a not-listening repo gives the row the Repositories area’s own label and reason', () => {
  const w = triggerRepoWarning(trig(), ROWS, { agentId: 'dev' });
  assert.equal(w.status, 'no-token');
  assert.equal(w.label, statusMeta('no-token').label);
  assert.equal(w.text, describeRow(noToken, Date.now()).text);
  assert.deepEqual(w.links.map((l) => l.to), ['/chats/team-x?tab=repositories']);
});

test('AC5: a detached repo reads "not attached"; the link back to this very tab is dropped', () => {
  const w = triggerRepoWarning(trig({ repo: 'acme/gone' }), ROWS, { agentId: 'dev' });
  assert.equal(w.label, 'Not listening — repository not attached');
  assert.deepEqual(w.links.map((l) => l.to), ['/chats/other?rail=triggers']);
});

test('AC5: listened-to repositories (listening or failing) show no warning', () => {
  assert.equal(triggerRepoWarning(trig({ repo: 'acme/team' }), ROWS), null);
  assert.equal(triggerRepoWarning(trig({ repo: 'acme/failing' }), ROWS), null);
});

test('no warning for disabled / internal / non-github triggers, a missing row, or unavailable status', () => {
  assert.equal(triggerRepoWarning(trig({ enabled: false }), ROWS), null);
  assert.equal(triggerRepoWarning(trig({ transport: 'internal' }), ROWS), null);
  assert.equal(triggerRepoWarning({ type: 'cron', cron: '* * * * *' }, ROWS), null);
  assert.equal(triggerRepoWarning(trig({ repo: 'acme/unknown' }), ROWS), null);
  assert.equal(triggerRepoWarning(trig(), null), null);
  assert.equal(triggerRepoWarning(trig({ repo: '' }), ROWS), null);
});

test('TriggersPanel wires the picker options and the row warning', () => {
  const src = fs.readFileSync(new URL('./TriggersPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /triggerRepoOptions\(\{[\s\S]{0,120}agentRepositories: agent\?\.agentRepositories/);
  assert.match(src, /repoWarning=\{isDraft \? null : triggerRepoWarning\(t, repoStatusRows, \{ agentId \}\)\}/);
  assert.match(src, /apiCall\('GET', '\/api\/github-events\/repo-status'\)/);
  assert.match(src, /environmentRepoOptions\(availableRepos\)/);
});
