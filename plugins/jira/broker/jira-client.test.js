'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jc = require('./jira-client');

// ── pure builders ───────────────────────────────────────────────────────────

test('basicAuthHeader: email:token base64, Basic scheme', () => {
  assert.equal(jc.basicAuthHeader('bot@acme.com', 'tok'), `Basic ${Buffer.from('bot@acme.com:tok').toString('base64')}`);
});

test('buildProjectJql: quoted key, escaped quotes, minutes window, oldest-first', () => {
  assert.equal(jc.buildProjectJql('ENG', 10), 'project = "ENG" AND updated >= -10m ORDER BY updated ASC');
  assert.equal(jc.buildProjectJql('A"B', 5), 'project = "A\\"B" AND updated >= -5m ORDER BY updated ASC');
  assert.equal(jc.buildProjectJql('ENG', 0), 'project = "ENG" AND updated >= -10m ORDER BY updated ASC'); // fallback
});

test('buildJqlSearchBody: fields + changelog expansion; expand is a STRING on /search/jql; nextPageToken only when given', () => {
  assert.deepEqual(jc.buildJqlSearchBody('jql'), { jql: 'jql', fields: ['summary', 'status'], expand: 'changelog', maxResults: 100 });
  assert.equal(typeof jc.buildJqlSearchBody('jql').expand, 'string'); // array form is a 400 on this endpoint
  assert.equal(jc.buildJqlSearchBody('jql', 'TOK').nextPageToken, 'TOK');
});

test('changelogPath: encodes the issue key and paginates', () => {
  assert.equal(jc.changelogPath('ENG-1', 100), '/rest/api/3/issue/ENG-1/changelog?startAt=100&maxResults=100');
});

test('shapeIssue: narrows to key/summary/status/changelog', () => {
  assert.deepEqual(
    jc.shapeIssue({ key: 'ENG-1', fields: { summary: 'S', status: { name: 'In Progress' } }, changelog: { total: 1, histories: [] } }),
    { key: 'ENG-1', summary: 'S', status: 'In Progress', changelog: { total: 1, histories: [] } },
  );
  assert.equal(jc.shapeIssue(null), null);
});

test('mapJiraError: 401 names the credential, 429 says backing off', () => {
  assert.match(jc.mapJiraError(401), /credential/i);
  assert.match(jc.mapJiraError(429), /rate limit/i);
  assert.match(jc.mapJiraError(500, 'boom'), /HTTP 500.*boom/);
});

test('apiBaseFor: JIRA_API_BASE seam wins over the stored siteUrl', () => {
  assert.equal(jc.apiBaseFor('acme', { JIRA_API_BASE: 'http://fake-jira:8080/' }), 'http://fake-jira:8080');
  assert.equal(jc.apiBaseFor('acme', {}), 'https://acme.atlassian.net');
});

// ── async adapters (global.fetch stubbed) ───────────────────────────────────

function withFetch(handler, fn) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = orig; });
}

const CRED = { siteUrl: 'acme', email: 'bot@acme.com', apiToken: 'tok', env: { JIRA_API_BASE: 'http://fake-jira:8080' } };

test('searchProjectIssues: POSTs the JQL search, shapes issues, follows nextPageToken', async () => {
  await withFetch((url, opts, n) => {
    assert.equal(url, 'http://fake-jira:8080/rest/api/3/search/jql');
    assert.equal(opts.method, 'POST');
    assert.match(opts.headers.Authorization, /^Basic /);
    if (n === 1) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        isLast: false, nextPageToken: 'P2',
        issues: [{ key: 'ENG-1', fields: { summary: 'One' }, changelog: { total: 1, histories: [] } }],
      }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-2', fields: { summary: 'Two' } }],
    }) };
  }, async (calls) => {
    const issues = await jc.searchProjectIssues(CRED, { projectKey: 'ENG', windowMinutes: 10, env: CRED.env });
    assert.deepEqual(issues.map((i) => i.key), ['ENG-1', 'ENG-2']);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[1].opts.body).nextPageToken, 'P2');
  });
});

test('requestJson: a transport failure ("fetch failed") is retried once, then succeeds', async () => {
  let n = 0;
  const orig = global.fetch;
  global.fetch = async () => {
    n += 1;
    if (n === 1) {
      const e = new TypeError('fetch failed');
      e.cause = { code: 'UND_ERR_SOCKET' };
      throw e;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, issues: [{ key: 'ENG-1', fields: {} }] }) };
  };
  try {
    const issues = await jc.searchProjectIssues(CRED, { projectKey: 'ENG', windowMinutes: 10, env: CRED.env });
    assert.equal(n, 2); // retried once
    assert.deepEqual(issues.map((i) => i.key), ['ENG-1']);
  } finally { global.fetch = orig; }
});

test('requestJson: a transport failure that persists surfaces the cause in the message', async () => {
  const orig = global.fetch;
  global.fetch = async () => {
    const e = new TypeError('fetch failed');
    e.cause = { code: 'ENOTFOUND' };
    throw e;
  };
  try {
    await assert.rejects(
      () => jc.searchProjectIssues(CRED, { projectKey: 'ENG', windowMinutes: 10, env: CRED.env }),
      /fetch failed \(ENOTFOUND\)/,
    );
  } finally { global.fetch = orig; }
});

test('searchProjectIssues: a 401 throws a mapped error carrying the status', async () => {
  await withFetch(() => ({ ok: false, status: 401, text: async () => 'nope' }), async () => {
    await assert.rejects(
      () => jc.searchProjectIssues(CRED, { projectKey: 'ENG', windowMinutes: 10, env: CRED.env }),
      (err) => err.status === 401 && /credential/i.test(err.message),
    );
  });
});

test('fetchFullChangelog: pages until isLast, concatenating histories', async () => {
  await withFetch((url, opts, n) => {
    assert.match(url, /\/rest\/api\/3\/issue\/ENG-9\/changelog/);
    if (n === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: false, total: 3, values: [{ id: '1' }, { id: '2' }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, total: 3, values: [{ id: '3' }] }) };
  }, async () => {
    const histories = await jc.fetchFullChangelog(CRED, 'ENG-9', { env: CRED.env });
    assert.deepEqual(histories.map((h) => h.id), ['1', '2', '3']);
  });
});

test('listProjects: paginates /project/search and narrows to key/name/id/type', async () => {
  await withFetch((url, opts, n) => {
    assert.match(url, /\/rest\/api\/3\/project\/search/);
    if (n === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: false, total: 2, values: [{ key: 'ENG', name: 'Engineering', id: '1', projectTypeKey: 'software' }] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ key: 'OPS', name: 'Ops', id: '2', projectTypeKey: 'business' }] }) };
  }, async () => {
    const projects = await jc.listProjects(CRED, { env: CRED.env });
    assert.deepEqual(projects, [
      { key: 'ENG', name: 'Engineering', id: '1', type: 'software' },
      { key: 'OPS', name: 'Ops', id: '2', type: 'business' },
    ]);
  });
});

test('listProjectIssues: project-scoped JQL, optional status filter, narrow rows', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/search\/jql/);
    const body = JSON.parse(opts.body);
    assert.equal(body.jql, 'project = "KAN" AND status = "Ready for Dev" ORDER BY updated DESC');
    assert.deepEqual(body.fields, ['summary', 'status', 'assignee', 'updated']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [
      { key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, assignee: { displayName: 'Jane' }, updated: '2026-09-09T10:00:00Z' } },
    ] }) };
  }, async () => {
    const rows = await jc.listProjectIssues({ siteUrl: 'acme', email: 'e', apiToken: 't' }, { projectKey: 'KAN', status: 'Ready for Dev', env: CRED.env });
    assert.deepEqual(rows, [{
      key: 'KAN-6', summary: 'Login', status: 'Ready for Dev', assignee: 'Jane',
      updated: '2026-09-09T10:00:00Z', url: 'https://acme.atlassian.net/browse/KAN-6',
    }]);
  });
});

test('listProjectIssues: no status → JQL without the status clause', async () => {
  await withFetch((url, opts) => {
    assert.equal(JSON.parse(opts.body).jql, 'project = "KAN" ORDER BY updated DESC');
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [] }) };
  }, async () => {
    assert.deepEqual(await jc.listProjectIssues(CRED, { projectKey: 'KAN', env: CRED.env }), []);
  });
});

test('searchJql: runs an arbitrary query through /search/jql', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/search\/jql/);
    assert.equal(JSON.parse(opts.body).jql, 'assignee = currentUser()');
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'x' } }] }) };
  }, async () => {
    const issues = await jc.searchJql(CRED, 'assignee = currentUser()', { env: CRED.env });
    assert.deepEqual(issues.map((i) => i.key), ['ENG-1']);
  });
});

test('commentAdf: wraps text as ADF paragraphs, attribution first', () => {
  const doc = jc.commentAdf('line one\n\nline two', 'by an agent');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.content[0].content[0].text, 'by an agent');
  assert.equal(doc.content[0].content[0].marks[0].type, 'em');
  assert.equal(doc.content[1].content[0].text, 'line one');
  assert.deepEqual(doc.content[2].content, []); // blank line
});

test('addComment: POSTs an ADF body to /issue/:key/comment', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-6\/comment$/);
    assert.equal(opts.method, 'POST');
    assert.equal(JSON.parse(opts.body).body.type, 'doc');
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: '10099' }) };
  }, async () => {
    assert.deepEqual(await jc.addComment(CRED, 'KAN-6', { body: 'hi', attribution: 'x', env: CRED.env }), { id: '10099', issueKey: 'KAN-6' });
  });
});

test('transitionIssue: resolves the transition id by target status, then POSTs it', async () => {
  await withFetch((url, opts, n) => {
    if (n === 1) {
      assert.match(url, /\/transitions$/);
      assert.equal(opts.method, 'GET');
      return { ok: true, status: 200, text: async () => JSON.stringify({ transitions: [
        { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
        { id: '21', name: 'Ready', to: { name: 'Ready for Dev' } },
      ] }) };
    }
    assert.equal(opts.method, 'POST');
    assert.equal(JSON.parse(opts.body).transition.id, '21');
    return { ok: true, status: 204, text: async () => '' };
  }, async () => {
    const r = await jc.transitionIssue(CRED, 'KAN-6', { toStatus: 'ready for dev', env: CRED.env });
    assert.deepEqual(r, { issueKey: 'KAN-6', applied: 'Ready', toStatus: 'Ready for Dev' });
  });
});

test('transitionIssue: no transition to the target → a 409 naming the options', async () => {
  await withFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }] }) }), async () => {
    await assert.rejects(
      () => jc.transitionIssue(CRED, 'KAN-6', { toStatus: 'Done', env: CRED.env }),
      (e) => e.status === 409 && /Available: Start → In Progress/.test(e.message),
    );
  });
});

test('getIssue: reads summary/status/assignee and builds a browse URL from the real site', async () => {
  await withFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({
    key: 'ENG-5', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, assignee: { displayName: 'Jane' } },
  }) }), async () => {
    const issue = await jc.getIssue({ siteUrl: 'acme', email: 'e', apiToken: 't' }, 'ENG-5', { env: CRED.env });
    assert.equal(issue.status, 'Ready for Dev');
    assert.equal(issue.assignee, 'Jane');
    assert.equal(issue.url, 'https://acme.atlassian.net/browse/ENG-5'); // browse URL uses the real site, not the seam
  });
});
