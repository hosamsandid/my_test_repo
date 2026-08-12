'use strict';

// ─── gke-broker kubectl client (READ-ONLY) ──────────────────────────────────
//
// The privilege boundary for the GKE plugin. The agent CLI (aee-gke) forwards a
// kubectl arg-vector; this module is the server-side gate that decides whether
// it may run, then executes it with the broker-held bearer token injected.
//
// Two defenses, both here (never in the agent CLI, which is a privilege-less
// client — everything it can do it could do with curl, concept §3):
//   1. VERB ALLOWLIST — only read verbs run. No apply/create/delete/patch/edit/
//      scale/exec/attach/cp/port-forward/proxy/etc. This is the read-only pilot.
//   2. FLAG DENYLIST  — the agent may not override identity/endpoint/credential
//      (--server/--token/--kubeconfig/--as impersonation/client certs), which
//      would let it point kubectl elsewhere or escalate.
//
// `buildReadArgs` is pure (unit-testable, no spawn); `runKubectl` is the thin
// impure exec around it.

const { spawnSync } = require('child_process');

// Read-only kubectl verbs. Mirrors the CLI's friendly allowlist, but THIS is
// the security gate — the CLI's is only an early exit.
const READ_VERBS = new Set([
  'get', 'describe', 'logs', 'api-resources', 'api-versions',
  'top', 'explain', 'version', 'cluster-info',
]);

// Flags an agent must never set — they would repoint kubectl at another
// endpoint/identity or impersonate. `--server`/`--token` are injected by us.
const DENIED_FLAG_PREFIXES = [
  '--server', '--token', '--kubeconfig', '--as', '--as-group', '--as-uid',
  '--client-certificate', '--client-key', '--certificate-authority',
  '--username', '--password', '--tls-server-name', '--insecure-skip-tls-verify',
];

// Validate + normalise the agent-supplied argv into a safe kubectl arg-vector.
// Throws Error(message) on any policy violation. Does NOT append --server/--token
// (the caller injects those with the live bearer so the token never appears in a
// thrown message or a cached args array).
function buildReadArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('empty command');
  }
  const verb = String(argv[0] || '');
  if (!READ_VERBS.has(verb)) {
    throw new Error(
      `refused: '${verb}' is not a read verb (read-only plugin). Allowed: ` +
      `${[...READ_VERBS].sort().join(', ')}`,
    );
  }
  for (const raw of argv) {
    const tok = String(raw);
    const flag = tok.split('=', 1)[0].toLowerCase();
    if (DENIED_FLAG_PREFIXES.includes(flag)) {
      throw new Error(`refused: flag '${flag}' may not be set by the agent`);
    }
  }
  return argv.map(String);
}

// Run one read-only kubectl call. `server` is the Connect Gateway URL; `token`
// is the current OAuth bearer (broker-held). Returns { ok, output } — output is
// stdout on success, stderr on failure. Never throws for a kubectl domain error
// (a missing namespace is a normal failure the agent should see); throws only on
// a policy violation (via buildReadArgs) which the caller turns into isError.
function runKubectl(argv, { server, token, timeoutMs = 25000 }) {
  const safe = buildReadArgs(argv);
  const args = [
    ...safe,
    '--server', server,
    '--token', token,
    '--request-timeout=20s',
  ];
  const res = spawnSync('kubectl', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    // No KUBECONFIG in the container → kubectl builds an in-memory config from
    // the flags alone; the public Google cert validates against system roots.
    env: { ...process.env, KUBECONFIG: '' },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, output: `kubectl failed to run: ${res.error.message}` };
  }
  if (res.status === 0) {
    return { ok: true, output: res.stdout || '' };
  }
  return { ok: false, output: (res.stderr || res.stdout || `kubectl exited ${res.status}`).trim() };
}

module.exports = { READ_VERBS, DENIED_FLAG_PREFIXES, buildReadArgs, runKubectl };
