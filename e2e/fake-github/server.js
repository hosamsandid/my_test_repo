// Fake GitHub server (#710, docs/journey-spec-concept.md §6.1).
//
// A dependency-free HTTP server implementing the minimal GitHub REST surface
// the stack touches, plus a mock Anthropic `/v1/messages` endpoint (§6.3) so
// `POST /api/agent-prompt/generate` works in the E2E stack without a real LLM.
// State is in memory and reset per run; an inspection endpoint exposes it for
// test assertions. e2e overlay only — never wired into the production stack.
//
// The GitHub side speaks just enough of the REST API for:
//   - orchestrator/github-poller.js — the Events API with ETag/304 semantics.
//   - the wizard repo-probe / coordinator-workflow endpoints (via GITHUB_API_BASE).
//   - agents and test steps acting as "the human" — issues/PRs/labels CRUD.
//
// Label mutations emit matching `issues.labeled` / `pull_request.*` events into
// the events feed, closing the loop poller-side. Events are GitHub-Events-API
// shaped: { id, type, actor, repo, payload:{ action, issue|pull_request, label },
// created_at }, newest first, exactly what the poller's TYPE_KEY/action parsing
// expects.
//
// Pure logic (state + mutations) is kept module-private and driven only through
// the HTTP layer, so the unit test exercises the real request/response path.
const http = require('http');

// ── In-memory state ─────────────────────────────────────────────────────────
function makeState() {
  return {
    repos: new Map(), // "owner/repo" -> repo record
    seq: 0, // monotonic id source for events, issues, PRs (shared, simple)
    clock: 0, // monotonic fake clock; distinct created_at per mutation
    // Real wall-clock base captured at state creation / reset (#711). Event
    // created_at MUST be anchored to real time, not a fixed 2023 epoch: the
    // production GitHub poller gates every event by the subscriber's real-time
    // history horizon (activatedAt/createdAt, widened by a 5-min grace —
    // github-poller.js passesHorizon), so a fixed-epoch 2023 timestamp is always
    // older than a team materialised "now" and the label-chain events get
    // dropped before reaching the Developer/Reviewer. Anchoring to reset-time
    // (the ibanStoryTeam fixture resets fake-github just before materialising)
    // keeps events inside the horizon window. The monotonic `clock` increment
    // preserves strictly-increasing, distinct timestamps for ordering assertions.
    epoch: Date.now(),
  };
}

function isoAt(state) {
  // Strictly-increasing timestamps anchored to the real wall-clock base (see
  // makeState); the +1000ms step guarantees distinct, ordered created_at values
  // without depending on the host clock's resolution.
  state.clock += 1000;
  return new Date(state.epoch + state.clock).toISOString();
}

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

function getRepo(state, owner, repo) {
  const key = repoKey(owner, repo);
  let r = state.repos.get(key);
  if (!r) {
    r = {
      fullName: key,
      owner,
      name: repo,
      issues: new Map(), // number -> issue
      pulls: new Map(), // number -> pull
      comments: new Map(), // number -> [ { id, body, user } ] (issue == PR namespace)
      labels: new Map(), // name -> { name, color }
      events: [], // newest first
      etag: 'W/"0"',
    };
    state.repos.set(key, r);
  }
  return r;
}

function bumpEtag(repo) {
  const n = Number((repo.etag.match(/"(\d+)"/) || [])[1] || 0) + 1;
  repo.etag = `W/"${n}"`;
}

// Push a GitHub-Events-API-shaped event to the front of the feed.
function emitEvent(state, repo, type, payload) {
  state.seq += 1;
  repo.events.unshift({
    id: String(state.seq),
    type,
    actor: { login: 'e2e' },
    repo: { name: repo.fullName },
    payload,
    created_at: isoAt(state),
    public: true,
  });
  bumpEtag(repo);
}

function ensureLabels(repo, names) {
  for (const name of names) {
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color: 'ededed' });
  }
}

function issueView(repo, issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    state: issue.state,
    labels: issue.labels.map((n) => repo.labels.get(n) || { name: n, color: 'ededed' }),
    html_url: `http://${repo.fullName}/issues/${issue.number}`,
    url: `/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullView(repo, pull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body || '',
    state: pull.state,
    labels: pull.labels.map((n) => repo.labels.get(n) || { name: n, color: 'ededed' }),
    head: { ref: pull.head },
    base: { ref: pull.base },
    html_url: `http://${repo.fullName}/pull/${pull.number}`,
    url: `/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// ── Mutations (each returns the created/updated view) ────────────────────────
function createIssue(state, owner, repo, { title, body, labels }) {
  const r = getRepo(state, owner, repo);
  state.seq += 1;
  const number = state.seq;
  ensureLabels(r, labels || []);
  const issue = { number, title: title || `Issue ${number}`, body: body || '', state: 'open', labels: [...(labels || [])] };
  r.issues.set(number, issue);
  emitEvent(state, r, 'IssuesEvent', { action: 'opened', issue: issueView(r, issue) });
  return issueView(r, issue);
}

function createPull(state, owner, repo, { title, body, head, base }) {
  const r = getRepo(state, owner, repo);
  state.seq += 1;
  const number = state.seq;
  const pull = { number, title: title || `PR ${number}`, body: body || '', state: 'open', labels: [], head: head || 'feature', base: base || 'main' };
  r.pulls.set(number, pull);
  emitEvent(state, r, 'PullRequestEvent', { action: 'opened', number, pull_request: pullView(r, pull) });
  return pullView(r, pull);
}

// Add labels to an issue or PR; emit one labeled event per newly-added label.
// PRs emit PullRequestEvent(labeled); issues emit IssuesEvent(labeled) — the
// "corresponding" events §6.1 calls for.
function addLabels(state, owner, repo, kind, number, names) {
  const r = getRepo(state, owner, repo);
  const target = kind === 'pulls' ? r.pulls.get(number) : r.issues.get(number);
  if (!target) return null;
  ensureLabels(r, names);
  for (const name of names) {
    if (target.labels.includes(name)) continue; // idempotent, like GitHub
    target.labels.push(name);
    const label = r.labels.get(name);
    if (kind === 'pulls') {
      emitEvent(state, r, 'PullRequestEvent', { action: 'labeled', number, pull_request: pullView(r, target), label });
    } else {
      emitEvent(state, r, 'IssuesEvent', { action: 'labeled', issue: issueView(r, target), label });
    }
  }
  return kind === 'pulls' ? pullView(r, target) : issueView(r, target);
}

// Add a comment to an issue OR a PR (GitHub shares the issues/:n/comments
// endpoint for both — #711, the Code Reviewer posts its verdict here). Numbers
// come from the shared `state.seq`, so an issue and a PR never collide on `n`.
function addComment(state, owner, repo, number, body) {
  const r = getRepo(state, owner, repo);
  const target = r.issues.get(number) || r.pulls.get(number);
  if (!target) return null;
  state.seq += 1;
  const comment = { id: state.seq, body: body || '', user: { login: 'e2e' }, created_at: isoAt(state) };
  const list = r.comments.get(number) || [];
  list.push(comment);
  r.comments.set(number, list);
  return comment;
}

function listComments(state, owner, repo, number) {
  const r = getRepo(state, owner, repo);
  return r.comments.get(number) || [];
}

function removeLabel(state, owner, repo, kind, number, name) {
  const r = getRepo(state, owner, repo);
  const target = kind === 'pulls' ? r.pulls.get(number) : r.issues.get(number);
  if (!target) return null;
  const i = target.labels.indexOf(name);
  if (i === -1) return kind === 'pulls' ? pullView(r, target) : issueView(r, target);
  target.labels.splice(i, 1);
  const label = r.labels.get(name) || { name, color: 'ededed' };
  if (kind === 'pulls') {
    emitEvent(state, r, 'PullRequestEvent', { action: 'unlabeled', number, pull_request: pullView(r, target), label });
  } else {
    emitEvent(state, r, 'IssuesEvent', { action: 'unlabeled', issue: issueView(r, target), label });
  }
  return kind === 'pulls' ? pullView(r, target) : issueView(r, target);
}

// ── Mock Anthropic /v1/messages (§6.3) ───────────────────────────────────────
function cannedMessage() {
  return {
    id: 'msg_e2e_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-fake-e2e',
    content: [
      {
        type: 'text',
        text:
          'You are a diligent Developer agent on an Agent Studio team. You implement '
          + 'ready-labelled issues, open pull requests, and keep changes tightly scoped '
          + 'to the issue. (canned e2e fixture response)',
      },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 40 },
  };
}

// ── HTTP layer ────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
}

// Build a request handler bound to a state object. Exported so callers can
// share one state across a listening server and its reset/inspection needs.
function makeHandler(state) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://fake-github');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    // ── Control / inspection ─────────────────────────────────────────────
    if (parts[0] === '_reset' && method === 'POST') {
      state.repos = new Map();
      state.seq = 0;
      state.clock = 0;
      // Re-anchor the wall-clock base so post-reset events are stamped "now"
      // (≈ the team-materialisation horizon), not the process-start time (#711).
      state.epoch = Date.now();
      return send(res, 200, { ok: true });
    }
    if (parts[0] === '_state' && method === 'GET') {
      const repos = {};
      for (const [key, r] of state.repos) {
        repos[key] = {
          issues: [...r.issues.values()].map((i) => issueView(r, i)),
          pulls: [...r.pulls.values()].map((p) => pullView(r, p)),
          comments: [...r.comments.entries()].flatMap(
            ([number, list]) => list.map((c) => ({ number, body: c.body })),
          ),
          labels: [...r.labels.keys()],
          eventCount: r.events.length,
          events: r.events,
        };
      }
      return send(res, 200, { repos });
    }

    // ── Mock Anthropic Messages API (§6.3) ───────────────────────────────
    if (parts[0] === 'v1' && parts[1] === 'messages' && method === 'POST') {
      await readBody(req);
      return send(res, 200, cannedMessage());
    }

    // ── GitHub REST: /repos/:owner/:repo/... ─────────────────────────────
    if (parts[0] === 'repos' && parts.length >= 3) {
      const [, owner, repo, ...rest] = parts;

      // GET /repos/:owner/:repo/events — Events API with ETag/304.
      if (rest[0] === 'events' && method === 'GET') {
        const r = getRepo(state, owner, repo);
        const inm = req.headers['if-none-match'];
        if (inm && inm === r.etag) {
          res.writeHead(304, { ETag: r.etag });
          return res.end();
        }
        return send(res, 200, r.events, { ETag: r.etag });
      }

      // GET /repos/:owner/:repo — repo metadata (wizard repo-probe).
      if (rest.length === 0 && method === 'GET') {
        const r = getRepo(state, owner, repo);
        return send(res, 200, { full_name: r.fullName, name: repo, default_branch: 'main' });
      }
      if (rest[0] === 'branches' && method === 'GET') {
        return send(res, 200, [{ name: 'main' }]);
      }

      // Labels registry.
      if (rest[0] === 'labels' && rest.length === 1) {
        const r = getRepo(state, owner, repo);
        if (method === 'GET') return send(res, 200, [...r.labels.values()]);
        if (method === 'POST') {
          const body = await readBody(req);
          ensureLabels(r, [body.name]);
          return send(res, 201, r.labels.get(body.name));
        }
      }

      // Issues.
      if (rest[0] === 'issues') {
        if (rest.length === 1 && method === 'POST') {
          const body = await readBody(req);
          return send(res, 201, createIssue(state, owner, repo, body));
        }
        const number = Number(rest[1]);
        if (rest.length === 2 && method === 'GET') {
          const r = getRepo(state, owner, repo);
          const issue = r.issues.get(number);
          if (!issue) return send(res, 404, { message: 'Not Found' });
          return send(res, 200, issueView(r, issue));
        }
        if (rest[2] === 'labels' && method === 'POST') {
          const body = await readBody(req);
          const names = Array.isArray(body) ? body : body.labels || [];
          const out = addLabels(state, owner, repo, 'issues', number, names);
          return out ? send(res, 200, out.labels) : send(res, 404, { message: 'Not Found' });
        }
        if (rest[2] === 'labels' && rest[3] && method === 'DELETE') {
          const out = removeLabel(state, owner, repo, 'issues', number, decodeURIComponent(rest[3]));
          return out ? send(res, 200, out.labels) : send(res, 404, { message: 'Not Found' });
        }
        // Comments — shared issue/PR endpoint (the Code Reviewer's verdict, #711).
        if (rest[2] === 'comments' && method === 'POST') {
          const body = await readBody(req);
          const out = addComment(state, owner, repo, number, body.body);
          return out ? send(res, 201, out) : send(res, 404, { message: 'Not Found' });
        }
        if (rest[2] === 'comments' && method === 'GET') {
          return send(res, 200, listComments(state, owner, repo, number));
        }
      }

      // Pull requests.
      if (rest[0] === 'pulls') {
        if (rest.length === 1 && method === 'POST') {
          const body = await readBody(req);
          return send(res, 201, createPull(state, owner, repo, body));
        }
        const number = Number(rest[1]);
        if (rest.length === 2 && method === 'GET') {
          const r = getRepo(state, owner, repo);
          const pull = r.pulls.get(number);
          if (!pull) return send(res, 404, { message: 'Not Found' });
          return send(res, 200, pullView(r, pull));
        }
      }

      // Labelling a PR goes through the issues labels path on real GitHub;
      // support /repos/:o/:r/issues/:n/labels for PRs too by number lookup —
      // but PR-specific callers can also POST /pulls/:n/labels for clarity.
      if (rest[0] === 'pulls' && rest[2] === 'labels' && method === 'POST') {
        const number = Number(rest[1]);
        const body = await readBody(req);
        const names = Array.isArray(body) ? body : body.labels || [];
        const out = addLabels(state, owner, repo, 'pulls', number, names);
        return out ? send(res, 200, out.labels) : send(res, 404, { message: 'Not Found' });
      }
    }

    return send(res, 404, { message: 'Not Found', path: url.pathname });
  };
}

function createServer() {
  const state = makeState();
  const server = http.createServer(makeHandler(state));
  server.fakeState = state; // handy for in-process tests
  return server;
}

module.exports = { createServer, makeHandler, makeState };

// Run standalone (compose service) when invoked directly.
if (require.main === module) {
  const port = Number(process.env.PORT || 80);
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[fake-github] listening on :${port}`);
  });
}
