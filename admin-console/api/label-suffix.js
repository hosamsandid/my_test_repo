'use strict';

// Label-suffix stamping — one-shot transform applied at materialisation.
//
// A team can receive an optional `labelSuffix` (e.g. "k3f9") at creation time.
// It is applied ONCE to the member-shaped output of templateToCustomRoles (post
// var-substitution, pre POST /internal/agents): every label token is renamed
// from e.g. `ready-for-implementation` → `ready-for-implementation-k3f9`
// everywhere it appears — trigger labelFilters, channel labels, outcome
// setLabel actions, emits[], and prompt text. The platform has no notion of a
// "logical" vs "physical" label — what's in the config is what's in the prompt
// is what's on GitHub. (#902)

// Character class: lowercase base36 plus SINGLE INNER hyphens, 1–8 chars
// (#1934). The suffix is appended to GitHub label tokens
// (`ready-for-review` → `ready-for-review-team-1`) and GitHub label names allow
// hyphens, so a readable `team-1` / `pre-prod` is legal — but a leading,
// trailing or doubled hyphen would produce `ready--x` / `ready-x-`, so those
// stay rejected. Kept byte-identical to the client's SUFFIX_RE in
// admin-console/src/pages/process/launch-team.js.
const SUFFIX_RE = /^(?=.{1,8}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUFFIX_RULE = 'labelSuffix must be 1–8 chars of [a-z0-9] with single inner hyphens (e.g. k3f9, team-1, pre-prod)';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a labelSuffix value (or absence).
 * Returns { ok: true } or { ok: false, error: string }.
 */
function validateSuffix(suffix) {
  if (suffix === undefined || suffix === null || suffix === '') return { ok: true };
  if (typeof suffix !== 'string') return { ok: false, error: 'labelSuffix must be a string' };
  if (!SUFFIX_RE.test(suffix)) {
    return { ok: false, error: SUFFIX_RULE };
  }
  return { ok: true };
}

/**
 * Generate a random 4-char base36 suggestion. Deliberately hyphen-free — an
 * auto-generated token has no words to separate (#1934 AC8).
 */
function suggestSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * Collect all unique label tokens used in port surfaces across a member array.
 * Also includes names from bundleLabels (the gate/brake registry).
 *
 * @param {object[]} members - output of templateToCustomRoles
 * @param {object[]} bundleLabels - array of {name, humanGate?, brake?}
 * @returns {Set<string>}
 */
function collectLabelTokens(members, bundleLabels = []) {
  const tokens = new Set();
  for (const m of members) {
    if (Array.isArray(m.emits)) {
      for (const e of m.emits) {
        if (typeof e === 'string' && e.trim()) tokens.add(e.trim());
      }
    }
    if (Array.isArray(m.triggers)) {
      for (const t of m.triggers) {
        if (typeof t.labelFilter === 'string' && t.labelFilter.trim()) {
          tokens.add(t.labelFilter.trim());
        }
      }
    }
    if (Array.isArray(m.channels)) {
      for (const c of m.channels) {
        if (typeof c.label === 'string' && c.label.trim()) tokens.add(c.label.trim());
      }
    }
    if (m.outcomes?.options) {
      for (const opt of m.outcomes.options) {
        for (const act of opt.actions || []) {
          if (act.type === 'setLabel' && typeof act.label === 'string' && act.label.trim()) {
            tokens.add(act.label.trim());
          }
        }
      }
    }
  }
  for (const l of bundleLabels) {
    if (typeof l.name === 'string' && l.name.trim()) tokens.add(l.name.trim());
  }
  return tokens;
}

/**
 * Apply a label suffix to members + the bundle label registry in one pass.
 *
 * Rules:
 *  1. Port surfaces (labelFilter, channel.label, setLabel actions, emits) are
 *     rewritten directly — exact string replacement, no parsing needed.
 *  2. Prompt text (systemPrompt / trigger promptTemplate):
 *     a. Backtick-quoted tokens: always rewritten — `token` → `token-suffix`
 *     b. Bare tokens containing a dash: rewritten as whole words (\b…\b)
 *     c. Bare tokens without a dash: NOT rewritten (coverage warning emitted)
 *  3. Idempotency guard: tokens that already end with `-<suffix>` are skipped.
 *  4. Longest-first matching prevents partial collisions (e.g. `ready` being
 *     found inside `ready-for-review` when both are in the token set).
 *
 * @param {object[]} members
 * @param {object[]} bundleLabels - array of {name, humanGate?, brake?}
 * @param {string} suffix - validated, non-empty suffix
 * @returns {{ members: object[], bundleLabels: object[], tokenSet: Set<string>, warnings: string[] }}
 */
function applyLabelSuffix(members, bundleLabels, suffix) {
  if (!suffix) {
    const tokenSet = collectLabelTokens(members, bundleLabels);
    return { members, bundleLabels, tokenSet, warnings: [] };
  }

  const tokenSet = collectLabelTokens(members, bundleLabels);
  const warnings = [];

  // Sort longest-first to avoid shorter tokens matching inside longer ones.
  const sorted = [...tokenSet].sort((a, b) => b.length - a.length);

  // Pre-filter tokens already ending in -<suffix> (idempotency guard).
  const toStamp = sorted.filter(t => !t.endsWith(`-${suffix}`));

  const stampedSet = new Set(toStamp.map(t => `${t}-${suffix}`));

  function stampLabel(label) {
    if (typeof label !== 'string') return label;
    const t = label.trim();
    if (!toStamp.includes(t)) return label;
    return `${t}-${suffix}`;
  }

  function stampPromptText(text) {
    if (typeof text !== 'string' || !text) return text;
    let result = text;
    for (const token of toStamp) {
      const stamped = `${token}-${suffix}`;
      // 1. Bare word — only for tokens containing a dash (multi-word). Runs FIRST
      //    so the backtick-enclosed form is also caught here (backticks are just
      //    characters; the \b boundaries fire at the token edges inside them).
      //    After this pass the backtick pattern below won't find a stale token.
      if (token.includes('-')) {
        result = result.replace(
          new RegExp('\\b' + escapeRegex(token) + '\\b', 'g'),
          stamped,
        );
      }
      // 2. Backtick-quoted — handles no-dash tokens that are explicitly quoted.
      //    Dash tokens are already handled above; this pass is a no-op for them.
      result = result.replace(
        new RegExp('`' + escapeRegex(token) + '`', 'g'),
        `\`${stamped}\``,
      );
    }
    return result;
  }

  function checkPromptCoverage(text) {
    if (typeof text !== 'string' || !text) return;
    for (const token of toStamp) {
      if (!token.includes('-') && text.includes(token) && !text.includes(`\`${token}\``)) {
        const escaped = escapeRegex(token);
        if (new RegExp(`\\b${escaped}\\b`).test(text)) {
          warnings.push(
            `Prompt mentions label '${token}' as a bare word — it will not be stamped. ` +
            `Wrap it in backticks (\`${token}\`) in the template to stamp it automatically.`,
          );
        }
      }
    }
  }

  function stampMember(m) {
    const next = { ...m };

    if (Array.isArray(m.emits)) {
      next.emits = m.emits.map(stampLabel);
    }

    if (Array.isArray(m.triggers)) {
      next.triggers = m.triggers.map(t => {
        const nt = { ...t };
        if (typeof t.labelFilter === 'string') {
          nt.labelFilter = stampLabel(t.labelFilter);
        }
        if (typeof t.promptTemplate === 'string') {
          checkPromptCoverage(t.promptTemplate);
          nt.promptTemplate = stampPromptText(t.promptTemplate);
        }
        return nt;
      });
    }

    if (Array.isArray(m.channels)) {
      next.channels = m.channels.map(c => {
        if (typeof c.label === 'string') return { ...c, label: stampLabel(c.label) };
        return c;
      });
    }

    if (m.outcomes?.options) {
      next.outcomes = {
        ...m.outcomes,
        options: m.outcomes.options.map(opt => ({
          ...opt,
          actions: (opt.actions || []).map(act => {
            if (act.type === 'setLabel' && typeof act.label === 'string') {
              return { ...act, label: stampLabel(act.label) };
            }
            return act;
          }),
        })),
      };
    }

    if (typeof m.promptTemplate === 'string') {
      checkPromptCoverage(m.promptTemplate);
      next.promptTemplate = stampPromptText(m.promptTemplate);
    }

    return next;
  }

  const stampedMembers = members.map(stampMember);
  const stampedBundleLabels = bundleLabels.map(l => {
    if (typeof l.name === 'string' && toStamp.includes(l.name.trim())) {
      return { ...l, name: `${l.name.trim()}-${suffix}` };
    }
    return l;
  });

  return {
    members: stampedMembers,
    bundleLabels: stampedBundleLabels,
    tokenSet: stampedSet,
    warnings: dedupe(warnings),
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { SUFFIX_RE, SUFFIX_RULE, validateSuffix, suggestSuffix, collectLabelTokens, applyLabelSuffix };
