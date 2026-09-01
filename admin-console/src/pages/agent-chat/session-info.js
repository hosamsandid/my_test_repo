// session-info.js — pure presentation/derivation helpers for the Agent-Chat
// header context-usage indicator and the session/model info popover (#1718).
// Dependency-free so they run under `node --test` in the admin-console-src CI
// job; the JSX shells (ChatPanel header + SessionInfoPopover) stay thin.
//
// The context-window *resolution* (a model's real window in tokens) stays in
// context-window.js (#471); this module owns only the #1718 formatting and the
// view models the header + popover render.

import { formatTokenCountK } from './context-window.js';

// Compact token-window format (#1718): whole thousands as "K", millions as "M"
// with at most one decimal (dropped when it adds nothing). Used for a model's
// context window and its optional max-output tokens.
//   1_000_000 → "1M", 1_500_000 → "1.5M", 200_000 → "200K", 128_000 → "128K".
// Returns null for a non-positive / unknown input so the caller OMITS the value
// rather than showing a guess or a zero placeholder (AC1/AC5/AC8).
export function formatContextWindow(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${m}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

// The model-selector row's context-window caption, e.g. "1M context" (AC1).
// null → the row shows no window (never a guess).
export function selectorWindowLabel(tokens) {
  const w = formatContextWindow(tokens);
  return w ? `${w} context` : null;
}

// The compact header context-usage indicator (#1718, AC2/AC3). Given the used
// context tokens, the resolved window (null when unknown) and the fill level
// ({ pct, level } from computeContextFillLevel, or null), returns what the
// always-visible header shows:
//   window known   → { text: "34K / 200K · 17%", level, windowKnown: true }
//   window unknown → { text: "34K", level: 'normal', windowKnown: false }
// Returns null when there is no usage data at all (fresh session).
export function headerContextIndicator(usedTokens, windowTokens, fill) {
  if (typeof usedTokens !== 'number' || usedTokens < 0) return null;
  const used = formatTokenCountK(usedTokens);
  if (used == null) return null;
  if (typeof windowTokens === 'number' && windowTokens > 0) {
    const windowLabel = formatContextWindow(windowTokens);
    const pct = fill && typeof fill.pct === 'number' ? fill.pct : null;
    const level = fill && fill.level ? fill.level : 'normal';
    return {
      text: pct != null ? `${used} / ${windowLabel} · ${pct}%` : `${used} / ${windowLabel}`,
      level,
      windowKnown: true,
    };
  }
  return { text: used, level: 'normal', windowKnown: false };
}

// The popover's single total price (AC4/AC6 — one total, never a per-class
// cost). null → the price row is omitted (no cost data yet).
export function sessionPriceLabel(usd) {
  if (typeof usd !== 'number' || !(usd > 0)) return null;
  return `$${usd.toFixed(4)}`;
}

// Group a non-negative integer with thousands separators without a regex
// (linear scan — no polynomial-ReDoS surface), e.g. 17718 → "17,718".
function groupThousands(n) {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

// Normalises a gitInfo array for the About-this-chat popover (#1807).
// Returns one entry per repo with null-safe defaults. Returns [] when empty.
export function repoBranchRows(gitInfo) {
  if (!Array.isArray(gitInfo) || gitInfo.length === 0) return [];
  return gitInfo.map(r => ({
    repoPath: r.repoPath ?? '',
    branch: r.branch ?? 'detached',
    isDirty: Boolean(r.isDirty),
    changesCount: typeof r.changesCount === 'number' ? r.changesCount : 0,
  }));
}

// The popover's four-class token breakdown (AC4). Takes the raw per-class
// totals { input, output, cacheWrite, cacheRead } and returns one row per class
// in a fixed order with a human label and a grouped count. Returns [] when the
// session carries no token data at all — every class missing OR every class
// zero (a fresh session) — so the caller omits the whole section rather than
// showing a zero placeholder (AC8). Once there IS usage, a genuine 0 for one
// class (e.g. a cache-only turn's output) is a real value and is shown.
export function tokenBreakdownRows(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return [];
  const classes = [
    ['input', 'Input'],
    ['output', 'Output'],
    ['cacheWrite', 'Cache-write'],
    ['cacheRead', 'Cache-read'],
  ];
  const values = classes.map(([key, label]) => {
    const raw = breakdown[key];
    return { key, label, n: typeof raw === 'number' && raw >= 0 ? raw : 0 };
  });
  const total = values.reduce((sum, v) => sum + v.n, 0);
  if (total <= 0) return [];
  return values.map(({ key, label, n }) => ({ key, label, value: groupThousands(n) }));
}
