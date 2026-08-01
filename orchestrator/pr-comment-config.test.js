'use strict';

// Run: node --test orchestrator/pr-comment-config.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('./pr-comment-config');

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aee-ttc-'));
}

test('AC4 — OFF by default: no file means disabled', () => {
  const ws = tmpWorkspace();
  assert.equal(cfg.isPrMergeCommentEnabled(ws, 'team-a'), false);
});

test('set true then read enabled; the file lives under the team dir', () => {
  const ws = tmpWorkspace();
  cfg.setPrMergeCommentEnabled(ws, 'team-a', true);
  assert.equal(cfg.isPrMergeCommentEnabled(ws, 'team-a'), true);
  assert.ok(fs.existsSync(path.join(ws, 'teams', 'team-a', 'token-telemetry-config.json')));
});

test('toggling back to false disables again', () => {
  const ws = tmpWorkspace();
  cfg.setPrMergeCommentEnabled(ws, 'team-a', true);
  cfg.setPrMergeCommentEnabled(ws, 'team-a', false);
  assert.equal(cfg.isPrMergeCommentEnabled(ws, 'team-a'), false);
});

test('only strict boolean true enables (truthy strings do not)', () => {
  const ws = tmpWorkspace();
  const p = path.join(ws, 'teams', 'team-a', 'token-telemetry-config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ prMergeComment: 'yes' }));
  assert.equal(cfg.isPrMergeCommentEnabled(ws, 'team-a'), false);
});

test('a write preserves sibling keys already in the file', () => {
  const ws = tmpWorkspace();
  const p = path.join(ws, 'teams', 'team-a', 'token-telemetry-config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ other: 1 }));
  const next = cfg.setPrMergeCommentEnabled(ws, 'team-a', true);
  assert.equal(next.other, 1);
  assert.equal(next.prMergeComment, true);
});

test('unsafe team id: read is OFF, write throws', () => {
  const ws = tmpWorkspace();
  assert.equal(cfg.isPrMergeCommentEnabled(ws, '../evil'), false);
  assert.throws(() => cfg.setPrMergeCommentEnabled(ws, '../evil', true), /unsafe team id/);
});

test('corrupt config file reads as OFF, never throws', () => {
  const ws = tmpWorkspace();
  const p = path.join(ws, 'teams', 'team-a', 'token-telemetry-config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ not json');
  assert.equal(cfg.isPrMergeCommentEnabled(ws, 'team-a'), false);
});
