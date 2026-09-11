// Pure, JSX-free model for the Session Log's generic tool Input/Result
// renderer (#2197) — the fallback every tool call hits unless it has its own
// bespoke render (task-tracking tools via task-todo.js, Edit/Write via
// edit-diff.js, task_updated/task_notification via system-event.js). Turns an
// arbitrary JS value into a flat, depth-tagged list of rows a JSX renderer can
// walk to produce an indented key/value list with no raw JSON punctuation —
// unquoted keys, one field per line, nested objects/arrays indented
// recursively, and multi-line/markdown-like string leaves flagged so the
// caller can render real line breaks / SafeMarkdown instead of an escaped
// one-line JSON string.

// Defensive caps so a pathological payload (a huge array, a giant blob) can't
// blow up the DOM — mirrors the RESULT_MAX truncation the old JSON.stringify
// dump relied on, just applied per-array and per-leaf instead of to the whole
// serialized blob.
const MAX_ARRAY_ITEMS = 200;
const MAX_LEAF_LEN = 4000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// A conservative "reads like markdown" heuristic — code fences, headings,
// bullet/numbered/quote lines, or inline bold/links. Deliberately permissive:
// a false positive just renders plain text through SafeMarkdown, which is a
// no-op for text with no markdown syntax in it.
const MARKDOWN_PATTERN = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/;

export function looksLikeMarkdown(s) {
  return typeof s === 'string' && MARKDOWN_PATTERN.test(s);
}

function childPath(parentPath, key, isIndex) {
  if (!parentPath) return isIndex ? `[${key}]` : String(key);
  return isIndex ? `${parentPath}[${key}]` : `${parentPath}.${key}`;
}

// Build the leaf row for a scalar (string/number/boolean/null/undefined)
// value: classifies a string as 'scalar' (single line), 'multiline' (contains
// a newline, not markdown-like) or 'markdown' (contains a newline and looks
// like markdown), and truncates an overlong string leaf.
function leafRow(key, value, path, depth, out) {
  if (typeof value === 'string') {
    const truncated = value.length > MAX_LEAF_LEN;
    const text = truncated ? value.slice(0, MAX_LEAF_LEN) : value;
    const kind = text.includes('\n')
      ? (looksLikeMarkdown(text) ? 'markdown' : 'multiline')
      : 'scalar';
    out.push({ path, key, depth, kind, value: text, truncated });
    return;
  }
  out.push({ path, key, depth, kind: 'scalar', value, truncated: false });
}

// Recursively flatten `value` (already known to sit at `key`/`path`/`depth`)
// into `out`. A non-empty object/array pushes its own branch row (kind
// 'object'/'array', no value rendered inline) immediately followed by its
// children at depth+1; an empty container is a single leaf-like row (kind
// 'empty-object'/'empty-array'); everything else is a `leafRow`.
function walk(key, value, path, depth, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ path, key, depth, kind: 'empty-array', value });
      return;
    }
    out.push({ path, key, depth, kind: 'array', value });
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    items.forEach((item, i) => {
      walk(`[${i}]`, item, childPath(path, i, true), depth + 1, out);
    });
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push({
        path: `${path}[…]`,
        key: '…',
        depth: depth + 1,
        kind: 'scalar',
        value: `(${value.length - MAX_ARRAY_ITEMS} more)`,
        truncated: false,
      });
    }
    return;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push({ path, key, depth, kind: 'empty-object', value });
      return;
    }
    out.push({ path, key, depth, kind: 'object', value });
    for (const [k, v] of entries) {
      walk(k, v, childPath(path, k, false), depth + 1, out);
    }
    return;
  }
  leafRow(key, value, path, depth, out);
}

/**
 * Turn an arbitrary JS value (a tool's `input` or a `toolResult.content`)
 * into a flat, ordered list of rows:
 *   { path, key, depth, kind, value, truncated? }
 * `kind` is one of 'scalar' | 'multiline' | 'markdown' | 'object' | 'array' |
 * 'empty-object' | 'empty-array'. `key` is `null` only for a bare top-level
 * scalar (no field name to show); a top-level object/array is unwrapped so
 * its own fields/items start at depth 0 rather than nesting one level under
 * a value-less root row.
 */
export function renderableRows(value) {
  const out = [];
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{ path: '', key: null, depth: 0, kind: 'empty-object', value }];
    for (const [k, v] of entries) walk(k, v, childPath('', k, false), 0, out);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: '', key: null, depth: 0, kind: 'empty-array', value }];
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    items.forEach((item, i) => walk(`[${i}]`, item, childPath('', i, true), 0, out));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push({
        path: '[…]',
        key: '…',
        depth: 0,
        kind: 'scalar',
        value: `(${value.length - MAX_ARRAY_ITEMS} more)`,
        truncated: false,
      });
    }
    return out;
  }
  leafRow(null, value, '', 0, out);
  return out;
}
