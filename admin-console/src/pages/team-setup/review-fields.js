// Pure derivation of the Team-Wizard Review step's scalar summary fields (#760).
//
// The Review step's compaction is presentation-only, but the value each field
// shows (including the "—" / empty-state placeholders) is worth pinning down
// with a unit test. This module is deliberately React-free and fs-free so it
// runs under `node --test`; the JSX (StepReview) resolves the environment / SSH
// / token lookups (and the env's credential descriptors, #2658) and supplies the
// knowledge-learning constants — which live in a React component module — as
// plain data via `knowledgeMeta`.

const DASH = '—';

// One-line summary of the promotion gates, matching the wizard's Knowledge step.
export function knowledgeGateSummary(kc, gateOrder, gateLabels) {
  return gateOrder
    .map((tr) => {
      const state = tr === 'team>global'
        ? 'always reviewed'
        : (((kc.gates || {})[tr] || 'review') === 'auto' ? 'automatic' : 'needs review');
      return `${gateLabels[tr]}: ${state}`;
    })
    .join(' · ');
}

// The single-line "Knowledge learning" value (autonomy + review + gates).
export function knowledgeLearningValue(form, knowledgeMeta) {
  const { defaults, autonomyLevels, gateOrder, gateLabels } = knowledgeMeta;
  const kc = form.knowledgeConfig || defaults;
  const lvl = autonomyLevels.find((l) => l.level === kc.autonomy) || autonomyLevels[1];
  return `Autonomy ${kc.autonomy} · ${lvl.label} · Review ${kc.review ? 'on' : 'off'} · ${knowledgeGateSummary(kc, gateOrder, gateLabels)}`;
}

// How one credential row reads on the Review step (#2658). `id` is the
// credential the environment references, `visible` the caller's own lookup row
// for it (their scope-filtered /api/ssh-keys or /api/github-tokens list), and
// `ref` the metadata-only descriptor from GET /api/environments/:id
// `credentialRefs` ({ tier, ownerLabel, visibleToCaller }). A credential the
// caller cannot see is still a credential the team will use — it must never
// read as "no credential".
export function credentialValue({ id, visible, ref, noun }) {
  if (!id) return 'none';
  if (visible) return visible.name;
  if (ref) {
    const hidden = ref.visibleToCaller ? '' : ' (hidden)';
    if (ref.tier === 'personal') return `personal ${noun} of ${ref.ownerLabel}${hidden}`;
    if (ref.tier === 'system') return `system ${noun}${hidden}`;
    return `team ${noun} of ${ref.ownerLabel}${hidden}`;
  }
  // Descriptor not loaded yet (or a dangling reference): still say it is set.
  return `${id} (not visible to you)`;
}

// The identity the team's GitHub writes (commits, PRs, reviews) will carry, when
// it differs from the environment's token (#2658). The wizard's caller becomes
// the new team's Team Admin, and a Team Admin's personal GitHub token overrides
// the environment's for autonomous work (credential-resolution.js baseline).
// `personalToken` is the caller's own personal token row, or undefined. Returns
// null when there is nothing different to say (no repository, no personal
// token, or the environment already uses that very token).
export function githubIdentityValue({ form, personalToken }) {
  if (!form.repoUrl || !personalToken) return null;
  if (personalToken.id === form.githubTokenId) return null;
  return `your personal token ${personalToken.name} (used instead of the environment's token for commits, PRs and reviews)`;
}

// Ordered list of the scalar review fields shown as { key, label, value }.
// `env`, `sshKey`, `ghToken` are the already-resolved lookup rows (or undefined);
// `credentialRefs` is the env detail's descriptor map (or undefined) and
// `personalToken` the caller's own personal GitHub token (or undefined).
export function buildReviewFields({ form, env, sshKey, ghToken, credentialRefs, personalToken, knowledgeMeta }) {
  const refs = credentialRefs || {};
  const identity = githubIdentityValue({ form, personalToken });
  return [
    { key: 'team', label: 'Team', value: `${form.teamName} (${form.teamId})` },
    ...(form.labelSuffix ? [{ key: 'labelSuffix', label: 'Label suffix', value: form.labelSuffix }] : []),
    {
      key: 'environment',
      label: 'Environment',
      value: env ? `${env.name} (${env.id})` : (form.environmentId || 'none (a fresh one is created for this team)'),
    },
    {
      key: 'repository',
      label: 'Repository',
      value: form.repoUrl ? `${form.repoUrl} @ ${form.branch || 'main'}` : 'none (repo-less team)',
    },
    {
      key: 'sshKey',
      label: 'SSH Key',
      value: credentialValue({ id: form.sshKeyId, visible: sshKey, ref: refs[form.sshKeyId], noun: 'SSH key' }),
    },
    {
      key: 'githubToken',
      label: 'GitHub Token',
      value: credentialValue({ id: form.githubTokenId, visible: ghToken, ref: refs[form.githubTokenId], noun: 'token' }),
    },
    ...(identity ? [{ key: 'githubIdentity', label: 'Acts on GitHub as', value: identity }] : []),
    {
      key: 'skills',
      label: 'Initial team skills',
      value: (form.skills || []).length ? form.skills.join(', ') : DASH,
    },
    { key: 'knowledge', label: 'Knowledge learning', value: knowledgeLearningValue(form, knowledgeMeta) },
  ];
}
