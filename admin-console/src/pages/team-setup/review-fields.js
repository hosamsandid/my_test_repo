// Pure derivation of the Team-Wizard Review step's scalar summary fields (#760).
//
// The Review step's compaction is presentation-only, but the value each field
// shows (including the "—" / empty-state placeholders) is worth pinning down
// with a unit test. This module is deliberately React-free and fs-free so it
// runs under `node --test`; the JSX (StepReview) resolves the environment / SSH
// / token lookups and supplies the knowledge-learning constants — which live in
// a React component module — as plain data via `knowledgeMeta`.

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

// Ordered list of the scalar review fields shown as { key, label, value }.
// `env`, `sshKey`, `ghToken` are the already-resolved lookup rows (or undefined).
export function buildReviewFields({ form, env, sshKey, ghToken, knowledgeMeta }) {
  return [
    { key: 'team', label: 'Team', value: `${form.teamName} (${form.teamId})` },
    ...(form.labelSuffix ? [{ key: 'labelSuffix', label: 'Label suffix', value: form.labelSuffix }] : []),
    {
      key: 'environment',
      label: 'Environment',
      value: env ? `${env.name} (${env.id})` : (form.environmentId || DASH),
    },
    { key: 'repository', label: 'Repository', value: `${form.repoUrl} @ ${form.branch || 'main'}` },
    { key: 'sshKey', label: 'SSH Key', value: sshKey ? sshKey.name : DASH },
    { key: 'githubToken', label: 'GitHub Token', value: ghToken ? ghToken.name : DASH },
    {
      key: 'skills',
      label: 'Initial team skills',
      value: (form.skills || []).length ? form.skills.join(', ') : DASH,
    },
    { key: 'knowledge', label: 'Knowledge learning', value: knowledgeLearningValue(form, knowledgeMeta) },
  ];
}
