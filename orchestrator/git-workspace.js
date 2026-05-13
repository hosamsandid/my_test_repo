'use strict';

const fs = require('fs');
const path = require('path');

// Walk upward from `start` looking for a directory containing a `.git` entry,
// stopping at (and including) `stopAt`. Returns the absolute path of the
// enclosing git checkout, or null if none was found within bounds.
//
// Used by the orchestrator to decide whether a briefings workspace is backed
// by a git checkout. The classic `briefingsPath` points directly at a repo
// root, but it may also point at a sub-directory of a cloned repo (multiple
// BP collections per repo) — in that case the `.git` lives one or more
// levels above. The agent root forms the upper bound so a misconfigured
// workspace can never escape into the orchestrator container's filesystem.
function findEnclosingGitRepo(start, stopAt) {
  const root = path.resolve(stopAt);
  let dir = path.resolve(start);
  // Bail when `start` is outside `stopAt`'s subtree — never walk up past the
  // agent root, regardless of input.
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = { findEnclosingGitRepo };
