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

// Read the full fake-github state (all repos). Small helper so the polling
// finders below don't each duplicate the fetch/parse.
async function _state(ctx) {
  const res = await ctx.request.get(`${fakeGithubBaseUrl()}/_state`);
  if (!res.ok()) return { repos: {} };
  return res.json();
}

function _repoState(state, repo) {
  return (state.repos || {})[repo] || {};
}

/**
 * Apply a label to the NEWEST issue in a repo (the human control point) without
 * the journey needing to know the issue number the BA playbook chose. Polls
 * briefly for the issue to appear (the BA agent creates it asynchronously),
 * then applies the label. Returns the issue number it labelled.
 *
 * @param {string} params.repo - "owner/name" of the repo on fake-github.
 * @param {string} params.label - Label to apply (e.g. `ready`).
 * @param {number} [params.timeoutMs=30000] - Max time to wait for the issue to appear.
 */
async function applyLabelToLatestIssue(ctx, { repo, label, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const issues = _repoState(await _state(ctx), repo).issues || [];
    if (issues.length) {
      const number = issues[issues.length - 1].number;
      // eslint-disable-next-line no-await-in-loop
      await applyLabel(ctx, { repo, issueNumber: number, label });
      return number;
    }
    if (Date.now() > deadline) {
      throw new Error(`no issue appeared in ${repo} within ${timeoutMs}ms to label '${label}'`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Poll until an issue exists in the repo (proves the BA→issue hop) — optionally
 * carrying a label. Number-agnostic so the journey stays declarative.
 *
 * @param {string} params.repo - "owner/name" of the repo on fake-github.
 * @param {string} [params.hasLabel] - If set, require an issue carrying this label.
 * @param {number} [params.timeoutMs=30000] - Max time to wait.
 */
async function expectIssueExists(ctx, { repo, hasLabel, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const issues = _repoState(await _state(ctx), repo).issues || [];
    const match = hasLabel
      ? issues.find((i) => (i.labels || []).some((l) => l.name === hasLabel))
      : issues[0];
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`no issue${hasLabel ? ` labelled '${hasLabel}'` : ''} in ${repo} within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Poll until a PR exists in the repo (proves the Developer→PR hop) — optionally
 * carrying a label (e.g. ready-for-review / ready-to-merge). Number-agnostic.
 *
 * @param {string} params.repo - "owner/name" of the repo on fake-github.
 * @param {string} [params.hasLabel] - If set, require a PR carrying this label.
 * @param {number} [params.timeoutMs=45000] - Max time to wait.
 */
async function expectPrExists(ctx, { repo, hasLabel, timeoutMs = 45_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const pulls = _repoState(await _state(ctx), repo).pulls || [];
    const match = hasLabel
      ? pulls.find((p) => (p.labels || []).some((l) => l.name === hasLabel))
      : pulls[0];
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`no PR${hasLabel ? ` labelled '${hasLabel}'` : ''} in ${repo} within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Poll until a comment whose body includes `bodyIncludes` exists (proves the
 * Code Reviewer posted its verdict, #711). Number-agnostic — matches any
 * issue/PR comment on the repo.
 *
 * @param {string} params.repo - "owner/name" of the repo on fake-github.
 * @param {string} params.bodyIncludes - Substring the comment body must contain.
 * @param {number} [params.timeoutMs=45000] - Max time to wait.
 */
async function expectComment(ctx, { repo, bodyIncludes, timeoutMs = 45_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const comments = _repoState(await _state(ctx), repo).comments || [];
    const match = comments.find((c) => (c.body || '').includes(bodyIncludes || ''));
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`no comment matching '${bodyIncludes}' in ${repo} within ${timeoutMs}ms`);
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
  applyLabelToLatestIssue,
  expectIssue,
  expectIssueExists,
  expectPr,
  expectPrExists,
  expectComment,
  expectEvent,
};
