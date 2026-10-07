/**
 * Synchronous Shiki rehype plugin — replaces rehype-pretty-code to fix the
 * runSync/async-transformer incompatibility with react-markdown@9 (#1857).
 *
 * rehype-pretty-code's transformer is declared `async function`, so unified's
 * runSync (used internally by react-markdown@9) throws even when the Shiki
 * highlighter is already loaded. We bypass this by calling codeToHast()
 * directly — which IS synchronous once the highlighter is initialized — in a
 * plain synchronous rehype transformer.
 *
 * Shiki is loaded LAZILY (#2918): nothing imports `shiki` statically, so pages
 * that never render a fenced code block download no grammar, theme or WASM.
 * The first code block this plugin sees kicks off `import('shiki')` and a
 * highlighter with NO preloaded languages; each block's grammar is then loaded
 * on demand via `loadLanguage`. Until the highlighter (or that block's grammar)
 * is ready, the block passes through as plain <pre><code> (graceful
 * degradation). Every time something new becomes ready the store version bumps
 * (`subscribeShiki` / `shikiVersion`), so a mounted renderer can re-render and
 * upgrade its plain blocks. Once loaded, every rehypeShikiSync() call completes
 * synchronously with no async behaviour.
 *
 * Output format: Shiki dual-theme (github-light / github-dark). The transformer
 * below adds `data-theme="github-light github-dark"` to <pre> and <code> so the
 * existing tokens.css selectors (`pre[data-theme*=' ']`, `code[data-theme*=' ']`)
 * pick up the correct CSS variables for the active admin-console theme.
 */

import { visit } from 'unist-util-visit';

const THEMES = { light: 'github-light', dark: 'github-dark' };
const DUAL_THEME_VALUE = `${THEMES.light} ${THEMES.dark}`;

// Shiki's built-in plain-text ids — they need no grammar, so a block in one of
// them highlights as soon as the highlighter itself exists.
const PLAIN_LANGS = new Set(['plaintext', 'text', 'txt', 'plain']);

let _hl = null;
let _bundled = null;     // shiki's bundledLanguages map (ids + aliases)
let _loading = null;     // the in-flight highlighter promise, once started
const _pendingLangs = new Set();

// A tiny external store so renderers can re-render when the highlighter or a
// grammar finishes loading (useSyncExternalStore(subscribeShiki, shikiVersion)).
let _version = 0;
const _listeners = new Set();
function bump() {
  _version += 1;
  for (const fn of _listeners) fn();
}
export function subscribeShiki(fn) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
export function shikiVersion() {
  return _version;
}

function ensureHighlighter() {
  if (_loading) return;
  _loading = import('shiki')
    .then(({ createHighlighter, bundledLanguages }) => {
      _bundled = bundledLanguages;
      return createHighlighter({ themes: Object.values(THEMES), langs: [] });
    })
    .then((h) => { _hl = h; bump(); })
    // Defense-in-depth: a failed chunk/WASM load degrades to plain
    // <pre><code> instead of an unhandled rejection.
    .catch(() => { _hl = null; });
}

// Adds data-theme to <pre> and <code> so tokens.css dual-theme selectors match.
const DATA_THEME_TRANSFORMER = {
  pre(node) { node.properties['data-theme'] = DUAL_THEME_VALUE; },
  code(node) { node.properties['data-theme'] = DUAL_THEME_VALUE; },
};

export function rehypeShikiSync() {
  return (tree) => {
    if (!_hl) {
      // Not loaded yet — code blocks pass through as plain pre/code. Only a
      // tree that actually holds a code block starts the (one-time) load.
      if (!_loading && hasCodeBlock(tree)) ensureHighlighter();
      return;
    }

    // `visit` walks the whole hast tree, and unist-util-visit throws
    // "Cannot use 'in' operator to search for 'children' in undefined" the
    // moment ANY children array holds an `undefined` hole — a shape the parse of
    // certain message bodies can produce. react-markdown's own renderer tolerates
    // such a tree (the GFM-only tier proves it), so this traversal is the ONLY
    // thing that turns it into a throw; without this guard the whole full-pipeline
    // render fails and, because the transcript re-renders on every SSE tick /
    // poll / virtual-list remount, re-throws and re-logs on each pass (the
    // "permanent" console errors). Catch it and leave code un-highlighted — the
    // message still renders fully. See markdown-safe.js for the outer floor.
    try {
      visit(tree, 'element', (node, index, parent) => {
        if (node.tagName !== 'pre' || !parent || index == null) return;
        const codeEl = node.children?.[0];
        if (!codeEl || codeEl.tagName !== 'code') return;

        const src = textContent(codeEl);
        const resolvedLang = resolveLang(extractLang(codeEl));

        try {
          const root = _hl.codeToHast(src, {
            lang: resolvedLang,
            themes: THEMES,
            defaultColor: false,
            transformers: [DATA_THEME_TRANSFORMER],
          });
          const pre = root.children?.[0];
          if (pre) parent.children[index] = pre;
        } catch {
          // leave original node as-is
        }
      });
    } catch {
      // Malformed tree (e.g. an undefined child) — leave code blocks
      // un-highlighted; react-markdown still renders the message.
    }
  };
}

/**
 * Resolve a fenced-code language to one Shiki has loaded, else 'plaintext',
 * kicking off a background load of that grammar (bump() re-renders once ready).
 *
 * Only languages in Shiki's bundle are loaded: `loadLanguage()` throws
 * SYNCHRONOUSLY for an unbundled one (e.g. `jcl` on this Mainframe stack —
 * Shiki ships `cobol` but not `jcl`), which once escaped the codeToHast
 * try/catch and took down the entire full-markdown render. The call stays
 * guarded as defense-in-depth.
 */
function resolveLang(lang) {
  if (!lang || PLAIN_LANGS.has(lang)) return 'plaintext';
  if (_hl.getLoadedLanguages().includes(lang)) return lang;
  if (_bundled && Object.hasOwn(_bundled, lang) && !_pendingLangs.has(lang)) {
    _pendingLangs.add(lang);
    try {
      _hl.loadLanguage(lang).then(bump, () => {});
    } catch {
      // unbundled language — stays plaintext
    }
  }
  return 'plaintext';
}

// Whether the hast tree holds a <pre> at all (cheap pre-check before loading).
function hasCodeBlock(tree) {
  let found = false;
  try {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'pre') { found = true; return false; }
      return undefined;
    });
  } catch {
    // Malformed tree — treat as no code block.
  }
  return found;
}

function extractLang(codeEl) {
  // remark-rehype stores the fenced-code language in properties.className
  const cls = codeEl?.properties?.className ?? [];
  const arr = Array.isArray(cls) ? cls : [cls];
  const match = arr.find(c => typeof c === 'string' && c.startsWith('language-'));
  return match ? match.slice('language-'.length) : null;
}

function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  if (Array.isArray(node.children)) return node.children.map(textContent).join('');
  return '';
}
