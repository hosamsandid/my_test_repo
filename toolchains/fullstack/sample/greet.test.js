'use strict';

// Runs under `node --test` (Node's built-in runner, no dependency) to prove the
// fullstack toolchain's Node half works: the pinned Node resolves and runs a
// test file. Reports the major version it ran on, the Node counterpart of
// SampleTest's AEE_TOOLCHAIN_JAVA_FEATURE line.
const { test } = require('node:test');
const assert = require('node:assert');
const { greet } = require('./greet');

test('greets by name', () => {
  assert.strictEqual(greet('world'), 'hello, world');
});

test('reports the running Node version', () => {
  const major = process.versions.node.split('.')[0];
  console.log(`AEE_TOOLCHAIN_NODE_MAJOR=${major}`);
  assert.ok(Number(major) >= 18, `expected a modern Node, got ${major}`);
});
