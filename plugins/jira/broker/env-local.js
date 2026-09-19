'use strict';

// ─── jira broker: gitignored broker/.env.local loader (spike diagnostics) ────
//
// Since Phase 1 the real credential is the orchestrator-pushed per-scope map
// (server.js), NOT env. This loader is now only for `spike.js` — its `probe` /
// `raw` / `whoami-jira` commands hit Jira by hand and read the credential from
// `broker/.env.local` (`KEY=VALUE`, gitignored).
//
// `parseEnvLocal` is pure (unit-tested in env-local.test.js): it skips blank
// lines and `#` comments, strips an inline `# comment` after an UNQUOTED value
// (the thing that bit the first smoke test), honours single/double quotes and an
// optional `export ` prefix.

const fs = require('fs');
const path = require('path');

function parseEnvLocal(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val[0] === '"' || val[0] === "'") {
      const end = val.indexOf(val[0], 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash);
      val = val.trim();
    }
    if (val) out[m[1]] = val;
  }
  return out;
}

// Read `<dir>/.env.local` and set any KEY not already in process.env. Absent
// file is normal (a real deployment has none).
function loadEnvLocal(dir) {
  try {
    const parsed = parseEnvLocal(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return parsed;
  } catch {
    return {};
  }
}

module.exports = { parseEnvLocal, loadEnvLocal };
