/**
 * Un-crashable markdown containment (#1974 follow-up).
 *
 * The bug this exists to end: `SafeMarkdown`/`SkillMarkdown` used to catch a
 * markdown-pipeline throw and fall back to a GFM-only render — but GFM-only
 * shares the same remark/rehype parse path, so when THAT threw too (a
 * `mdast-util-to-hast` "Cannot use 'in' operator to search for 'children' in
 * undefined" on one message), the boundary re-rendered the very fallback it had
 * just seen throw. Its `fallback:true` state never advanced, so React kept
 * catching → re-rendering → catching until it bailed with error #185 (max
 * update depth). That loop escaped the per-row `EventErrorBoundary` and took
 * down the whole Agent Chat page. Every prior fix chased "which message body
 * breaks the parser"; the real defect was that the fallback could itself throw.
 *
 * The fix here is structural, not per-trigger: a boundary whose fallback is
 * INFALLIBLE. `MarkdownSafeBoundary` renders `primary()`; on any throw it
 * switches — permanently, monotonically — to `fallback()`. Call sites nest two
 * of them so the tiers are `full pipeline → GFM-only → plain text`, and the
 * innermost fallback is always `plainTextFallback` (which touches nothing in
 * the markdown pipeline and cannot throw). Because every boundary's fallback is
 * either plain text or a nested boundary that resolves to plain text, no
 * boundary ever re-renders a child it already knows throws — so the #185 loop
 * is impossible regardless of what content or dependency version triggers the
 * original parse error.
 *
 * Authored JSX-free (`React.createElement`) for the same reason as
 * `ErrorBoundary.js`: this is safety-critical, so `node --test` must be able to
 * import and exercise the real class (`markdown-safe.test.js`).
 */

import React from 'react';

const h = React.createElement;

/**
 * A two-tier render boundary: render `primary()`; on ANY throw during that
 * render, switch permanently to `fallback()`.
 *
 * Contract enforced by the call sites: `fallback()` MUST be infallible, OR must
 * itself be a nested `MarkdownSafeBoundary` whose own fallback is
 * (transitively) infallible. Under that rule every fallback resolves to a
 * plain-text render that cannot throw.
 *
 * Deliberately a boolean, NOT a tier counter: React calls
 * `getDerivedStateFromError` on every throw but never hands it the previous
 * state, and `componentDidCatch` (which could read it) is a commit-phase
 * callback that never fires while a fallback keeps throwing before it can
 * commit. A boolean whose fallback is infallible needs neither — one throw, one
 * permanent switch to a render that is guaranteed not to throw again.
 *
 * @param {object} props
 * @param {() => import('react').ReactNode} props.primary   Rich render (may throw).
 * @param {() => import('react').ReactNode} props.fallback  Infallible-or-nested fallback.
 * @param {(err: unknown) => void} [props.onError]          Optional dev-console notice.
 */
export class MarkdownSafeBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    if (typeof this.props.onError === 'function') this.props.onError(err);
  }
  render() {
    return this.state.failed ? this.props.fallback() : this.props.primary();
  }
}

/**
 * The guaranteed floor under every markdown render: plain text.
 *
 * Preserves newlines (`white-space: pre-wrap`), wraps long unbroken tokens, and
 * coerces a non-string body with `String()` so even a malformed payload renders
 * as readable text. It touches nothing in the markdown/remark/rehype pipeline,
 * so it cannot throw — which is what makes it a valid `fallback()` for the
 * innermost `MarkdownSafeBoundary`.
 *
 * @param {unknown} body
 * @returns {import('react').ReactElement}
 */
export function plainTextFallback(body) {
  return h(
    'div',
    {
      className: 'agent-chat-md-plain',
      style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' },
    },
    String(body ?? ''),
  );
}
