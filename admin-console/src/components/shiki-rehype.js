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
 * The module-level createHighlighter() call fires once at import time. Until
 * it resolves, code blocks pass through as plain <pre><code> (graceful
 * degradation). After that, every rehypeShikiSync() call completes synchronously
 * with no async behaviour.
 *
 * Output format: Shiki dual-theme (github-light / github-dark). The transformer
 * below adds `data-theme="github-light github-dark"` to <pre> and <code> so the
 * existing tokens.css selectors (`pre[data-theme*=' ']`, `code[data-theme*=' ']`)
 * pick up the correct CSS variables for the active admin-console theme.
 */

import { createHighlighter } from 'shiki';
import { visit } from 'unist-util-visit';

const THEMES = { light: 'github-light', dark: 'github-dark' };
const DUAL_THEME_VALUE = `${THEMES.light} ${THEMES.dark}`;

const PRELOAD_LANGS = [
  'plaintext', 'text',
  'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx',
  'python', 'py', 'bash', 'sh', 'shell', 'zsh',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'dotenv',
  'markdown', 'md', 'html', 'css', 'scss', 'less',
  'sql', 'java', 'go', 'rust', 'ruby', 'rb', 'php',
  'c', 'cpp', 'csharp', 'cs', 'xml', 'diff',
  // 'jcl' is NOT a bundled Shiki language (v1.29.2 only ships 'cobol'), so
  // listing it here rejected createHighlighter — which left _hl null (ALL code
  // blocks silently un-highlighted) AND fired an unhandled rejection surfacing
  // as a page error. A ```jcl block still degrades to plaintext at render time
  // (see resolvedLang below), so nothing is lost by omitting it.
  'cobol',
];

let _hl = null;
createHighlighter({ themes: Object.values(THEMES), langs: PRELOAD_LANGS })
  .then(h => { _hl = h; })
  // Defense-in-depth: if any preload language is unavailable in a future Shiki
  // bump, degrade to plain <pre><code> instead of an unhandled rejection.
  .catch(() => { _hl = null; });

// Adds data-theme to <pre> and <code> so tokens.css dual-theme selectors match.
const DATA_THEME_TRANSFORMER = {
  pre(node) { node.properties['data-theme'] = DUAL_THEME_VALUE; },
  code(node) { node.properties['data-theme'] = DUAL_THEME_VALUE; },
};

export function rehypeShikiSync() {
  return (tree) => {
    if (!_hl) return; // not yet loaded — code blocks pass through as plain pre/code

    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index == null) return;
      const codeEl = node.children?.[0];
      if (!codeEl || codeEl.tagName !== 'code') return;

      const lang = extractLang(codeEl);
      const src = textContent(codeEl);

      // Kick off background load for unrecognised languages; fall back to plaintext.
      const resolvedLang =
        !lang || !_hl.getLoadedLanguages().includes(lang)
          ? (lang ? void _hl.loadLanguage(lang).catch(() => {}) : null, 'plaintext')
          : lang;

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
  };
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
