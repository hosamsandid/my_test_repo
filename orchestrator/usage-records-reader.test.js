'use strict';

// Run: node --test orchestrator/usage-records-reader.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('readJsonlDir reads matching day files, skips others + corrupt lines', () => {
  const { readJsonlDir } = require('./usage-records-reader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-usage-'));
  fs.writeFileSync(path.join(dir, 'usage-2026-07-15.jsonl'), '{"a":1}\n{"a":2}\n');
  fs.writeFileSync(path.join(dir, 'usage-2026-07-16.jsonl'), '{"a":3}\n\nnot-json\n{"a":4}\n');
  fs.writeFileSync(path.join(dir, 'pr-events-2026-07-16.jsonl'), '{"b":1}\n'); // wrong pattern -> ignored
  const recs = readJsonlDir(dir, /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.deepEqual(recs.map((r) => r.a), [1, 2, 3, 4]);
});

test('readJsonlDir returns [] for a missing directory', () => {
  const { readJsonlDir } = require('./usage-records-reader');
  assert.deepEqual(readJsonlDir('/no/such/dir/xyz', /.*/), []);
});

test('readUsageRecords + readPrEvents honour their env-configured dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-usage-env-'));
  fs.writeFileSync(path.join(dir, 'usage-2026-07-16.jsonl'), '{"ts":"2026-07-16T00:00:00Z","agentId":"a"}\n');
  fs.writeFileSync(path.join(dir, 'pr-events-2026-07-16.jsonl'), '{"kind":"pr-created","prNumber":1}\n');
  // Load with the env pointing at our temp dir (both readers default USAGE/PR dirs to it).
  const prev = process.env.USAGE_LOG_DIR;
  process.env.USAGE_LOG_DIR = dir;
  delete require.cache[require.resolve('./usage-log')];
  delete require.cache[require.resolve('./pr-events-log')];
  delete require.cache[require.resolve('./usage-records-reader')];
  try {
    const reader = require('./usage-records-reader');
    assert.equal(reader.readUsageRecords().length, 1);
    assert.equal(reader.readPrEvents().length, 1);
    assert.equal(reader.readPrEvents()[0].kind, 'pr-created');
  } finally {
    if (prev === undefined) delete process.env.USAGE_LOG_DIR; else process.env.USAGE_LOG_DIR = prev;
    delete require.cache[require.resolve('./usage-log')];
    delete require.cache[require.resolve('./pr-events-log')];
    delete require.cache[require.resolve('./usage-records-reader')];
  }
});
