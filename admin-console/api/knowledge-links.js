'use strict';

// Knowledge provenance / feed pure helpers (Shared Agent Learning, Phase 2).
//
// The pure, unit-tested cores behind the Knowledge Flow routes:
//   - buildSourceRefUrl — a KB entry's sourceRef ({kind, ref}) + the env's repo
//     URL → a GitHub web URL, so the provenance drill-down lands on the exact
//     PR/issue/commit the agent produced (where gh-as-agent attribution lives).
//   - buildSessionDeepLink — a deep link into the existing chat/session-log panel
//     for an agent, optionally focusing a room + highlighting a correlationId row.
//     (The IO of discovering WHICH room holds the correlationId lives in the
//     route; this builds the link from the resolved parts.)
//   - matchesScope — the SSE filter predicate: does a feed event belong to the
//     requested scope (agent/team/global)?
//   - shouldRefresh — the per-team canonical-clone refresh throttle predicate.
//
// No fs / no network — repo convention: test pure cores only.

// ---------------------------------------------------------------------------
// Source-ref → GitHub URL
// ---------------------------------------------------------------------------

// Normalize any git remote form (https, scp-like git@host:owner/repo, ssh://)
// to its web base https://host/owner/repo (no trailing .git). null if unparsable.
function repoWebBase(repoUrl) {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') return null;
  const u = repoUrl.trim();
  const clean = (host, pathPart) => `https://${host}/${pathPart.replace(/\.git$/, '').replace(/\/+$/, '')}`;

  // ssh://git@host[:port]/owner/repo(.git)
  let m = u.match(/^ssh:\/\/[^@]+@([^/:]+)(?::\d+)?\/(.+)$/);
  if (m) return clean(m[1], m[2]);

  // http(s)://host/owner/repo(.git)
  m = u.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (m) return clean(m[1], m[2]);

  // scp-like: git@github.com:owner/repo(.git) — only when there's no scheme.
  if (!u.includes('://')) {
    m = u.match(/^[^@\s]+@([^:/\s]+):(.+)$/);
    if (m) return clean(m[1], m[2]);
  }

  return null;
}

// Map a sourceRef to a browsable URL. Returns null for an unknown kind, a
// missing repo base (for repo-relative kinds), or a malformed ref.
function buildSourceRefUrl(sourceRef, repoUrl) {
  if (!sourceRef || typeof sourceRef !== 'object') return null;
  const kind = sourceRef.kind;
  const ref = typeof sourceRef.ref === 'string' ? sourceRef.ref.trim() : '';
  if (ref === '') return null;

  // `url` carries an absolute link directly; no repo needed.
  if (kind === 'url') {
    return /^https?:\/\//i.test(ref) ? ref : null;
  }

  const base = repoWebBase(repoUrl);
  if (!base) return null;
  switch (kind) {
    case 'pr':
      return `${base}/pull/${encodeURIComponent(ref)}`;
    case 'issue':
      return `${base}/issues/${encodeURIComponent(ref)}`;
    case 'commit':
      return `${base}/commit/${encodeURIComponent(ref)}`;
    case 'branch':
      return `${base}/tree/${encodeURIComponent(ref)}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Session deep-link
// ---------------------------------------------------------------------------

// Build the deep link into the agent chat + session-log panel. `roomId` and
// `correlationId` are optional — with them the UI focuses the room and
// highlights the originating run; without a room it just opens the agent chat.
function buildSessionDeepLink({ agentId, roomId = null, correlationId = null } = {}) {
  if (typeof agentId !== 'string' || agentId.trim() === '') return null;
  const id = agentId.trim();
  const link = {
    agentId: id,
    roomId: roomId || null,
    correlationId: correlationId || null,
  };
  let href = `/chats/${encodeURIComponent(id)}`;
  const qs = [];
  if (roomId) qs.push(`room=${encodeURIComponent(roomId)}`);
  if (correlationId) qs.push(`highlight=${encodeURIComponent(correlationId)}`);
  if (qs.length) href += `?${qs.join('&')}`;
  link.href = href;
  return link;
}

// ---------------------------------------------------------------------------
// SSE scope filter
// ---------------------------------------------------------------------------

// Does a feed event belong to the requested scope? Control frames (type
// starting with `_`, e.g. _cursor/_truncated) always pass. global sees all
// harvests; team:<id> matches on teamId; agent:<id> matches on agentId.
function matchesScope(event, scope) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.type === 'string' && event.type.startsWith('_')) return true;

  const s = typeof scope === 'string' ? scope.trim() : '';
  if (s === '' || s === 'global') return true;
  if (s.startsWith('team:')) {
    const teamId = s.slice('team:'.length).trim();
    return event.teamId === teamId;
  }
  if (s.startsWith('agent:')) {
    const agentId = s.slice('agent:'.length).trim();
    return event.agentId === agentId;
  }
  return true; // unknown scope → treat as global
}

// ---------------------------------------------------------------------------
// Refresh throttle
// ---------------------------------------------------------------------------

// Should the canonical clone be refreshed? True when never refreshed or when at
// least `minMs` has elapsed. Tolerant of a missing/garbage lastAt (→ refresh).
function shouldRefresh(lastAt, now = Date.now(), minMs = 30_000) {
  const last = typeof lastAt === 'number' ? lastAt : Date.parse(lastAt);
  if (!Number.isFinite(last)) return true;
  const n = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(n)) return true;
  return n - last >= minMs;
}

module.exports = {
  repoWebBase,
  buildSourceRefUrl,
  buildSessionDeepLink,
  matchesScope,
  shouldRefresh,
};
