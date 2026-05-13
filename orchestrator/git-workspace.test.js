'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findEnclosingGitRepo } = require('./git-workspace');

function mkSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-workspace-test-'));
}

function mkGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'));
}

test('briefingsPath at repo root is accepted', () => {
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const workspace = path.join(agentRoot, 'briefings-repo');
    mkGitRepo(workspace);

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), workspace);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('briefingsPath in a sub-directory of a cloned repo is accepted', () => {
  // Mirrors the real-world failure: 313885_agentic-demo-collection cloned
  // at the agent root, briefingsPath points at demo-06-future-of-sdlc.
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const repoRoot = path.join(agentRoot, 'demo-collection');
    const workspace = path.join(repoRoot, 'demo-06-future-of-sdlc');
    mkGitRepo(repoRoot);
    fs.mkdirSync(workspace, { recursive: true });

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), repoRoot);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('briefingsPath nested several levels below the repo root is accepted', () => {
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const repoRoot = path.join(agentRoot, 'mono-repo');
    const workspace = path.join(repoRoot, 'a', 'b', 'briefings');
    mkGitRepo(repoRoot);
    fs.mkdirSync(workspace, { recursive: true });

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), repoRoot);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('returns null when no ancestor (up to the agent root) has a .git', () => {
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const workspace = path.join(agentRoot, 'sub', 'briefings');
    fs.mkdirSync(workspace, { recursive: true });

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('returns null when the workspace dir does not exist and no ancestor has .git', () => {
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const workspace = path.join(agentRoot, 'never-cloned', 'briefings');
    fs.mkdirSync(agentRoot);

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('does not walk past the agent root, even if the parent has a .git', () => {
  // Defense-in-depth: a stray .git outside the agent's own subtree must
  // never be picked up — that would let a misconfigured workspace operate
  // on something it doesn't own.
  const sandbox = mkSandbox();
  try {
    mkGitRepo(sandbox); // .git lives ABOVE the agent root
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const workspace = path.join(agentRoot, 'briefings');
    fs.mkdirSync(workspace, { recursive: true });

    assert.equal(findEnclosingGitRepo(workspace, agentRoot), null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the agent root itself counts as a valid checkout location', () => {
  // Edge case: the briefings dir is the agent root (rel='.'), and the agent
  // root happens to be a repo. Check is inclusive of stopAt.
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    mkGitRepo(agentRoot);

    assert.equal(findEnclosingGitRepo(agentRoot, agentRoot), agentRoot);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('rejects a start path outside the stopAt subtree', () => {
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const sibling = path.join(sandbox, 'orchestrator-2');
    mkGitRepo(sibling);
    fs.mkdirSync(agentRoot);

    assert.equal(findEnclosingGitRepo(sibling, agentRoot), null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('does not confuse a sibling with a same-prefix name for the agent root', () => {
  // `dir.startsWith(root)` would falsely match `/foo/orchestrator-1-evil`
  // against root `/foo/orchestrator-1`. The implementation must enforce a
  // path-separator boundary.
  const sandbox = mkSandbox();
  try {
    const agentRoot = path.join(sandbox, 'orchestrator-1');
    const evilSibling = path.join(sandbox, 'orchestrator-1-evil');
    mkGitRepo(evilSibling);
    fs.mkdirSync(agentRoot);

    assert.equal(findEnclosingGitRepo(evilSibling, agentRoot), null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
