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

// ── listComments (CLI `comments`, #2899) ─────────────────────────────────────

const adfDoc = (...content) => ({ type: 'doc', version: 1, content });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const jiraComment = (id, created, body, { author = 'Jane', updated = created } = {}) => ({
  id, created, updated, author: { displayName: author }, body,
});
const commentsResponse = (total, comments) => ({ ok: true, status: 200, text: async () => JSON.stringify({ startAt: 0, total, comments }) });

test('listComments: newest first with id, author, created, updated, body and origin (AC1, AC3, edited)', async () => {
  const agentBody = adfDoc(para('Posted by an agent on team "team-1" via Agent Studio.'), para('Picked this up.'));
  await withFetch((url) => {
    assert.match(url, /\/rest\/api\/3\/issue\/KAN-10\/comment\?orderBy=-created&startAt=0&maxResults=20$/);
    return commentsResponse(3, [
      jiraComment('103', '2026-10-03T10:00:00.000+0000', adfDoc(para('Third')), { author: 'Anna', updated: '2026-10-04T08:00:00.000+0000' }),
      jiraComment('102', '2026-10-02T10:00:00.000+0000', agentBody, { author: 'Service Bot' }),
      jiraComment('101', '2026-10-01T10:00:00.000+0000', adfDoc(para('First')), { author: 'Ben' }),
    ]);
  }, async () => {
    const r = await jc.listComments(CRED, 'KAN-10', { ownWrites: { comments: {} }, env: CRED.env });
    assert.deepEqual(r.comments, [
      { id: '103', author: 'Anna', created: '2026-10-03T10:00:00.000+0000', updated: '2026-10-04T08:00:00.000+0000', body: 'Third', bodyTruncated: false, origin: 'human' },
      { id: '102', author: 'Service Bot', created: '2026-10-02T10:00:00.000+0000', updated: '2026-10-02T10:00:00.000+0000', body: 'Picked this up.', bodyTruncated: false, origin: 'agent' },
      { id: '101', author: 'Ben', created: '2026-10-01T10:00:00.000+0000', updated: '2026-10-01T10:00:00.000+0000', body: 'First', bodyTruncated: false, origin: 'human' },
    ]);
    assert.equal(r.issue, 'KAN-10');
    assert.equal(r.count, 3);
    assert.equal(r.total, 3);
    assert.equal(r.hasMore, false);
    assert.ok(!('nextOffset' in r));
  });
});

test('listComments: origin = agent from the own-writes registry even without the provenance line (AC3)', async () => {
  await withFetch(() => commentsResponse(2, [
    jiraComment('7', '2026-10-02T10:00:00Z', adfDoc(para('mine'))),
    jiraComment('6', '2026-10-01T10:00:00Z', adfDoc(para('theirs'))),
  ]), async () => {
    const r = await jc.listComments(CRED, 'KAN-10', { ownWrites: { comments: { 'KAN-10:c7': '2026-10-02T10:00:00Z' } }, env: CRED.env });
    assert.deepEqual(r.comments.map((c) => [c.id, c.origin]), [['7', 'agent'], ['6', 'human']]);
  });
});

test('listComments: 60 comments → newest 20 by default, hasMore + nextOffset, older page via offset (AC2)', async () => {
  const all = Array.from({ length: 60 }, (_, i) => jiraComment(String(1060 - i), `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00Z`, adfDoc(para(`c${60 - i}`))));
  await withFetch((url) => {
    const q = new URL(url).searchParams;
    const startAt = Number(q.get('startAt'));
    const max = Number(q.get('maxResults'));
    return commentsResponse(60, all.slice(startAt, startAt + max));
  }, async (calls) => {
    const first = await jc.listComments(CRED, 'KAN-10', { env: CRED.env });
    assert.equal(first.count, 20);
    assert.equal(first.comments[0].id, '1060');
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 20);
    assert.match(first.note, /40 older comment\(s\) not listed — read them with aee-jira comments KAN-10 --offset 20/);

    const last = await jc.listComments(CRED, 'KAN-10', { offset: '40', limit: '50', env: CRED.env });
    assert.match(calls[calls.length - 1].url, /startAt=40&maxResults=50$/);
    assert.equal(last.count, 20);
    assert.equal(last.comments[19].id, '1001');
    assert.equal(last.hasMore, false);
    assert.equal(last.offset, 40);
  });
});

test('listComments: a long body is cut like a wake with bodyTruncated; mentions / code / tables read as text (AC4)', async () => {
  const long = 'y'.repeat(5000);
  const rich = adfDoc(
    { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Anna' } }, { type: 'text', text: ' see' }] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('a')] }, { type: 'tableCell', content: [para('b')] }] }] },
  );
  await withFetch(() => commentsResponse(2, [
    jiraComment('2', '2026-10-02T10:00:00Z', adfDoc(para(long))),
    jiraComment('1', '2026-10-01T10:00:00Z', rich),
  ]), async () => {
    const r = await jc.listComments(CRED, 'KAN-10', { env: CRED.env });
    const ee = require('./event-extract');
    assert.equal(r.comments[0].bodyTruncated, true);
    assert.equal(r.comments[0].body.length, ee.COMMENT_BODY_MAX);
    assert.ok(r.comments[0].body.endsWith('…'));
    assert.equal(r.comments[1].bodyTruncated, false);
    assert.match(r.comments[1].body, /^@Anna see\nnpm test\n/);
    assert.match(r.comments[1].body, /a\s+b/);
  });
});

test('listComments: no comments → empty list with a note, not an error (AC5)', async () => {
  await withFetch(() => commentsResponse(0, []), async () => {
    const r = await jc.listComments(CRED, 'KAN-10', { env: CRED.env });
    assert.deepEqual(r.comments, []);
    assert.equal(r.count, 0);
    assert.equal(r.hasMore, false);
    assert.equal(r.note, 'KAN-10 has no comments.');
  });
});

test('listComments: an invisible issue is the standard out-of-scope refusal (AC7); bad limit / offset are 400 before Jira', async () => {
  await withFetch(() => ({ ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist"]}' }), async () => {
    await assert.rejects(
      () => jc.listComments(CRED, 'OTHER-1', { env: CRED.env }),
      (e) => e.status === 404 && /^Issue OTHER-1 was not found, or it is outside this team's Jira scope/.test(e.message),
    );
  });
  await withFetch(() => { throw new Error('no Jira call expected'); }, async (calls) => {
    for (const opts of [{ limit: '0' }, { limit: 'x' }, { offset: '-1' }, { offset: '1.5' }]) {
      await assert.rejects(() => jc.listComments(CRED, 'KAN-10', { ...opts, env: CRED.env }), (e) => e.status === 400);
    }
    await assert.rejects(() => jc.listComments(CRED, ' ', { env: CRED.env }), (e) => e.status === 400);
    assert.equal(calls.length, 0);
  });
  await withFetch((url) => {
    assert.match(url, /maxResults=100$/); // capped
    return commentsResponse(0, []);
  }, () => jc.listComments(CRED, 'KAN-10', { limit: 500, env: CRED.env }));
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

test('searchIssues: --fields names priority/labels/dueDate as columns, read from Jira only then (#2901 AC3)', async () => {
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    assert.deepEqual(JSON.parse(opts.body).fields, ['summary', 'status', 'assignee', 'updated', 'issuetype', 'parent', 'priority', 'labels', 'duedate']);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [
        { key: 'ENG-1', fields: { summary: 'One', priority: { name: 'High' }, labels: ['backend'], duedate: '2026-10-31' } },
        { key: 'ENG-2', fields: { summary: 'Two' } },
      ],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['key', 'priority', 'labels', 'dueDate'], env: CRED.env });
    assert.deepEqual(issues, [
      { key: 'ENG-1', priority: 'High', labels: ['backend'], dueDate: '2026-10-31' },
      { key: 'ENG-2', priority: null, labels: [], dueDate: null },
    ]);
  });
});

test('searchIssues: reporter/components/fixVersions are selectable --fields columns (#2901)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { reporter: { displayName: 'Anna' }, components: [{ name: 'API' }], fixVersions: [{ name: '1.4' }] } }],
    }) };
  }, async () => {
    const issues = await jc.searchIssues(CRED, { jql: 'project = ENG', fields: ['reporter', 'components', 'fixVersions'], env: CRED.env });
    assert.deepEqual(issues, [{ key: 'ENG-1', reporter: 'Anna', components: ['API'], fixVersions: ['1.4'] }]);
  });
});

test('searchIssues: without --fields the default row carries none of the #2901 columns (AC4)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'One', priority: { name: 'High' } } }],
    }) };
  }, async () => {
    const [row] = await jc.searchIssues(CRED, { jql: 'project = ENG', env: CRED.env });
    assert.deepEqual(Object.keys(row), jc.AGENT_ISSUE_COLUMNS);
  });
});

test('shapeStandardReadFields: drops non-string list entries, keeps names', () => {
  assert.deepEqual(jc.shapeStandardReadFields({ components: [{ name: 'API' }, {}, null], labels: ['a', ''] }), {
    priority: null, labels: ['a'], reporter: null, components: ['API'], fixVersions: [], dueDate: null,
  });
  assert.deepEqual(jc.shapeStandardReadFields(undefined).labels, []);
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

test('getIssue: returns priority, labels, reporter, components, fix versions and due date (#2901 AC1)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    assert.match(url, /fields=[^&]*priority,labels,reporter,components,fixVersions,duedate/);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'ENG-7', fields: {
        summary: 'S', status: { name: 'Open' }, issuetype: { name: 'Bug' },
        priority: { id: '2', name: 'High' },
        labels: ['backend', 'urgent'],
        reporter: { accountId: 'a-1', displayName: 'Anna' },
        components: [{ id: '10', name: 'API' }],
        fixVersions: [{ id: '20', name: '1.4' }],
        duedate: '2026-10-31',
      },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-7', { env: CRED.env });
    assert.equal(issue.priority, 'High');
    assert.deepEqual(issue.labels, ['backend', 'urgent']);
    assert.equal(issue.reporter, 'Anna');
    assert.deepEqual(issue.components, ['API']);
    assert.deepEqual(issue.fixVersions, ['1.4']);
    assert.equal(issue.dueDate, '2026-10-31');
  });
});

test('getIssue: unset/hidden standard fields are null or [] — never an error (#2901 AC2)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({
      // No priority key at all (project without a priority scheme); a reporter
      // whose account was deleted carries no display name.
      key: 'ENG-8', fields: { summary: 'S', labels: [], reporter: { accountId: 'gone' }, components: [], fixVersions: null, duedate: null },
    }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-8', { env: CRED.env });
    assert.equal(issue.priority, null);
    assert.deepEqual(issue.labels, []);
    assert.equal(issue.reporter, null);
    assert.deepEqual(issue.components, []);
    assert.deepEqual(issue.fixVersions, []);
    assert.equal(issue.dueDate, null);
  });
});

test('getIssue: the #2901 fields are additive — earlier keys keep their order and shape (AC5)', async () => {
  await withFetch((url) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ENG-9', fields: { summary: 'S' } }) };
  }, async () => {
    const issue = await jc.getIssue(CRED, 'ENG-9', { env: CRED.env });
    assert.deepEqual(Object.keys(issue).slice(0, 15), [
      'key', 'summary', 'status', 'issueType', 'assignee', 'created', 'updated', 'parent', 'links', 'url',
      'priority', 'labels', 'reporter', 'components', 'fixVersions',
    ]);
    assert.ok('dueDate' in issue);
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
  // #2901 standard fields are columns, not custom-field names.
  assert.deepEqual(jc.partitionFields(['priority', 'dueDate', 'Team']), { columns: ['priority', 'dueDate'], customNames: ['Team'] });
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

// ── standalone issue create (#2894) ─────────────────────────────────────────

const PROJECT_TYPES = [
  { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 },
  { id: '10002', name: 'Task', subtask: false, hierarchyLevel: 0 },
  { id: '10004', name: 'Fehler', subtask: false, hierarchyLevel: 0 },
  { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 },
  { id: '10003', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
];
const isProjectGet = (url) => /\/rest\/api\/3\/project\/[^/?]+$/.test(url);
const isCreateMeta = (url) => /\/rest\/api\/3\/issue\/createmeta\//.test(url);
const projectResponse = (key = 'KAN', issueTypes = PROJECT_TYPES) => ({ ok: true, status: 200, text: async () => JSON.stringify({ key, issueTypes }) });
const createMetaResponse = (fields = [
  { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false },
  { fieldId: 'reporter', name: 'Reporter', required: true, hasDefaultValue: true },
  { fieldId: 'project', name: 'Project', required: true, hasDefaultValue: false },
  { fieldId: 'issuetype', name: 'Issue Type', required: true, hasDefaultValue: false },
  { fieldId: 'priority', name: 'Priority', required: false, hasDefaultValue: true },
]) => ({ ok: true, status: 200, text: async () => JSON.stringify({ startAt: 0, maxResults: 100, total: fields.length, fields }) });

function standaloneJira({ project = projectResponse(), meta = createMetaResponse(), create, transitions = transitionsResponse() } = {}) {
  return (url, opts) => {
    if (isProjectGet(url)) return typeof project === 'function' ? project(url) : project;
    if (isCreateMeta(url)) return typeof meta === 'function' ? meta(url) : meta;
    if (isFieldList(url)) return createFieldList();
    if (isCreate(url, opts)) return create(JSON.parse(opts.body).fields);
    if (isTransitionList(url) && (!opts || opts.method !== 'POST')) return transitions;
    if (isTransitionList(url) && opts.method === 'POST') return { ok: true, status: 204, text: async () => '' };
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
}
const created201 = (key) => ({ ok: true, status: 201, text: async () => JSON.stringify({ id: '9', key }) });

test('createStandaloneIssue: a Bug with only a summary — key + URL, the project\'s type, no parent (#2894 AC1)', async () => {
  let sent;
  await withFetch(standaloneJira({
    project: projectResponse('KAN', [...PROJECT_TYPES, { id: '10005', name: 'Bug', subtask: false, hierarchyLevel: 0 }]),
    create: (f) => { sent = f; return created201('KAN-42'); },
  }), async (calls) => {
    const seen = [];
    const r = await jc.createStandaloneIssue(CRED, {
      projectKey: 'kan', issueType: 'bug', issue: { summary: ' Login fails ' }, allowList: [], onCreated: (k) => seen.push(k), env: CRED.env,
    });
    assert.deepEqual(r, { project: 'KAN', issueType: 'Bug', key: 'KAN-42', url: `${jc.apiBaseFor('acme', {})}/browse/KAN-42`, summary: 'Login fails' });
    assert.deepEqual(sent, { project: { key: 'KAN' }, issuetype: { id: '10005' }, summary: 'Login fails' });
    assert.deepEqual(seen, ['KAN-42']); // own-writes registration hook
    assert.match(calls.find((c) => isCreateMeta(c.url)).url, /createmeta\/KAN\/issuetypes\/10005\?/);
    assert.equal(calls.filter((c) => isTransitionList(c.url)).length, 0, 'no status → no transition');
  });
});

test('createStandaloneIssue: Task, Story and a project-specific type name, matched case-insensitively (#2894 AC2)', async () => {
  for (const [requested, id, name] of [['Task', '10002', 'Task'], ['STORY', '10001', 'Story'], ['fehler', '10004', 'Fehler']]) {
    await withFetch(standaloneJira({ create: (f) => { assert.deepEqual(f.issuetype, { id }); return created201('KAN-1'); } }), async () => {
      const r = await jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: requested, issue: { summary: 'S' }, allowList: [], env: CRED.env });
      assert.equal(r.issueType, name);
    });
  }
});

test('createStandaloneIssue: description, assignee, priority, labels and custom fields on create; status as a follow-up transition (#2894 AC3)', async () => {
  let sent;
  await withFetch(standaloneJira({ create: (f) => { sent = f; return created201('KAN-7'); } }), async (calls) => {
    const r = await jc.createStandaloneIssue(CRED, {
      projectKey: 'KAN',
      issueType: 'Task',
      issue: {
        summary: 'Do it', description: 'line one\n\nline two', assignee: 'acc-1', priority: 'High',
        labels: ['web', ' regression '], status: 'In Progress', fields: { Team: '42', 'Story point estimate': '3' },
      },
      allowList: ['Team', 'Story point estimate'],
      attribution: 'by an agent',
      env: CRED.env,
    });
    assert.equal(sent.description.type, 'doc'); // ADF, like update / create-epic
    assert.equal(sent.description.content.length, 4); // 3 lines (blank one kept) + attribution
    assert.deepEqual(sent.assignee, { accountId: 'acc-1' });
    assert.deepEqual(sent.priority, { name: 'High' });
    assert.deepEqual(sent.labels, ['web', 'regression']);
    assert.deepEqual(sent.customfield_20001, { id: '42' });
    assert.equal(sent.customfield_10016, 3);
    assert.equal('status' in sent, false, 'status is never a create field');
    assert.equal(r.status, 'In Progress');
    const createAt = calls.findIndex((c) => isCreate(c.url, c.opts));
    const transitionAt = calls.findIndex((c) => isTransitionList(c.url) && c.opts && c.opts.method === 'POST');
    assert.ok(transitionAt > createAt, 'the transition follows the create');
  });
});

test('createStandaloneIssue: an unknown type is a 400 listing the project\'s standard types (#2894 AC4)', async () => {
  await withFetch(standaloneJira({ create: () => { throw new Error('must not create'); } }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Bug', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /no issue type "Bug"/.test(e.message) && /Available: Story, Task, Fehler\./.test(e.message),
    );
  });
});

test('createStandaloneIssue: an Epic type points at create-epic; a sub-task type is refused (#2894 AC5)', async () => {
  await withFetch(standaloneJira({ create: () => { throw new Error('must not create'); } }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'epic', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /create-epic/.test(e.message),
    );
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Subtask', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /sub-task type/.test(e.message) && /parent/.test(e.message),
    );
  });
  assert.equal(jc.classifyIssueType({ name: 'Épique', hierarchyLevel: 1 }, 'Epic'), 'epic'); // a localised Epic
  assert.equal(jc.classifyIssueType({ name: 'Teilaufgabe', subtask: true, hierarchyLevel: -1 }, 'Epic'), 'subtask');
  assert.equal(jc.classifyIssueType({ name: 'Bug', hierarchyLevel: 0 }, 'Epic'), 'standard');
});

test('createStandaloneIssue: required fields the call does not set are named, before the create (#2894 AC6)', async () => {
  const meta = createMetaResponse([
    { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false },
    { fieldId: 'components', name: 'Components', required: true, hasDefaultValue: false },
    { fieldId: 'customfield_20001', name: 'Team', required: true, hasDefaultValue: false },
    { fieldId: 'customfield_30000', name: 'Severity', required: true, hasDefaultValue: true },
  ]);
  await withFetch(standaloneJira({ meta, create: () => { throw new Error('must not create'); } }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Task', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /not provided: Components, Team\./.test(e.message) && /Nothing was created/.test(e.message),
    );
  });
  // once Team is given, only Components is still missing
  await withFetch(standaloneJira({ meta, create: () => { throw new Error('must not create'); } }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Task', issue: { summary: 'S', fields: { Team: '1' } }, allowList: [], env: CRED.env }),
      (e) => /not provided: Components\./.test(e.message),
    );
  });
});

test('createStandaloneIssue: unreadable create metadata skips the pre-check; Jira\'s 400 is mapped to field names', async () => {
  await withFetch(standaloneJira({
    meta: { ok: false, status: 403, text: async () => 'nope' },
    create: () => ({ ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: [], errors: { customfield_20001: 'Team is required.' } }) }),
  }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Task', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /Jira refused to create the issue: Team: Team is required\. Nothing was created\./.test(e.message),
    );
  });
});

test('createStandaloneIssue: an invalid assignee is refused clearly and nothing is created', async () => {
  await withFetch(standaloneJira({
    create: () => ({ ok: false, status: 400, text: async () => JSON.stringify({ errors: { assignee: 'User \'nobody\' cannot be assigned issues.' } }) }),
  }), async (calls) => {
    let registered = 0;
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, {
        projectKey: 'KAN', issueType: 'Task', issue: { summary: 'S', assignee: 'nobody' }, allowList: [], onCreated: () => { registered += 1; }, env: CRED.env,
      }),
      (e) => e.status === 400 && /assignee "nobody" was rejected/.test(e.message) && /accountId/.test(e.message),
    );
    assert.equal(registered, 0);
    assert.equal(calls.filter((c) => isCreate(c.url, c.opts)).length, 1, 'never retried');
  });
});

test('createStandaloneIssue: a custom field off a non-empty allow-list is a 403 before any Jira call (#2894 AC7)', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Bug', issue: { summary: 'S', fields: { Team: '42' } }, allowList: ['Sprint'], env: CRED.env }),
      (e) => e.status === 403 && /Team/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });
});

test('createStandaloneIssue: a project the account cannot see is outside the team\'s scope (#2894 AC8)', async () => {
  await withFetch(standaloneJira({
    project: { ok: false, status: 404, text: async () => '{"errorMessages":["No project could be found with key \'OTHER\'."]}' },
    create: () => { throw new Error('must not create'); },
  }), async () => {
    await assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'OTHER', issueType: 'Bug', issue: { summary: 'S' }, allowList: [], env: CRED.env }),
      (e) => e.status === 404 && /Project OTHER was not found, or it is outside this team's Jira scope/.test(e.message),
    );
  });
});

test('createStandaloneIssue: an impossible status transition still reports the created key + the reason (#2894 AC9)', async () => {
  await withFetch(standaloneJira({ create: () => created201('KAN-9') }), async () => {
    const r = await jc.createStandaloneIssue(CRED, {
      projectKey: 'KAN', issueType: 'Task', issue: { summary: 'S', status: 'Released' }, allowList: [], env: CRED.env,
    });
    assert.equal(r.key, 'KAN-9');
    assert.equal(r.status, undefined);
    assert.match(r.statusError, /no transition to "Released"/);
  });
});

test('createStandaloneIssue: no project / type / summary, or a label with a space, is a 400 up front', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    const bad = (args, re) => assert.rejects(
      () => jc.createStandaloneIssue(CRED, { projectKey: 'KAN', issueType: 'Bug', issue: { summary: 'S' }, allowList: [], env: CRED.env, ...args }),
      (e) => e.status === 400 && (!re || re.test(e.message)),
    );
    await bad({ projectKey: '' });
    await bad({ issueType: ' ' });
    await bad({ issue: { summary: '  ' } });
    await bad({ issue: undefined });
    await bad({ issue: { summary: 'S', labels: ['two words'] } }, /"two words"/);
    await bad({ issue: { summary: 'S', labels: 'web' } });
    assert.equal(calls.length, 0);
  });
});

// ── any standard issue type under an existing Epic (#2896) ──────────────────

const EPIC_PROJECT_TYPES = [...PROJECT_TYPES, { id: '10005', name: 'Bug', subtask: false, hierarchyLevel: 0 }];

function epicChildJira({ epicLinkId, project = projectResponse('KAN', EPIC_PROJECT_TYPES), meta = createMetaResponse(), create, transitions = transitionsResponse() } = {}) {
  return (url, opts) => {
    if (isIssueGet(url, opts)) return issueResponse('KAN-12', 'Epic', { hierarchyLevel: 1 });
    if (isProjectGet(url)) return project;
    if (isCreateMeta(url)) return typeof meta === 'function' ? meta(url) : meta;
    if (isFieldList(url)) return createFieldList(epicLinkId);
    if (isCreate(url, opts)) return create(JSON.parse(opts.body).fields);
    if (isTransitionList(url) && (!opts || opts.method !== 'POST')) return transitions;
    if (isTransitionList(url) && opts.method === 'POST') return { ok: true, status: 204, text: async () => '' };
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
}

test('addStoriesToEpic: a Bug and a Task under the Epic in one call, each with the parent + its own type (#2896 AC1/AC8)', async () => {
  const sent = [];
  await withFetch(epicChildJira({ create: (f) => { sent.push(f); return created201(`KAN-${40 + sent.length}`); } }), async (calls) => {
    const seen = [];
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: 'KAN-12',
      stories: [
        { type: 'Bug', summary: 'Login fails', priority: 'High', labels: ['web', ' regression '] },
        { type: 'Task', summary: 'Rotate keys', status: 'In Progress' },
      ],
      allowList: [],
      onCreated: (k) => seen.push(k),
      env: CRED.env,
    });
    assert.equal(r.created, 2);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.stories.map((s) => [s.key, s.issueType, s.ok]), [['KAN-41', 'Bug', true], ['KAN-42', 'Task', true]]);
    assert.equal(r.stories[1].status, 'In Progress');
    assert.deepEqual(sent[0].issuetype, { id: '10005' });
    assert.deepEqual(sent[1].issuetype, { id: '10002' });
    for (const f of sent) assert.deepEqual(f.parent, { key: 'KAN-12' });
    assert.deepEqual(sent[0].priority, { name: 'High' });
    assert.deepEqual(sent[0].labels, ['web', 'regression']);
    assert.deepEqual(seen, ['KAN-41', 'KAN-42'], 'each registered as an own write (origin = agent)');
    assert.equal(calls.filter((c) => isProjectGet(c.url)).length, 1, 'project types read once');
  });
});

test('addStoriesToEpic: --type is the default, matched case-insensitively against the project\'s own names; a per-issue type wins (#2896 AC2)', async () => {
  const sent = [];
  await withFetch(epicChildJira({ create: (f) => { sent.push(f); return created201(`KAN-${50 + sent.length}`); } }), async () => {
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: 'KAN-12', defaultType: 'fehler', stories: [{ summary: 'A' }, { summary: 'B', type: 'STORY' }], allowList: [], env: CRED.env,
    });
    assert.deepEqual(r.stories.map((s) => s.issueType), ['Fehler', 'Story']);
    assert.deepEqual(sent.map((f) => f.issuetype.id), ['10004', '10001']);
  });
});

test('addStoriesToEpic: company-managed — a typed issue is linked via the Epic Link field (#2896 edge case)', async () => {
  await withFetch(epicChildJira({
    epicLinkId: 'customfield_10014',
    create: (f) => {
      assert.equal(f.customfield_10014, 'KAN-12');
      assert.equal('parent' in f, false);
      return created201('KAN-60');
    },
  }), async () => {
    const r = await jc.addStoriesToEpic(CRED, { epicKey: 'KAN-12', stories: [{ type: 'Task', summary: 'S' }], allowList: [], env: CRED.env });
    assert.equal(r.stories[0].key, 'KAN-60');
  });
});

test('addStoriesToEpic: no type anywhere is the unchanged Story create — no project / create-metadata reads (#2896 AC3)', async () => {
  await withFetch(epicChildJira({
    create: (f) => {
      assert.deepEqual(f.issuetype, { name: 'Story' });
      return created201('KAN-70');
    },
  }), async (calls) => {
    const r = await jc.addStoriesToEpic(CRED, { epicKey: 'KAN-12', stories: [{ summary: 'S' }], allowList: [], env: CRED.env });
    assert.deepEqual(r.stories, [{ summary: 'S', key: 'KAN-70', url: `${jc.apiBaseFor('acme', {})}/browse/KAN-70`, ok: true }]);
    assert.equal(calls.filter((c) => isProjectGet(c.url) || isCreateMeta(c.url)).length, 0);
  });
});

test('addStoriesToEpic: an unknown, Epic or sub-task type fails only that issue; the others are created (#2896 AC4)', async () => {
  const sent = [];
  await withFetch(epicChildJira({ create: (f) => { sent.push(f); return created201(`KAN-${80 + sent.length}`); } }), async () => {
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: 'KAN-12',
      stories: [
        { type: 'Improvement', summary: 'unknown' },
        { type: 'epic', summary: 'nested epic' },
        { type: 'Subtask', summary: 'sub' },
        { type: 'Bug', summary: 'fine' },
      ],
      allowList: [],
      env: CRED.env,
    });
    assert.equal(r.created, 1);
    assert.equal(r.failed, 3);
    assert.match(r.stories[0].error, /no issue type "Improvement"\. Available: Story, Task, Fehler, Bug\.$/);
    assert.match(r.stories[1].error, /Epic is an Epic type — an Epic cannot be created under another Epic/);
    assert.match(r.stories[2].error, /Subtask is a sub-task type/);
    assert.equal(r.stories[3].key, 'KAN-81');
    assert.equal(sent.length, 1);
  });
});

test('addStoriesToEpic: a project-required field the issue does not set is named, per issue (#2896 AC5)', async () => {
  const meta = (url) => (/issuetypes\/10005\?/.test(url)
    ? createMetaResponse([{ fieldId: 'components', name: 'Components', required: true, hasDefaultValue: false }])
    : createMetaResponse());
  const sent = [];
  await withFetch(epicChildJira({ meta, create: (f) => { sent.push(f); return created201('KAN-90'); } }), async (calls) => {
    const r = await jc.addStoriesToEpic(CRED, {
      epicKey: 'KAN-12', stories: [{ type: 'Bug', summary: 'b1' }, { type: 'Task', summary: 't' }, { type: 'bug', summary: 'b2' }], allowList: [], env: CRED.env,
    });
    assert.deepEqual(r.stories.map((s) => s.ok), [false, true, false]);
    assert.match(r.stories[0].error, /requires field\(s\) for a Bug that were not provided: Components\./);
    assert.equal(sent.length, 1);
    assert.equal(calls.filter((c) => isCreateMeta(c.url)).length, 2, 'create metadata read once per type');
  });
});

test('addStoriesToEpic: Jira\'s create 400 for a typed issue is mapped to field names, per issue', async () => {
  await withFetch(epicChildJira({
    meta: { ok: false, status: 403, text: async () => 'nope' },
    create: () => ({ ok: false, status: 400, text: async () => JSON.stringify({ errors: { customfield_20001: 'Team is required.' } }) }),
  }), async () => {
    const r = await jc.addStoriesToEpic(CRED, { epicKey: 'KAN-12', stories: [{ type: 'Task', summary: 'S' }], allowList: [], env: CRED.env });
    assert.equal(r.stories[0].ok, false);
    assert.equal(r.stories[0].error, 'Jira refused to create the issue: Team: Team is required.');
  });
});

test('addStoriesToEpic: a typed call on a non-Epic or an out-of-scope key is refused like before (#2896 AC6)', async () => {
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return issueResponse('KAN-7', 'Task', { hierarchyLevel: 0 });
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'KAN-7', defaultType: 'Bug', stories: [{ summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /KAN-7 is a Task, not an Epic — add-stories only adds new issues under an existing Epic/.test(e.message),
    );
  });
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return { ok: false, status: 404, text: async () => '{}' };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'NOPE-1', stories: [{ type: 'Bug', summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 404 && /outside this team's Jira scope/.test(e.message),
    );
  });
});

test('addStoriesToEpic: a failed follow-up status still reports the typed issue as created (#2896 AC7)', async () => {
  await withFetch(epicChildJira({ create: () => created201('KAN-95') }), async () => {
    const r = await jc.addStoriesToEpic(CRED, { epicKey: 'KAN-12', stories: [{ type: 'Bug', summary: 'S', status: 'Released' }], allowList: [], env: CRED.env });
    assert.equal(r.stories[0].ok, true);
    assert.equal(r.stories[0].key, 'KAN-95');
    assert.match(r.stories[0].statusError, /no transition to "Released"/);
  });
});

test('addStoriesToEpic: a label with a space or a non-string type is a 400 before any Jira call', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async (calls) => {
    const bad = (stories, re) => assert.rejects(
      () => jc.addStoriesToEpic(CRED, { epicKey: 'KAN-12', stories, allowList: [], env: CRED.env }),
      (e) => e.status === 400 && re.test(e.message),
    );
    await bad([{ summary: 'S' }, { summary: 'T', labels: ['two words'] }], /"two words" \(issue #2\)/);
    await bad([{ summary: 'S', labels: 'web' }], /labels must be a list/);
    await bad([{ summary: 'S', type: 5 }], /type must be an issue type name/);
    assert.equal(calls.length, 0);
  });
});

test('missingRequiredFields: required, no default, not set — project/issuetype exempt', () => {
  const meta = [
    { fieldId: 'project', name: 'Project', required: true },
    { fieldId: 'issuetype', name: 'Issue Type', required: true },
    { fieldId: 'summary', name: 'Summary', required: true },
    { fieldId: 'reporter', name: 'Reporter', required: true, hasDefaultValue: true },
    { fieldId: 'duedate', name: 'Due date', required: true },
    { fieldId: 'labels', name: 'Labels', required: false },
  ];
  assert.deepEqual(jc.missingRequiredFields(meta, { summary: 'S' }), ['Due date']);
  assert.deepEqual(jc.missingRequiredFields(null, {}), []);
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

// ── parent Epic of EXISTING issues (#2895) ───────────────────────────────────

// A tiny in-memory Jira: GET /issue/<KEY>?fields=… and PUT /issue/<KEY>, the
// parent kept as the native `parent` (team-managed) or, with `epicLinkId`, in the
// Epic Link field too (company-managed). `rejectParent` models an older classic
// project that refuses a native `parent` write (400) and needs the Epic Link field.
function parentJira(issues, { epicLinkId = null, rejectParent = false, put } = {}) {
  const puts = [];
  const handler = (url, opts) => {
    if (isFieldList(url)) return fieldListResponse(epicLinkId);
    const m = String(url).match(/\/rest\/api\/3\/issue\/([^/?]+)(\?fields=(.*))?$/);
    if (!m) throw new Error(`unexpected ${opts && opts.method} ${url}`);
    const key = decodeURIComponent(m[1]);
    const issue = issues[key];
    if (!issue) return { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    if (opts && opts.method === 'PUT') {
      const { fields } = JSON.parse(opts.body);
      puts.push({ key, fields });
      if (put) { const r = put(key, fields); if (r) return r; }
      if ('parent' in fields) {
        if (rejectParent) return { ok: false, status: 400, text: async () => '{"errors":{"parent":"Field cannot be set."}}' };
        issue.parent = fields.parent ? fields.parent.key : null;
      } else if (epicLinkId && epicLinkId in fields) {
        issue.parent = fields[epicLinkId];
      }
      return { ok: true, status: 204, text: async () => '' };
    }
    const f = {
      summary: issue.summary || `${key} summary`,
      issuetype: { name: issue.type, hierarchyLevel: issue.level, subtask: !!issue.subtask },
    };
    if (issue.parent) {
      if (epicLinkId) f[epicLinkId] = issue.parent; else f.parent = { key: issue.parent };
    }
    if (m[3]) assert.ok(!epicLinkId || decodeURIComponent(m[3]).includes(epicLinkId) || /issuetype,summary$/.test(decodeURIComponent(m[3])));
    return { ok: true, status: 200, text: async () => JSON.stringify({ key, fields: f }) };
  };
  return { handler, puts };
}

const EPIC = (extra = {}) => ({ type: 'Epic', level: 1, ...extra });
const STORY = (extra = {}) => ({ type: 'Story', level: 0, ...extra });

test('setParentEpic: puts issues without a parent under the Epic in one call (#2895 AC1)', async () => {
  const issues = { 'KAN-12': EPIC({ summary: 'Payments' }), 'KAN-30': STORY(), 'KAN-31': { type: 'Bug', level: 0 } };
  const { handler, puts } = parentJira(issues);
  await withFetch(handler, async () => {
    const changed = [];
    const r = await jc.setParentEpic(CRED, { epicKey: 'kan-12', issueKeys: ['KAN-30', 'kan-31'], env: CRED.env, onChanged: (k, d) => changed.push([k, d]) });
    assert.deepEqual(r.epic, { key: 'KAN-12', url: 'https://acme.atlassian.net/browse/KAN-12', summary: 'Payments' });
    assert.deepEqual(r.issues.map((i) => [i.issue, i.outcome, i.message]), [
      ['KAN-30', 'added', 'added to KAN-12'],
      ['KAN-31', 'added', 'added to KAN-12'],
    ]);
    assert.deepEqual([r.changed, r.unchanged, r.failed], [2, 0, 0]);
    assert.deepEqual(puts.map((p) => p.fields), [{ parent: { key: 'KAN-12' } }, { parent: { key: 'KAN-12' } }]);
    assert.deepEqual(changed, [['KAN-30', { from: null, to: 'KAN-12' }], ['KAN-31', { from: null, to: 'KAN-12' }]]);
    assert.equal(issues['KAN-30'].parent, 'KAN-12');
  });
  // AC1 — `show` then reports the parent
  await withFetch((url, opts) => {
    if (isTransitionList(url)) return transitionsResponse();
    return handler(url, opts);
  }, async () => {
    const shown = await jc.getIssue(CRED, 'KAN-30', { env: CRED.env });
    assert.equal(shown.parent, 'KAN-12');
  });
});

test('setParentEpic: moves an issue from another Epic; already-under is a success (#2895 AC2/AC4)', async () => {
  const issues = { 'KAN-5': EPIC(), 'KAN-12': EPIC(), 'KAN-30': STORY({ parent: 'KAN-5' }), 'KAN-31': STORY({ parent: 'KAN-12' }) };
  const { handler, puts } = parentJira(issues);
  await withFetch(handler, async () => {
    const changed = [];
    const r = await jc.setParentEpic(CRED, { epicKey: 'KAN-12', issueKeys: ['KAN-30', 'KAN-31'], env: CRED.env, onChanged: (k, d) => changed.push([k, d]) });
    assert.deepEqual(r.issues.map((i) => [i.issue, i.ok, i.outcome, i.message, i.from, i.to]), [
      ['KAN-30', true, 'moved', 'moved from KAN-5 to KAN-12', 'KAN-5', 'KAN-12'],
      ['KAN-31', true, 'unchanged', 'already under KAN-12', 'KAN-12', 'KAN-12'],
    ]);
    assert.deepEqual([r.changed, r.unchanged, r.failed], [1, 1, 0]);
    assert.equal(puts.length, 1, 'no write for an issue already under the Epic');
    assert.deepEqual(changed, [['KAN-30', { from: 'KAN-5', to: 'KAN-12' }]]);
    assert.equal(issues['KAN-30'].parent, 'KAN-12');
  });
});

test('setParentEpic: epicKey null takes issues out of their Epic; no parent is unchanged (#2895 AC3)', async () => {
  const issues = { 'KAN-30': STORY({ parent: 'KAN-5' }), 'KAN-31': STORY() };
  const { handler, puts } = parentJira(issues);
  await withFetch(handler, async (calls) => {
    const r = await jc.setParentEpic(CRED, { epicKey: null, issueKeys: ['KAN-30', 'KAN-31'], env: CRED.env });
    assert.equal(r.epic, null);
    assert.deepEqual(r.issues.map((i) => [i.issue, i.outcome, i.message]), [
      ['KAN-30', 'removed', 'removed from KAN-5'],
      ['KAN-31', 'unchanged', 'has no parent Epic'],
    ]);
    assert.deepEqual(puts.map((p) => p.fields), [{ parent: null }]);
    assert.equal(issues['KAN-30'].parent, null);
    assert.ok(!calls.some((c) => /\/issue\/null/.test(c.url)), 'no target lookup when removing');
  });
});

test('setParentEpic: one bad key does not hide the others — per-issue reasons (#2895 AC5/AC7)', async () => {
  const issues = {
    'KAN-12': EPIC(), 'KAN-30': STORY(), 'KAN-13': EPIC(), 'KAN-40': { type: 'Sub-task', level: -1, subtask: true, parent: 'KAN-30' },
    'KAN-41': STORY(), 'KAN-42': STORY(),
  };
  const { handler } = parentJira(issues, {
    put: (key) => {
      if (key === 'KAN-41') return { ok: false, status: 403, text: async () => '{"errorMessages":["You do not have permission to edit issues in this project."]}' };
      if (key === 'KAN-42') return { ok: false, status: 400, text: async () => '{"errors":{"parent":"Issues from project OPS cannot be added to this Epic."}}' };
      return null;
    },
  });
  await withFetch(handler, async () => {
    const r = await jc.setParentEpic(CRED, {
      epicKey: 'KAN-12', issueKeys: ['NOPE-1', 'KAN-13', 'KAN-40', 'KAN-41', 'KAN-42', 'not a key', 'KAN-30'], env: CRED.env,
    });
    const by = Object.fromEntries(r.issues.map((i) => [i.issue, i]));
    assert.equal(r.issues.length, 7, 'every key gets an outcome');
    assert.match(by['NOPE-1'].error, /^NOPE-1 was not found, or it is outside this team's Jira scope/);
    assert.match(by['KAN-13'].error, /KAN-13 is an Epic — an Epic cannot be put under/);
    assert.match(by['KAN-40'].error, /KAN-40 is a Sub-task — a sub-task's parent is a standard issue/);
    assert.match(by['KAN-41'].error, /the Jira account may not edit KAN-41 \(403\): You do not have permission to edit issues in this project/);
    assert.match(by['KAN-42'].error, /Jira refused the change: parent: Issues from project OPS cannot be added to this Epic/);
    assert.match(by['NOT A KEY'].error, /is not a Jira issue key/);
    assert.equal(by['KAN-30'].outcome, 'added');
    assert.deepEqual([r.changed, r.unchanged, r.failed], [1, 0, 6]);
  });
});

test('setParentEpic: the target must be a visible Epic — refused before any change (#2895 AC6/AC8)', async () => {
  const issues = { 'KAN-7': STORY(), 'KAN-30': STORY() };
  const { handler, puts } = parentJira(issues);
  await withFetch(handler, async () => {
    await assert.rejects(() => jc.setParentEpic(CRED, { epicKey: 'KAN-7', issueKeys: ['KAN-30'], env: CRED.env }),
      (e) => e.status === 400 && /KAN-7 is a Story, not an Epic .*Nothing was changed\./.test(e.message));
    await assert.rejects(() => jc.setParentEpic(CRED, { epicKey: 'OTHER-1', issueKeys: ['KAN-30'], env: CRED.env }),
      (e) => e.status === 404 && /Epic OTHER-1 was not found, or it is outside this team's Jira scope .*Nothing was changed\./.test(e.message));
    await assert.rejects(() => jc.setParentEpic(CRED, { epicKey: 'KAN 12', issueKeys: ['KAN-30'], env: CRED.env }), (e) => e.status === 400);
    await assert.rejects(() => jc.setParentEpic(CRED, { epicKey: 'KAN-12', issueKeys: [' '], env: CRED.env }),
      (e) => e.status === 400 && /at least one issue key/.test(e.message));
    assert.equal(puts.length, 0);
  });
});

test('setParentEpic: company-managed — reads the Epic Link field, falls back to it when `parent` is refused (#2895 AC9)', async () => {
  const issues = { 'KAN-5': EPIC(), 'KAN-12': EPIC(), 'KAN-30': STORY({ parent: 'KAN-5' }), 'KAN-31': STORY({ parent: 'KAN-12' }) };
  const { handler, puts } = parentJira(issues, { epicLinkId: 'customfield_10014', rejectParent: true });
  await withFetch(handler, async () => {
    const r = await jc.setParentEpic(CRED, { epicKey: 'KAN-12', issueKeys: ['KAN-30', 'KAN-31'], env: CRED.env });
    assert.deepEqual(r.issues.map((i) => i.outcome), ['moved', 'unchanged']); // KAN-31 read via the Epic Link field
    assert.deepEqual(puts.map((p) => p.fields), [{ parent: { key: 'KAN-12' } }, { customfield_10014: 'KAN-12' }]);
    assert.equal(issues['KAN-30'].parent, 'KAN-12');
    const out = await jc.setParentEpic(CRED, { epicKey: null, issueKeys: ['KAN-30'], env: CRED.env });
    assert.equal(out.issues[0].outcome, 'removed');
    assert.deepEqual(puts.slice(-1)[0].fields, { customfield_10014: null });
  });
});

test('setParentEpic: a key listed twice is handled once; a long list is never truncated (#2895 edge cases)', async () => {
  const issues = { 'KAN-12': EPIC() };
  const keys = [];
  for (let i = 100; i < 150; i += 1) { issues[`KAN-${i}`] = STORY(); keys.push(`KAN-${i}`); }
  const { handler, puts } = parentJira(issues);
  await withFetch(handler, async () => {
    const r = await jc.setParentEpic(CRED, { epicKey: 'KAN-12', issueKeys: [...keys, 'kan-100', 'KAN-101'], env: CRED.env });
    assert.equal(r.issues.length, 50);
    assert.equal(r.changed, 50);
    assert.equal(puts.length, 50);
  });
});

test('parentWriteRefusal: Jira\'s reason, readable; a 404 reads as outside the team scope', () => {
  const err = (status, body) => Object.assign(new Error('mapped'), { status, body });
  assert.match(jc.parentWriteRefusal(err(404, ''), 'KAN-1'), /^KAN-1 was not found, or it is outside this team's Jira scope/);
  assert.equal(jc.parentWriteRefusal(err(400, '{"errorMessages":["Nope."]}'), 'KAN-1'), 'Jira refused the change: Nope');
  assert.equal(jc.parentWriteRefusal(err(500, 'oops'), 'KAN-1'), 'mapped');
});

// ── standard fields of an existing issue (#2897) ─────────────────────────────

// A tiny in-memory Jira for `edit`: GET /issue/<KEY>?fields=…, PUT /issue/<KEY>
// (`fields` + `update` add/remove ops, applied like Jira does), the site's
// priorities and the project's components / versions. `put` may answer a PUT
// itself (a refusal).
function editJira(issues, { put } = {}) {
  const puts = [];
  const PRIORITIES = [{ id: '1', name: 'Highest' }, { id: '2', name: 'High' }, { id: '3', name: 'Medium' }, { id: '4', name: 'Low' }];
  const COMPONENTS = [{ id: '10', name: 'Backend' }, { id: '11', name: 'Frontend' }, { id: '12', name: 'API' }];
  const VERSIONS = [{ id: '20', name: '1.0' }, { id: '21', name: '1.1' }, { id: '22', name: '2.0' }];
  const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const handler = (url, opts) => {
    const u = String(url);
    if (/\/rest\/api\/3\/priority$/.test(u)) return json(PRIORITIES);
    if (/\/rest\/api\/3\/project\/KAN\/components$/.test(u)) return json(COMPONENTS);
    if (/\/rest\/api\/3\/project\/KAN\/versions$/.test(u)) return json(VERSIONS);
    const m = u.match(/\/rest\/api\/3\/issue\/([^/?]+)(\?fields=(.*))?$/);
    if (!m) throw new Error(`unexpected ${opts && opts.method} ${url}`);
    const key = decodeURIComponent(m[1]);
    const issue = issues[key];
    if (!issue) return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);
    if (opts && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      puts.push({ key, body });
      if (put) { const r = put(key, body); if (r) return r; }
      Object.assign(issue, body.fields || {});
      for (const [id, ops] of Object.entries(body.update || {})) {
        let list = issue[id] || [];
        const nameOf = (v) => (typeof v === 'object' ? v.name : v);
        for (const op of ops) {
          if (op.add !== undefined) list = [...list, op.add];
          if (op.remove !== undefined) list = list.filter((x) => nameOf(x) !== nameOf(op.remove));
        }
        issue[id] = list;
      }
      return json(undefined, 204);
    }
    return json({ key, fields: { project: { key: 'KAN' }, ...issue } });
  };
  return { handler, puts };
}

const KAN10 = () => ({
  summary: 'Old title',
  assignee: { accountId: 'acc-anna', displayName: 'Anna' },
  priority: { name: 'Medium' },
  labels: ['web', 'urgent'],
  components: [{ name: 'Frontend' }],
  fixVersions: [{ name: '1.0' }],
  duedate: null,
});

test('isIsoDate: a real YYYY-MM-DD only', () => {
  assert.equal(jc.isIsoDate('2026-10-31'), true);
  assert.equal(jc.isIsoDate('2028-02-29'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '31.10.2026', '2026-10-31T10:00:00Z', '', null, '2026-1-5']) {
    assert.equal(jc.isIsoDate(bad), false, String(bad));
  }
});

test('editIssueFields: changes the summary; `show` returns the new summary (#2897 AC1)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    const seen = [];
    const r = await jc.editIssueFields(CRED, 'kan-10', { changes: { summary: '  New title ' }, env: CRED.env, onChanged: (ids) => seen.push(ids) });
    assert.equal(r.issue, 'KAN-10');
    assert.equal(r.url, 'https://acme.atlassian.net/browse/KAN-10');
    assert.deepEqual(r.fields, [{ field: 'summary', from: 'Old title', to: 'New title', outcome: 'changed' }]);
    assert.deepEqual([r.changed, r.unchanged], [1, 0]);
    assert.deepEqual(puts.map((p) => p.body), [{ fields: { summary: 'New title' } }]);
    assert.deepEqual(seen, [['summary']]);
  });
  await withFetch((url, opts) => {
    if (isFieldList(url)) return fieldListResponse();
    if (isTransitionList(url)) return transitionsResponse();
    return handler(url, opts);
  }, async () => {
    const shown = await jc.getIssue(CRED, 'KAN-10', { env: CRED.env });
    assert.equal(shown.summary, 'New title');
  });
});

test('editIssueFields: sets the assignee by accountId and unassigns (#2897 AC2)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    let r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { assignee: 'acc-bob' }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'assignee', from: 'acc-anna', to: 'acc-bob', outcome: 'changed' }]);
    r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { assignee: null }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'assignee', from: 'acc-bob', to: null, outcome: 'changed' }]);
    assert.deepEqual(puts.map((p) => p.body), [{ fields: { assignee: { accountId: 'acc-bob' } } }, { fields: { assignee: null } }]);
  });
});

test('editIssueFields: priority by name (case-insensitive); unknown lists the site priorities (#2897 AC3)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    const r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { priority: 'high' }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'priority', from: 'Medium', to: 'High', outcome: 'changed' }]);
    assert.deepEqual(puts[0].body, { fields: { priority: { name: 'High' } } });
    await assert.rejects(
      jc.editIssueFields(CRED, 'KAN-10', { changes: { priority: 'Blocker' }, env: CRED.env }),
      (e) => e.status === 400 && /no priority "Blocker"\. Available: Highest, High, Medium, Low\. Nothing was changed/.test(e.message),
    );
    assert.equal(puts.length, 1);
  });
});

test('editIssueFields: labels added/removed individually keep the others; replaced as a whole (#2897 AC4)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    let r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { labels: { add: ['backend', 'web'], remove: ['urgent', 'absent'] } }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'labels', from: ['web', 'urgent'], to: ['web', 'backend'], outcome: 'changed' }]);
    // only the real changes, as add/remove ops — the other labels are not resent
    assert.deepEqual(puts[0].body, { update: { labels: [{ add: 'backend' }, { remove: 'urgent' }] } });
    assert.deepEqual(issues['KAN-10'].labels, ['web', 'backend']);
    r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { labels: { set: ['ops'] } }, env: CRED.env });
    assert.deepEqual(r.fields[0].to, ['ops']);
    assert.deepEqual(puts[1].body, { fields: { labels: ['ops'] } });
    r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { labels: { set: [] } }, env: CRED.env });
    assert.deepEqual(puts[2].body, { fields: { labels: [] } });
  });
});

test('editIssueFields: components and fix versions by name; unknown lists the project values (#2897 AC5)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    const r = await jc.editIssueFields(CRED, 'KAN-10', {
      changes: { components: { add: ['backend'], remove: ['Frontend'] }, fixVersions: { set: ['1.1', '2.0'] } },
      env: CRED.env,
    });
    assert.deepEqual(r.fields, [
      { field: 'components', from: ['Frontend'], to: ['Backend'], outcome: 'changed' },
      { field: 'fixVersions', from: ['1.0'], to: ['1.1', '2.0'], outcome: 'changed' },
    ]);
    assert.deepEqual(puts[0].body, {
      fields: { fixVersions: [{ name: '1.1' }, { name: '2.0' }] },
      update: { components: [{ add: { name: 'Backend' } }, { remove: { name: 'Frontend' } }] },
    });
    await assert.rejects(
      jc.editIssueFields(CRED, 'KAN-10', { changes: { components: { add: ['Mobile'] } }, env: CRED.env }),
      (e) => e.status === 400 && /project KAN has no component "Mobile"\. Available: Backend, Frontend, API/.test(e.message),
    );
    await assert.rejects(
      jc.editIssueFields(CRED, 'KAN-10', { changes: { fixVersions: { remove: ['9.9'] } }, env: CRED.env }),
      (e) => e.status === 400 && /project KAN has no version "9\.9"\. Available: 1\.0, 1\.1, 2\.0/.test(e.message),
    );
    assert.equal(puts.length, 1);
  });
});

test('editIssueFields: due date set and cleared; an invalid date is refused before Jira is called (#2897 AC6)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async (calls) => {
    let r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { dueDate: '2026-10-31' }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'dueDate', from: null, to: '2026-10-31', outcome: 'changed' }]);
    r = await jc.editIssueFields(CRED, 'KAN-10', { changes: { dueDate: null }, env: CRED.env });
    assert.deepEqual(r.fields, [{ field: 'dueDate', from: '2026-10-31', to: null, outcome: 'changed' }]);
    assert.deepEqual(puts.map((p) => p.body), [{ fields: { duedate: '2026-10-31' } }, { fields: { duedate: null } }]);
    const before = calls.length;
    for (const bad of ['31.10.2026', '2026-02-30']) {
      await assert.rejects(
        jc.editIssueFields(CRED, 'KAN-10', { changes: { dueDate: bad }, env: CRED.env }),
        (e) => e.status === 400 && /is not a valid due date — use YYYY-MM-DD/.test(e.message),
      );
    }
    assert.equal(calls.length, before, 'Jira was not called');
  });
});

test('editIssueFields: several fields in ONE edit; unchanged ones are reported, not sent (#2897 AC7, edge case)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler, puts } = editJira(issues);
  await withFetch(handler, async () => {
    const seen = [];
    const r = await jc.editIssueFields(CRED, 'KAN-10', {
      changes: { summary: 'Old title', priority: 'Highest', labels: { add: ['web'] }, dueDate: '2026-12-01', assignee: 'acc-anna' },
      env: CRED.env,
      onChanged: (ids) => seen.push(ids),
    });
    assert.deepEqual(r.fields.map((f) => [f.field, f.outcome]), [
      ['summary', 'unchanged'], ['assignee', 'unchanged'], ['priority', 'changed'], ['labels', 'unchanged'], ['dueDate', 'changed'],
    ]);
    assert.deepEqual([r.changed, r.unchanged], [2, 3]);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0].body, { fields: { priority: { name: 'Highest' }, duedate: '2026-12-01' } });
    assert.deepEqual(seen, [['priority', 'duedate']]);
    // everything already at its value: success, no write, no own-write stamp
    const again = await jc.editIssueFields(CRED, 'KAN-10', { changes: { priority: 'Highest' }, env: CRED.env, onChanged: (ids) => seen.push(ids) });
    assert.deepEqual([again.changed, again.unchanged], [0, 1]);
    assert.equal(puts.length, 1);
    assert.equal(seen.length, 1);
  });
});

test('editIssueFields: a Jira refusal is readable, names the field, and nothing is reported changed (#2897 AC7/AC8, edge case)', async () => {
  const issues = { 'KAN-10': KAN10() };
  const { handler } = editJira(issues, {
    put: (key, body) => {
      if (body.fields && body.fields.duedate) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ errors: { duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown." } }) };
      }
      if (body.fields && body.fields.assignee) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ errors: { assignee: "User 'acc-zed' cannot be assigned issues." } }) };
      }
      return null;
    },
  });
  await withFetch(handler, async () => {
    const seen = [];
    await assert.rejects(
      jc.editIssueFields(CRED, 'KAN-10', { changes: { summary: 'X', dueDate: '2026-12-01' }, env: CRED.env, onChanged: (ids) => seen.push(ids) }),
      (e) => e.status === 400
        && /Due date cannot be changed on KAN-10 — the field is not on the issue's edit screen in Jira/.test(e.message)
        && /Nothing was changed\.$/.test(e.message),
    );
    await assert.rejects(
      jc.editIssueFields(CRED, 'KAN-10', { changes: { assignee: 'acc-zed' }, env: CRED.env, onChanged: (ids) => seen.push(ids) }),
      (e) => /Jira refused the edit of KAN-10: Assignee: User 'acc-zed' cannot be assigned issues/.test(e.message),
    );
    assert.deepEqual(seen, [], 'a refused edit is never stamped as changed');
    assert.equal(issues['KAN-10'].summary, 'Old title');
  });
});

test('editIssueFields: outside the team scope is the standard 404 refusal (#2897 AC10)', async () => {
  const { handler, puts } = editJira({});
  await withFetch(handler, async () => {
    await assert.rejects(
      jc.editIssueFields(CRED, 'OTHER-1', { changes: { summary: 'x' }, env: CRED.env }),
      (e) => e.status === 404 && /OTHER-1 was not found, or it is outside this team's Jira scope/.test(e.message),
    );
    assert.equal(puts.length, 0);
  });
});

test('normalizeIssueEdit: shape refusals before Jira (labels with spaces, set+add, empty, add+remove)', () => {
  const bad = (changes, re) => assert.throws(() => jc.normalizeIssueEdit(changes), (e) => e.status === 400 && re.test(e.message));
  bad({ labels: { add: ['needs review'] } }, /label "needs review" contains a space — Jira labels are single words \(use e\.g\. "needs-review"\)/);
  bad({ labels: { set: ['a b'] } }, /contains a space/);
  bad({ labels: { set: ['a'], add: ['b'] } }, /replace the whole list or add\/remove single values, not both/);
  bad({ components: { add: ['API'], remove: ['api'] } }, /"API" is both added and removed/);
  bad({ fixVersions: {} }, /nothing to set, add or remove/);
  bad({ summary: '  ' }, /summary cannot be empty/);
  bad({ priority: '' }, /a priority name is required/);
  bad({}, /nothing to change/);
  assert.deepEqual(jc.normalizeIssueEdit({ assignee: '', dueDate: '' }), { assignee: null, dueDate: null });
  assert.deepEqual(jc.normalizeIssueEdit({ labels: { add: ['a', 'A', 'b'] } }), { labels: { add: ['a', 'b'], remove: [] } });
});

// ── user lookup (#2898) ─────────────────────────────────────────────────────

const jiraUser = (id, name, extra = {}) => ({ accountId: id, displayName: name, active: true, accountType: 'atlassian', ...extra });
const usersResponse = (list) => ({ ok: true, status: 200, text: async () => JSON.stringify(list) });

test('searchUsers: name query → accountId, displayName, email only when Jira gives it, active, accountType (#2898 AC1/AC6)', async () => {
  await withFetch((url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/rest/api/3/user/search');
    assert.equal(u.searchParams.get('query'), 'Anna');
    assert.equal(u.searchParams.get('maxResults'), '51'); // one extra row tells "more matches"
    return usersResponse([
      jiraUser('acc-1', 'Anna Schmidt', { emailAddress: 'anna@acme.com' }),
      jiraUser('acc-2', 'Anna Berg', { emailAddress: '' }),
    ]);
  }, async () => {
    const r = await jc.searchUsers(CRED, { query: ' Anna ', env: CRED.env });
    assert.deepEqual(r, {
      query: 'Anna', assignableOnly: false, count: 2, truncated: false, note: null,
      users: [
        { accountId: 'acc-1', displayName: 'Anna Schmidt', email: 'anna@acme.com', active: true, accountType: 'atlassian' },
        { accountId: 'acc-2', displayName: 'Anna Berg', email: null, active: true, accountType: 'atlassian' },
      ],
    });
  });
});

test('searchUsers: a full e-mail address is passed to Jira as the query (#2898 AC2)', async () => {
  await withFetch((url) => {
    assert.equal(new URL(url).searchParams.get('query'), 'anna@acme.com');
    return usersResponse([jiraUser('acc-1', 'Anna Schmidt', { emailAddress: 'anna@acme.com' })]);
  }, async () => {
    const r = await jc.searchUsers(CRED, { query: 'anna@acme.com', env: CRED.env });
    assert.deepEqual(r.users.map((u) => u.accountId), ['acc-1']);
  });
});

test('searchUsers: --project checks scope, then searches assignable users and leaves inactive ones out (#2898 AC3/AC5)', async () => {
  await withFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/rest/api/3/project/KAN') return usersResponse({ key: 'KAN' });
    assert.equal(u.pathname, '/rest/api/3/user/assignable/search');
    assert.equal(u.searchParams.get('project'), 'KAN');
    return usersResponse([jiraUser('acc-1', 'Anna'), jiraUser('acc-9', 'Anna Gone', { active: false })]);
  }, async (calls) => {
    const r = await jc.searchUsers(CRED, { query: 'Anna', project: 'KAN', env: CRED.env });
    assert.equal(r.assignableOnly, true);
    assert.equal(r.project, 'KAN');
    assert.deepEqual(r.users.map((u) => u.accountId), ['acc-1']);
    assert.equal(calls.length, 2);
  });
});

test('searchUsers: --issue narrows to people assignable to that issue (#2898 AC3)', async () => {
  await withFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/rest/api/3/issue/KAN-10') return usersResponse({ key: 'KAN-10' });
    assert.equal(u.pathname, '/rest/api/3/user/assignable/search');
    assert.equal(u.searchParams.get('issueKey'), 'KAN-10');
    assert.equal(u.searchParams.get('project'), null);
    return usersResponse([jiraUser('acc-1', 'Anna')]);
  }, async () => {
    const r = await jc.searchUsers(CRED, { query: 'Anna', issue: 'KAN-10', env: CRED.env });
    assert.equal(r.issue, 'KAN-10');
    assert.equal(r.count, 1);
  });
});

test('searchUsers: without narrowing, an inactive account is listed and marked; apps are marked (#2898 AC5, edge case)', async () => {
  await withFetch(() => usersResponse([
    jiraUser('acc-9', 'Anna Gone', { active: false }),
    jiraUser('app-1', 'Anna Bot', { accountType: 'app' }),
  ]), async () => {
    const r = await jc.searchUsers(CRED, { query: 'Anna', env: CRED.env });
    assert.deepEqual(r.users.map((u) => [u.accountId, u.active, u.accountType]), [['acc-9', false, 'atlassian'], ['app-1', true, 'app']]);
    assert.match(r.note, /accountType "app" are apps \/ bots/);
    assert.match(r.note, /active: false are deactivated accounts/);
  });
});

test('searchUsers: no match is an empty result with a "no user found" note, not an error (#2898 AC4)', async () => {
  await withFetch((url) => (/\/project\//.test(url) ? usersResponse({}) : usersResponse([])), async () => {
    const r = await jc.searchUsers(CRED, { query: 'Zed', env: CRED.env });
    assert.deepEqual([r.users, r.count, r.truncated, r.note], [[], 0, false, 'No user found matching "Zed".']);
    const p = await jc.searchUsers(CRED, { query: 'Zed', project: 'KAN', env: CRED.env });
    assert.equal(p.note, 'No user found matching "Zed" who can be assigned in project KAN.');
  });
});

test('searchUsers: capped at 50 (or --limit) and says when there were more (#2898 AC7)', async () => {
  const many = Array.from({ length: 51 }, (_, i) => jiraUser(`acc-${i}`, `Person ${i}`));
  await withFetch((url) => {
    const max = Number(new URL(url).searchParams.get('maxResults'));
    return usersResponse(many.slice(0, max));
  }, async () => {
    const r = await jc.searchUsers(CRED, { query: 'Person', env: CRED.env });
    assert.equal(r.count, jc.USER_SEARCH_LIMIT);
    assert.equal(r.truncated, true);
    assert.match(r.note, /More than 50 users match — only the first 50 are listed/);
    const small = await jc.searchUsers(CRED, { query: 'Person', limit: '3', env: CRED.env });
    assert.deepEqual([small.count, small.truncated], [3, true]);
    const capped = await jc.searchUsers(CRED, { query: 'Person', limit: 500, env: CRED.env });
    assert.equal(capped.count, 50);
  });
});

test('searchUsers: several people with the same name are all returned and flagged (#2898 edge case)', async () => {
  await withFetch(() => usersResponse([
    jiraUser('acc-1', 'Anna Schmidt', { emailAddress: 'a1@acme.com' }),
    jiraUser('acc-2', 'anna schmidt'),
    jiraUser('acc-3', 'Anna Berg'),
  ]), async () => {
    const r = await jc.searchUsers(CRED, { query: 'Anna', env: CRED.env });
    assert.equal(r.count, 3);
    assert.match(r.note, /2 users are named "Anna Schmidt" — tell them apart by e-mail or accountId, do not guess/);
    assert.doesNotMatch(r.note, /Anna Berg/);
  });
});

test('searchUsers: a project or issue outside the team scope is the standard refusal, no user search (#2898 AC8)', async () => {
  await withFetch(() => ({ ok: false, status: 404, text: async () => '{}' }), async (calls) => {
    await assert.rejects(
      jc.searchUsers(CRED, { query: 'Anna', project: 'OTHER', env: CRED.env }),
      (e) => e.status === 404 && e.message === "Project OTHER was not found, or it is outside this team's Jira scope (the account cannot see it).",
    );
    await assert.rejects(
      jc.searchUsers(CRED, { query: 'Anna', issue: 'OTHER-1', env: CRED.env }),
      (e) => e.status === 404 && /^Issue OTHER-1 was not found, or it is outside this team's Jira scope/.test(e.message),
    );
    assert.ok(calls.every((c) => !/\/user\//.test(c.url)));
  });
});

test('searchUsers: usage refusals before any HTTP (empty query, project + issue, bad limit)', async () => {
  await withFetch(() => { throw new Error('no HTTP expected'); }, async () => {
    const bad = (args, re) => assert.rejects(jc.searchUsers(CRED, { ...args, env: CRED.env }), (e) => e.status === 400 && re.test(e.message));
    await bad({ query: '  ' }, /a search query is required/);
    await bad({ query: 'A', project: 'KAN', issue: 'KAN-1' }, /--project OR --issue, not both/);
    await bad({ query: 'A', limit: 'x' }, /--limit must be a whole number from 1 to 50/);
    await bad({ query: 'A', limit: 0 }, /--limit must be a whole number/);
  });
});

// ── new Sub-tasks under an existing standard issue (#2900) ──────────────────

function subtaskJira({ parent = issueResponse('KAN-10', 'Story', { hierarchyLevel: 0 }), project = projectResponse(), meta = createMetaResponse(), create } = {}) {
  const fallback = standaloneJira({ project, meta, create });
  return (url, opts) => (isIssueGet(url, opts) ? parent : fallback(url, opts));
}

test('addSubtasksToIssue: three Sub-tasks under KAN-10 — parent set, the project\'s one sub-task type used unnamed (#2900 AC1)', async () => {
  const sent = [];
  await withFetch(subtaskJira({ create: (f) => { sent.push(f); return created201(`KAN-${10 + sent.length}`); } }), async (calls) => {
    const seen = [];
    const r = await jc.addSubtasksToIssue(CRED, {
      parentKey: ' kan-10 ', subtasks: [{ summary: 'A' }, { summary: 'B' }, { summary: 'C' }], allowList: [], onCreated: (k) => seen.push(k), env: CRED.env,
    });
    assert.equal(r.project, 'KAN');
    assert.equal(r.parent.key, 'KAN-10');
    assert.equal(r.parent.issueType, 'Story');
    assert.equal(r.created, 3);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.subtasks.map((s) => [s.key, s.issueType]), [['KAN-11', 'Subtask'], ['KAN-12', 'Subtask'], ['KAN-13', 'Subtask']]);
    assert.ok(sent.every((f) => f.parent.key === 'KAN-10' && f.issuetype.id === '10003' && f.project.key === 'KAN'));
    assert.deepEqual(seen, ['KAN-11', 'KAN-12', 'KAN-13']); // own-writes registration hook
    assert.equal(calls.filter((c) => isCreateMeta(c.url)).length, 1, 'create metadata read once per type');
  });
});

test('addSubtasksToIssue: optional fields as in create-issue; status as a follow-up transition (#2900 AC2)', async () => {
  let sent;
  await withFetch(subtaskJira({ create: (f) => { sent = f; return created201('KAN-11'); } }), async () => {
    const r = await jc.addSubtasksToIssue(CRED, {
      parentKey: 'KAN-10',
      subtasks: [{ summary: 'S', description: 'why', assignee: 'acc-1', priority: 'High', labels: ['web'], status: 'In Progress', fields: { Team: '42' } }],
      allowList: [], attribution: 'by an agent', env: CRED.env,
    });
    assert.equal(sent.description.type, 'doc');
    assert.deepEqual(sent.assignee, { accountId: 'acc-1' });
    assert.deepEqual(sent.priority, { name: 'High' });
    assert.deepEqual(sent.labels, ['web']);
    assert.deepEqual(sent.customfield_20001, { id: '42' });
    assert.equal(r.subtasks[0].status, 'In Progress');
  });
});

test('addSubtasksToIssue: an Epic or a Sub-task as parent is refused before any create (#2900 AC3)', async () => {
  for (const [parent, re] of [
    [issueResponse('KAN-1', 'Epic', { hierarchyLevel: 1 }), /KAN-1 is an Epic — Jira does not allow Sub-tasks directly under an Epic.*Nothing was created\.$/],
    [issueResponse('KAN-2', 'Unteraufgabe', { hierarchyLevel: -1 }), /KAN-2 is itself a Unteraufgabe — a Sub-task cannot have Sub-tasks.*Nothing was created\.$/],
  ]) {
    await withFetch(subtaskJira({ parent, create: () => { throw new Error('must not create'); } }), async () => {
      await assert.rejects(jc.addSubtasksToIssue(CRED, { parentKey: 'KAN-1', subtasks: [{ summary: 'S' }], allowList: [], env: CRED.env }), (e) => e.status === 400 && re.test(e.message));
    });
  }
});

test('addSubtasksToIssue: a project without a sub-task type is refused (#2900 AC4)', async () => {
  await withFetch(subtaskJira({ project: projectResponse('KAN', PROJECT_TYPES.filter((t) => !t.subtask)), create: () => { throw new Error('must not create'); } }), async () => {
    await assert.rejects(
      jc.addSubtasksToIssue(CRED, { parentKey: 'KAN-10', subtasks: [{ summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /project KAN has no sub-task issue type — Sub-tasks are disabled there/.test(e.message),
    );
  });
});

test('addSubtasksToIssue: one failing Sub-task (missing required field, Jira refusal, wrong type) does not stop the others (#2900 AC5)', async () => {
  const meta = createMetaResponse([
    { fieldId: 'summary', name: 'Summary', required: true, hasDefaultValue: false },
    { fieldId: 'parent', name: 'Parent', required: true, hasDefaultValue: false },
    { fieldId: 'customfield_20001', name: 'Team', required: true, hasDefaultValue: false },
  ]);
  let n = 0;
  await withFetch(subtaskJira({
    meta,
    create: (f) => {
      if (f.summary === 'refused') return { ok: false, status: 400, text: async () => JSON.stringify({ errors: { assignee: 'User does not exist' } }) };
      n += 1;
      return created201(`KAN-${20 + n}`);
    },
  }), async () => {
    const r = await jc.addSubtasksToIssue(CRED, {
      parentKey: 'KAN-10',
      subtasks: [
        { summary: 'ok', fields: { Team: '1' } },
        { summary: 'no team' },
        { summary: 'refused', assignee: 'nobody', fields: { Team: '1' } },
        { summary: 'a story', type: 'Story', fields: { Team: '1' } },
        { summary: 'ok too', fields: { Team: '1' } },
      ],
      allowList: [], env: CRED.env,
    });
    assert.equal(r.created, 2);
    assert.equal(r.failed, 3);
    assert.deepEqual(r.subtasks.map((s) => s.key || null), ['KAN-21', null, null, null, 'KAN-22']);
    assert.match(r.subtasks[1].error, /requires field\(s\) for a Subtask that were not provided: Team\./);
    assert.match(r.subtasks[2].error, /assignee "nobody" was rejected \(User does not exist\)/);
    assert.match(r.subtasks[3].error, /^Story is not a sub-task type\. Sub-task types: Subtask\.$/);
  });
});

test('addSubtasksToIssue: a parent outside the team\'s scope is a 404 with the standard wording (#2900 AC6)', async () => {
  await withFetch((url, opts) => {
    if (isIssueGet(url, opts)) return { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist"]}' };
    throw new Error(`unexpected ${url}`);
  }, async () => {
    await assert.rejects(
      jc.addSubtasksToIssue(CRED, { parentKey: 'OTHER-1', subtasks: [{ summary: 'S' }], allowList: [], env: CRED.env }),
      (e) => e.status === 404 && e.message === "Issue OTHER-1 was not found, or it is outside this team's Jira scope (the account cannot see it). Nothing was created.",
    );
  });
});

test('addSubtasksToIssue: several sub-task types — a named type is matched case-insensitively; none named is refused listing them (edge case)', async () => {
  const types = [...PROJECT_TYPES, { id: '10009', name: 'Unteraufgabe', subtask: true, hierarchyLevel: -1 }];
  const sent = [];
  await withFetch(subtaskJira({ project: projectResponse('KAN', types), create: (f) => { sent.push(f); return created201(`KAN-${30 + sent.length}`); } }), async (calls) => {
    const r = await jc.addSubtasksToIssue(CRED, {
      parentKey: 'KAN-10', defaultType: 'unteraufgabe', subtasks: [{ summary: 'A' }, { summary: 'B', type: 'SUBTASK' }], allowList: [], env: CRED.env,
    });
    assert.deepEqual(r.subtasks.map((s) => s.issueType), ['Unteraufgabe', 'Subtask']);
    assert.deepEqual(sent.map((f) => f.issuetype.id), ['10009', '10003']);
    const before = calls.length;
    await assert.rejects(
      jc.addSubtasksToIssue(CRED, { parentKey: 'KAN-10', subtasks: [{ summary: 'A' }], allowList: [], env: CRED.env }),
      (e) => e.status === 400 && /several sub-task types \(Subtask, Unteraufgabe\) — name one with --type.*Nothing was created\./.test(e.message),
    );
    assert.equal(calls.slice(before).filter((c) => isCreate(c.url, c.opts)).length, 0);
  });
});

test('addSubtasksToIssue: shape and allow-list guards run before any Jira call', async () => {
  await withFetch(() => { throw new Error('no Jira call expected'); }, async (calls) => {
    const bad = (args, status, re) => assert.rejects(jc.addSubtasksToIssue(CRED, { allowList: [], env: CRED.env, ...args }), (e) => e.status === status && re.test(e.message));
    await bad({ subtasks: [{ summary: 'S' }] }, 400, /a --parent key is required/);
    await bad({ parentKey: 'nope', subtasks: [{ summary: 'S' }] }, 400, /is not a Jira issue key/);
    await bad({ parentKey: 'KAN-1', subtasks: [] }, 400, /at least one sub-task is required/);
    await bad({ parentKey: 'KAN-1', subtasks: [{ summary: 'S' }, {}] }, 400, /sub-task #2 requires a summary/);
    await bad({ parentKey: 'KAN-1', subtasks: [{ summary: 'S', labels: ['two words'] }] }, 400, /labels cannot contain spaces/);
    await bad({ parentKey: 'KAN-1', subtasks: [{ summary: 'S', fields: { Team: '1' } }], allowList: ['Other'] }, 403, /not writable by agents: Team/);
    assert.equal(calls.length, 0);
  });
});
