#!/usr/bin/env node
'use strict';

// The seed-path checks now live next to the code they test: the per-agent MCP
// materialization moved out of orchestrator.js into orchestrator/mcp-seed.js
// (#2289), which is requireable, so its behaviour is covered by the ordinary
// node:test suite (orchestrator/mcp-seed.test.js, run by `npm test` in CI).
// This script keeps run-all.sh's entry point and just runs that suite.

const { spawnSync } = require('child_process');
const path = require('path');

const orchestratorDir = path.resolve(__dirname, '..', '..', 'orchestrator');
const r = spawnSync(process.execPath, ['--test', 'mcp-seed.test.js'], { cwd: orchestratorDir, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
