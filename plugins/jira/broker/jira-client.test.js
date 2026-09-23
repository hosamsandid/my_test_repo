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
  assert.deepEqual(jc.buildJqlSearchBody('jql'), { jql: 'jql', fields: ['summary', 'status', 'issuetype'], expand: 'changelog', maxResults: 100 });
  assert.equal(typeof jc.buildJqlSearchBody('jql').expand, 'string'); // array form is a 400 on this endpoint
  assert.equal(jc.buildJqlSearchBody('jql', 'TOK').nextPageToken, 'TOK');
});

test('changelogPath: encodes the issue key and paginates', () => {
  assert.equal(jc.changelogPath('ENG-1', 100), '/rest/api/3/issue/ENG-1/changelog?startAt=100&maxResults=100');
});

test('shapeIssue: narrows to key/summary/status/issueType/changelog', () => {
  assert.deepEqual(
    jc.shapeIssue({ key: 'ENG-1', fields: { summary: 'S', status: { name: 'In Progress' }, issuetype: { name: 'Bug' } }, changelog: { total: 1, histories: [] } }),
    { key: 'ENG-1', summary: 'S', status: 'In Progress', issueType: 'Bug', changelog: { total: 1, histories: [] } },
  );
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
  global.fetch = async (url, opts) => {
    calls.push(`${opts.method || 'GET'} ${new URL(url).pathname}`);
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

test('listProjectIssues: project-scoped JQL, optional status filter, narrow rows', async () => {
  await withFetch((url, opts) => {
    assert.match(url, /\/rest\/api\/3\/search\/jql/);
    const body = JSON.parse(opts.body);
    assert.equal(body.jql, 'project = "KAN" AND status = "Ready for Dev" ORDER BY updated DESC');
    assert.deepEqual(body.fields, ['summary', 'status', 'assignee', 'created', 'updated', 'issuetype']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [
      { key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, assignee: { displayName: 'Jane' }, created: '2026-09-08T09:00:00Z', updated: '2026-09-09T10:00:00Z', issuetype: { name: 'Story' } } },
    ] }) };
  }, async () => {
    const rows = await jc.listProjectIssues({ siteUrl: 'acme', email: 'e', apiToken: 't' }, { projectKey: 'KAN', status: 'Ready for Dev', env: CRED.env });
    assert.deepEqual(rows, [{
      key: 'KAN-6', summary: 'Login', status: 'Ready for Dev', issueType: 'Story', assignee: 'Jane',
      created: '2026-09-08T09:00:00Z', updated: '2026-09-09T10:00:00Z', url: 'https://acme.atlassian.net/browse/KAN-6',
    }]);
  });
});

test('listProjectIssues: status with a backslash-quote cannot break out of the clause', async () => {
  await withFetch((url, opts) => {
    assert.equal(JSON.parse(opts.body).jql, 'project = "KAN" AND status = "x\\\\\\" OR 1=1 --" ORDER BY updated DESC');
    return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [] }) };
  }, async () => {
    await jc.listProjectIssues(CRED, { projectKey: 'KAN', status: 'x\\" OR 1=1 --', env: CRED.env });
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
    assert.match(url, /fields=summary,status,description,assignee,issuetype,attachment,created,updated/);
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
    assert.equal(issue.url, 'https://acme.atlassian.net/browse/ENG-5'); // browse URL uses the real site, not the seam
    assert.ok(!('attachments' in issue)); // no attachments → no key at all (AC2/AC8)
  });
});

test('getIssue: missing created/updated fields surface as null (#2414)', async () => {
  await withFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({
    key: 'ENG-6', fields: { summary: 'S', status: { name: 'To Do' }, issuetype: { name: 'Task' } },
  }) }), async () => {
    const issue = await jc.getIssue(CRED, 'ENG-6', { env: CRED.env });
    assert.equal(issue.created, null);
    assert.equal(issue.updated, null);
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
  await withFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({
    key: 'ENG-7', fields: { summary: 'S', attachment: many },
  }) }), async () => {
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
