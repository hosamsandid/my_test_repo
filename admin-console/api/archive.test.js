'use strict';

// Unit tests for the zip/unzip runner behind the agent- and skill-archive
// routes. The regression these guard against: a large agent workspace made
// `zip` print more than 1 MB of "adding: …" lines, spawnSync's default
// maxBuffer killed the child mid-archive, and the export failed with an
// undiagnosable `status: null` / empty stderr.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runArchiveTool, describeArchiveFailure } = require('./archive');

const NODE = process.execPath;

test('a child flooding stdout still completes successfully', async () => {
  // 4 MB — four times spawnSync's default maxBuffer, comfortably more than the
  // ~3.4 MB of path listing a 26k-file agent workspace produces.
  const result = await runArchiveTool(NODE, [
    '-e', 'const line = "adding: some/very/long/path/inside/the/workspace (deflated 42%)\\n";' +
          'for (let i = 0; i < 60000; i++) process.stdout.write(line);',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
});

test('non-zero exit is reported with its stderr', async () => {
  const result = await runArchiveTool(NODE, [
    '-e', 'process.stderr.write("zip I/O error: No space left on device\\n"); process.exit(14);',
  ]);
  assert.equal(result.code, 14);
  assert.equal(result.stderr, 'zip I/O error: No space left on device');
});

test('stderr is captured even when stdout is noisy', async () => {
  const result = await runArchiveTool(NODE, [
    '-e', 'for (let i = 0; i < 40000; i++) process.stdout.write("noise ".repeat(10) + "\\n");' +
          'process.stderr.write("warning: name not matched\\n"); process.exit(12);',
  ]);
  assert.equal(result.code, 12);
  assert.equal(result.stderr, 'warning: name not matched');
});

test('captured stderr is bounded', async () => {
  const result = await runArchiveTool(NODE, [
    '-e', 'for (let i = 0; i < 20000; i++) process.stderr.write("x".repeat(100) + "\\n"); process.exit(1);',
  ]);
  assert.equal(result.code, 1);
  // 64 KB cap + at most one overshooting chunk.
  assert.ok(result.stderr.length < 1024 * 1024, `stderr grew to ${result.stderr.length} bytes`);
});

test('a missing executable resolves instead of throwing', async () => {
  const result = await runArchiveTool('definitely-not-an-installed-binary-xyz', ['-r']);
  assert.equal(result.code, null);
  assert.match(result.stderr, /could not run definitely-not-an-installed-binary-xyz/);
});

test('a child killed by a signal reports the signal', async () => {
  const result = await runArchiveTool(NODE, ['-e', 'process.kill(process.pid, "SIGKILL");']);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stderr, 'killed by SIGKILL');
});

test('cwd is honoured', async () => {
  const result = await runArchiveTool(NODE, [
    '-e', 'if (process.cwd() !== process.env.HOME) process.exit(3);',
  ], { cwd: process.env.HOME });
  assert.equal(result.code, 0);
});

test('describeArchiveFailure summarises code, signal and stderr', () => {
  assert.equal(
    describeArchiveFailure('zip', { code: 14, signal: null, stderr: 'No space left on device' }),
    'zip exited 14: No space left on device',
  );
  assert.equal(
    describeArchiveFailure('zip', { code: null, signal: 'SIGKILL', stderr: 'killed by SIGKILL' }),
    'zip exited null (SIGKILL): killed by SIGKILL',
  );
  assert.equal(
    describeArchiveFailure('unzip', { code: 9, signal: null, stderr: '' }),
    'unzip exited 9',
  );
});
