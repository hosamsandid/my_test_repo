// GitHub API base seam (#710, docs/journey-spec-concept.md §6.1).
//
// The Events-API host is hardcoded to `api.github.com` in the poller today.
// This module introduces the ONE product change J5 needs: a `GITHUB_API_BASE`
// env (default `https://api.github.com`) so the E2E stack can point the poller
// at the in-stack `fake-github` service. When the env is absent the resolved
// target is byte-identical to today's production behaviour — same host, same
// (empty) path prefix, same `https` transport.
//
// Pure + fs-free so it is trivially unit-testable (`node --test`). The only
// runtime dependency is picking the right transport module (http for the fake
// server over plain HTTP, https for production).
const http = require('http');
const https = require('https');

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

// The configured API base origin, trailing slash stripped. Reads the env at
// call time (not module load) so tests can flip it per-case.
function githubApiBase(env = process.env) {
  const raw = (env && env.GITHUB_API_BASE) || DEFAULT_GITHUB_API_BASE;
  return String(raw).replace(/\/+$/, '');
}

// Resolve a base URL into the pieces `https.request`/`http.request` need.
// `basePath` is any path prefix on the base (e.g. a base of
// `http://fake-github/gh` yields basePath `/gh`); production's bare origin
// yields `''`. `transport` is the matching core module. Throws on a
// syntactically invalid base so a misconfiguration fails loudly at startup
// rather than silently dialling the wrong place.
function resolveGithubApiTarget(base = githubApiBase()) {
  const u = new URL(base);
  const isHttp = u.protocol === 'http:';
  if (!isHttp && u.protocol !== 'https:') {
    throw new Error(`GITHUB_API_BASE must be http(s): got "${base}"`);
  }
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    // `''` (falsy) when no explicit port — request() then uses the protocol
    // default (443/80), matching production where no port is set.
    port: u.port || undefined,
    // Strip a trailing slash so callers can concatenate `/repos/...` cleanly.
    basePath: u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''),
    transport: isHttp ? http : https,
  };
}

module.exports = { githubApiBase, resolveGithubApiTarget, DEFAULT_GITHUB_API_BASE };
