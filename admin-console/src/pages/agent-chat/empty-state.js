// Pure descriptor for the Agent Chat left-rail "no agents yet" empty state (#1893).
//
// The empty state is the first-run experience. It used to offer three links
// (/quickstart "Create a single agent", /team-setup "Set up a team",
// /getting-started overview) — targets that drifted after the create flows were
// consolidated behind the unified launcher (#1665). It now offers a SINGLE
// call-to-action pointing at /create, the same launcher the persistent
// "+ Create" sidebar control navigates to, so there is one obvious next step.

export const CREATE_ROUTE = '/create';

// The single primary CTA shown when the agent list is empty.
export function emptyStateCta() {
  return { to: CREATE_ROUTE, label: 'Create your first agent' };
}
