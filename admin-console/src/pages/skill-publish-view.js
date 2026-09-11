/**
 * Pure decisions for publishing an agent's edited skill up to the team/global
 * pool (#2180) — shared by the Skills page's agent-tier row action and the
 * Knowledge page's per-agent private-skills panel, via the shared
 * `PublishSkillAction` component, so the two surfaces cannot drift (design
 * decision 4 of the linked issue).
 */

// A drift state that means "nothing has actually changed here" — an unchanged
// seed copy (in-sync), or a copy whose SOURCE moved on while the agent's own
// copy never did (outdated — nothing local to give back). Everything else
// (diverged / conflict / orphaned / unknown, or no recorded drift at all —
// a hand-authored skill) is a legitimate publish candidate.
const NON_CANDIDATE_DRIFT_STATES = new Set(['in-sync', 'outdated']);

// `drift` is undefined for a hand-authored (never-granted) skill — always a
// candidate. A recorded state only excludes when it proves nothing changed.
export function isPublishEligible(drift) {
  return !NON_CANDIDATE_DRIFT_STATES.has(drift);
}

// The two publish paths the operator chooses between (design decision 1: BOTH
// are offered — a direct agent→global publish, and the staged
// agent→team→global path — never just one).
export const PUBLISH_PATHS = Object.freeze([
  {
    id: 'direct',
    label: 'Publish to global',
    hint: "Copy this agent's edited skill directly into the global pool.",
  },
  {
    id: 'staged',
    label: 'Publish via team pool',
    hint: 'Lift this skill into the team pool, then promote that copy to the global pool.',
  },
]);

// The ordered POST /api/skills/transfer bodies for a chosen path. `staged` is
// two sequential calls (lift, then promote); `direct` is one. Pure — the
// caller does the fetching, in order, stopping to resolve an overwrite
// collision on whichever step reports one.
export function publishSteps(pathId, { name, agentId, teamId }) {
  const lift = { name, from: { tier: 'agent', agentId }, to: { tier: 'team', teamId }, mode: 'copy' };
  const direct = { name, from: { tier: 'agent', agentId }, to: { tier: 'global' }, mode: 'copy' };
  const promote = { name, from: { tier: 'team', teamId }, to: { tier: 'global' }, mode: 'copy' };
  if (pathId === 'staged') return [lift, promote];
  return [direct];
}

// Human label for whichever step is in flight / just failed, keyed by the
// step's own `to.tier` (a lift targets 'team', direct-publish and promote both
// target 'global' but only one step of a plan ever does).
export function stepVerb(step) {
  if (!step) return 'Publishing';
  if (step.to?.tier === 'team') return 'Lifting to team';
  return 'Publishing to global';
}
