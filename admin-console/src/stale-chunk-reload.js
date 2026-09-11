// Recover an already-open tab after the SPA has been rebuilt/redeployed.
//
// Vite content-hashes every lazy page chunk (`AgentChat-<hash>.js`, …). When the
// server is redeployed those hashes change, but a tab opened BEFORE the rebuild
// still holds the old `index-<hash>.js` naming the OLD chunk hashes. The next
// route that lazy-imports a page then requests a filename that no longer exists;
// the SPA server answers the `index.html` fallback (HTTP 200, wrong MIME), and
// the dynamic `import()` rejects with "Failed to fetch dynamically imported
// module". Symptoms an operator sees: an opaque page crash, plus a burst of
// stray `*.js`/`*.md` requests coming back as HTML (404/415) and suspended SSE
// streams — all because the tab is running code the server no longer serves.
//
// Vite fires a `vite:preloadError` event for exactly this; some browsers only
// surface the generic promise rejection. Either way the correct recovery is a
// single full reload, which re-fetches the CURRENT index and its current chunk
// hashes. The one hazard is a reload LOOP when the failure is not actually
// staleness (the server is genuinely down): guard with a short cooldown
// persisted across the reload so we attempt recovery at most once per window.

export const RELOAD_COOLDOWN_MS = 10_000;
export const RELOAD_MARK_KEY = 'staleChunkReload.at';

// The messages browsers use when a dynamically imported module fails to load.
// Kept as substrings — the exact wording varies by engine and carries the URL.
export const STALE_CHUNK_MESSAGES = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  'Unable to preload CSS',
];

// Does this rejection/error reason look like a stale-chunk load failure?
export function isStaleChunkError(reason) {
  const msg =
    typeof reason === 'string'
      ? reason
      : (reason && (reason.message || reason.value?.message)) || '';
  return STALE_CHUNK_MESSAGES.some((m) => msg.includes(m));
}

// Reload at most once per `cooldownMs` so a truly broken server cannot loop the
// tab. `lastReloadAt` is the persisted timestamp of the previous recovery
// reload (0 / null / NaN when none).
export function shouldReloadForChunkError({ now, lastReloadAt, cooldownMs = RELOAD_COOLDOWN_MS }) {
  const last = Number(lastReloadAt);
  if (!last) return true;
  return now - last >= cooldownMs;
}
