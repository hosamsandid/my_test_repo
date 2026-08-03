/**
 * Pure view model for the Prompt tab's meta badges + the read-only
 * behaviour rows beneath them (#1112).
 *
 * The Prompt tab (`PromptPreviewPanel.jsx`) is the only place three
 * behaviour-shaping settings surface at all — `sessionPolicy` (fresh vs.
 * continued context), autonomy (unattended vs. chat-driven) and whether the
 * agent was instantiated from a saved template. Previously they rendered as
 * bare pills ("per-invocation", "autonomous", "blueprint") with no tooltip
 * and no legend, and "blueprint" was internal legacy vocabulary that appears
 * nowhere else in the UI.
 *
 * This module keeps the wording (labels, tooltips, help text) out of the JSX
 * shell so it lands in the `admin-console-src` CI job with node:test coverage
 * (the JSX panel itself stays uncovered per #651). It holds no state and
 * touches no DOM.
 *
 * `meta` is the `meta` object from `GET /api/agents/:id/prompt-preview`:
 *   { autonomous, sessionPolicy, blueprintInstance, hasRepository, hasSkills,
 *     hasKnowledgeDigest, environmentId, environmentName }
 */

// One-line meaning for each session policy. `persistent` is the legacy default
// applied server-side when the field is absent (`cfg.sessionPolicy || 'persistent'`).
export const SESSION_POLICY_HELP = {
  'per-invocation':
    'Fresh context each run — every triggered run starts with an empty context window and no memory of earlier runs, so anything the next run needs must be persisted to disk (memory/, the worklist).',
  persistent:
    'Continued context — the agent resumes its previous session, so earlier conversation carries over from one run to the next.',
};

// Human label for a session policy value; unknown/empty values pass through
// verbatim (better to show the raw token than to hide it).
export function sessionPolicyLabel(policy) {
  if (policy === 'per-invocation') return 'per-invocation (fresh context)';
  if (policy === 'persistent') return 'persistent (continued context)';
  return policy || 'persistent';
}

// Human label + one-line meaning for autonomy.
export function autonomyLabel(autonomous) {
  return autonomous ? 'Autonomous' : 'Interactive';
}

export function autonomyHelp(autonomous) {
  return autonomous
    ? 'Runs unattended on triggers (schedules, GitHub events, loops) — there may be no human reading in real time.'
    : 'Chat-driven — responds to messages in its DM room; it has no triggers that would run it unattended.';
}

/**
 * Meta badges shown above the prompt preview. Returns `{ label, title }`
 * objects so every pill carries a hover tooltip (AC #1). The set and order
 * mirror the previous bare-string `buildBadges`, with two changes:
 *   - each pill now has an explanatory `title`;
 *   - the legacy "blueprint" pill is relabelled "from template" (AC #3) — the
 *     internal token is replaced with plain wording and explained in the tip.
 */
export function buildBadges(role, meta = {}) {
  const out = [];
  if (role) out.push({ label: role, title: `Agent role: ${role}.` });
  if (meta.sessionPolicy) {
    out.push({
      label: meta.sessionPolicy,
      title: SESSION_POLICY_HELP[meta.sessionPolicy] || 'How context carries from one run to the next.',
    });
  }
  out.push(
    meta.autonomous
      ? { label: 'autonomous', title: autonomyHelp(true) }
      : { label: 'interactive', title: autonomyHelp(false) },
  );
  if (meta.hasRepository) {
    out.push({ label: 'repo', title: 'A Git repository is cloned into this agent’s workspace.' });
  }
  if (meta.hasSkills) {
    out.push({ label: 'skills', title: 'One or more skills are granted and seeded into this agent.' });
  }
  if (meta.blueprintInstance) {
    out.push({
      label: 'from template',
      title: 'Instantiated from a saved BriefingPack template (shown as “blueprint” in older builds).',
    });
  }
  return out;
}

/**
 * Read-only behaviour rows rendered under the badges (AC #2): the two
 * settings that shape how the agent runs but have no field of their own on the
 * Agents page, each with a human value and a one-line explanation.
 */
export function buildSettingRows(meta = {}) {
  return [
    {
      key: 'sessionPolicy',
      label: 'Session policy',
      value: sessionPolicyLabel(meta.sessionPolicy),
      help: SESSION_POLICY_HELP[meta.sessionPolicy] || SESSION_POLICY_HELP.persistent,
    },
    {
      key: 'autonomy',
      label: 'Autonomy',
      value: autonomyLabel(!!meta.autonomous),
      help: autonomyHelp(!!meta.autonomous),
    },
  ];
}
