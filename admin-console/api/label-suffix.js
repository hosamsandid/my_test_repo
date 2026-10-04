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
//
// #2718 widened the surfaces: trigger `claim` (remove/add) and the `humans`
// registry are stamped too, prompt matching never rewrites inside a longer
// label name, and the live-edit routes re-run the same transform with the
// team's stored suffix so a label added to a live team gets it as well.

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
 * Also includes names from bundleLabels (the gate/brake registry) and the label
 * entries of the humans registry (#2718). A trigger `claim` contributes nothing:
 * it is stamped only when it names a token found here.
 *
 * @param {object[]} members - output of templateToCustomRoles
 * @param {object[]} bundleLabels - array of {name, humanGate?, brake?}
 * @param {object[]} humans - array of {id, emits?, consumes?}
 * @returns {Set<string>}
 */
function collectLabelTokens(members, bundleLabels = [], humans = []) {
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
        // A comment listener's required label (#2822) is a label port too.
        if (typeof t.requireLabel === 'string' && t.requireLabel.trim()) {
          tokens.add(t.requireLabel.trim());
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
    if (l && typeof l.name === 'string' && l.name.trim()) tokens.add(l.name.trim());
  }
  for (const h of humans) {
    for (const e of (Array.isArray(h?.emits) ? h.emits : [])) {
      if (typeof e === 'string' && e.trim()) tokens.add(e.trim());
    }
    for (const c of (Array.isArray(h?.consumes) ? h.consumes : [])) {
      if (c && typeof c.label === 'string' && c.label.trim()) tokens.add(c.label.trim());
    }
  }
  return tokens;
}

/**
 * Apply a label suffix to members + the bundle label registry + the humans
 * registry in one pass.
 *
 * Rules:
 *  1. Port surfaces (labelFilter, requireLabel, channel.label, setLabel actions, emits, the
 *     label registry, humans emits / consumes[].label) are rewritten directly —
 *     exact string replacement, no parsing needed.
 *  2. Trigger `claim` (#2718): `remove` is stamped when it is a known token;
 *     `add` has its base label stamped and keeps the author's ending
 *     (`foo:wip` → `foo-S:wip`). `postcondition` is never touched.
 *  3. Prompt text (systemPrompt / trigger promptTemplate / trigger prompt):
 *     a. Backtick-quoted tokens: always rewritten — `token` → `token-suffix`
 *     b. Bare tokens containing a dash: rewritten as whole label names — never
 *        inside a longer name (a following `-<more>` or a preceding `<word>-`
 *        means the token is part of another label, #2718)
 *     c. Bare tokens without a dash: NOT rewritten (coverage warning emitted)
 *  4. Idempotency guard: tokens that already end with `-<suffix>` are skipped.
 *  5. Longest-first matching prevents partial collisions (e.g. `ready` being
 *     found inside `ready-for-review` when both are in the token set).
 *
 * @param {object[]} members
 * @param {object[]} bundleLabels - array of {name, humanGate?, brake?}
 * @param {string} suffix - validated, non-empty suffix
 * @param {object[]} [humans] - the named human roles registry (#987)
 * @returns {{ members: object[], bundleLabels: object[], humans: object[], tokenSet: Set<string>, warnings: string[] }}
 */
function applyLabelSuffix(members, bundleLabels, suffix, humans = []) {
  const tokenSet = collectLabelTokens(members, bundleLabels, humans);
  if (!suffix) {
    return { members, bundleLabels, humans, tokenSet, warnings: [] };
  }

  const warnings = [];

  // Sort longest-first to avoid shorter tokens matching inside longer ones.
  const sorted = [...tokenSet].sort((a, b) => b.length - a.length);

  // Pre-filter tokens already ending in -<suffix> (idempotency guard).
  const toStamp = sorted.filter(t => !t.endsWith(`-${suffix}`));
  const stampSet = new Set(toStamp);

  const stampedSet = new Set(toStamp.map(t => `${t}-${suffix}`));

  function stampLabel(label) {
    if (typeof label !== 'string') return label;
    const t = label.trim();
    if (!stampSet.has(t)) return label;
    return `${t}-${suffix}`;
  }

  // `claim.add` is `<wake>:wip` by convention, but an author may have used
  // another ending — stamp the base label only and keep whatever follows.
  function stampClaim(claim) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return claim;
    const next = { ...claim };
    const remove = typeof claim.remove === 'string' ? claim.remove.trim() : '';
    if (remove) next.remove = stampLabel(claim.remove);
    if (typeof claim.add === 'string') {
      const add = claim.add.trim();
      // The longest known label wins, so a known `foo-bar` in `foo-bar:wip`
      // is never split into `foo-x1-bar:wip` just because it starts with
      // `remove` = `foo` (#2718 AC4). The `remove` prefix is only the fallback
      // for an unknown tail (`ready-wip` → `ready-x1-wip`).
      let base = '';
      const colon = add.indexOf(':');
      if (stampSet.has(add)) base = add;
      else if (colon > 0 && stampSet.has(add.slice(0, colon))) base = add.slice(0, colon);
      else if (remove && stampSet.has(remove) && add.startsWith(remove)) {
        base = remove;
        for (const t of stampSet) {
          if (t.length > base.length && t.startsWith(`${remove}-`) && add.startsWith(t)
              && (add.length === t.length || add[t.length] === '-' || add[t.length] === ':')) base = t;
        }
      }
      if (base) next.add = `${base}-${suffix}${add.slice(base.length)}`;
    }
    return next;
  }

  function stampPromptText(text) {
    if (typeof text !== 'string' || !text) return text;
    let result = text;
    for (const token of toStamp) {
      const stamped = `${token}-${suffix}`;
      // 1. Bare word — only for tokens containing a dash (multi-word). Runs FIRST
      //    so the backtick-enclosed form is also caught here (backticks are just
      //    characters; the boundaries hold at the token edges inside them).
      //    After this pass the backtick pattern below won't find a stale token.
      //    The boundaries reject a token that continues into a longer label
      //    name (`foo` inside `foo-abc` / `foo-x1`), so nothing is stamped twice.
      if (token.includes('-')) {
        result = result.replace(
          new RegExp('(?<![\\w-])' + escapeRegex(token) + '(?!-?\\w)', 'g'),
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
        if (!t || typeof t !== 'object') return t;
        const nt = { ...t };
        if (typeof t.labelFilter === 'string') {
          nt.labelFilter = stampLabel(t.labelFilter);
        }
        if (typeof t.requireLabel === 'string') {
          nt.requireLabel = stampLabel(t.requireLabel);
        }
        if (t.claim !== undefined) nt.claim = stampClaim(t.claim);
        if (typeof t.promptTemplate === 'string') {
          checkPromptCoverage(t.promptTemplate);
          nt.promptTemplate = stampPromptText(t.promptTemplate);
        }
        // A live trigger carries its text as `prompt` (#2718).
        if (typeof t.prompt === 'string') {
          checkPromptCoverage(t.prompt);
          nt.prompt = stampPromptText(t.prompt);
        }
        return nt;
      });
    }

    if (Array.isArray(m.channels)) {
      next.channels = m.channels.map(c => {
        if (c && typeof c.label === 'string') return { ...c, label: stampLabel(c.label) };
        return c;
      });
    }

    if (Array.isArray(m.outcomes?.options)) {
      next.outcomes = {
        ...m.outcomes,
        options: m.outcomes.options.map(opt => (opt && typeof opt === 'object' ? {
          ...opt,
          actions: (Array.isArray(opt.actions) ? opt.actions : []).map(act => {
            if (act && act.type === 'setLabel' && typeof act.label === 'string') {
              return { ...act, label: stampLabel(act.label) };
            }
            return act;
          }),
        } : opt)),
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
    if (l && typeof l.name === 'string' && stampSet.has(l.name.trim())) {
      return { ...l, name: `${l.name.trim()}-${suffix}` };
    }
    return l;
  });
  // Humans registry (#2718): only label entries are stamped — a consume that
  // names a producer role (`from`), an artifact or a file is left as is.
  const stampedHumans = humans.map(h => {
    if (!h || typeof h !== 'object') return h;
    const nh = { ...h };
    if (Array.isArray(h.emits)) nh.emits = h.emits.map(stampLabel);
    if (Array.isArray(h.consumes)) {
      nh.consumes = h.consumes.map(c => (c && typeof c.label === 'string' ? { ...c, label: stampLabel(c.label) } : c));
    }
    return nh;
  });

  return {
    members: stampedMembers,
    bundleLabels: stampedBundleLabels,
    humans: stampedHumans,
    tokenSet: stampedSet,
    warnings: dedupe(warnings),
  };
}

/**
 * Live-team edits (#2718): stamp the labels a write to a suffixed team carries,
 * so a label added after creation gets the same suffix the team was created
 * with. `body` is the request body of a live write — an agent PUT (`emits`,
 * `outcomes`, `channels`, `labels`, `humans`), a trigger, or a member create
 * (`triggers`, …). The same rules as applyLabelSuffix apply; a name that
 * already ends in `-<suffix>` is left as is. Returns `body` unchanged when there
 * is no suffix or nothing to stamp, so an unsuffixed team's write is untouched.
 *
 * @param {object} body
 * @param {string} suffix - the team's stored labelSuffix ('' / undefined = none)
 * @param {{ trigger?: boolean }} [opts] - `trigger: true` when body IS a trigger
 * @returns {object}
 */
// The token set is built from `body` alone, so a body must carry every label it
// references: a trigger PUT with a `claim` but no `labelFilter` leaves the claim
// unstamped. All current callers (Flow editor dialogs, Copilot live apply) send
// full triggers.
function stampLiveLabels(body, suffix, { trigger = false } = {}) {
  if (!suffix || !validateSuffix(suffix).ok) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const member = trigger ? { triggers: [body] } : body;
  const labels = !trigger && Array.isArray(body.labels) ? body.labels : [];
  const humans = !trigger && Array.isArray(body.humans) ? body.humans : [];
  const out = applyLabelSuffix([member], labels, suffix, humans);
  if (trigger) return out.members[0].triggers[0];
  const next = { ...out.members[0] };
  // promptTemplate is not a field of a live agent write; never rewrite it here.
  if ('promptTemplate' in body) next.promptTemplate = body.promptTemplate;
  if (Array.isArray(body.labels)) next.labels = out.bundleLabels;
  if (Array.isArray(body.humans)) next.humans = out.humans;
  return next;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { SUFFIX_RE, SUFFIX_RULE, validateSuffix, suggestSuffix, collectLabelTokens, applyLabelSuffix, stampLiveLabels };
