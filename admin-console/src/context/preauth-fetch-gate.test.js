// ─── Pre-auth fetch gate wiring guard (#2616) ────────────────────────────────
//
// The app-level providers below are mounted in index.jsx ABOVE App's auth gate,
// so they render on the login screen too. Each one reads a session-protected
// endpoint; fetching on mount regardless of auth state produced a 401 (and a
// "Failed to load resource" console error) on every login-page visit.
//
// There is no JSX test renderer yet (#651), so this reads the real sources and
// asserts the wiring: every such provider takes `authenticated` from useAuth,
// bails out of its fetch effect while it is false, and re-runs the effect when
// it changes. The matchers are also run over synthetic sources so a broken
// matcher fails loudly instead of passing vacuously.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// The provider files and the protected endpoint each one fetches.
const GATED = [
  ['HelperChatContext.jsx', '/api/helper/page-help'],
  ['AgentStatusesContext.jsx', '/api/agents/statuses'],
  ['MaintenanceModeContext.jsx', '/api/maintenance-mode'],
];

// The useEffect(...) block that contains `endpoint`, from `useEffect(` up to
// and including its dependency array. null when the endpoint is not fetched
// inside a useEffect.
function effectFor(src, endpoint) {
  const at = src.indexOf(`'${endpoint}'`);
  if (at < 0) return null;
  const start = src.lastIndexOf('useEffect(', at);
  if (start < 0) return null;
  const end = src.indexOf('}, [', at);
  if (end < 0) return null;
  const close = src.indexOf(']', end);
  return src.slice(start, close + 1);
}

function isAuthGated(src, endpoint) {
  const s = stripComments(src);
  if (!/const\s*\{[^}]*\bauthenticated\b[^}]*\}\s*=\s*useAuth\(\)/.test(s)) return false;
  const effect = effectFor(s, endpoint);
  if (!effect) return false;
  const bailsOut = /if\s*\(\s*!authenticated\s*\)/.test(effect)
    && effect.indexOf('!authenticated') < effect.indexOf(`'${endpoint}'`);
  const deps = effect.slice(effect.lastIndexOf('}, ['));
  return bailsOut && /\bauthenticated\b/.test(deps);
}

test('matcher: accepts a gated effect and rejects the ungated shapes', () => {
  const gated = `
    const { authenticated } = useAuth();
    useEffect(() => {
      if (!authenticated) return undefined;
      fetch('/api/x');
    }, [authenticated]);`;
  assert.equal(isAuthGated(gated, '/api/x'), true);

  const ungated = `
    useEffect(() => {
      fetch('/api/x');
    }, []);`;
  assert.equal(isAuthGated(ungated, '/api/x'), false);

  const noDep = gated.replace('}, [authenticated]);', '}, []);');
  assert.equal(isAuthGated(noDep, '/api/x'), false);

  const noBail = gated.replace('if (!authenticated) return undefined;', '');
  assert.equal(isAuthGated(noBail, '/api/x'), false);

  const commentedOut = gated.replace('const { authenticated } = useAuth();', '// const { authenticated } = useAuth();');
  assert.equal(isAuthGated(commentedOut, '/api/x'), false);
});

for (const [file, endpoint] of GATED) {
  test(`${file} fetches ${endpoint} only once authenticated`, () => {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.ok(src.includes(`'${endpoint}'`), `${file} no longer fetches ${endpoint} — update this guard`);
    assert.ok(isAuthGated(src, endpoint),
      `${file} must skip the ${endpoint} fetch while !authenticated and re-run on [authenticated] (#2616)`);
  });
}
