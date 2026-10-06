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

test('jqlQuote: backslash is escaped BEFORE the quote, so `\\"` cannot close the string', () => {
  // In a JQL quoted string `\` is the escape char: a bare `\"` → `\\"` would be
  // a literal backslash followed by an UNESCAPED quote — a clause breakout.
  assert.equal(jc.jqlQuote('A\\"B'), '"A\\\\\\"B"');
  assert.equal(jc.jqlQuote('plain'), '"plain"');
  assert.equal(jc.jqlQuote('back\\slash'), '"back\\\\slash"');
  assert.equal(jc.buildProjectJql('A\\"B', 5), 'project = "A\\\\\\"B" AND updated >= -5m ORDER BY updated ASC');
});

test('buildJqlSearchBody: fields + changelog expansion; expand is a STRING on /search/jql; nextPageToken only when given', () => {
  assert.deepEqual(jc.buildJqlSearchBody('jql'), { jql: 'jql', fields: ['summary', 'status', 'issuetype', 'created', 'reporter', 'priority', 'comment'], expand: 'changelog', maxResults: 100 });
  assert.equal(typeof jc.buildJqlSearchBody('jql').expand, 'string'); // array form is a 400 on this endpoint
  assert.equal(jc.buildJqlSearchBody('jql', 'TOK').nextPageToken, 'TOK');
});

test('changelogPath: encodes the issue key and paginates', () => {
  assert.equal(jc.changelogPath('ENG-1', 100), '/rest/api/3/issue/ENG-1/changelog?startAt=100&maxResults=100');
});

test('shapeIssue: narrows to key/summary/status/issueType/created/reporter/priority/comment/changelog', () => {
  assert.deepEqual(
    jc.shapeIssue({ key: 'ENG-1', fields: { summary: 'S', status: { name: 'In Progress' }, issuetype: { name: 'Bug' } }, changelog: { total: 1, histories: [] } }),
    { key: 'ENG-1', summary: 'S', status: 'In Progress', issueType: 'Bug', created: null, reporter: null, priority: null, comment: null, changelog: { total: 1, histories: [] } },
  );
  const withComments = { total: 3, comments: [{ id: '1' }] };
  assert.deepEqual(jc.shapeIssue({ key: 'ENG-4', fields: { comment: withComments } }).comment, withComments);
  const full = jc.shapeIssue({ key: 'ENG-3', fields: {
    summary: 'S', created: '2026-01-01T11:58:00.000+0000',
    reporter: { displayName: 'Jane', accountId: 'x', emailAddress: 'j@x' }, priority: { name: 'High', id: '2' },
  } });
  assert.equal(full.created, '2026-01-01T11:58:00.000+0000');
  assert.equal(full.reporter, 'Jane');
  assert.equal(full.priority, 'High');
  assert.equal(jc.shapeIssue({ key: 'ENG-2', fields: { summary: 'S' } }).issueType, null);
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
  jc.__resetCaches(); // #2415 — drop the per-site Epic Link id cache between tests
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = orig; });
}

const CRED = { siteUrl: 'acme', email: 'bot@acme.com', apiToken: 'tok', env: { JIRA_API_BASE: 'http://fake-jira:8080' } };

// #2415 — a `/rest/api/3/field` request (the Epic Link id lookup a read makes).
const isFieldList = (url) => /\/rest\/api\/3\/field$/.test(url);
// #2421 — the transitions GET `getIssue` now makes to fold `availableTransitions`
// into `show`. A stubbed default response so every getIssue stub can branch on it.
const isTransitionList = (url) => /\/transitions$/.test(url);
const transitionsResponse = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ transitions: [
  { id: '21', name: 'Start Progress', to: { name: 'In Progress' } },
  { id: '31', name: 'Done', to: { name: 'Done' } },
] }) });
// Its stubbed response: no Epic Link field by default (reads fall back to the
// native `parent`); pass an id to model a company-managed site that has one.
function fieldListResponse(epicLinkId) {
  const fields = epicLinkId
    ? [{ id: epicLinkId, name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }]
    : [];
  return { ok: true, status: 200, text: async () => JSON.stringify(fields) };
}

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

test('requestJson: a NON-idempotent write is never retried — a slow Jira that already accepted it must not get a second copy (F6)', async () => {
  // A transport error (incl. the 20s abort) after Jira accepted a POST would,
  // retried, post the attribution comment twice / re-run the transition.
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(`${opts.method || 'GET'} ${new URL(url).pathname}`);
    const e = new TypeError('fetch failed');
    e.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    throw e;
  };
  try {
    await assert.rejects(() => jc.addComment(CRED, 'KAN-6', { body: 'hi', attribution: 'x', env: CRED.env }), /fetch failed/);
    await assert.rejects(() => jc.updateDescription(CRED, 'KAN-6', { description: 'd', attribution: 'x', env: CRED.env }), /fetch failed/);
    assert.deepEqual(calls, [
      'POST /rest/api/3/issue/KAN-6/comment',
      'PUT /rest/api/3/issue/KAN-6',
    ]); // exactly one attempt each
  } finally { global.fetch = orig; }
});

test('requestJson: the POST-but-read issue search IS retried (the stale-socket case the retry exists for)', async () => {
  const calls = [];
  const orig = global.fetch;
  jc.__resetCaches();
  global.fetch = async (url, opts) => {
    const pathname = new URL(url).pathname;
    // The Epic Link id lookup (#2415) is incidental here — serve it and don't
    // count it, so the assertion stays about the search POST's retry.
    if (pathname === '/rest/api/3/field') return { ok: true, status: 200, text: async () => '[]' };
    calls.push(`${opts.method || 'GET'} ${pathname}`);
    if (calls.length === 1) { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET' }; throw e; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, issues: [] }) };
  };
  try {
    await jc.listProjectIssues(CRED, { projectKey: 'KAN', env: CRED.env });
    assert.deepEqual(calls, ['POST /rest/api/3/search/jql', 'POST /rest/api/3/search/jql']);
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

test('listProjectStatuses: reads /project/{key}/statuses and groups by issue type (#2421)', async () => {
  await withFetch((url) => {
    assert.match(url, /\/rest\/api\/3\/project\/KAN\/statuses$/);
    return { ok: true, status: 200, text: async () => JSON.stringify([
      { id: '10001', name: 'Story', subtask: false, statuses: [
        { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
        { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        { id: '4', name: 'Done', statusCategory: { key: 'done' } },
      ] },
      { id: '10002', name: 'Bug', subtask: false, statuses: [
        { id: '1', name: 'Open', statusCategory: { key: 'new' } },
      ] },
    ]) };
  }, async () => {
    const grouped = await jc.listProjectStatuses(CRED, { projectKey: 'KAN', env: CRED.env });
    assert.deepEqual(grouped, [
      { issueType: 'Story', statuses: [
        { name: 'To Do', category: 'new' },
        { name: 'In Progress', category: 'indeterminate' },
        { name: 'Done', category: 'done' },
      ] },
      { issueType: 'Bug', statuses: [{ name: 'Open', category: 'new' }] },
    ]);
  });
});

test('listProjectStatuses: a blank project key is a 400 before any HTTP (#2421)', async () => {
  let called = false;
  await withFetch(() => { called = true; return { ok: true, status: 200, text: async () => '[]' }; }, async () => {
    await assert.rejects(
      () => jc.listProjectStatuses(CRED, { projectKey: '  ', env: CRED.env }),
      (e) => e.status === 400,
    );
    assert.equal(called, false); // fails fast — no Jira call for a missing key
  });
});

test('getComment: reads one comment in full as plain text (show --comment, the rest of a bodyTruncated wake)', async () => {
  const long = 'x'.repeat(5000);
  await withFetch((url) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-6\/comment\/10042$/);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      id: '10042', created: '2026-09-08T09:00:00Z', author: { displayName: 'Jane' },
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }] },
    }) };
  }, async () => {
    const c = await jc.getComment(CRED, 'KAN-6', '10042', { env: CRED.env });
    assert.deepEqual(c, { id: '10042', author: 'Jane', created: '2026-09-08T09:00:00Z', body: long });
  });
});

test('getIssue: a failed transitions lookup degrades to omitting availableTransitions (#2421)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-20', fields: { summary: 'S', status: { name: 'To Do' }, issuetype: { name: 'Task' } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-20', { env: CRED.env });
    assert.ok(!('availableTransitions' in issue)); // lookup failure must not break the read
    assert.equal(issue.status, 'To Do');
  });
});

test('listProjectIssues: project-scoped JQL, optional status filter, narrow rows', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    assert.match(url, /\/rest\/api\/3\/search\/jql/);
    const body = JSON.parse(opts.body);
    assert.equal(body.jql, 'project = "KAN" AND status = "Ready for Dev" ORDER BY updated DESC');
    assert.deepEqual(body.fields, ['summary', 'status', 'assignee', 'created', 'updated', 'issuetype', 'parent']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [
      { key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, assignee: { displayName: 'Jane' }, created: '2026-09-08T09:00:00Z', updated: '2026-09-09T10:00:00Z', issuetype: { name: 'Story' }, parent: { key: 'KAN-1' } } },
    ] }) };
  }, async () => {
    const rows = await jc.listProjectIssues({ siteUrl: 'acme', email: 'e', apiToken: 't' }, { projectKey: 'KAN', status: 'Ready for Dev', env: CRED.env });
    assert.deepEqual(rows, [{
      key: 'KAN-6', summary: 'Login', status: 'Ready for Dev', issueType: 'Story', assignee: 'Jane',
      created: '2026-09-08T09:00:00Z', updated: '2026-09-09T10:00:00Z', parent: 'KAN-1', url: 'https://acme.atlassian.net/browse/KAN-6',
    }]);
  });
});

test('listProjectIssues: status with a backslash-quote cannot break out of the clause', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    assert.equal(JSON.parse(opts.body).jql, 'project = "KAN" AND status = "x\\\\\\" OR 1=1 --" ORDER BY updated DESC');
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [] }) };
  }, async () => {
    await jc.listProjectIssues(CRED, { projectKey: 'KAN', status: 'x\\" OR 1=1 --', env: CRED.env });
  });
});

test('listProjectIssues: no status → JQL without the status clause', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
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

test('clampSearchLimit: default one page, hard-ceilinged at MAX_PAGES × PAGE_SIZE, non-positive → default', () => {
  assert.equal(jc.clampSearchLimit(undefined), jc.PAGE_SIZE);
  assert.equal(jc.clampSearchLimit(0), jc.PAGE_SIZE);
  assert.equal(jc.clampSearchLimit(-5), jc.PAGE_SIZE);
  assert.equal(jc.clampSearchLimit('nope'), jc.PAGE_SIZE);
  assert.equal(jc.clampSearchLimit(3), 3);
  assert.equal(jc.clampSearchLimit(3.9), 3); // floored
  assert.equal(jc.clampSearchLimit(999999), jc.MAX_PAGES * jc.PAGE_SIZE);
});

test('pickAgentColumns: no fields → full shape; a subset always keeps key', () => {
  const issue = { key: 'ENG-1', summary: 's', status: 'Open', issueType: 'Story', assignee: null, updated: 'u', url: 'x' };
  assert.deepEqual(jc.pickAgentColumns(issue, undefined), issue);
  assert.deepEqual(jc.pickAgentColumns(issue, []), issue);
  assert.deepEqual(jc.pickAgentColumns(issue, ['summary']), { key: 'ENG-1', summary: 's' });
  assert.deepEqual(jc.pickAgentColumns(issue, ['key', 'status']), { key: 'ENG-1', status: 'Open' });
});

test('searchIssues: runs the caller JQL, shapes like `list`, follows nextPageToken', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    assert.equal(url, 'http://fake-jira:8080/rest/api/3/search/jql');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.fields, ['summary', 'status', 'assignee', 'updated', 'issuetype', 'parent']);
    if (!body.nextPageToken) {
      assert.equal(body.jql, 'issuetype = Story');
      return { ok: true, status: 200, text: async () => JSON.stringify({
        isLast: false, nextPageToken: 'P2',
        issues: [{ key: 'ENG-1', fields: { summary: 'One', status: { name: 'Open' }, issuetype: { name: 'Story' }, updated: '2026-09-09T10:00:00Z', parent: { key: 'EPIC-1' } } }],
      }) };
    }
    assert.equal(body.nextPageToken, 'P2');
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-2', fields: { summary: 'Two', assignee: { displayName: 'Jane' } } }],
    }) };
  }, async (calls) => {
    const issues = await jc.searchIssues(CRED, { jql: '  issuetype = Story  ', env: CRED.env });
    assert.equal(calls.length, 3); // 1 Epic Link lookup + 2 search pages
    assert.deepEqual(issues, [
      { key: 'ENG-1', summary: 'One', status: 'Open', issueType: 'Story', assignee: null, updated: '2026-09-09T10:00:00Z', parent: 'EPIC-1', url: 'https://acme.atlassian.net/browse/ENG-1' },
      { key: 'ENG-2', summary: 'Two', status: null, issueType: null, assignee: 'Jane', updated: null, parent: null, url: 'https://acme.atlassian.net/browse/ENG-2' },
    ]);
  });
});

test('searchIssues: --limit caps total issues and shrinks the page request, stops paging', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    assert.equal(JSON.parse(opts.body).maxResults, 2); // min(PAGE_SIZE, cap)
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: false, nextPageToken: 'P2',
      issues: [
        { key: 'ENG-1', fields: {} }, { key: 'ENG-2', fields: {} }, { key: 'ENG-3', fields: {} },
      ],
    }) };
  }, async (calls) => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', limit: 2, env: CRED.env });
    assert.deepEqual(issues.map((i) => i.key), ['ENG-1', 'ENG-2']); // capped, extra page never fetched
    assert.equal(calls.length, 2); // 1 Epic Link lookup + 1 capped search page
  });
});

test('searchIssues: --fields narrows the returned columns (validated before any request)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'One', status: { name: 'Open' } } }],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['summary'], env: CRED.env });
    assert.deepEqual(issues, [{ key: 'ENG-1', summary: 'One' }]);
  });
});

test('searchIssues: resolves the Epic Link field on a classic site and surfaces it as parent (#2415)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse('customfield_10014');
    assert.deepEqual(JSON.parse(opts.body).fields, ['summary', 'status', 'assignee', 'updated', 'issuetype', 'parent', 'customfield_10014']);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'One', customfield_10014: 'EPIC-3' } }],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', env: CRED.env });
    assert.equal(issues[0].parent, 'EPIC-3');
  });
});

test('searchIssues: `parent` is a selectable --fields column (#2415)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'One', parent: { key: 'EPIC-9' } } }],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['parent'], env: CRED.env });
    assert.deepEqual(issues, [{ key: 'ENG-1', parent: 'EPIC-9' }]);
  });
});

test('searchIssues: an empty JQL is a 400 before any HTTP call', async () => {
  let called = false;
  const orig = global.fetch;
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    await assert.rejects(() => jc.searchIssues(CRED, { jql: '   ', env: CRED.env }), (e) => e.status === 400);
    assert.equal(called, false);
  } finally { global.fetch = orig; }
});

test('searchIssues: an unknown --fields column is a 400 before any HTTP call', async () => {
  let called = false;
  const orig = global.fetch;
  global.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    await assert.rejects(
      () => jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['bogus'], env: CRED.env }),
      (e) => e.status === 400 && /bogus/.test(e.message),
    );
    assert.equal(called, false);
  } finally { global.fetch = orig; }
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

test('descriptionAdf: text paragraphs, attribution LAST in italics (a rewritten human description reads its provenance at the end)', () => {
  const doc = jc.descriptionAdf('Human section\n\nAgent section', 'by an agent');
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.equal(doc.content[0].content[0].text, 'Human section');
  assert.deepEqual(doc.content[1].content, []);
  assert.equal(doc.content[2].content[0].text, 'Agent section');
  const last = doc.content[doc.content.length - 1].content[0];
  assert.equal(last.text, 'by an agent');
  assert.equal(last.marks[0].type, 'em');
  // No attribution → no trailing paragraph.
  assert.equal(jc.descriptionAdf('x').content.length, 1);
});

test('updateDescription: PUTs {fields:{description}} to /issue/:key and reports what changed', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-10$/);
    assert.equal(opts.method, 'PUT');
    const body = JSON.parse(opts.body);
    assert.equal(body.fields.description.type, 'doc');
    assert.equal(body.fields.description.content[0].content[0].text, 'new text');
    return { ok: true, status: 204, text: async () => '' };
  }, async () => {
    const r = await jc.updateDescription(CRED, 'KAN-10', { description: 'new text', attribution: 'x', env: CRED.env });
    assert.deepEqual(r, { issueKey: 'KAN-10', updated: 'description' });
  });
});

test('updateDescription: a blank description is a 400 before any request', async () => {
  await withFetch(() => { throw new Error('must not be called'); }, async () => {
    await assert.rejects(
      () => jc.updateDescription(CRED, 'KAN-10', { description: '   ', env: CRED.env }),
      (e) => e.status === 400 && /description is required/.test(e.message),
    );
  });
});

test('getIssue: reads summary/status/issueType/assignee and builds a browse URL from the real site', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    assert.match(url, /fields=summary,status,description,assignee,issuetype,attachment,created,updated,parent/);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-5', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, assignee: { displayName: 'Jane' }, issuetype: { name: 'Task' }, created: '2026-09-08T09:00:00Z', updated: '2026-09-09T10:00:00Z' },
    }) };
  }, async () => {
    const issue = await jc.getIssue({ siteUrl: 'acme', email: 'e', apiToken: 't' }, 'ENG-5', { env: CRED.env });
    assert.equal(issue.status, 'Ready for Dev');
    assert.equal(issue.issueType, 'Task');
    assert.equal(issue.assignee, 'Jane');
    assert.equal(issue.created, '2026-09-08T09:00:00Z'); // #2414 — timestamps surfaced for age filter/sort
    assert.equal(issue.updated, '2026-09-09T10:00:00Z');
    assert.equal(issue.parent, null); // #2415 — no parent → null (not omitted)
    assert.equal(issue.url, 'https://acme.atlassian.net/browse/ENG-5'); // browse URL uses the real site, not the seam
    assert.ok(!('attachments' in issue)); // no attachments → no key at all (AC2/AC8)
    // #2421 — the transitions reachable from the current status, folded into show.
    assert.deepEqual(issue.availableTransitions, [
      { transition: 'Start Progress', toStatus: 'In Progress' },
      { transition: 'Done', toStatus: 'Done' },
    ]);
  });
});

test('getIssue: missing created/updated fields surface as null (#2414)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-6', fields: { summary: 'S', status: { name: 'To Do' }, issuetype: { name: 'Task' } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-6', { env: CRED.env });
    assert.equal(issue.created, null);
    assert.equal(issue.updated, null);
  });
});

test('getIssue: surfaces the native parent key (#2415)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse(); // team-managed → no Epic Link field
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-8', fields: { summary: 'Story', status: { name: 'To Do' }, issuetype: { name: 'Story' }, parent: { key: 'ENG-1', fields: { summary: 'The Epic' } } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-8', { env: CRED.env });
    assert.equal(issue.parent, 'ENG-1'); // agent can now `show ENG-1`
  });
});

test('getIssue: falls back to the Epic Link custom field on a classic project (#2415)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse('customfield_10014'); // company-managed
    if (isTransitionList(url)) return transitionsResponse();
    assert.match(url, /customfield_10014/); // the resolved field id is requested
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-9', fields: { summary: 'Story', status: { name: 'To Do' }, issuetype: { name: 'Story' }, customfield_10014: 'EPIC-7' },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-9', { env: CRED.env });
    assert.equal(issue.parent, 'EPIC-7');
  });
});

test('getIssue: a failed Epic Link lookup degrades to native parent only (#2415)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-10', fields: { summary: 'S', status: { name: 'To Do' }, issuetype: { name: 'Story' } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-10', { env: CRED.env });
    assert.equal(issue.parent, null); // lookup failure must not break the read
  });
});

// ── custom-field reads (#2416) ───────────────────────────────────────────────

// A `/rest/api/3/field` response carrying a "Team" custom field (id varies per
// site), optionally the Epic Link field too.
function customFieldList({ withEpicLink = false } = {}) {
  const fields = [{ id: 'customfield_20001', name: 'Team' }];
  if (withEpicLink) fields.push({ id: 'customfield_10014', name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } });
  return { ok: true, status: 200, text: async () => JSON.stringify(fields) };
}

test('renderCustomFieldValue: normalises the common shapes; empty is null', () => {
  assert.equal(jc.renderCustomFieldValue(null), null);
  assert.equal(jc.renderCustomFieldValue(undefined), null);
  assert.equal(jc.renderCustomFieldValue([]), null); // an unset multi-value field
  assert.equal(jc.renderCustomFieldValue('text'), 'text');
  assert.equal(jc.renderCustomFieldValue(7), 7);
  assert.deepEqual(jc.renderCustomFieldValue({ id: '42', title: 'Payments' }), { id: '42', value: 'Payments' });
  assert.deepEqual(jc.renderCustomFieldValue({ value: 'High' }), { value: 'High' });
  assert.deepEqual(jc.renderCustomFieldValue([{ value: 'a' }, { value: 'b' }]), [{ value: 'a' }, { value: 'b' }]);
});

test('partitionFields: standard columns vs custom-field names', () => {
  assert.deepEqual(jc.partitionFields(['status', 'Team', 'summary']), { columns: ['status', 'summary'], customNames: ['Team'] });
  assert.deepEqual(jc.partitionFields(undefined), { columns: [], customNames: [] });
  assert.deepEqual(jc.partitionFields(['Team']), { columns: [], customNames: ['Team'] });
});

test('mergeCustomFieldNames: unions and de-dups case-insensitively, first spelling wins', () => {
  assert.deepEqual(jc.mergeCustomFieldNames(['Team', 'Sprint'], ['team', 'Epic']), ['Team', 'Sprint', 'Epic']);
  assert.deepEqual(jc.mergeCustomFieldNames([], ['Team']), ['Team']);
  assert.deepEqual(jc.mergeCustomFieldNames(undefined, undefined), []);
});

test('getIssue: --fields reads a custom field, resolving its name → id and rendering the value (#2416)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return customFieldList();
    if (isTransitionList(url)) return transitionsResponse();
    assert.match(url, /customfield_20001/); // the resolved id is requested
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-11', fields: { summary: 'S', status: { name: 'To Do' }, customfield_20001: { id: '42', title: 'Payments' } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-11', { env: CRED.env, customFields: ['Team'] });
    assert.deepEqual(issue.customFields, { Team: { id: '42', value: 'Payments' } });
  });
});

test('getIssue: an empty custom field is null, distinguishable from a set one (#2416)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return customFieldList();
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-12', fields: { summary: 'S', customfield_20001: null } }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-12', { env: CRED.env, customFields: ['Team'] });
    assert.deepEqual(issue.customFields, { Team: null }); // present-but-null, not a dropped key
  });
});

test('getIssue: with no --fields the shape carries no customFields key (byte-identical to before)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return customFieldList();
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-12b', fields: { summary: 'S' } }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-12b', { env: CRED.env });
    assert.equal('customFields' in issue, false);
  });
});

test('getIssue: an unknown --fields name is a 400 naming the offending field (#2416)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return { ok: true, status: 200, text: async () => '[]' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-13', fields: {} }) };
  }, async () => {
    await assert.rejects(
      () => jc.getIssue(CRED, 'ENG-13', { env: CRED.env, customFields: ['Nope'] }),
      (e) => e.status === 400 && /Nope/.test(e.message),
    );
  });
});

test('getIssue: one field-catalog fetch feeds both the Epic Link and custom-field lookups (#2416)', async () => {
  let fieldGets = 0;
  await withFetch((url) => {
    if (isFieldList(url)) { fieldGets += 1; return customFieldList({ withEpicLink: true }); }
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-14', fields: { customfield_10014: 'EPIC-1', customfield_20001: { title: 'Payments' } },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-14', { env: CRED.env, customFields: ['Team'] });
    assert.equal(issue.parent, 'EPIC-1'); // classic Epic Link still resolves
    assert.deepEqual(issue.customFields, { Team: { value: 'Payments' } });
    assert.equal(fieldGets, 1); // a single catalog GET, not one per concern
  });
});

test('searchIssues: customFields ride alongside the projected columns (#2416)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return customFieldList();
    assert.ok(JSON.parse(opts.body).fields.includes('customfield_20001'));
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'One', status: { name: 'Open' }, customfield_20001: { title: 'Payments' } } }],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['status'], customFields: ['Team'], env: CRED.env });
    assert.deepEqual(issues, [{ key: 'ENG-1', status: 'Open', customFields: { Team: { value: 'Payments' } } }]);
  });
});

test('listProjectIssues: an admin-configured custom field is surfaced on each row (#2416)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return customFieldList();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      issues: [{ key: 'ENG-1', fields: { summary: 'One', customfield_20001: { title: 'Payments' } } }],
    }) };
  }, async () => {
    const issues = await jc.listProjectIssues(CRED, { projectKey: 'ENG', customFields: ['Team'], env: CRED.env });
    assert.deepEqual(issues[0].customFields, { Team: { value: 'Payments' } });
  });
});

// ── custom-field write (#2417) ───────────────────────────────────────────────

// A `/rest/api/3/field` response carrying a typed "Team" field and a plain-text
// "Notes" field, so a write can resolve name → id AND shape by schema type.
function writableFieldList() {
  return { ok: true, status: 200, text: async () => JSON.stringify([
    { id: 'customfield_20001', name: 'Team', schema: { type: 'team', custom: 'com.atlassian.teams:rm-teams-custom-field-team' } },
    { id: 'customfield_20009', name: 'Notes', schema: { type: 'string' } },
  ]) };
}

test('shapeFieldWriteValue: shapes per schema type; a bad number is a 400', () => {
  assert.equal(jc.shapeFieldWriteValue({ type: 'string' }, 'hi'), 'hi');
  assert.equal(jc.shapeFieldWriteValue({ type: 'date' }, '2026-01-01'), '2026-01-01');
  assert.equal(jc.shapeFieldWriteValue({ type: 'number' }, '7'), 7);
  assert.deepEqual(jc.shapeFieldWriteValue({ type: 'option' }, 'High'), { value: 'High' });
  assert.deepEqual(jc.shapeFieldWriteValue({ type: 'user' }, 'acc-1'), { accountId: 'acc-1' });
  assert.deepEqual(jc.shapeFieldWriteValue({ type: 'team' }, '42'), { id: '42' });
  assert.deepEqual(jc.shapeFieldWriteValue({ type: 'array', items: 'option' }, 'a'), [{ value: 'a' }]);
  assert.deepEqual(jc.shapeFieldWriteValue({ type: 'array', items: 'string' }, 'a'), ['a']);
  assert.equal(jc.shapeFieldWriteValue(null, 'plain'), 'plain'); // unmodelled → string
  assert.throws(() => jc.shapeFieldWriteValue({ type: 'number' }, 'NaN'), (e) => e.status === 400);
});

test('fieldValueMatches: an id/value object, a scalar, an array member, else false', () => {
  assert.equal(jc.fieldValueMatches({ id: '42', title: 'Payments' }, '42'), true);
  assert.equal(jc.fieldValueMatches({ id: '42', title: 'Payments' }, 'Payments'), true);
  assert.equal(jc.fieldValueMatches({ id: '42', title: 'Payments' }, '99'), false);
  assert.equal(jc.fieldValueMatches('EPIC-1', 'EPIC-1'), true);
  assert.equal(jc.fieldValueMatches([{ value: 'a' }, { value: 'b' }], 'b'), true);
  assert.equal(jc.fieldValueMatches(null, 'x'), false);
});

test('setCustomField: a field not on a NON-EMPTY allow-list is refused (403) before any Jira call', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    await assert.rejects(
      () => jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Team', value: '42', allowList: ['Sprint'], env: CRED.env }),
      (e) => e.status === 403 && /not writable/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });
});

test('setCustomField: an EMPTY allow-list is unrestricted — any resolvable field is writable (#2449)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return writableFieldList();
    if (opts && opts.method === 'PUT') return { ok: true, status: 204, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-1', fields: { customfield_20001: null } }) };
  }, async (calls) => {
    // no admin ever named "Team", yet an empty list permits the write
    const r = await jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Team', value: '42', allowList: [], env: CRED.env });
    assert.equal(r.changed, true);
    const put = calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.deepEqual(JSON.parse(put.opts.body), { fields: { customfield_20001: { id: '42' } } });
    // an unresolvable field is still a 400 even with an empty list (AC3)
    await assert.rejects(
      () => jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Ghost', value: 'x', allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /unknown Jira field: Ghost/.test(e.message),
    );
  });
});

test('setCustomField: an allow-listed but unknown Jira field name is a 400', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return { ok: true, status: 200, text: async () => '[]' };
    throw new Error('no write expected');
  }, async () => {
    await assert.rejects(
      () => jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Ghost', value: 'x', allowList: ['Ghost'], env: CRED.env }),
      (e) => e.status === 400 && /unknown Jira field: Ghost/.test(e.message),
    );
  });
});

test('setCustomField: resolves name → id, shapes by type, and PUTs {fields:{id}} (Team as {id})', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return writableFieldList();
    if (opts && opts.method === 'PUT') return { ok: true, status: 204, text: async () => '' };
    // the idempotency pre-read: the field is currently unset
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-1', fields: { customfield_20001: null } }) };
  }, async (calls) => {
    const r = await jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Team', value: '42', allowList: ['Team'], env: CRED.env });
    assert.deepEqual(r, { issueKey: 'ENG-1', field: 'Team', fieldId: 'customfield_20001', changed: true, value: '42' });
    const put = calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.match(put.url, /\/rest\/api\/3\/issue\/ENG-1$/);
    assert.deepEqual(JSON.parse(put.opts.body), { fields: { customfield_20001: { id: '42' } } });
  });
});

test('setCustomField: idempotent — a value the field already holds is a no-op (no PUT)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return writableFieldList();
    if (opts && opts.method === 'PUT') throw new Error('should not write when unchanged');
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-1', fields: { customfield_20001: { id: '42', title: 'Payments' } } }) };
  }, async (calls) => {
    const r = await jc.setCustomField(CRED, 'ENG-1', { fieldName: 'Team', value: '42', allowList: ['Team'], env: CRED.env });
    assert.equal(r.changed, false);
    assert.deepEqual(r.value, { id: '42', value: 'Payments' });
    assert.equal(calls.some((c) => c.opts && c.opts.method === 'PUT'), false);
  });
});

test('setCustomField: --value-json is sent verbatim, with no idempotency pre-read', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return writableFieldList();
    if (opts && opts.method === 'PUT') return { ok: true, status: 204, text: async () => '' };
    throw new Error('no GET pre-read expected for jsonValue');
  }, async (calls) => {
    const r = await jc.setCustomField(CRED, 'ENG-1', {
      fieldName: 'Team', jsonValue: { id: '99' }, allowList: ['Team'], env: CRED.env,
    });
    assert.equal(r.changed, true);
    const put = calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.deepEqual(JSON.parse(put.opts.body), { fields: { customfield_20001: { id: '99' } } });
    // exactly two calls: the field catalog GET + the PUT (no pre-read GET)
    assert.equal(calls.filter((c) => !isFieldList(c.url) && (!c.opts || c.opts.method !== 'PUT')).length, 0);
  });
});

// ── attachments (#2399) ──────────────────────────────────────────────────────

test('shapeAttachment: narrows to id/filename/mimeType/size/author/created/contentUrl; drops idless', () => {
  assert.deepEqual(
    jc.shapeAttachment({ id: 10312, filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048, author: { displayName: 'Jane' }, created: '2026-09-20T10:00:00Z', content: 'https://acme.atlassian.net/rest/api/3/attachment/content/10312' }),
    { id: '10312', filename: 'spec.pdf', mimeType: 'application/pdf', size: 2048, author: 'Jane', created: '2026-09-20T10:00:00Z', contentUrl: 'https://acme.atlassian.net/rest/api/3/attachment/content/10312' },
  );
  assert.equal(jc.shapeAttachment({ filename: 'no-id.txt' }), null);
  assert.equal(jc.shapeAttachment(null), null);
});

test('isTextualAttachment: text/* and text-ish application types + known extensions are inline; images are not', () => {
  assert.equal(jc.isTextualAttachment('text/plain', 'a.txt'), true);
  assert.equal(jc.isTextualAttachment('application/json', 'a.json'), true);
  assert.equal(jc.isTextualAttachment('application/xml', 'a.xml'), true);
  assert.equal(jc.isTextualAttachment('image/png', 'a.png'), false);
  assert.equal(jc.isTextualAttachment('application/octet-stream', 'server.log'), true); // extension fallback
  assert.equal(jc.isTextualAttachment('application/octet-stream', 'photo.jpg'), false);
});

test('getIssue: lists attachment metadata when present, capped with a true count', async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ id: String(1000 + i), filename: `f${i}.txt`, mimeType: 'text/plain', size: 10, author: { displayName: 'Jane' } }));
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-7', fields: { summary: 'S', attachment: many },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-7', { env: CRED.env });
    assert.equal(issue.attachmentCount, 55);
    assert.equal(issue.attachments.length, jc.ATTACHMENT_LIST_CAP);
    assert.equal(issue.attachmentsTruncated, true);
    assert.deepEqual(issue.attachments[0], { id: '1000', filename: 'f0.txt', mimeType: 'text/plain', size: 10, author: 'Jane', created: null, contentUrl: null });
  });
});

test('getAttachment: confirms the id is on the issue, downloads a text attachment inline', async () => {
  await withFetch((url, opts, n) => {
    if (n === 1) {
      assert.match(url, /\/rest\/api\/3\/issue\/KAN-6\?fields=attachment$/);
      return { ok: true, status: 200, text: async () => JSON.stringify({
        key: 'KAN-6', fields: { attachment: [{ id: '10312', filename: 'notes.md', mimeType: 'text/markdown', size: 11, author: { displayName: 'Jane' }, content: 'https://acme.atlassian.net/rest/api/3/attachment/content/10312' }] },
      }) };
    }
    assert.match(url, /\/rest\/api\/3\/attachment\/content\/10312$/);
    assert.match(opts.headers.Authorization, /^Basic /);
    return { ok: true, status: 200, headers: { get: () => 'text/markdown' }, arrayBuffer: async () => Buffer.from('hello world', 'utf8') };
  }, async () => {
    const att = await jc.getAttachment(CRED, 'KAN-6', '10312', { env: CRED.env });
    assert.equal(att.encoding, 'text');
    assert.equal(att.content, 'hello world');
    assert.equal(att.filename, 'notes.md');
  });
});

test('getAttachment: a binary attachment comes back base64', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  await withFetch((url, opts, n) => {
    if (n === 1) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        key: 'KAN-6', fields: { attachment: [{ id: '77', filename: 'shot.png', mimeType: 'image/png', size: bytes.length, author: { displayName: 'Jane' } }] },
      }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes };
  }, async () => {
    const att = await jc.getAttachment(CRED, 'KAN-6', '77', { env: CRED.env });
    assert.equal(att.encoding, 'base64');
    assert.equal(att.content, bytes.toString('base64'));
    assert.equal(att.mimeType, 'image/png');
  });
});

test('getAttachment: an id not on the issue is a 404 domain error, and never triggers a download', async () => {
  const calls = [];
  await withFetch((url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-6', fields: { attachment: [{ id: '10312', filename: 'a.txt' }] } }) };
  }, async () => {
    await assert.rejects(
      () => jc.getAttachment(CRED, 'KAN-6', '999', { env: CRED.env }),
      (e) => e.status === 404 && /not on issue KAN-6/.test(e.message),
    );
    assert.equal(calls.length, 1); // ownership check only — no content fetch
  });
});

test('getAttachment: an over-cap file is refused (413) before any download', async () => {
  const calls = [];
  await withFetch((url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-6', fields: { attachment: [{ id: '5', filename: 'huge.bin', mimeType: 'application/octet-stream', size: 999 }] } }) };
  }, async () => {
    await assert.rejects(
      () => jc.getAttachment(CRED, 'KAN-6', '5', { env: CRED.env, maxBytes: 100 }),
      (e) => e.status === 413 && /over the 100-byte fetch limit/.test(e.message),
    );
    assert.equal(calls.length, 1); // refused on metadata, never downloaded
  });
});

// ── attachment upload (#2408) ─────────────────────────────────────────────────

test('addAttachment: multipart POST with X-Atlassian-Token, returns the created attachment metadata', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-6\/attachments$/);
    assert.equal(opts.method, 'POST');
    assert.match(opts.headers.Authorization, /^Basic /);
    assert.equal(opts.headers['X-Atlassian-Token'], 'no-check'); // Jira's XSRF guard on this endpoint
    assert.ok(opts.body instanceof FormData);           // multipart, not JSON
    assert.equal(opts.headers['Content-Type'], undefined); // boundary set by fetch, not by hand
    return { ok: true, status: 200, text: async () => JSON.stringify([
      { id: 20099, filename: 'report.pdf', mimeType: 'application/pdf', size: 3, author: { displayName: 'Jane' } },
    ]) };
  }, async () => {
    const att = await jc.addAttachment(CRED, 'KAN-6', { filename: 'report.pdf', buffer: Buffer.from('abc'), env: CRED.env });
    assert.deepEqual(att, { id: '20099', filename: 'report.pdf', mimeType: 'application/pdf', size: 3, author: 'Jane', created: null, contentUrl: null });
  });
});

test('addAttachment: an over-cap file is refused (413) before any request', async () => {
  const calls = [];
  await withFetch((url) => { calls.push(url); return { ok: true, status: 200, text: async () => '[]' }; }, async () => {
    await assert.rejects(
      () => jc.addAttachment(CRED, 'KAN-6', { filename: 'big.bin', buffer: Buffer.alloc(200), env: CRED.env, maxBytes: 100 }),
      (e) => e.status === 413 && /over the 100-byte upload limit/.test(e.message),
    );
    assert.equal(calls.length, 0); // never uploaded
  });
});

test('addAttachment: a 404 (unknown/foreign issue) is a mapped domain error carrying the status (AC4)', async () => {
  await withFetch(() => ({ ok: false, status: 404, text: async () => 'no issue' }), async () => {
    await assert.rejects(
      () => jc.addAttachment(CRED, 'NOPE-1', { filename: 'a.txt', buffer: Buffer.from('x'), env: CRED.env }),
      (e) => e.status === 404 && /not found/i.test(e.message),
    );
  });
});

test('addAttachment: a 413 from Jira (instance size limit) maps to a clear message', async () => {
  await withFetch(() => ({ ok: false, status: 413, text: async () => 'too big' }), async () => {
    await assert.rejects(
      () => jc.addAttachment(CRED, 'KAN-6', { filename: 'a.bin', buffer: Buffer.from('x'), env: CRED.env }),
      (e) => e.status === 413 && /larger than this Jira instance allows/i.test(e.message),
    );
  });
});

test('addAttachment: a transport failure is NOT retried — a retry would create a duplicate attachment (F6)', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(`${opts.method} ${new URL(url).pathname}`);
    const e = new TypeError('fetch failed');
    e.cause = { code: 'UND_ERR_SOCKET' };
    throw e;
  };
  try {
    await assert.rejects(
      () => jc.addAttachment(CRED, 'KAN-6', { filename: 'a.txt', buffer: Buffer.from('x'), env: CRED.env }),
      /fetch failed \(UND_ERR_SOCKET\)/,
    );
    assert.deepEqual(calls, ['POST /rest/api/3/issue/KAN-6/attachments']); // exactly one attempt
  } finally { global.fetch = orig; }
});

test('addAttachment: a blank filename or missing buffer is a 400 before any request', async () => {
  await withFetch(() => { throw new Error('must not be called'); }, async () => {
    await assert.rejects(() => jc.addAttachment(CRED, 'KAN-6', { filename: '  ', buffer: Buffer.from('x'), env: CRED.env }), (e) => e.status === 400);
    await assert.rejects(() => jc.addAttachment(CRED, 'KAN-6', { filename: 'a.txt', env: CRED.env }), (e) => e.status === 400);
  });
});

// ── create one Epic + child Stories (#2424) ──────────────────────────────────

// A field catalog carrying a typed "Team" and a numeric "Story point estimate",
// so a create can resolve name → id AND shape by schema type. `epicLinkId`, when
// given, models a company-managed site (its story→epic link is the Epic Link
// custom field, not the native `parent`).
function createFieldList(epicLinkId) {
  const fields = [
    { id: 'customfield_20001', name: 'Team', schema: { type: 'team', custom: 'com.atlassian.teams:rm-teams-custom-field-team' } },
    { id: 'customfield_10016', name: 'Story point estimate', schema: { type: 'number' } },
  ];
  if (epicLinkId) fields.push({ id: epicLinkId, name: 'Epic Link', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } });
  return { ok: true, status: 200, text: async () => JSON.stringify(fields) };
}
const isCreate = (url, opts) => opts && opts.method === 'POST' && /\/rest\/api\/3\/issue$/.test(url);

test('buildCreateFields: project + issuetype + summary; description as ADF; assignee; custom fields shaped by schema', () => {
  const fieldMeta = new Map([
    ['team', { id: 'customfield_20001', schema: { type: 'team' } }],
    ['story point estimate', { id: 'customfield_10016', schema: { type: 'number' } }],
  ]);
  const f = jc.buildCreateFields({
    projectKey: 'KAN',
    issueTypeName: 'Story',
    spec: { summary: '  Do it  ', description: 'why', assignee: 'acc-1', fields: { Team: '42', 'Story point estimate': '5' } },
    fieldMeta,
    attribution: 'by an agent',
  });
  assert.equal(f.project.key, 'KAN');
  assert.deepEqual(f.issuetype, { name: 'Story' });
  assert.equal(f.summary, 'Do it'); // trimmed
  assert.equal(f.description.type, 'doc'); // ADF
  assert.deepEqual(f.assignee, { accountId: 'acc-1' });
  assert.deepEqual(f.customfield_20001, { id: '42' }); // team → {id}
  assert.equal(f.customfield_10016, 5); // number → Number
});

test('buildCreateFields: no description/assignee/fields → only project+issuetype+summary; object value sent verbatim', () => {
  const f = jc.buildCreateFields({ projectKey: 'KAN', issueTypeName: 'Epic', spec: { summary: 'Ask' }, fieldMeta: new Map() });
  assert.deepEqual(f, { project: { key: 'KAN' }, issuetype: { name: 'Epic' }, summary: 'Ask' });
  const meta = new Map([['sprint', { id: 'customfield_30001', schema: { type: 'array' } }]]);
  const g = jc.buildCreateFields({ projectKey: 'KAN', issueTypeName: 'Story', spec: { summary: 'S', fields: { Sprint: [{ id: 9 }] } }, fieldMeta: meta });
  assert.deepEqual(g.customfield_30001, [{ id: 9 }]); // object value verbatim (escape hatch)
});

test('collectCustomFieldNames: union across epic + stories, first spelling wins, case-insensitive dedupe', () => {
  assert.deepEqual(
    jc.collectCustomFieldNames({ fields: { Team: 1 } }, [{ fields: { team: 2, 'Story Points': 3 } }, { fields: { 'story points': 4 } }]),
    ['Team', 'Story Points'],
  );
  assert.deepEqual(jc.collectCustomFieldNames({ summary: 'x' }, [{ summary: 'y' }]), []);
});

test('createEpicWithStories: creates the epic then each story linked via native parent; shapes custom fields; applies status transition', async () => {
  let epicKey = null;
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList(); // team-managed: no Epic Link field
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      if (body.fields.issuetype.name === 'Epic') { epicKey = 'KAN-100'; return { ok: true, status: 201, text: async () => JSON.stringify({ id: '1', key: 'KAN-100' }) }; }
      // a story: linked to the epic via native parent, custom fields shaped
      assert.deepEqual(body.fields.parent, { key: 'KAN-100' });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: '2', key: 'KAN-101' }) };
    }
    if (isTransitionList(url) && (!opts || opts.method !== 'POST')) return transitionsResponse(); // list transitions
    if (isTransitionList(url) && opts.method === 'POST') return { ok: true, status: 204, text: async () => '' }; // apply
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async (calls) => {
    const seen = [];
    const r = await jc.createEpicWithStories(CRED, {
      onCreated: (key) => seen.push({ key, createsSoFar: calls.filter((c) => isCreate(c.url, c.opts)).length }),
      projectKey: 'KAN',
      epic: { summary: 'Q4 revamp', description: 'the ask' },
      stories: [{ summary: 'Design', assignee: 'acc-1', status: 'In Progress', fields: { Team: '42', 'Story point estimate': 5 } }],
      allowList: ['Team', 'Story point estimate'],
      attribution: 'by an agent',
      env: CRED.env,
    });
    assert.equal(r.epic.key, 'KAN-100');
    // onCreated fires per issue, right after ITS create — before the next one
    assert.deepEqual(seen, [{ key: 'KAN-100', createsSoFar: 1 }, { key: 'KAN-101', createsSoFar: 2 }]);
    assert.match(r.epic.url, /\/browse\/KAN-100$/);
    assert.equal(r.created, 2);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.stories[0], { summary: 'Design', key: 'KAN-101', url: `${jc.apiBaseFor('acme', {})}/browse/KAN-101`, ok: true, status: 'In Progress' });
    // the story create carried the shaped custom fields
    const storyCreate = calls.find((c) => isCreate(c.url, c.opts) && JSON.parse(c.opts.body).fields.issuetype.name === 'Story');
    const sf = JSON.parse(storyCreate.opts.body).fields;
    assert.deepEqual(sf.customfield_20001, { id: '42' });
    assert.equal(sf.customfield_10016, 5);
    assert.deepEqual(sf.assignee, { accountId: 'acc-1' });
  });
});

test('createEpicWithStories: company-managed site links a story via the Epic Link custom field, not parent', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList('customfield_10014'); // has an Epic Link field
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      if (body.fields.issuetype.name === 'Epic') return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-1' }) };
      assert.equal(body.fields.customfield_10014, 'KAN-1'); // epic key via Epic Link
      assert.equal('parent' in body.fields, false);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-2' }) };
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.createEpicWithStories(CRED, {
      projectKey: 'KAN', epic: { summary: 'E' }, stories: [{ summary: 'S' }], allowList: [], env: CRED.env,
    });
    assert.equal(r.epic.key, 'KAN-1');
    assert.equal(r.stories[0].key, 'KAN-2');
  });
});

test('createEpicWithStories: a custom field not on the allow-list is refused (403) before any create', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    await assert.rejects(
      () => jc.createEpicWithStories(CRED, {
        projectKey: 'KAN', epic: { summary: 'E' }, stories: [{ summary: 'S', fields: { Team: '42' } }], allowList: ['Sprint'], env: CRED.env,
      }),
      (e) => e.status === 403 && /Team/.test(e.message),
    );
    assert.equal(calls.length, 0); // refused before the catalog fetch or any create
  });
});

test('createEpicWithStories: an EMPTY allow-list permits any custom field on the stories (#2449)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      if (body.fields.issuetype.name === 'Epic') return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-1' }) };
      assert.deepEqual(body.fields.customfield_20001, { id: '42' }); // "Team" written though never allow-listed
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-2' }) };
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.createEpicWithStories(CRED, {
      projectKey: 'KAN', epic: { summary: 'E' }, stories: [{ summary: 'S', fields: { Team: '42' } }], allowList: [], env: CRED.env,
    });
    assert.equal(r.failed, 0);
    assert.equal(r.stories[0].key, 'KAN-2');
  });
});

test('createEpicWithStories: an allow-listed but unknown Jira field name is a 400 before any create', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) throw new Error('no create expected');
    throw new Error('unexpected');
  }, async () => {
    await assert.rejects(
      () => jc.createEpicWithStories(CRED, {
        projectKey: 'KAN', epic: { summary: 'E', fields: { Ghost: 'x' } }, stories: [], allowList: ['Ghost'], env: CRED.env,
      }),
      (e) => e.status === 400 && /unknown Jira field\(s\): Ghost/.test(e.message),
    );
  });
});

test('createEpicWithStories: a missing project / epic summary / story summary is a 400 up front', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async () => {
    await assert.rejects(() => jc.createEpicWithStories(CRED, { projectKey: '', epic: { summary: 'E' }, env: CRED.env }), (e) => e.status === 400);
    await assert.rejects(() => jc.createEpicWithStories(CRED, { projectKey: 'KAN', epic: { summary: '  ' }, env: CRED.env }), (e) => e.status === 400);
    await assert.rejects(
      () => jc.createEpicWithStories(CRED, { projectKey: 'KAN', epic: { summary: 'E' }, stories: [{ summary: '' }], env: CRED.env }),
      (e) => e.status === 400 && /story #1/.test(e.message),
    );
  });
});

test('createEpicWithStories: a story-create failure after the epic exists is reported, not fatal (no create-transaction)', async () => {
  let n = 0;
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      if (body.fields.issuetype.name === 'Epic') return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-1' }) };
      n += 1;
      if (n === 1) return { ok: false, status: 400, text: async () => 'bad assignee' }; // first story fails
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-3' }) };
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.createEpicWithStories(CRED, {
      projectKey: 'KAN', epic: { summary: 'E' }, stories: [{ summary: 'bad' }, { summary: 'good' }], allowList: [], env: CRED.env,
    });
    assert.equal(r.epic.key, 'KAN-1');
    assert.equal(r.created, 2); // epic + the good story
    assert.equal(r.failed, 1);
    assert.equal(r.stories[0].ok, false);
    assert.match(r.stories[0].error, /400/);
    assert.equal(r.stories[1].key, 'KAN-3');
  });
});

test('createEpicWithStories: a create is NOT retried on a transport failure (F6 — a retry would duplicate)', async () => {
  const calls = [];
  await withFetch((url, opts) => {
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) {
      calls.push('create');
      const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET' }; throw e;
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(
      () => jc.createEpicWithStories(CRED, { projectKey: 'KAN', epic: { summary: 'E' }, stories: [], allowList: [], env: CRED.env }),
      /fetch failed/,
    );
    assert.deepEqual(calls, ['create']); // exactly one attempt — no retry
  });
});

// ── add new Stories to an EXISTING Epic (#2890) ──────────────────────────────

// GET /rest/api/3/issue/<KEY>?fields=… — the parent lookup that runs before any create.
const isIssueGet = (url, opts) => (!opts || !opts.method || opts.method === 'GET') && /\/rest\/api\/3\/issue\/[^/?]+\?fields=/.test(url);
const issueResponse = (key, typeName, { project = 'KAN', hierarchyLevel } = {}) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ key, fields: { summary: 'Existing epic', project: { key: project }, issuetype: { name: typeName, hierarchyLevel } } }),
});

test('addStoriesToEpic: creates every story under the existing Epic in ITS project — never an Epic (#2890 AC1/AC2/AC6)', async () => {
  let n = 0;
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) {
      assert.match(url, /\/issue\/OPS-12\?/); // a lowercase key is normalised
      return issueResponse('OPS-12', 'Epic', { project: 'OPS', hierarchyLevel: 1 });
    }
    if (isFieldList(url)) return createFieldList(); // team-managed: native parent
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      assert.equal(body.fields.issuetype.name, 'Story'); // AC2 — no Epic is ever created
      assert.deepEqual(body.fields.project, { key: 'OPS' }); // the Epic's project
      assert.deepEqual(body.fields.parent, { key: 'OPS-12' });
      n += 1;
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `OPS-${100 + n}` }) };
    }
    if (isTransitionList(url) && (!opts || opts.method !== 'POST')) return transitionsResponse();
    if (isTransitionList(url) && opts.method === 'POST') return { ok: true, status: 204, text: async () => '' };
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async (calls) => {
    const seen = [];
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: ' ops-12 ',
      stories: [
        { summary: 'Design', description: 'the why', assignee: 'acc-1', status: 'In Progress', fields: { Team: '42', 'Story point estimate': 5 } },
        { summary: 'Build' },
        { summary: 'Ship' },
      ],
      allowList: ['Team', 'Story point estimate'],
      attribution: 'by an agent',
      onCreated: (key) => seen.push(key),
      env: CRED.env,
    });
    assert.equal(r.project, 'OPS');
    assert.equal(r.epic.key, 'OPS-12');
    assert.match(r.epic.url, /\/browse\/OPS-12$/);
    assert.equal(r.created, 3);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.stories.map((s) => s.key), ['OPS-101', 'OPS-102', 'OPS-103']);
    assert.equal(r.stories[0].status, 'In Progress'); // follow-up transition, as in create-epic
    assert.deepEqual(seen, ['OPS-101', 'OPS-102', 'OPS-103']); // each registered as it is created
    const first = JSON.parse(calls.find((c) => isCreate(c.url, c.opts)).opts.body).fields;
    assert.deepEqual(first.customfield_20001, { id: '42' });
    assert.equal(first.customfield_10016, 5);
    assert.deepEqual(first.assignee, { accountId: 'acc-1' });
    assert.ok(first.description, 'description sent as ADF');
  });
});

test('addStoriesToEpic: a company-managed site links via the Epic Link field, not parent', async () => {
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return issueResponse('KAN-1', 'Epic');
    if (isFieldList(url)) return createFieldList('customfield_10014');
    if (isCreate(url, opts)) {
      const body = JSON.parse(opts.body);
      assert.equal(body.fields.customfield_10014, 'KAN-1');
      assert.equal('parent' in body.fields, false);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: 'KAN-2' }) };
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.addStoriesToEpic(CRED, { epicKey: 'KAN-1', stories: [{ summary: 'S' }], allowList: [], env: CRED.env });
    assert.equal(r.stories[0].key, 'KAN-2');
  });
});

test('addStoriesToEpic: one failing story does not block the others (#2890 AC3)', async () => {
  let n = 0;
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return issueResponse('KAN-1', 'Epic');
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) {
      n += 1;
      if (n === 1) return { ok: false, status: 400, text: async () => 'bad assignee' };
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `KAN-${n + 1}` }) };
    }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: 'KAN-1', stories: [{ summary: 'bad' }, { summary: 'good' }], allowList: [], env: CRED.env,
    });
    assert.equal(r.created, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.stories[0].ok, false);
    assert.match(r.stories[0].error, /400/);
    assert.equal(r.stories[1].key, 'KAN-3');
  });
});

test('addStoriesToEpic: a missing or invisible Epic is a 404 and nothing is created (#2890 AC4)', async () => {
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async (calls) => {
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'NOPE-9', stories: [{ summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 404 && /NOPE-9/.test(e.message) && /scope/.test(e.message) && /Nothing was created/.test(e.message),
    );
    assert.equal(calls.filter((c) => isCreate(c.url, c.opts)).length, 0);
  });
});

test('addStoriesToEpic: a parent that is not an Epic is refused, naming its type (#2890 AC5)', async () => {
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return issueResponse('KAN-7', 'Bug', { hierarchyLevel: 0 });
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async (calls) => {
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'KAN-7', stories: [{ summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /KAN-7 is a Bug, not an Epic/.test(e.message),
    );
    assert.equal(calls.filter((c) => isCreate(c.url, c.opts)).length, 0);
  });
});

test('isEpicIssueType: by name (case-insensitive, overridable) or by Epic hierarchy level', () => {
  assert.equal(jc.isEpicIssueType({ name: 'epic' }, 'Epic'), true);
  assert.equal(jc.isEpicIssueType({ name: 'Initiative' }, 'Initiative'), true);
  assert.equal(jc.isEpicIssueType({ name: 'Épique', hierarchyLevel: 1 }, 'Epic'), true); // localised name
  assert.equal(jc.isEpicIssueType({ name: 'Story', hierarchyLevel: 0 }, 'Epic'), false);
  assert.equal(jc.isEpicIssueType(undefined, 'Epic'), false);
});

test('addStoriesToEpic: a custom field off a non-empty allow-list is a 403 before any Jira call (#2890 AC7)', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, {
        epicKey: 'KAN-1', stories: [{ summary: 'ok' }, { summary: 'S', fields: { Team: '42' } }], allowList: ['Sprint'], env: CRED.env,
      }),
      (e) => e.status === 403 && /Team/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });
});

test('addStoriesToEpic: no key / a malformed key / no stories / a story without a summary is a 400 up front (#2890 AC8)', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    const bad = (args) => assert.rejects(() => jc.addStoriesToEpic(CRED, { allowList: [], env: CRED.env, ...args }), (e) => e.status === 400);
    await bad({ epicKey: '', stories: [{ summary: 'S' }] });
    await bad({ epicKey: 'not a key', stories: [{ summary: 'S' }] });
    await bad({ epicKey: 'KAN-1', stories: [] });
    await bad({ epicKey: 'KAN-1' });
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'KAN-1', stories: [{ summary: 'S' }, { summary: '  ' }], allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /story #2/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });
});

// ── board & sprint management (#2450) ───────────────────────────────────────

const AGILE = 'http://fake-jira:8080/rest/agile/1.0';
const isBoardSearch = (url) => /\/rest\/agile\/1\.0\/board\?/.test(url);
const isSprintList = (url) => /\/rest\/agile\/1\.0\/board\/\d+\/sprint/.test(url);
const isSprintCreate = (url, opts) => /\/rest\/agile\/1\.0\/sprint$/.test(url) && opts && opts.method === 'POST';
const boardSearchResponse = (boards) => ({ ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: boards }) });

test('weekOfMonth: the Nth-weekday-of-month index (ceil(day/7))', () => {
  assert.equal(jc.weekOfMonth(new Date(Date.UTC(2026, 9, 26))), 4); // Mon 26 Oct → 4th Monday
  assert.equal(jc.weekOfMonth(new Date(Date.UTC(2026, 10, 2))), 1); // Mon 2 Nov → 1st Monday
  assert.equal(jc.weekOfMonth(new Date(Date.UTC(2026, 0, 1))), 1);
  assert.equal(jc.weekOfMonth(new Date(Date.UTC(2026, 0, 31))), 5);
});

test('renderSprintName: substitutes known placeholders, leaves unknown verbatim', () => {
  const day = new Date(Date.UTC(2026, 9, 26)); // Mon 26 Oct 2026
  assert.equal(jc.renderSprintName('Acc2.0 {MMM}_{weekOfMonth}', day, 1), 'Acc2.0 Oct_4');
  assert.equal(jc.renderSprintName('{MMMM} {DD}/{MM}/{YYYY} #{n}', day, 3), 'October 26/10/2026 #3');
  assert.equal(jc.renderSprintName('S{index} {YY}', day, 7), 'S7 26');
  assert.equal(jc.renderSprintName('keep {bogus}', day, 1), 'keep {bogus}'); // unknown token untouched
});

test('planSprints: the ticket example — month follows the sprint Monday across a week that crosses months', () => {
  const plan = jc.planSprints({
    start: new Date(Date.UTC(2026, 9, 26)), cadenceDays: 7,
    until: new Date(Date.UTC(2026, 10, 8)), nameTemplate: 'Acc2.0 {MMM}_{weekOfMonth}',
  });
  assert.deepEqual(plan, [
    { name: 'Acc2.0 Oct_4', startDate: '2026-10-26T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z' },
    { name: 'Acc2.0 Nov_1', startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-08T00:00:00.000Z' },
  ]);
});

test('planSprints: a sprint is generated while its START is on or before the target date', () => {
  // until falls mid-second-sprint → the second sprint (start ≤ until) is still created.
  const plan = jc.planSprints({
    start: new Date(Date.UTC(2026, 0, 5)), cadenceDays: 7,
    until: new Date(Date.UTC(2026, 0, 13)), nameTemplate: 'S{n}',
  });
  assert.deepEqual(plan.map((p) => p.startDate), ['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z']);
});

test('planSprints: rejects an empty template, a bad cadence, and a runaway run', () => {
  const base = { start: new Date(Date.UTC(2026, 0, 1)), until: new Date(Date.UTC(2026, 0, 8)) };
  assert.throws(() => jc.planSprints({ ...base, cadenceDays: 7, nameTemplate: '  ' }), /template is required/);
  assert.throws(() => jc.planSprints({ ...base, cadenceDays: 0, nameTemplate: 'S{n}' }), /cadence/);
  assert.throws(
    () => jc.planSprints({ start: base.start, cadenceDays: 1, until: new Date(Date.UTC(2030, 0, 1)), nameTemplate: 'S{n}' }),
    /more than 104 sprints/,
  );
});

test('resolveBoardByName: an exact (case-insensitive) name wins over other substring matches', async () => {
  await withFetch((url) => {
    if (isBoardSearch(url)) return boardSearchResponse([
      { id: 5, name: 'Team Scrum Board', type: 'scrum' },
      { id: 9, name: 'Team Scrum Board (old)', type: 'scrum' },
    ]);
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const b = await jc.resolveBoardByName(CRED, { boardName: 'team scrum board', env: CRED.env });
    assert.deepEqual(b, { id: '5', name: 'Team Scrum Board', type: 'scrum' });
  });
});

test('resolveBoardByName: no match → 404; several non-exact matches → 409', async () => {
  await withFetch(() => boardSearchResponse([]), async () => {
    await assert.rejects(() => jc.resolveBoardByName(CRED, { boardName: 'nope', env: CRED.env }), (e) => e.status === 404);
  });
  await withFetch(() => boardSearchResponse([
    { id: 1, name: 'Scrum Board A' }, { id: 2, name: 'Scrum Board B' },
  ]), async () => {
    await assert.rejects(() => jc.resolveBoardByName(CRED, { boardName: 'Scrum Board', env: CRED.env }), (e) => e.status === 409);
  });
});

test('listBoardSprints: resolves the board by name, paginates, shapes the sprints', async () => {
  await withFetch((url) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board', type: 'scrum' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true,
      values: [
        { id: 100, name: 'Sprint 1', state: 'closed', startDate: '2026-01-05T00:00:00.000Z', endDate: '2026-01-11T00:00:00.000Z', originBoardId: 7 },
        { id: 101, name: 'Sprint 2', state: 'future' },
      ],
    }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const { board, sprints } = await jc.listBoardSprints(CRED, { boardName: 'Board', env: CRED.env });
    assert.deepEqual(board, { id: '7', name: 'Board' });
    assert.equal(sprints.length, 2);
    assert.deepEqual(sprints[0], {
      id: '100', name: 'Sprint 1', state: 'closed',
      startDate: '2026-01-05T00:00:00.000Z', endDate: '2026-01-11T00:00:00.000Z', goal: null, boardId: '7',
    });
    assert.equal(sprints[1].startDate, null);
  });
});

test('createSprint: POSTs name + normalized dates + originBoardId (a write, not retried)', async () => {
  const bodies = [];
  const calls = [];
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 12, name: 'Board' }]);
    if (isSprintCreate(url, opts)) {
      calls.push('create');
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 300, name: 'Sprint 12', state: 'future', originBoardId: 12 }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async () => {
    const r = await jc.createSprint(CRED, { boardName: 'Board', name: 'Sprint 12', startDate: '2026-10-26', endDate: '2026-11-01', env: CRED.env });
    assert.deepEqual(bodies[0], {
      name: 'Sprint 12', originBoardId: 12,
      startDate: '2026-10-26T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(r.sprint.id, '300');
    assert.equal(r.board.id, '12');
  });
  // a create is never retried on a transport failure (F6)
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 1, name: 'B' }]);
    if (isSprintCreate(url, opts)) { calls.push('retry?'); const e = new TypeError('fetch failed'); e.cause = { code: 'X' }; throw e; }
    throw new Error('unexpected');
  }, async () => {
    await assert.rejects(() => jc.createSprint(CRED, { boardName: 'B', name: 'S', startDate: '2026-01-01', endDate: '2026-01-07', env: CRED.env }), /fetch failed/);
  });
  assert.deepEqual(calls, ['create', 'retry?']); // exactly one create in each phase — no retry
});

test('bulkCreateSprints: continues from the board latest sprint end, reports a per-sprint failure map', async () => {
  let creates = 0;
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 3, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true,
      values: [{ id: 50, name: 'Prev', state: 'future', startDate: '2026-10-19T00:00:00.000Z', endDate: '2026-10-25T00:00:00.000Z' }],
    }) };
    if (isSprintCreate(url, opts)) {
      creates += 1;
      if (creates === 2) return { ok: false, status: 400, text: async () => 'bad' }; // the 2nd sprint fails
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 500 + creates, state: 'future' }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async () => {
    const r = await jc.bulkCreateSprints(CRED, {
      boardName: 'Board', nameTemplate: 'Acc2.0 {MMM}_{weekOfMonth}', until: '2026-11-15', env: CRED.env,
    });
    // continues from 2026-10-25 → first new sprint starts Mon 2026-10-26; through
    // 2026-11-15 that is 3 sprints (start 10-26, 11-02, 11-09).
    assert.equal(r.sprints[0].name, 'Acc2.0 Oct_4');
    assert.equal(r.sprints[0].startDate, '2026-10-26T00:00:00.000Z');
    assert.equal(r.requested, 3);
    assert.equal(r.created, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.sprints[1].ok, false);
    assert.match(r.sprints[1].error, /400/);
  });
});

test('bulkCreateSprints: a board with no dated sprint and no --start is refused (400)', async () => {
  await withFetch((url) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 3, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [] }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(
      () => jc.bulkCreateSprints(CRED, { boardName: 'Board', nameTemplate: 'S{n}', until: '2026-11-08', env: CRED.env }),
      (e) => e.status === 400 && /supply --start/.test(e.message),
    );
  });
});

test('bulkCreateSprints: an explicit --start overrides continue-from-latest (no sprint list fetched)', async () => {
  let listed = false;
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 3, name: 'Board' }]);
    if (isSprintList(url)) { listed = true; return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [] }) }; }
    if (isSprintCreate(url, opts)) return { ok: true, status: 201, text: async () => JSON.stringify({ id: 9, state: 'future' }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.bulkCreateSprints(CRED, {
      boardName: 'Board', nameTemplate: 'S{n}', start: '2026-01-05', until: '2026-01-05', env: CRED.env,
    });
    assert.equal(listed, false); // --start given → no need to read existing sprints
    assert.equal(r.requested, 1);
    assert.equal(r.sprints[0].startDate, '2026-01-05T00:00:00.000Z');
  });
});

// ── fetchRecentComments (comment_added backfill) ────────────────────────────

test('fetchRecentComments: newest-first pages, stops at the first comment older than since, returns oldest-first', async () => {
  const c = (id, created) => ({ id, created, body: { type: 'doc', content: [] } });
  await withFetch((url) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-6\/comment\?orderBy=-created&startAt=\d+&maxResults=50$/);
    const startAt = Number(/startAt=(\d+)/.exec(url)[1]);
    const pages = {
      0: { total: 120, comments: [c('9', '2026-01-01T11:59:00Z'), c('8', '2026-01-01T11:58:00Z')] },
      2: { total: 120, comments: [c('7', '2026-01-01T11:57:00Z'), c('6', '2026-01-01T11:00:00Z'), c('5', '2026-01-01T10:59:00Z')] },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[startAt] || { total: 120, comments: [] }) };
  }, async (calls) => {
    const out = await jc.fetchRecentComments(CRED, 'KAN-6', { sinceIso: '2026-01-01T11:50:00Z', env: CRED.env });
    assert.deepEqual(out.map((x) => x.id), ['7', '8', '9']);
    assert.equal(calls.length, 2, 'stops paging once it reaches an old comment');
  });
});

// ── sprint lifecycle transitions: close / start / advance (#2491) ────────────

const isSprintState = (url, opts) => /\/rest\/agile\/1\.0\/sprint\/\d+$/.test(url) && opts && opts.method === 'POST';
const isSprintGet = (url, opts) => /\/rest\/agile\/1\.0\/sprint\/\d+$/.test(url) && (!opts || opts.method === 'GET' || !opts.method);
const isSprintIssues = (url) => /\/rest\/agile\/1\.0\/sprint\/\d+\/issue/.test(url);
const sprintIssuesResponse = (cats) => ({ ok: true, status: 200, text: async () => JSON.stringify({
  total: cats.length, issues: cats.map((k, i) => ({ id: String(i), fields: { status: { statusCategory: { key: k } } } })),
}) });

test('activeSprintOf / nextFutureSprint: pick the active one and the earliest-starting future one', () => {
  const sprints = [
    { id: '1', state: 'closed', startDate: '2026-01-01T00:00:00.000Z' },
    { id: '2', state: 'active', startDate: '2026-01-08T00:00:00.000Z' },
    { id: '3', state: 'future', startDate: '2026-01-22T00:00:00.000Z' },
    { id: '4', state: 'future', startDate: '2026-01-15T00:00:00.000Z' },
  ];
  assert.equal(jc.activeSprintOf(sprints).id, '2');
  assert.equal(jc.nextFutureSprint(sprints).id, '4'); // earliest future start wins
  assert.equal(jc.activeSprintOf([]), null);
  assert.equal(jc.nextFutureSprint([{ id: '9', state: 'closed' }]), null);
});

test('closeSprint: closes the board active sprint, re-sends its fields, reports incomplete issues', async () => {
  const bodies = [];
  const calls = [];
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintIssues(url)) return sprintIssuesResponse(['done', 'indeterminate', 'new']); // 2 incomplete
    if (isSprintState(url, opts)) {
      calls.push('state');
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 200, name: 'Sprint 5', state: 'closed', originBoardId: 7 }) };
    }
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 199, name: 'Old', state: 'closed' },
      { id: 200, name: 'Sprint 5', state: 'active', startDate: '2026-02-02T00:00:00.000Z', endDate: '2026-02-08T00:00:00.000Z', goal: 'ship it' },
    ] }) };
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async () => {
    const r = await jc.closeSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.sprint.id, '200');
    assert.equal(r.sprint.state, 'closed');
    assert.equal(r.incompleteIssues, 2);
    assert.equal(bodies[0].state, 'closed');
    assert.equal(bodies[0].startDate, '2026-02-02T00:00:00.000Z'); // existing fields re-sent
    assert.equal(bodies[0].goal, 'ship it');
  });
  assert.deepEqual(calls, ['state']); // exactly one write
});

test('closeSprint: no active sprint → 409; a non-active --sprint-id → 409', async () => {
  await withFetch((url) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 1, state: 'closed' }] }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(() => jc.closeSprint(CRED, { boardName: 'Board', env: CRED.env }), (e) => e.status === 409 && /no active sprint/.test(e.message));
  });
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintState(url, opts)) throw new Error('must not write');
    if (isSprintGet(url, opts)) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 55, name: 'Fut', state: 'future' }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(() => jc.closeSprint(CRED, { boardName: 'Board', sprintId: '55', env: CRED.env }), (e) => e.status === 409 && /only an active sprint can be closed/.test(e.message));
  });
});

test('closeSprint: incomplete-issue count degrades to null on a lookup failure (never breaks the close)', async () => {
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintIssues(url)) return { ok: false, status: 500, text: async () => 'boom' };
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 200, name: 'A', state: 'active', startDate: '2026-02-02T00:00:00.000Z', endDate: '2026-02-08T00:00:00.000Z' }] }) };
    if (isSprintState(url, opts)) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 200, state: 'closed' }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.closeSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.incompleteIssues, null);
    assert.equal(r.sprint.state, 'closed');
  });
});

test('startSprint: activates the earliest future sprint (not retried on transport failure)', async () => {
  const bodies = [];
  const calls = [];
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 300, name: 'Later', state: 'future', startDate: '2026-03-16T00:00:00.000Z', endDate: '2026-03-22T00:00:00.000Z' },
      { id: 301, name: 'Next', state: 'future', startDate: '2026-03-09T00:00:00.000Z', endDate: '2026-03-15T00:00:00.000Z' },
    ] }) };
    if (isSprintState(url, opts)) {
      calls.push('state'); bodies.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 301, name: 'Next', state: 'active' }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async () => {
    const r = await jc.startSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.sprint.id, '301');
    assert.equal(r.sprint.state, 'active');
    assert.match(bodies[0].url, /\/sprint\/301$/); // the earliest-start future one
    assert.equal(bodies[0].body.state, 'active');
  });
  // never retried
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 301, name: 'Next', state: 'future', startDate: '2026-03-09T00:00:00.000Z', endDate: '2026-03-15T00:00:00.000Z' }] }) };
    if (isSprintState(url, opts)) { calls.push('retry?'); const e = new TypeError('fetch failed'); e.cause = { code: 'X' }; throw e; }
    throw new Error('unexpected');
  }, async () => {
    await assert.rejects(() => jc.startSprint(CRED, { boardName: 'Board', env: CRED.env }), /fetch failed/);
  });
  assert.deepEqual(calls, ['state', 'retry?']);
});

test('startSprint: refuses a second active sprint, a non-future target, and a dateless sprint', async () => {
  // already an active sprint
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintState(url, opts)) throw new Error('must not write');
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 400, name: 'Running', state: 'active', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-07T00:00:00.000Z' },
      { id: 401, name: 'Next', state: 'future', startDate: '2026-01-08T00:00:00.000Z', endDate: '2026-01-14T00:00:00.000Z' },
    ] }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(() => jc.startSprint(CRED, { boardName: 'Board', env: CRED.env }), (e) => e.status === 409 && /already has an active sprint/.test(e.message));
  });
  // a dateless future sprint
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintState(url, opts)) throw new Error('must not write');
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 402, name: 'Undated', state: 'future' }] }) };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(() => jc.startSprint(CRED, { boardName: 'Board', env: CRED.env }), (e) => e.status === 400 && /no start\/end date/.test(e.message));
  });
});

test('advanceSprint: closes the active sprint then starts the next future one', async () => {
  const writes = [];
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintIssues(url)) return sprintIssuesResponse(['done']); // 0 incomplete
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 500, name: 'Cur', state: 'active', startDate: '2026-04-06T00:00:00.000Z', endDate: '2026-04-12T00:00:00.000Z' },
      { id: 501, name: 'Nxt', state: 'future', startDate: '2026-04-13T00:00:00.000Z', endDate: '2026-04-19T00:00:00.000Z' },
    ] }) };
    if (isSprintState(url, opts)) {
      const body = JSON.parse(opts.body);
      writes.push({ url, state: body.state });
      const id = url.match(/\/sprint\/(\d+)$/)[1];
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: Number(id), state: body.state }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  }, async () => {
    const r = await jc.advanceSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.failed, false);
    assert.equal(r.close.ok, true);
    assert.equal(r.close.sprint.id, '500');
    assert.equal(r.close.incompleteIssues, 0);
    assert.equal(r.start.ok, true);
    assert.equal(r.start.sprint.id, '501');
    assert.deepEqual(writes.map((w) => w.state), ['closed', 'active']); // close before start
  });
});

test('advanceSprint: no active sprint skips the close but still starts the next future one', async () => {
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 601, name: 'Nxt', state: 'future', startDate: '2026-05-04T00:00:00.000Z', endDate: '2026-05-10T00:00:00.000Z' },
    ] }) };
    if (isSprintState(url, opts)) { const body = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 601, state: body.state }) }; }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.advanceSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.close.ok, false);
    assert.equal(r.close.skipped, true);
    assert.equal(r.start.ok, true);
    assert.equal(r.failed, false); // a skipped close is not a failure
  });
});

test('advanceSprint: closed but no future sprint to start is a reported partial (failed:true)', async () => {
  await withFetch((url, opts) => {
    if (isBoardSearch(url)) return boardSearchResponse([{ id: 7, name: 'Board' }]);
    if (isSprintIssues(url)) return sprintIssuesResponse(['new']); // 1 incomplete
    if (isSprintList(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
      { id: 700, name: 'Cur', state: 'active', startDate: '2026-06-01T00:00:00.000Z', endDate: '2026-06-07T00:00:00.000Z' },
    ] }) };
    if (isSprintState(url, opts)) { const body = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 700, state: body.state }) }; }
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const r = await jc.advanceSprint(CRED, { boardName: 'Board', env: CRED.env });
    assert.equal(r.close.ok, true);
    assert.equal(r.close.incompleteIssues, 1);
    assert.equal(r.start.ok, false);
    assert.match(r.start.error, /no future sprint to start/);
    assert.equal(r.failed, true);
  });
});

// ── issue links (#2884) ─────────────────────────────────────────────────────

const LINK_TYPES = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10001', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
];
const json = (status, body, headers) => ({
  ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)),
  headers: { get: (h) => (headers || {})[h.toLowerCase()] || null },
});
const isLinkTypes = (url) => /\/issueLinkType$/.test(url);
const isConfiguration = (url) => /\/rest\/api\/3\/configuration$/.test(url);
const issueLinksOf = (url) => (/\/issue\/([^/?]+)\?fields=issuelinks$/.exec(url) || [])[1];
const BLOCKS = LINK_TYPES[0];
const RELATES = LINK_TYPES[2];

test('shapeIssueLink: the relationship is phrased from THIS issue — outwardIssue → outward phrase, inwardIssue → inward', () => {
  const out = jc.shapeIssueLink({ id: 7, type: BLOCKS, outwardIssue: { key: 'KAN-2', fields: { summary: 'Two', status: { name: 'To Do' } } } }, 'KAN-1');
  assert.deepEqual(out, {
    id: '7', type: 'Blocks', relationship: 'blocks',
    otherIssue: { key: 'KAN-2', summary: 'Two', status: 'To Do' }, statement: 'KAN-1 blocks KAN-2',
  });
  const inn = jc.shapeIssueLink({ id: '8', type: BLOCKS, inwardIssue: { key: 'KAN-3', fields: { summary: 'Three' } } }, 'KAN-1');
  assert.equal(inn.relationship, 'is blocked by');
  assert.equal(inn.statement, 'KAN-1 is blocked by KAN-3');
  assert.equal(inn.otherIssue.status, null);
});

test('shapeIssueLinks: a link whose other end is missing (deleted / not visible) is skipped, the rest kept; none → []', () => {
  const links = jc.shapeIssueLinks([
    { id: '1', type: BLOCKS }, // other end not returned
    { id: '2', type: RELATES, outwardIssue: { key: 'KAN-9', fields: {} } },
    null,
  ], 'KAN-1');
  assert.deepEqual(links.map((l) => l.id), ['2']);
  assert.deepEqual(jc.shapeIssueLinks(undefined, 'KAN-1'), []);
});

test('getIssue: `links` lists the issue links (both directions) and is [] when there are none (#2884 AC1)', async () => {
  const body = (issuelinks) => ({ key: 'KAN-1', fields: { summary: 'S', status: { name: 'To Do' }, issuelinks } });
  let links = [
    { id: '100', type: BLOCKS, outwardIssue: { key: 'KAN-2', fields: { summary: 'Two', status: { name: 'Done' } } } },
    { id: '101', type: BLOCKS, inwardIssue: { key: 'OPS-4', fields: { summary: 'Four', status: { name: 'To Do' } } } },
  ];
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    assert.match(url, /fields=[^&]*issuelinks/);
    return json(200, body(links));
  }, async () => {
    const issue = await jc.getIssue(CRED, 'KAN-1', { env: CRED.env });
    assert.deepEqual(issue.links.map((l) => [l.id, l.statement, l.otherIssue.status]), [
      ['100', 'KAN-1 blocks KAN-2', 'Done'],
      ['101', 'KAN-1 is blocked by OPS-4', 'To Do'],
    ]);
    links = undefined;
    assert.deepEqual((await jc.getIssue(CRED, 'KAN-1', { env: CRED.env })).links, []);
  });
});

test('resolveLinkType: name or either phrase, case-insensitive; a phrase sets the direction (#2884 AC4)', () => {
  assert.deepEqual(jc.resolveLinkType(LINK_TYPES, 'Blocks'), { type: BLOCKS, phrase: 'blocks', reversed: false });
  assert.deepEqual(jc.resolveLinkType(LINK_TYPES, 'blocks'), { type: BLOCKS, phrase: 'blocks', reversed: false });
  assert.deepEqual(jc.resolveLinkType(LINK_TYPES, '  IS BLOCKED BY '), { type: BLOCKS, phrase: 'is blocked by', reversed: true });
  assert.deepEqual(jc.resolveLinkType(LINK_TYPES, 'duplicates'), { type: LINK_TYPES[1], phrase: 'duplicates', reversed: false });
  assert.deepEqual(jc.resolveLinkType(LINK_TYPES, 'relates to'), { type: RELATES, phrase: 'relates to', reversed: false });
});

test('resolveLinkType: an unknown type lists the available ones; a phrase two types share is ambiguous', () => {
  assert.throws(() => jc.resolveLinkType(LINK_TYPES, 'causes'),
    (e) => e.status === 400 && /unknown link type "causes"/.test(e.message) && /Blocks \(blocks \/ is blocked by\)/.test(e.message) && /Relates/.test(e.message));
  const shared = [...LINK_TYPES, { id: '20000', name: 'Hard block', inward: 'is blocked by', outward: 'hard-blocks' }];
  assert.throws(() => jc.resolveLinkType(shared, 'is blocked by'),
    (e) => e.status === 400 && /several link types \(Blocks, Hard block\)/.test(e.message) && /name the link type/.test(e.message));
  assert.throws(() => jc.resolveLinkType(LINK_TYPES, ''), (e) => e.status === 400);
});

test('listLinkTypes: reads /issueLinkType as { id, name, inward, outward } (#2884 AC2)', async () => {
  await withFetch((url) => {
    assert.ok(isLinkTypes(url));
    return json(200, { issueLinkTypes: [{ id: 10000, name: 'Blocks', inward: 'is blocked by', outward: 'blocks', self: 'x' }] });
  }, async () => {
    assert.deepEqual(await jc.listLinkTypes(CRED, { env: CRED.env }), [BLOCKS]);
  });
});

// A stub Jira for the link writes. `links` maps an issue key to its raw
// `issuelinks`; every call is recorded.
function linkJira({ links = {}, config = { issueLinkingEnabled: true }, post, del, getLink } = {}) {
  return (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (isLinkTypes(url)) return json(200, { issueLinkTypes: LINK_TYPES });
    if (isConfiguration(url)) return json(200, config);
    const key = issueLinksOf(url);
    if (key) return key in links ? json(200, { key, fields: { issuelinks: links[key] } }) : json(404, { errorMessages: ['Issue does not exist'] });
    if (/\/issueLink$/.test(url) && method === 'POST') return post ? post(JSON.parse(opts.body)) : json(201, undefined, { location: 'http://fake-jira:8080/rest/api/3/issueLink/555' });
    if (/\/issueLink\/\d+$/.test(url) && method === 'DELETE') return del ? del(url) : json(204);
    if (/\/issueLink\/\d+$/.test(url)) return getLink ? getLink(url) : json(404, {});
    throw new Error(`unexpected ${method} ${url}`);
  };
}
const writesOf = (calls) => calls.filter((c) => c.opts && c.opts.method && c.opts.method !== 'GET');

test('createIssueLink: "A blocks B" posts A as inwardIssue (Jira gives the inward end the outward phrase) and returns the Location id (#2884 AC3)', async () => {
  await withFetch(linkJira({ links: { 'KAN-1': [] } }), async (calls) => {
    const r = await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env });
    assert.deepEqual(r, { created: true, id: '555', type: 'Blocks', statement: 'KAN-1 blocks KAN-2', issues: ['KAN-1', 'KAN-2'] });
    const [post] = writesOf(calls);
    assert.deepEqual(JSON.parse(post.opts.body), { type: { name: 'Blocks' }, inwardIssue: { key: 'KAN-1' }, outwardIssue: { key: 'KAN-2' } });
  });
});

test('createIssueLink: an inward phrase flips the direction — "A is blocked by B" is the link "B blocks A"', async () => {
  await withFetch(linkJira({ links: { 'KAN-2': [] } }), async (calls) => {
    const r = await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'Is Blocked By', to: 'KAN-2', env: CRED.env });
    assert.equal(r.statement, 'KAN-1 is blocked by KAN-2');
    const [post] = writesOf(calls);
    assert.deepEqual(JSON.parse(post.opts.body), { type: { name: 'Blocks' }, inwardIssue: { key: 'KAN-2' }, outwardIssue: { key: 'KAN-1' } });
  });
});

test('createIssueLink: an existing link of the same type + direction is reported, not duplicated (#2884 AC5)', async () => {
  const links = { 'KAN-1': [{ id: '42', type: BLOCKS, outwardIssue: { key: 'KAN-2' } }] };
  await withFetch(linkJira({ links }), async (calls) => {
    const r = await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'Blocks', to: 'kan-2', env: CRED.env });
    assert.equal(r.created, false);
    assert.equal(r.id, '42');
    assert.equal(writesOf(calls).length, 0);
  });
  // the OPPOSITE direction is a different link → created
  const reverse = { 'KAN-1': [{ id: '42', type: BLOCKS, inwardIssue: { key: 'KAN-2' } }] };
  await withFetch(linkJira({ links: reverse }), async (calls) => {
    assert.equal((await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'Blocks', to: 'KAN-2', env: CRED.env })).created, true);
    assert.equal(writesOf(calls).length, 1);
  });
});

test('createIssueLink: a symmetric type ("relates to") treats B→A as the same link as A→B', async () => {
  const links = { 'KAN-1': [{ id: '77', type: RELATES, inwardIssue: { key: 'KAN-2' } }] };
  await withFetch(linkJira({ links }), async (calls) => {
    const r = await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'relates to', to: 'KAN-2', env: CRED.env });
    assert.deepEqual([r.created, r.id], [false, '77']);
    assert.equal(writesOf(calls).length, 0);
  });
});

test('createIssueLink: self-link refused before ANY Jira call; unknown type refused before any write (#2884 AC4/AC7)', async () => {
  await withFetch(linkJira(), async (calls) => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'kan-1', env: CRED.env }),
      (e) => e.status === 400 && /itself/.test(e.message));
    assert.equal(calls.length, 0);
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'causes', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 400 && /Available: Blocks/.test(e.message));
    assert.equal(writesOf(calls).length, 0);
  });
});

test('createIssueLink: no Location header → the id is read back from the subject\'s links', async () => {
  let posted = false;
  const links = { 'KAN-1': [] };
  await withFetch(linkJira({ links, post: () => { posted = true; links['KAN-1'] = [{ id: '901', type: BLOCKS, outwardIssue: { key: 'KAN-2' } }]; return json(201); } }), async () => {
    const r = await jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env });
    assert.ok(posted);
    assert.equal(r.id, '901');
  });
});

test('createIssueLink: Jira refusals name their cause — disabled linking, no Link Issues permission, invisible issue (#2884 AC8)', async () => {
  await withFetch(linkJira({ links: { 'KAN-1': [] }, config: { issueLinkingEnabled: false } }), async (calls) => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 409 && /linking is disabled/.test(e.message));
    assert.equal(writesOf(calls).length, 0);
  });
  await withFetch(linkJira({ links: { 'KAN-1': [] }, post: () => json(404, { errorMessages: ["No Link Issue Permission for issue 'KAN-1'."] }) }), async () => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 403 && /"Link Issues" permission/.test(e.message));
  });
  await withFetch(linkJira({ links: { 'KAN-1': [] }, post: () => json(403, {}) }), async () => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 403 && /"Link Issues" permission/.test(e.message));
  });
  await withFetch(linkJira({ links: { 'KAN-1': [] }, post: () => json(404, { errorMessages: ['Issue does not exist'] }) }), async () => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-404', env: CRED.env }),
      (e) => e.status === 404 && /KAN-404 was not found/.test(e.message));
  });
  // the first issue itself not visible → a 404 naming it, before the write
  await withFetch(linkJira({ links: {} }), async (calls) => {
    await assert.rejects(() => jc.createIssueLink(CRED, { from: 'GONE-1', type: 'blocks', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 404 && /issue GONE-1 was not found/.test(e.message));
    assert.equal(writesOf(calls).length, 0);
  });
});

test('removeIssueLink: by id — reads the link (for both keys) then DELETEs it (#2884 AC6)', async () => {
  const getLink = () => json(200, { id: '42', type: BLOCKS, inwardIssue: { key: 'KAN-1' }, outwardIssue: { key: 'KAN-2' } });
  await withFetch(linkJira({ getLink }), async (calls) => {
    const r = await jc.removeIssueLink(CRED, { id: '42', env: CRED.env });
    assert.deepEqual(r, { removed: true, id: '42', type: 'Blocks', issues: ['KAN-1', 'KAN-2'] });
    const [del] = writesOf(calls);
    assert.equal(del.opts.method, 'DELETE');
    assert.match(del.url, /\/issueLink\/42$/);
  });
});

test('removeIssueLink: by type + keys — finds the link in the given direction and DELETEs it', async () => {
  const links = { 'KAN-2': [{ id: '43', type: BLOCKS, outwardIssue: { key: 'KAN-1' } }] };
  await withFetch(linkJira({ links }), async (calls) => {
    const r = await jc.removeIssueLink(CRED, { from: 'KAN-1', type: 'is blocked by', to: 'KAN-2', env: CRED.env });
    assert.deepEqual(r, { removed: true, id: '43', type: 'Blocks', statement: 'KAN-1 is blocked by KAN-2', issues: ['KAN-1', 'KAN-2'] });
    assert.match(writesOf(calls)[0].url, /\/issueLink\/43$/);
  });
});

test('removeIssueLink: a link that does not exist is a clear 404 and nothing is deleted', async () => {
  await withFetch(linkJira(), async (calls) => {
    await assert.rejects(() => jc.removeIssueLink(CRED, { id: '999', env: CRED.env }),
      (e) => e.status === 404 && /link 999 was not found/.test(e.message));
    assert.equal(writesOf(calls).length, 0);
  });
  await withFetch(linkJira({ links: { 'KAN-1': [] } }), async (calls) => {
    await assert.rejects(() => jc.removeIssueLink(CRED, { from: 'KAN-1', type: 'blocks', to: 'KAN-2', env: CRED.env }),
      (e) => e.status === 404 && /no link "KAN-1 blocks KAN-2" exists/.test(e.message));
    assert.equal(writesOf(calls).length, 0);
  });
  await withFetch(linkJira(), async (calls) => {
    await assert.rejects(() => jc.removeIssueLink(CRED, { id: 'abc', env: CRED.env }), (e) => e.status === 400);
    assert.equal(calls.length, 0);
  });
});
