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
function applyLabelSuffix(members, bundleLabels, suffix, humans = [], { keep } = {}) {
  const tokenSet = collectLabelTokens(members, bundleLabels, humans);
  if (!suffix) {
    return { members, bundleLabels, humans, tokenSet, skipped: [], warnings: [] };
  }

  const warnings = [];

  // Pre-filter tokens already ending in -<suffix> (idempotency guard), and the
  // labels a live team keeps unsuffixed on purpose (#2858: a foreign label that
  // was never stamped is not silently stamped by a later edit).
  const kept = keep instanceof Set ? keep : new Set(keep || []);
  const skipped = [...tokenSet].filter(t => t.endsWith(`-${suffix}`) && !kept.has(t));
  const toStamp = [...tokenSet].filter(t => !t.endsWith(`-${suffix}`) && !kept.has(t));
  const renames = new Map(toStamp.map(t => [t, `${t}-${suffix}`]));

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

  const out = renameLabelTokens(members, bundleLabels, humans, renames, { onPrompt: checkPromptCoverage });
  return {
    ...out,
    tokenSet: new Set(renames.values()),
    // Tokens left as they were because they already ended in -<suffix> — the
    // team records them as foreign so a later split never mistakes `team-1`
    // (suffix `1`) for base `team` + suffix (#2858).
    skipped,
    warnings: dedupe(warnings),
  };
}

/**
 * Rename label tokens across members + the label registry + the humans
 * registry (#2858) — the engine behind applyLabelSuffix (old → `old-<suffix>`)
 * and a live team's suffix change (`foo-old` → `foo-new`, or → `foo` when the
 * suffix is removed). `renames` maps an exact physical label to its new name;
 * the surfaces and token rules are those documented on applyLabelSuffix:
 *  - port surfaces are exact-string replacements;
 *  - a trigger `claim.add` keeps the author's ending (`foo-x:wip` → `foo-y:wip`);
 *  - prompt text rewrites a dashed token as a whole label name (never inside a
 *    longer one) and a dash-free token only when backtick-quoted.
 * Prompt rewriting is a single pass, so a renamed name is never renamed again.
 *
 * @param {object[]} members
 * @param {object[]} bundleLabels
 * @param {object[]} humans
 * @param {Map<string,string>} renames
 * @param {{ onPrompt?: (text: string) => void, promptFields?: string[] }} [opts]
 *   `promptFields` — the member-level prompt fields to rewrite (default: a
 *   template role's `promptTemplate`); a live suffix change adds `systemPrompt`
 *   and `systemPromptTemplate`.
 * @returns {{ members: object[], bundleLabels: object[], humans: object[] }}
 */
function renameLabelTokens(members, bundleLabels = [], humans = [], renames = new Map(),
  { onPrompt, promptFields = ['promptTemplate'] } = {}) {
  if (!renames.size) return { members, bundleLabels, humans };

  // Longest-first alternation prevents partial collisions (e.g. `ready` being
  // found inside `ready-for-review` when both are renamed).
  const sorted = [...renames.keys()].sort((a, b) => b.length - a.length);
  const dashed = sorted.filter(t => t.includes('-'));
  const bareRe = dashed.length
    ? new RegExp('(?<![\\w-])(' + dashed.map(escapeRegex).join('|') + ')(?!-?\\w)', 'g')
    : null;
  const quotedRe = new RegExp('`(' + sorted.map(escapeRegex).join('|') + ')`', 'g');

  function renameLabel(label) {
    if (typeof label !== 'string') return label;
    const t = label.trim();
    return renames.has(t) ? renames.get(t) : label;
  }

  // `claim.add` is `<wake>:wip` by convention, but an author may have used
  // another ending — rename the base label only and keep whatever follows.
  function renameClaim(claim) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return claim;
    const next = { ...claim };
    const remove = typeof claim.remove === 'string' ? claim.remove.trim() : '';
    if (remove) next.remove = renameLabel(claim.remove);
    if (typeof claim.add === 'string') {
      const add = claim.add.trim();
      // The longest known label wins, so a known `foo-bar` in `foo-bar:wip`
      // is never split into `foo-x1-bar:wip` just because it starts with
      // `remove` = `foo` (#2718 AC4). The `remove` prefix is only the fallback
      // for an unknown tail (`ready-wip` → `ready-x1-wip`).
      let base = '';
      const colon = add.indexOf(':');
      if (renames.has(add)) base = add;
      else if (colon > 0 && renames.has(add.slice(0, colon))) base = add.slice(0, colon);
      else if (remove && renames.has(remove) && add.startsWith(remove)) {
        base = remove;
        for (const t of renames.keys()) {
          if (t.length > base.length && t.startsWith(`${remove}-`) && add.startsWith(t)
              && (add.length === t.length || add[t.length] === '-' || add[t.length] === ':')) base = t;
        }
      }
      if (base) next.add = `${renames.get(base)}${add.slice(base.length)}`;
    }
    return next;
  }

  function renamePromptText(text) {
    if (typeof text !== 'string' || !text) return text;
    if (onPrompt) onPrompt(text);
    // 1. Bare word — only for tokens containing a dash (multi-word); the
    //    backtick-enclosed form is caught here too (backticks are not word
    //    characters). The boundaries reject a token that continues into a
    //    longer label name (`foo` inside `foo-abc` / `foo-x1`).
    let result = bareRe ? text.replace(bareRe, t => renames.get(t)) : text;
    // 2. Backtick-quoted — handles dash-free tokens that are explicitly quoted.
    //    A name produced by pass 1 contains a dash, so it cannot match a
    //    dash-free token here.
    result = result.replace(quotedRe, (m, t) => (t.includes('-') ? m : `\`${renames.get(t)}\``));
    return result;
  }

  function renameMember(m) {
    const next = { ...m };

    if (Array.isArray(m.emits)) {
      next.emits = m.emits.map(renameLabel);
    }

    if (Array.isArray(m.triggers)) {
      next.triggers = m.triggers.map(t => {
        if (!t || typeof t !== 'object') return t;
        const nt = { ...t };
        if (typeof t.labelFilter === 'string') {
          nt.labelFilter = renameLabel(t.labelFilter);
        }
        if (typeof t.requireLabel === 'string') {
          nt.requireLabel = renameLabel(t.requireLabel);
        }
        if (t.claim !== undefined) nt.claim = renameClaim(t.claim);
        if (typeof t.promptTemplate === 'string') {
          nt.promptTemplate = renamePromptText(t.promptTemplate);
        }
        // A live trigger carries its text as `prompt` (#2718).
        if (typeof t.prompt === 'string') {
          nt.prompt = renamePromptText(t.prompt);
        }
        return nt;
      });
    }

    if (Array.isArray(m.channels)) {
      next.channels = m.channels.map(c => {
        if (c && typeof c.label === 'string') return { ...c, label: renameLabel(c.label) };
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
              return { ...act, label: renameLabel(act.label) };
            }
            return act;
          }),
        } : opt)),
      };
    }

    for (const field of promptFields) {
      if (typeof m[field] === 'string') next[field] = renamePromptText(m[field]);
    }

    return next;
  }

  return {
    members: members.map(renameMember),
    bundleLabels: bundleLabels.map(l => {
      if (l && typeof l.name === 'string' && renames.has(l.name.trim())) {
        return { ...l, name: renames.get(l.name.trim()) };
      }
      return l;
    }),
    // Humans registry (#2718): only label entries are renamed — a consume that
    // names a producer role (`from`), an artifact or a file is left as is.
    humans: humans.map(h => {
      if (!h || typeof h !== 'object') return h;
      const nh = { ...h };
      if (Array.isArray(h.emits)) nh.emits = h.emits.map(renameLabel);
      if (Array.isArray(h.consumes)) {
        nh.consumes = h.consumes.map(c => (c && typeof c.label === 'string' ? { ...c, label: renameLabel(c.label) } : c));
      }
      return nh;
    }),
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
// `keep` (#2858) — the team's foreign labels (teamForeignLabels): a label the
// team already carries unsuffixed is written back as is, never silently stamped.
function stampLiveLabels(body, suffix, { trigger = false, keep } = {}) {
  if (!suffix || !validateSuffix(suffix).ok) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const member = trigger ? { triggers: [body] } : body;
  const labels = !trigger && Array.isArray(body.labels) ? body.labels : [];
  const humans = !trigger && Array.isArray(body.humans) ? body.humans : [];
  const out = applyLabelSuffix([member], labels, suffix, humans, { keep });
  if (trigger) return out.members[0].triggers[0];
  const next = { ...out.members[0] };
  // promptTemplate is not a field of a live agent write; never rewrite it here.
  if ('promptTemplate' in body) next.promptTemplate = body.promptTemplate;
  if (Array.isArray(body.labels)) next.labels = out.bundleLabels;
  if (Array.isArray(body.humans)) next.humans = out.humans;
  return next;
}

// ─── Live suffix change (#2858) ──────────────────────────────────────────────

/**
 * Is `label` one of the team's suffixed labels? A label of a suffixed team is a
 * team label when it is `<base>-<suffix>` and not recorded as foreign in the
 * team's `labelSuffixExempt` (a template label that already ended in the suffix
 * and was therefore never stamped — `team-1` under suffix `1`).
 */
function isTeamLabel(label, suffix, exempt = []) {
  if (!suffix || typeof label !== 'string') return false;
  const t = label.trim();
  const ex = exempt instanceof Set ? exempt : new Set(exempt || []);
  return t.length > suffix.length + 1 && t.endsWith(`-${suffix}`) && !ex.has(t);
}

/**
 * A live team as the suffix tools see it: every agent of the team (the team
 * agent itself and all members/pool instances) as `{ id, config, triggers }`.
 * Returns the member-shaped list renameLabelTokens walks, plus the team's label
 * and humans registries.
 */
function teamSurfaces(agents, teamId) {
  const team = agents.find(a => a.id === teamId);
  const teamCfg = (team && team.config) || {};
  return {
    teamCfg,
    shaped: agents.map(a => ({ ...(a.config || {}), triggers: Array.isArray(a.triggers) ? a.triggers : [] })),
    labels: Array.isArray(teamCfg.labels) ? teamCfg.labels : [],
    humans: Array.isArray(teamCfg.humans) ? teamCfg.humans : [],
  };
}

/**
 * The labels a suffixed team carries that are NOT team labels (#2858 AC4) —
 * foreign names a live edit must write back as they are.
 */
function teamForeignLabels(agents, teamId) {
  const { teamCfg, shaped, labels, humans } = teamSurfaces(agents, teamId);
  const suffix = typeof teamCfg.labelSuffix === 'string' ? teamCfg.labelSuffix.trim() : '';
  if (!suffix) return new Set();
  const exempt = new Set(Array.isArray(teamCfg.labelSuffixExempt) ? teamCfg.labelSuffixExempt : []);
  const tokens = collectLabelTokens(shaped, labels, humans);
  return new Set([...tokens].filter(t => !isTeamLabel(t, suffix, exempt)));
}

/**
 * Plan a live team's suffix change (#2858 AC7/AC11): `oldSuffix` → `newSuffix`
 * ('' on either side = no suffix). Pure — the caller persists the result.
 *
 *  - With an old suffix, the team labels are the `<base>-<old>` tokens that are
 *    not exempt; they become `<base>-<new>` (or `<base>` when the suffix is
 *    removed). Foreign labels are left alone.
 *  - Without one, every label token is a team label, exactly as at creation;
 *    a token that already ends in `-<new>` is left as is and recorded as
 *    exempt, mirroring applyLabelSuffix's idempotency guard.
 *  - `otherTeamLabels` (labels other teams on the same repository use) and the
 *    team's own foreign labels are collision targets: a resulting name that
 *    already belongs to one of them is reported, not merged (AC10).
 *
 * @param {{ id: string, config: object, triggers: object[] }[]} agents - the team agent + all its members
 * @param {string} teamId
 * @param {string} newSuffix
 * @param {{ otherTeamLabels?: Iterable<string> }} [opts]
 * @returns {{ oldSuffix: string, newSuffix: string, renames: {from: string, to: string}[],
 *   collisions: {label: string, from: string, owner: 'other-team'|'this-team'}[],
 *   agents: { id: string, config: object, triggers: object[], configChanged: boolean, triggersChanged: boolean }[],
 *   exempt: string[] }}
 */
function planSuffixChange(agents, teamId, newSuffix, { otherTeamLabels = [] } = {}) {
  const { teamCfg, shaped, labels, humans } = teamSurfaces(agents, teamId);
  const oldSuffix = typeof teamCfg.labelSuffix === 'string' ? teamCfg.labelSuffix.trim() : '';
  const next = typeof newSuffix === 'string' ? newSuffix.trim() : '';
  const oldExempt = Array.isArray(teamCfg.labelSuffixExempt) ? teamCfg.labelSuffixExempt : [];
  const tokens = collectLabelTokens(shaped, labels, humans);

  const renames = new Map();
  const exempt = new Set(oldExempt);
  for (const t of tokens) {
    let base;
    if (oldSuffix) {
      if (!isTeamLabel(t, oldSuffix, oldExempt)) continue;
      base = t.slice(0, -(oldSuffix.length + 1));
    } else {
      if (exempt.has(t)) continue;
      if (next && t.endsWith(`-${next}`)) { exempt.add(t); continue; }
      base = t;
    }
    const to = next ? `${base}-${next}` : base;
    if (to !== t) renames.set(t, to);
  }

  const foreign = new Set([...tokens].filter(t => !renames.has(t) && !(oldSuffix && isTeamLabel(t, oldSuffix, oldExempt))));
  const others = new Set(otherTeamLabels);
  const collisions = [];
  for (const [from, to] of renames) {
    if (others.has(to)) collisions.push({ label: to, from, owner: 'other-team' });
    else if (foreign.has(to)) collisions.push({ label: to, from, owner: 'this-team' });
  }

  const out = renameLabelTokens(shaped, labels, humans, renames,
    { promptFields: ['promptTemplate', 'systemPrompt', 'systemPromptTemplate'] });
  const planned = agents.map((a, i) => {
    const { triggers, ...cfg } = out.members[i];
    const config = { ...cfg };
    if (a.id === teamId) {
      if (Array.isArray(teamCfg.labels)) config.labels = out.bundleLabels;
      if (Array.isArray(teamCfg.humans)) config.humans = out.humans;
      if (next) config.labelSuffix = next; else delete config.labelSuffix;
      // Exempt names are only meaningful under the suffix they were recorded
      // for; a removed suffix leaves nothing to tell apart.
      if (next && exempt.size) config.labelSuffixExempt = [...exempt].sort();
      else delete config.labelSuffixExempt;
    }
    const before = a.config || {};
    return {
      id: a.id,
      config,
      triggers,
      configChanged: JSON.stringify(config) !== JSON.stringify(before),
      triggersChanged: JSON.stringify(triggers) !== JSON.stringify(Array.isArray(a.triggers) ? a.triggers : []),
    };
  });

  return {
    oldSuffix,
    newSuffix: next,
    renames: [...renames].map(([from, to]) => ({ from, to })),
    collisions,
    agents: planned,
    exempt: [...exempt],
  };
}

/**
 * The GitHub renames a suffix change needs (#2858 AC8): the plan's label
 * renames plus the claim lifecycle labels collectLabelTokens does not see —
 * each trigger's `claim.add` (`<wake>:wip`) and its completion mirror
 * `<claim.remove>:completed` (the runner's CLAIM_COMPLETED_SUFFIX). Items in
 * flight carry those, so they must move with the wake label or the poller,
 * the claim swap and the Flow Control board stop recognising them.
 *
 * Claim labels are created on demand, so they are marked `optional`: a label
 * that does not exist on GitHub is nothing to rename, never created.
 *
 * @param {{ renames: {from: string, to: string}[], agents: { id: string, triggers: object[] }[] }} plan
 * @param {{ id: string, triggers: object[] }[]} agents - the agents planSuffixChange was given
 * @returns {{ from: string, to: string, optional?: true }[]}
 */
function githubRenamesForPlan(plan, agents) {
  const out = (plan.renames || []).map(r => ({ from: r.from, to: r.to }));
  const seen = new Set(out.map(r => r.from));
  const add = (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return;
    from = from.trim(); to = to.trim();
    if (!from || !to || from === to || seen.has(from)) return;
    seen.add(from);
    out.push({ from, to, optional: true });
  };
  const before = new Map(agents.map(a => [a.id, Array.isArray(a.triggers) ? a.triggers : []]));
  for (const a of plan.agents || []) {
    const old = before.get(a.id) || [];
    (Array.isArray(a.triggers) ? a.triggers : []).forEach((t, i) => {
      const was = old[i] && old[i].claim;
      const now = t && t.claim;
      if (!was || !now || typeof was !== 'object' || typeof now !== 'object') return;
      add(was.add, now.add);
      if (typeof was.remove === 'string' && typeof now.remove === 'string' && was.remove.trim() && now.remove.trim()) {
        add(`${was.remove.trim()}:completed`, `${now.remove.trim()}:completed`);
      }
    });
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = {
  SUFFIX_RE, SUFFIX_RULE, validateSuffix, suggestSuffix, collectLabelTokens, applyLabelSuffix, stampLiveLabels,
  renameLabelTokens, isTeamLabel, teamForeignLabels, planSuffixChange, githubRenamesForPlan,
};
