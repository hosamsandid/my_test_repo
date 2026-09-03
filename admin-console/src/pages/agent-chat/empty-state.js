// Pure descriptor for the Agent Chat left-rail "no agents yet" empty state.
//
// History, because the shape changed twice for opposite reasons. It used to
// offer three links (/quickstart "Create a single agent", /team-setup "Set up a
// team", /getting-started overview) — targets that drifted after the create
// flows were consolidated behind the unified launcher (#1665) — so #1893
// replaced them with a SINGLE call-to-action button pointing at /create.
//
// #1956 moved the chat's create/import actions into the Shell's page-action
// header, where every other page keeps them. That turns the button here into a
// *second* interactive way to do the same thing, which is what the house
// pattern forbids: `WorkingEnvironments.jsx` and `Briefings.jsx` both keep a
// text pointer in the empty state and the real action in the header. So this is
// a sentence naming the header button, not a competing call to action.

export const CREATE_ROUTE = '/create';

// The header button this points at. Exported so the sentence below and the
// button `AgentChat` renders cannot drift into naming two different controls.
export const HEADER_CREATE_LABEL = 'New Agent';

// The text pointer shown when the agent list is empty.
export function emptyStatePointer() {
  return {
    lead: 'No agents yet.',
    hint: `Use ${HEADER_CREATE_LABEL} at the top of the page to create one.`,
  };
}
