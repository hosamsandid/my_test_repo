'use strict';

// Running `zip` / `unzip` for the agent- and skill-archive routes.
//
// Why this is not a one-line spawnSync: both tools print one line per archive
// member, and spawnSync's default maxBuffer is 1 MB. An agent workspace with
// tens of thousands of files (repo clones, a knowledge checkout) overflows it,
// the child is killed with SIGPIPE, and the call returns `status: null` with an
// EMPTY stderr — an export that fails with no usable diagnosis. Here stdout is
// discarded outright (the call sites also pass `-q`), only stderr is captured
// (bounded), and the run is asynchronous so archiving a multi-hundred-MB
// workspace does not block the single-threaded API for its whole duration.

const { spawn } = require('child_process');

const MAX_STDERR = 64 * 1024;

/**
 * Runs an archive tool without buffering its per-file listing.
 *
 * Never rejects — the caller decides what a non-zero exit means.
 *
 * @param {string} cmd  executable (`zip` / `unzip`)
 * @param {string[]} args  argv, passed without a shell
 * @param {object} [opts]  spawn options (`cwd`, …); `stdio` is always overridden
 * @returns {Promise<{code: number|null, signal: string|null, stderr: string}>}
 *   `code` is null when the child died from a signal or never spawned; `stderr`
 *   then carries the reason.
 */
function runArchiveTool(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, stderr: `could not run ${cmd}: ${err.message}` });
      return;
    }
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Bounded: a pathological run must not grow the buffer without limit.
      if (stderr.length < MAX_STDERR) stderr += chunk;
    });
    child.on('error', (err) => {
      settle({ code: null, signal: null, stderr: `could not run ${cmd}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      settle({
        code,
        signal,
        stderr: signal && !stderr.trim() ? `killed by ${signal}` : stderr.trim(),
      });
    });
  });
}

/**
 * One-line description of a failed run, for logs and error responses.
 * @param {string} cmd
 * @param {{code: number|null, signal: string|null, stderr: string}} result
 */
function describeArchiveFailure(cmd, result) {
  const sig = result.signal ? ` (${result.signal})` : '';
  const err = result.stderr ? `: ${result.stderr}` : '';
  return `${cmd} exited ${result.code}${sig}${err}`;
}

module.exports = { runArchiveTool, describeArchiveFailure, MAX_STDERR };
