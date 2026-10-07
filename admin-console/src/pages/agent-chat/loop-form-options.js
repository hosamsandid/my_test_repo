// Plain-language option mappings for the "Start a loop" dialog (#1083).
//
// These translate the loop trigger's technical fields — the `until` shell
// command, the raw `maxTokens` integer and the raw `minGapSeconds` number —
// into selector choices a non-technical user can reason about, WITHOUT changing
// the loop trigger schema or runtime behaviour. The form derives its selector
// state from a stored trigger with the `derive*` helpers and resolves the
// selectors back to the exact wire values with the `resolve*` helpers, so a
// power user's custom command / exact token budget / exact gap round-trips
// untouched. Pure + framework-free so it carries its own node:test suite,
// mirroring trigger-summary.js.

// ── Stop condition ("Done when…") ──────────────────────────────────────────
// Only the `custom` option produces an `until` command; the other two run the
// loop to the iteration cap (the verifier, if set, decides whether a pass
// counts). Two predefined options + a custom escape hatch (#1083 AC2).
export const STOP_CONDITIONS = [
  { value: 'verifier',   label: 'The verifier approves the work' },
  { value: 'iterations', label: 'It reaches the maximum number of tries' },
  { value: 'custom',     label: 'A custom command succeeds (advanced)' },
];

// ── Token budget presets ────────────────────────────────────────────────────
// `tokens: null` = no cap (the platform's runaway safeguard still applies).
// `custom` reveals a raw number field in the advanced section (#1083 AC3).
export const TOKEN_BUDGET_PRESETS = [
  { value: 'none',   label: 'No limit',              tokens: null },
  { value: 'small',  label: 'Small (~500K tokens)',  tokens: 500000 },
  { value: 'medium', label: 'Medium (~2M tokens)',   tokens: 2000000 },
  { value: 'large',  label: 'Large (~8M tokens)',    tokens: 8000000 },
  { value: 'custom', label: 'Custom…',               tokens: undefined },
];

// ── Minimum gap between runs ────────────────────────────────────────────────
// `seconds: 0` = chain immediately (the default). `custom` reveals a raw
// seconds field in the advanced section (#1083 AC4).
export const GAP_PRESETS = [
  { value: 'immediate', label: 'Immediately',  seconds: 0 },
  { value: '1min',      label: '1 minute',     seconds: 60 },
  { value: '5min',      label: '5 minutes',    seconds: 300 },
  { value: '15min',     label: '15 minutes',   seconds: 900 },
  { value: 'custom',    label: 'Custom…',       seconds: undefined },
];

// Derive the "Done when…" selector value from a stored trigger. A stored
// `until` command is the only unambiguous signal (→ 'custom'); otherwise fall
// back to the presence of a verifier to pick the friendlier default.
export function deriveStopCondition(until, hasVerify) {
  const cmd = until && typeof until === 'object' ? until.command : null;
  if (cmd && String(cmd).trim()) return 'custom';
  return hasVerify ? 'verifier' : 'iterations';
}

// Derive the token-budget preset + raw string from a stored `maxTokens`.
// An exact value matching a preset selects it; anything else is 'custom'.
export function deriveTokenBudget(maxTokens) {
  if (maxTokens == null) return { preset: 'none', raw: '' };
  const match = TOKEN_BUDGET_PRESETS.find(p => p.tokens === maxTokens);
  return match ? { preset: match.value, raw: '' } : { preset: 'custom', raw: String(maxTokens) };
}

// Derive the gap preset + raw string from a stored `minGapSeconds`.
export function deriveGap(minGapSeconds) {
  if (minGapSeconds == null) return { preset: 'immediate', raw: '' };
  const match = GAP_PRESETS.find(p => p.seconds === minGapSeconds);
  return match ? { preset: match.value, raw: '' } : { preset: 'custom', raw: String(minGapSeconds) };
}

// Resolve the effective `maxTokens` (number | undefined) to send on save.
// `undefined` = omit the field (no cap). Custom raw is validated as a
// positive number, matching the pre-#1083 raw-field validation.
export function resolveTokenBudget(preset, raw) {
  if (preset === 'custom') {
    const n = Number(raw);
    return String(raw).trim() && Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const p = TOKEN_BUDGET_PRESETS.find(x => x.value === preset);
  return p && p.tokens != null ? p.tokens : undefined;
}

// Resolve the effective `minGapSeconds` (number | undefined) to send on save.
// `undefined` = omit the field (chain immediately). A zero gap is the default,
// so it also serializes as absent — keeping the wire output minimal.
export function resolveGapSeconds(preset, raw) {
  if (preset === 'custom') {
    const n = Number(raw);
    if (!String(raw).trim() || !Number.isFinite(n) || n < 0) return undefined;
    return n > 0 ? n : undefined;
  }
  const p = GAP_PRESETS.find(x => x.value === preset);
  return p && p.seconds > 0 ? p.seconds : undefined;
}

// Verifier copy for the loop form's "Who checks the work?" field (#2682). A
// team agent's blank verifier is filled with a sibling — client-side on roster
// load and again server-side on save (concept §4.6) — but only when a sibling
// exists. With no other member in the Agent Team nothing can be assigned and
// the loop runs self-graded, so the copy must say that instead of promising a
// teammate. `roster` is the form's loopRoster ({ isTeamAgent, siblings }) or
// null while loading. Returns { noneLabel, notice, noticeTone, enforced }
// (notice null = no notice; enforced = a separate verifier will be applied).
export function loopVerifierCopy(roster) {
  const isTeamAgent = !!roster?.isTeamAgent;
  const hasSibling = Array.isArray(roster?.siblings) && roster.siblings.length > 0;
  if (!isTeamAgent) {
    return { noneLabel: 'No one (the agent judges itself)', notice: null, noticeTone: null, enforced: false };
  }
  if (!hasSibling) {
    return {
      noneLabel: 'No one (no teammate available — the agent checks its own work)',
      notice: 'No teammate available — this Agent Team has no other member, so the agent '
        + 'checks its own work. For an independent check, choose a command that must pass '
        + 'each try, or add a reviewer to the team.',
      noticeTone: 'info',
      enforced: false,
    };
  }
  return {
    noneLabel: 'No one (a teammate is assigned automatically)',
    notice: 'Team agents must not grade their own work — a separate teammate is '
      + 'assigned automatically and re-applied on save even if left blank.',
    noticeTone: 'warning',
    enforced: true,
  };
}
