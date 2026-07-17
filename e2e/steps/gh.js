// Fake-GitHub step library (#710, docs/journey-spec-concept.md §2.2, §6.1).
//
// The journeys act as "the human on GitHub": create issues/PRs and apply the
// control-point labels (`ready` etc.) that wake the real trigger machinery. In
// the E2E stack that GitHub is the in-stack `fake-github` service (§6.1), which
// emits the matching `issues.labeled` / `pull_request.*` events into its feed so
// the orchestrator poller reacts exactly as against real GitHub.
//
// Every function takes (ctx, params) like the other step modules. Unlike the
// wizard steps these talk to fake-github directly (not the admin-console API),
// so they use an absolute base URL — the host-published fake-github port
// (E2E_FAKE_GITHUB_URL, default http://localhost:4014). fake-github state is
// reset per run, so these are safe to re-run.
const { expect } = require('@playwright/test');

const DEFAULT_FAKE_GITHUB_URL = 'http://localhost:4014';

// Pure: resolve the host-reachable fake-github base URL from the environment.
// Kept as a named export so it can be reasoned about / reused without a browser.
function fakeGithubBaseUrl(env = process.env) {
  return ((env && env.E2E_FAKE_GITHUB_URL) || DEFAULT_FAKE_GITHUB_URL).replace(/\/+$/, '');
}

function repoPath(repo) {
  // Accept "owner/name" and normalise to the fake-github /repos/:owner/:repo path.
  const [owner, name] = String(repo).split('/');
  return `/repos/${owner}/${name}`;
}

// Reset all fake-github state (issues, PRs, labels, events). A journey/fixture
// precondition so a re-run on the same stack starts clean.
async function reset(ctx) {
  const res = await ctx.request.post(`${fakeGithubBaseUrl()}/_reset`);
  expect(res.ok(), `fake-github reset failed: HTTP ${res.status()}`).toBeTruthy();
}

// Create an issue; returns the created issue view (with its number).
async function createIssue(ctx, { repo, title, body, labels }) {
  const res = await ctx.request.post(`${fakeGithubBaseUrl()}${repoPath(repo)}/issues`, {
    data: { title, body, labels },
  });
  expect(res.ok(), `create issue failed: HTTP ${res.status()}`).toBeTruthy();
  return res.json();
}

// Apply a label to an issue (the human control point — e.g. `ready`). fake-github
// emits the corresponding issues.labeled event, waking the subscribed agent.
async function applyLabel(ctx, { repo, issueNumber, label }) {
  const res = await ctx.request.post(
    `${fakeGithubBaseUrl()}${repoPath(repo)}/issues/${issueNumber}/labels`,
    { data: { labels: [label] } },
  );
  expect(res.ok(), `apply label '${label}' failed: HTTP ${res.status()}`).toBeTruthy();
  return res.json();
}

// Assert an issue exists in fake-github and (optionally) carries a label.
async function expectIssue(ctx, { repo, issueNumber, hasLabel }) {
  const res = await ctx.request.get(`${fakeGithubBaseUrl()}${repoPath(repo)}/issues/${issueNumber}`);
  expect(res.ok(), `issue #${issueNumber} not found: HTTP ${res.status()}`).toBeTruthy();
  const issue = await res.json();
  if (hasLabel) {
    const names = (issue.labels || []).map((l) => l.name);
    expect(names, `issue #${issueNumber} labels`).toContain(hasLabel);
  }
  return issue;
}

// Assert a PR exists (e.g. after a Developer agent opened one) and optionally
// that it carries a label (e.g. `ready-for-review`).
async function expectPr(ctx, { repo, prNumber, hasLabel }) {
  const res = await ctx.request.get(`${fakeGithubBaseUrl()}${repoPath(repo)}/pulls/${prNumber}`);
  expect(res.ok(), `PR #${prNumber} not found: HTTP ${res.status()}`).toBeTruthy();
  const pr = await res.json();
  if (hasLabel) {
    const names = (pr.labels || []).map((l) => l.name);
    expect(names, `PR #${prNumber} labels`).toContain(hasLabel);
  }
  return pr;
}

// Poll fake-github's inspection endpoint until an event matching the predicate
// appears (the poller/agent loop is asynchronous). Returns the matching event.
async function expectEvent(ctx, { repo, type, action, label, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ctx.request.get(`${fakeGithubBaseUrl()}/_state`);
    if (res.ok()) {
      // eslint-disable-next-line no-await-in-loop
      const state = await res.json();
      last = ((state.repos || {})[repo] || {}).events || [];
      const match = last.find((e) => (!type || e.type === type)
        && (!action || (e.payload && e.payload.action === action))
        && (!label || (e.payload && e.payload.label && e.payload.label.name === label)));
      if (match) return match;
    }
    if (Date.now() > deadline) {
      throw new Error(`fake-github event not seen within ${timeoutMs}ms `
        + `(type=${type} action=${action} label=${label}); saw ${last.length} events`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = {
  fakeGithubBaseUrl,
  reset,
  createIssue,
  applyLabel,
  expectIssue,
  expectPr,
  expectEvent,
};
