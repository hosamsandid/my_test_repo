import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard (#651) for the agent-scoped repository feature
// (#2067). The pure modules cover every decision; what they cannot cover is the
// JSX that has to render them — and three of this ticket's acceptance criteria
// are properties of that JSX alone:
//
//   AC20 — BOTH surfaces render the SAME panel. Two panels over one endpoint
//          would satisfy every unit test and still let one of them drift into a
//          differently-warned copy of a destructive action.
//   D2   — the attach form is the console's ONE repository card, not a second
//          card that agrees today and diverges at the next copy change.
//   AC4  — a successful attach refreshes the Workspace tree, so the reader does
//          not have to work out that Refresh is now needed.
//
// It also pins the client/server parity of the availability rule, which is
// deliberately duplicated (CommonJS in another container) and therefore the one
// place in this feature where two copies of a decision legitimately exist.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..');
const REPO = path.join(HERE, '..', '..', '..', '..');

const read = (p) => fs.readFileSync(p, 'utf8');

/** Comments name the very feature under test, so strip them before asserting. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Index of `needle`, asserted to be a real hit — `-1 < x` is trivially true. */
function at(src, needle, label) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `${label || needle} not found — this guard needs re-pointing`);
  return i;
}

const workspace = () => stripComments(read(path.join(HERE, 'WorkspaceBrowser.jsx')));
const settings = () => stripComments(read(path.join(SRC, 'pages/agent-lifecycle/AgentEditForm.jsx')));
const panel = () => stripComments(read(path.join(HERE, 'AgentRepositoriesPanel.jsx')));
const envPage = () => stripComments(read(path.join(SRC, 'pages/WorkingEnvironments.jsx')));

// ── AC20: one panel, two hosts ──────────────────────────────────────────────

test('AC20: both surfaces render the same AgentRepositoriesPanel', () => {
  for (const [label, src] of [['Workspace view', workspace()], ['Settings tab', settings()]]) {
    assert.match(src, /import AgentRepositoriesPanel from/, `${label} imports the shared panel`);
    assert.match(src, /<AgentRepositoriesPanel\b/, `${label} renders it`);
  }
});

test('the panel is the only place either surface talks to the repositories API', () => {
  const endpoint = /\/repositories`/;
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.match(
      panel(),
      new RegExp(`apiCall\\('${method}', \`/api/agents/\\$\\{encodeURIComponent\\(\\w+\\)\\}/repositories\``),
      `the panel owns the ${method}`,
    );
  }
  // Neither host may reach the endpoint behind the panel's back — that is how
  // "neither surface can reach a state the other cannot" stops being true.
  assert.doesNotMatch(workspace(), endpoint);
  assert.doesNotMatch(settings(), endpoint);
});

test('the Settings surface puts it next to Sync repositories (D7), not somewhere else', () => {
  const src = settings();
  const sync = at(src, 'actionLabel="Sync repositories"');
  const own = at(src, '<AgentRepositoriesPanel');
  assert.ok(own > sync, 'the agent-scoped panel follows the environment sync control');
  // Both are gated off a team record, which has no workspace at all (AC16).
  assert.match(src, /agent\.role !== 'team' && \(\s*<div[\s\S]{0,400}?<AgentRepositoriesPanel/);
});

// ── D2: one repository card ─────────────────────────────────────────────────

test('D2: the attach form and the environment form render one shared card', () => {
  assert.match(panel(), /import RepositoryCard from '\.\.\/\.\.\/components\/RepositoryCard'/);
  assert.match(panel(), /<RepositoryCard\b/);
  assert.match(envPage(), /import RepositoryCard from '\.\.\/components\/RepositoryCard'/);
  assert.match(envPage(), /<RepositoryCard\b/);
  // The card must no longer be declared on the page it came from, or the
  // "extraction" would just be a copy the environment page keeps using.
  assert.doesNotMatch(envPage(), /function RepositoryCard\(/);
  assert.doesNotMatch(envPage(), /function useRepoCheck\(/);
});

test('AC3: the agent form gets the environment form probe, not a reimplementation', () => {
  const card = stripComments(read(path.join(SRC, 'components/RepositoryCard.jsx')));
  assert.match(card, /export function useRepoCheck\(/);
  assert.match(card, /'\/api\/repositories\/check'/);
  assert.match(card, /}, 700\);/, 'the same 700ms debounce');
  // The three distinguishable results AC3 names.
  assert.match(card, /empty: !!result\.empty/);
  assert.match(card, /status: 'error'/);
  assert.match(card, /status: 'ok'/);
  // The panel must NOT hand the card a token id — D5 means the agent surface
  // has no credential of its own, and `githubTokenId` is a real id the card
  // sends to the live reachability probe (#2161): a placeholder there makes
  // the probe 400 against the token registry, not just misdescribe the hint.
  assert.match(panel(), /githubTokenId=""/);
  assert.match(panel(), /tokenTarget="environment"/);
});

// ── AC4: the tree refreshes itself ──────────────────────────────────────────

test('AC4: an attach on the Workspace surface refreshes the file tree', () => {
  assert.match(workspace(), /<AgentRepositoriesPanel[\s\S]{0,200}?onChanged=\{refreshAll\}/);
});

test('the Workspace action sits with Upload / Export / Refresh (D1)', () => {
  const src = workspace();
  const repos = at(src, "title=\"Repositories in this agent's workspace\"");
  const upload = at(src, 'title="Upload files or folder to workspace"');
  const refresh = at(src, 'title="Reload tree"');
  assert.ok(repos < upload && upload < refresh, 'one toolbar, in that order');
  // Opening one panel closes the other, so the tree is never pushed off-screen.
  assert.match(src, /setReposOpen\(o => !o\); if \(!reposOpen\) setUploadOpen\(false\)/);
  assert.match(src, /setUploadOpen\(o => !o\); if \(!uploadOpen\) setReposOpen\(false\)/);
  // Reset on agent change, like every other piece of this panel's state.
  assert.match(src, /setReposOpen\(false\);/);
});

// ── the one legitimate duplication ──────────────────────────────────────────

test('the client availability rule states the same four cases as the server', () => {
  const client = stripComments(read(path.join(HERE, 'agent-repos-view.js')));
  const server = stripComments(read(path.join(REPO, 'orchestrator/agent-repositories.js')));
  // Same discriminators, in the same precedence order: a team record before a
  // stub before a rights check before busy. A different order silently changes
  // which reason a reader is given.
  for (const src of [client, server]) {
    // The two copies live in different module systems and quote differently,
    // so match on the discriminator rather than on its literal spelling.
    const idx = (re, label) => {
      const m = re.exec(src);
      assert.ok(m, `${label} not found — this guard needs re-pointing`);
      return m.index;
    };
    const team = idx(/role\s*===\s*['"]team['"]/, 'team check');
    const stub = idx(/materialized === false/, 'stub check');
    const rights = idx(/canManage === false/, 'rights check');
    const busy = idx(/busy === true/, 'busy check');
    assert.ok(team < stub && stub < rights && rights < busy, 'precedence order matches');
  }
  // And the same verdict on the one asymmetric case (AC17).
  assert.match(client, /canAttach: true,\s*canRemove: false/);
  assert.match(server, /canAttach: true,\s*canRemove: false/);
});

test('AC8/AC12: the remove action exists only for a removable row and honours the gate', () => {
  const src = panel();
  assert.match(src, /row\.removable \?/, 'an inherited row is offered no remove action at all');
  assert.match(src, /disabled=\{!gate\.canRemove\}/);
  assert.match(src, /label=\{gate\.canRemove \? 'Remove repository from this agent' : gate\.reason\}/);
  assert.match(src, /disabled=\{!gate\.canAttach\}/);
  // The reason is stated, not swallowed (AC16 — "disabled with a stated reason").
  assert.match(src, /\{!gate\.canAttach && gate\.reason &&/);
});

test('the server sentence is what the reader sees — no re-worded refusal', () => {
  const src = panel();
  // All three handlers (read, attach, detach) surface err.message; none
  // substitutes a generic string that would hide the collision / credential
  // detail AC13/AC19 require. The fallback after `||` is only reached when the
  // transport itself produced no message.
  assert.equal((src.match(/err\.message \|\| 'Could not/g) || []).length, 3);
  assert.doesNotMatch(src, /Something went wrong/);
});
