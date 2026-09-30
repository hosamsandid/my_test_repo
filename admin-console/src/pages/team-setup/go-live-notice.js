// Pure copy for the Team-Wizard Review step's "What happens next" notice
// (#1129, reworded per #2658). React-free so it runs under `node --test`; the
// JSX (GoLiveNotice in TeamSetup.jsx) only renders the parts returned here.
//
// The notice states the consequence of the final click, and that consequence
// depends on two inputs: whether members are provisioned now (materializeNow —
// unticked means stubs, nothing goes live) and whether a repository is bound
// (repo-less means nothing watches GitHub).

// True when the process hands work over on GitHub: a channel carrying an issue
// or a PR, a GitHub produce flag, a github-event trigger, a GitHub outcome
// action (open issue / PR, set label), or a label registry. A repo-less team
// running such a process has hand-offs that cannot fire.
export function bundleUsesGithub(bundle) {
  if (!bundle || typeof bundle !== 'object') return false;
  if (Array.isArray(bundle.labels) && bundle.labels.length > 0) return true;
  const GITHUB_ACTIONS = new Set(['openIssue', 'openPr', 'setLabel']);
  return (bundle.roles || []).some((role) => {
    if (!role || typeof role !== 'object') return false;
    if ((role.channels || []).some(c => c && (c.artifact === 'issue' || c.artifact === 'pr' || c.label))) return true;
    if (role.github && (role.github.producesPr || role.github.producesIssue)) return true;
    if ((role.triggers || []).some(t => t && t.type === 'github-event')) return true;
    const options = (role.outcomes && role.outcomes.options) || [];
    return options.some(o => ((o && o.actions) || []).some(a => a && GITHUB_ACTIONS.has(a.type)));
  });
}

// { tone, before, code, after, repoWarning } — `code` (the repository label) is
// rendered as <code> between `before` and `after`; it is null when the sentence
// names no repository. `tone` is 'warning' when agents go live, 'info' for stubs.
// `repoWarning` is set for a repo-less team whose process relies on GitHub.
export function goLiveNotice({ agentCount, repoLabel, materializeNow, usesGithub }) {
  const agents = agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'}` : 'the team’s agents';
  const repoWarning = !repoLabel && usesGithub
    ? 'This process hands work over on GitHub (issues, pull requests, labels), but the team has no '
      + 'repository — those hand-offs cannot work until a repository is added to the team’s environment.'
    : null;
  if (!materializeNow) {
    return {
      tone: 'info',
      before: `Creating the team writes ${agents} as stubs — nothing goes live yet: no container starts, `
        + 'no repository is cloned and no agent acts on its own. Provision each one later by enabling it; '
        + 'Agent Chat lists them under “Not materialized yet”.',
      code: null,
      after: '',
      repoWarning,
    };
  }
  if (!repoLabel) {
    return {
      tone: 'warning',
      before: `Creating the team provisions ${agents} that go live immediately. The team has no repository, `
        + 'so nothing watches GitHub — the agents act when you chat with them and on their own schedules.',
      code: null,
      after: '',
      repoWarning,
    };
  }
  return {
    tone: 'warning',
    before: `Creating the team provisions ${agents} that go live immediately and begin watching `,
    code: repoLabel,
    after: ' for issues and pull requests, acting autonomously from that moment.',
    repoWarning,
  };
}
