'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnvLocal, loadEnvLocal } = require('./env-local');

test('parseEnvLocal: strips inline comments after unquoted values, honours quotes + export', () => {
  const parsed = parseEnvLocal([
    '# a comment line',
    '',
    'JIRA_SITE_URL=insurance-agent          # or https://your-subdomain.atlassian.net',
    'export JIRA_EMAIL = bot@acme.com ',
    'JIRA_API_TOKEN="tok#en with spaces"',
    "OTHER='literal#value'",
    'BLANK=',
    'not a valid line',
  ].join('\n'));
  assert.deepEqual(parsed, {
    JIRA_SITE_URL: 'insurance-agent',
    JIRA_EMAIL: 'bot@acme.com',
    JIRA_API_TOKEN: 'tok#en with spaces',
    OTHER: 'literal#value',
  });
});

test('loadEnvLocal: sets only unset keys; missing file is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-envlocal-'));
  assert.deepEqual(loadEnvLocal(dir), {}); // no .env.local → {}
  fs.writeFileSync(path.join(dir, '.env.local'), 'JIRA_FOO=frombfile\nJIRA_BAR=barval\n');
  process.env.JIRA_FOO = 'preset';
  try {
    loadEnvLocal(dir);
    assert.equal(process.env.JIRA_FOO, 'preset');   // already set → untouched
    assert.equal(process.env.JIRA_BAR, 'barval');   // unset → filled
  } finally {
    delete process.env.JIRA_FOO;
    delete process.env.JIRA_BAR;
  }
});
