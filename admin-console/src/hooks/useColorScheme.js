import { useEffect, useState } from 'react';

/**
 * Resolve the active admin-console color scheme to either `'dark'` or `'light'`.
 *
 * Source of truth is `document.documentElement.dataset.theme`:
 *   - `admin-dark`     → 'dark'
 *   - `admin-light`    → 'light'
 *   - `high-contrast`  → 'dark'  (sits on a black background)
 *   - missing / other  → falls back to `prefers-color-scheme`
 *
 * The hook subscribes via a `MutationObserver` on the `<html>` `data-theme`
 * attribute so that components re-render in lockstep when the user toggles
 * themes elsewhere in the app. As a secondary signal it also watches
 * `prefers-color-scheme` for the unset case.
 *
 * Note: this hook intentionally has no consumer-visible side effects beyond
 * the returned scheme — components like Message.jsx use it only to drive
 * presentation (e.g. picking a Shiki theme to *prefer*; the dual-theme CSS
 * in tokens.css does the actual switching).
 *
 * @returns {'dark' | 'light'}
 */
export function useColorScheme() {
  const [scheme, setScheme] = useState(() => readScheme());

  useEffect(() => {
    const root = document.documentElement;

    function refresh() {
      setScheme(readScheme());
    }

    const obs = new MutationObserver(refresh);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    // Also react to prefers-color-scheme changes when no explicit theme
    // attribute is set on <html>.
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    if (mq) {
      // addEventListener supersedes the legacy addListener but we keep both
      // for older Safari.
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', refresh);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(refresh);
      }
    }

    return () => {
      obs.disconnect();
      if (mq) {
        if (typeof mq.removeEventListener === 'function') {
          mq.removeEventListener('change', refresh);
        } else if (typeof mq.removeListener === 'function') {
          mq.removeListener(refresh);
        }
      }
    };
  }, []);

  return scheme;
}

function readScheme() {
  if (typeof document === 'undefined') return 'dark';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'admin-light') return 'light';
  if (explicit === 'admin-dark') return 'dark';
  if (explicit === 'high-contrast') return 'dark';
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

export default useColorScheme;
