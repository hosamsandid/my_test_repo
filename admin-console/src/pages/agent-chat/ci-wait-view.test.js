import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shellTokens,
  parseCiWaitCommand,
  slugFromRemote,
  buildRepoDirectory,
  resolveCiWaitRepo,
  prUrl,
  parseCiWaitResult,
  ciVerdict,
  ciWaitCard,
  toolHeaderText,
} from './ci-wait-view.js';

const DIR = buildRepoDirectory([
  { url: 'git@github.com:AccentureCodeFoundry/314092_agent-execution-environment.git', dirName: '314092_agent-execution-environment' },
  { url: 'https://github.com/acme/other-repo', dirName: 'other-repo' },
]);

test('shellTokens: quotes, operators, fd redirections', () => {
  assert.deepEqual(shellTokens(`aee-wait-ci 7 --repo "my repo" 2>&1 | tail -5`),
    ['aee-wait-ci', '7', '--repo', 'my repo', '2>', '&', '1', '|', 'tail', '-5']);
  assert.deepEqual(shellTokens('a && b; c'), ['a', '&&', 'b', ';', 'c']);
});

test('detects a plain call with default timeout', () => {
  assert.deepEqual(parseCiWaitCommand('aee-wait-ci 2838'),
    { pr: 2838, repoArg: null, urlRepo: null, timeoutMinutes: 20 });
});

test('detects #N, --repo clone dir and = forms, piped through tail', () => {
  const p = parseCiWaitCommand('cd /workspace && aee-wait-ci "#123" --repo=other-repo --timeout 30 2>&1 | tail -20');
  assert.equal(p.pr, 123);
  assert.equal(p.repoArg, 'other-repo');
  assert.equal(p.timeoutMinutes, 30);
});

test('detects the URL form and a path to the CLI', () => {
  const p = parseCiWaitCommand('/usr/local/bin/aee-wait-ci https://github.com/acme/widgets/pull/42 --no-conflict-check; echo "exit=$?"');
  assert.equal(p.pr, 42);
  assert.deepEqual(p.urlRepo, { host: 'github.com', slug: 'acme/widgets' });
});

test('caps --timeout at the CLI ceiling', () => {
  assert.equal(parseCiWaitCommand('aee-wait-ci 1 --timeout 90').timeoutMinutes, 50);
});

test('not a CI wait: other commands, usage errors', () => {
  assert.equal(parseCiWaitCommand('ls -la'), null);
  assert.equal(parseCiWaitCommand('grep aee-wait-ci-foo file'), null);
  assert.equal(parseCiWaitCommand('aee-wait-ci'), null);
  assert.equal(parseCiWaitCommand('aee-wait-ci --help'), null);
  assert.equal(parseCiWaitCommand('aee-wait-ci 1 2'), null);
  assert.equal(parseCiWaitCommand('aee-wait-ci 1 --timeout abc'), null);
  assert.equal(parseCiWaitCommand('aee-wait-ci abc'), null);
  assert.equal(parseCiWaitCommand(undefined), null);
});

test('slugFromRemote: ssh and https', () => {
  assert.equal(slugFromRemote('git@github.com:o/n.git'), 'o/n');
  assert.equal(slugFromRemote('https://github.com/o/n'), 'o/n');
  assert.equal(slugFromRemote('https://gitlab.com/o/n'), null);
});

test('repo resolution: result > URL > --repo owner/name > clone dir > only repo', () => {
  const p = (cmd) => parseCiWaitCommand(cmd);
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1'), { repo: 'x/y' }, DIR), 'x/y');
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci https://github.com/a/b/pull/1'), null, DIR), 'a/b');
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1 --repo foo/bar'), null, DIR), 'foo/bar');
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1 --repo other-repo'), null, DIR), 'acme/other-repo');
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1 --repo ./other-repo/'), null, DIR), 'acme/other-repo');
  // No --repo: several repos are ambiguous, a single one is the default.
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1'), null, DIR), null);
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1'), null, DIR.slice(0, 1)),
    'AccentureCodeFoundry/314092_agent-execution-environment');
  assert.equal(resolveCiWaitRepo(p('aee-wait-ci 1 --repo unknown-dir'), null, DIR), null);
});

test('prUrl', () => {
  assert.equal(prUrl('o/n', 7), 'https://github.com/o/n/pull/7');
  assert.equal(prUrl(null, 7), null);
});

test('verdict from the JSON result', () => {
  const r = (obj) => ciVerdict(parseCiWaitResult(JSON.stringify(obj)));
  assert.deepEqual(r({ status: 'passed' }), { key: 'passed', label: 'CI passed', tone: 'ok' });
  assert.equal(r({ status: 'no-ci' }).label, 'No CI configured');
  assert.equal(r({ status: 'failed' }).label, 'CI failed');
  assert.equal(r({ status: 'conflict' }).label, 'Merge conflict');
  assert.equal(r({ status: 'timeout' }).label, 'Timed out');
  assert.equal(r({ status: 'error' }).label, 'Error');
  assert.equal(r({ status: 'weird', merge: 'conflict' }).key, 'conflict');
  assert.equal(r({ status: 'weird', ci: 'none' }).key, 'no-ci');
});

test('JSON is found after other output lines and wins over the exit code', () => {
  const content = 'Exit code 4\nsome log\n{"ok":false,"status":"failed","repo":"o/n","pr":3}';
  const parsed = parseCiWaitResult(content);
  assert.equal(parsed.json.status, 'failed');
  assert.equal(parsed.exitCode, 4);
  assert.equal(ciVerdict(parsed).key, 'failed');
});

test('verdict from the exit code when there is no JSON', () => {
  const v = (text) => ciVerdict(parseCiWaitResult(text))?.key ?? null;
  assert.equal(v('exit=0'), 'passed');
  assert.equal(v('Exit code 4'), 'failed');
  assert.equal(v('Exit code 5\n(tail cut)'), 'conflict');
  assert.equal(v('exit_code=6'), 'timeout');
  assert.equal(v('Exit code 1'), 'error');
  assert.equal(v('Exit code 2'), 'error');
  assert.equal(v('Exit code 3'), 'error');
  assert.equal(v('no idea what happened'), null);
  assert.equal(v(''), null);
});

test('array-shaped tool result content is read too', () => {
  const parsed = parseCiWaitResult([{ type: 'text', text: '{"status":"passed"}' }]);
  assert.equal(ciVerdict(parsed).key, 'passed');
});

test('ciWaitCard: pending, settled, unreadable, not a wait', () => {
  const use = { tool: 'Bash', input: { command: 'aee-wait-ci 2838 --timeout 25' } };
  const pending = ciWaitCard(use, null, DIR.slice(0, 1));
  assert.equal(pending.pr, 2838);
  assert.equal(pending.url, 'https://github.com/AccentureCodeFoundry/314092_agent-execution-environment/pull/2838');
  assert.equal(pending.timeoutText, 'max 25m');
  assert.equal(pending.verdict, null);
  assert.equal(pending.unreadable, false);

  const done = ciWaitCard(use, { ok: true, content: '{"status":"passed","repo":"acme/x","pr":2838,"waitedSeconds":372}' }, DIR);
  assert.equal(done.verdict.label, 'CI passed');
  assert.equal(done.url, 'https://github.com/acme/x/pull/2838');
  assert.equal(done.waitedSeconds, 372);

  const unreadable = ciWaitCard(use, { ok: false, content: 'killed' }, DIR);
  assert.equal(unreadable.verdict, null);
  assert.equal(unreadable.unreadable, true);

  assert.equal(ciWaitCard({ tool: 'Bash', input: { command: 'npm test' } }, null, DIR), null);
  assert.equal(ciWaitCard({ tool: 'Read', input: { file_path: 'aee-wait-ci' } }, null, DIR), null);
});

test('toolHeaderText: CI card while waiting, settled, stopped; plain tools', () => {
  const ci = { verdict: null, timeoutText: 'max 20m', waitedSeconds: null };
  assert.deepEqual(toolHeaderText({ tool: 'Bash', ci, runView: { label: 'running · 6m 00s', elapsedText: '6m 00s' }, pending: true, stopped: false }),
    { label: 'Waiting for CI', trailing: '6m 00s of max 20m' });
  assert.deepEqual(toolHeaderText({ tool: 'Bash', ci, runView: null, pending: true, stopped: false }),
    { label: 'Waiting for CI', trailing: 'max 20m' });
  assert.deepEqual(toolHeaderText({ tool: 'Bash', ci, runView: { label: 'stopped after 2m 00s', elapsedText: '2m 00s' }, pending: true, stopped: true }),
    { label: 'Waiting for CI', trailing: 'stopped after 2m 00s' });
  const done = { verdict: { label: 'CI failed' }, timeoutText: 'max 20m', waitedSeconds: 372 };
  assert.deepEqual(toolHeaderText({ tool: 'Bash', ci: done, runView: { label: '', elapsedText: '' }, pending: false, stopped: false }),
    { label: 'CI failed', trailing: 'took 6m 12s' });
  assert.deepEqual(toolHeaderText({ tool: 'Read', ci: null, runView: { label: 'took 45s' }, pending: false, stopped: false }),
    { label: 'Read', trailing: 'took 45s' });
});
