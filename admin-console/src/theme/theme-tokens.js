// Pure helpers over src/theme/tokens.css (#2701): which --eb-* tokens a theme
// defines, which ones the source uses, and the WCAG contrast between two
// resolved token colours. Dependency-free so node:test can run it directly.

export const THEMES = ['admin-dark', 'admin-light', 'high-contrast'];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Custom-property declarations of the first rule whose selector list matches
// `selectorRe`.
function declarations(css, selectorRe) {
  const rule = new RegExp(`${selectorRe.source}[^{]*\\{([^}]*)\\}`).exec(css);
  if (!rule) throw new Error(`tokens.css has no rule for ${selectorRe}`);
  const vars = {};
  for (const m of rule[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

// { theme: { '--eb-x': 'value' } } for every theme. The dark block is also the
// bare `:root` default, so the other themes inherit every token they don't
// override.
export function themeTokens(cssText) {
  const css = stripComments(cssText);
  const base = declarations(css, /:root,\s*:root\[data-theme="admin-dark"\]/);
  return {
    'admin-dark': base,
    'admin-light': { ...base, ...declarations(css, /:root\[data-theme="admin-light"\]/) },
    'high-contrast': { ...base, ...declarations(css, /:root\[data-theme="high-contrast"\]/) },
  };
}

// Every --eb-* token referenced through var(…) in a source text.
export function usedTokens(source) {
  return new Set([...source.matchAll(/var\(\s*(--eb-[\w-]+)/g)].map(m => m[1]));
}

// Line numbers of style blocks (a JS style object or a CSS rule, i.e. an
// innermost {…}) that fill with --eb-accent-primary but hard-code white text.
// White on the high-contrast accent is ~3:1; use --eb-text-inverted instead.
export function whiteOnAccentLines(source) {
  const lines = [];
  for (const m of source.matchAll(/\{[^{}]*\}/g)) {
    const block = m[0];
    const accentFill = /background(?:-color|Color)?['"]?\s*:\s*['"]?var\(\s*--eb-accent-primary\s*\)/.test(block);
    const whiteText = /(?:^|[\s,{;])color['"]?\s*:\s*['"]?(?:#fff(?:fff)?\b|white\b)/i.test(block);
    if (accentFill && whiteText) lines.push(source.slice(0, m.index).split('\n').length);
  }
  return lines;
}

// Follows bare var(--x) references until a literal value is reached.
export function resolveToken(vars, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`cyclic token ${name}`);
  seen.add(name);
  const value = vars[name];
  if (value === undefined) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? resolveToken(vars, ref[1], seen) : value;
}

// ─── Colour maths (CSS Color 4: OKLCH → OKLab → linear sRGB) ──────────────

function parseOklch(value) {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function parseHex(value) {
  let hex = value.slice(1);
  if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a hex colour: ${value}`);
  return [0, 2, 4].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

// Linear-light sRGB channels of an `oklch(…)` or `#hex` colour, clipped to
// the sRGB gamut the way a browser displays it.
export function linearSrgb(value) {
  if (value.startsWith('#')) return parseHex(value);
  const [L, a, b] = parseOklch(value);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return rgb.map(c => Math.min(1, Math.max(0, c)));
}

export function relativeLuminance(value) {
  const [r, g, b] = linearSrgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2 contrast ratio (1–21) between two literal colours.
export function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
