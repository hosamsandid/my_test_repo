// Pure decision core for the unified Single Agent page (#1664, Phase A of #1661).
//
// The page used to fork up front between two modes — "From a GitHub repository"
// and "LLM only / no repository" — via a segmented toggle. That was a false
// fork: whether an agent has a repository is just one optional detail, not a
// different kind of agent. This module collapses the two paths into one form
// where the repository is an optional field, and decides — from whether a repo
// URL was entered — which existing backend endpoint the submission targets.
//
// Both endpoints are unchanged (AC8): a repo URL routes to POST /api/quickstart
// (with the SSH-key / token pickers), an empty repo URL routes to the LLM-only
// POST /api/quickstart/llm (name + provider only). Kept pure (no React / no
// fetch) so the routing, body shape and submit-readiness are unit-testable
// without a DOM (the #651 convention); QuickStart.jsx is the thin renderer.

// Has the user entered a (non-whitespace) repository URL? This single predicate
// is the fork: everything downstream (endpoint, body, prerequisites) keys off it.
export function hasRepoUrl(url) {
  return typeof url === 'string' && url.trim().length > 0;
}

// The existing backend endpoint the submission targets, chosen purely by whether
// a repo URL is present. Neither endpoint changes (AC8) — this only picks between
// them.
export function quickstartEndpoint(url) {
  return hasRepoUrl(url) ? '/api/quickstart' : '/api/quickstart/llm';
}

// The request body for the chosen endpoint. Repo path: url + optional token/ssh
// pickers, exactly as today. LLM path: display name + selected provider only —
// no token or SSH key demanded (AC4).
export function quickstartBody({ url, tokenId, sshKeyId, displayName, llmEndpointId }) {
  if (hasRepoUrl(url)) {
    return {
      url: url.trim(),
      githubTokenId: tokenId || undefined,
      sshKeyId: sshKeyId || undefined,
    };
  }
  return {
    displayName: (displayName || '').trim(),
    llmEndpointId: llmEndpointId || '',
  };
}

// GitHub prerequisites (a token AND an SSH key) are enforced ONLY when a repo URL
// is present (AC5). A repo-less submission never depends on them.
export function repoPrerequisitesMet({ hasTokens, hasSshKeys }) {
  return !!hasTokens && !!hasSshKeys;
}

// Whether the token / SSH-key warning cards (and the picker fields) are relevant:
// only once a repo URL has been entered. Before that the page shows no GitHub
// prerequisites at all.
export function showRepoPrerequisites(url) {
  return hasRepoUrl(url);
}

// --- No usable model provider: lock the form, guide honestly (#2084) --------
//
// The page used to show ONE message to everyone when no provider was usable —
// "No model provider configured — Add provider →" — with the link pointing at
// /models, a route `canAccessCredentialPages` closes to a plain Team Member.
// Following in-form guidance therefore bounced that user to /chats: a dead end
// dressed up as a fix. Two things replace it, both keyed on whether the caller
// may add a provider at all (the SAME predicate that gates the route, passed in
// by the page as `canAddProvider` — kept as an argument rather than imported so
// a later policy change to *who* may add re-points one call site, not this
// module).
//
// 1. The form is LOCKED up front (`providerLockActive`) instead of letting the
//    user name an assistant and then fail on submit.
// 2. The guidance is role-aware (`providerGuidance`): a caller who can add one
//    keeps a working link; a caller who cannot gets a passive, honest sentence
//    with NO link, so there is nothing to click that could redirect them.
export const PROVIDER_GUIDANCE_COPY = {
  // Shown to a caller who can act on it — unchanged from before.
  canAdd: 'An agent needs a model provider — it is the only thing it runs on.',
  linkLabel: 'Add provider →',
  linkTo: '/models',
  // Shown to a caller who cannot. It says what is missing and who to ask,
  // and deliberately offers no affordance at all.
  cannotAdd:
    'No model provider is set up for you yet. Please ask a Team or System '
    + 'Administrator to add one.',
};

// Is the form locked because no model provider can be used? Deliberately keyed
// on the loading flag as well: while the provider list is in flight we know
// neither that one exists nor that none does, so the page shows its existing
// loading state rather than a premature lock (or a dead link).
export function providerLockActive({ llmEndpointsLoading, hasLlmEndpoints }) {
  return !llmEndpointsLoading && !hasLlmEndpoints;
}

// The guidance to render in place of the old one-size-fits-all warning. Returns
// a `link` only when the caller may actually open it — the renderer has no other
// branch to get wrong, and a `null` link cannot be turned into a dead one.
export function providerGuidance({ canAddProvider }) {
  if (canAddProvider) {
    return {
      canAddProvider: true,
      text: PROVIDER_GUIDANCE_COPY.canAdd,
      link: { to: PROVIDER_GUIDANCE_COPY.linkTo, label: PROVIDER_GUIDANCE_COPY.linkLabel },
    };
  }
  return {
    canAddProvider: false,
    text: PROVIDER_GUIDANCE_COPY.cannotAdd,
    link: null,
  };
}

// The submit-checklist wording for the missing provider. Role-aware for the same
// reason the card is: "Add a model provider" is an instruction a plain Team
// Member cannot carry out, which is guidance that misleads rather than helps.
export function providerBlockerMessage(canAddProvider) {
  return canAddProvider
    ? 'Add a model provider — an agent needs one to run.'
    : 'Ask a Team or System Administrator to add a model provider — an agent needs one to run.';
}

// Can the form be submitted?
//   - no usable provider: never (#2084). An agent needs a provider in BOTH
//     paths — it is the only thing it runs on — so the repo path is now gated
//     on it too. Previously it was not: the backend auto-binds a default
//     provider there and reports an `llmWarning` instead, which created an
//     agent that could not answer its first message. That is the same dead end
//     from the other side, so the lock covers both paths.
//   - repo present: GitHub prerequisites must be met (token + SSH key) — the URL
//     itself is non-empty by definition here.
//   - repo absent : a model provider must be selected, and a name given
//     (AC4 / AC6).
export function canSubmitQuickstart({
  url,
  hasTokens,
  hasSshKeys,
  hasLlmEndpoints,
  displayName,
  selectedLlmId,
}) {
  if (!hasLlmEndpoints) return false;
  if (hasRepoUrl(url)) {
    return repoPrerequisitesMet({ hasTokens, hasSshKeys });
  }
  return !!(displayName || '').trim() && !!selectedLlmId;
}

// Why is the "Create agent & start chatting" button disabled? This is the SAME
// gate as canSubmitQuickstart, broken out into the specific unmet requirements
// so QuickStart.jsx can show a plain-language checklist instead of an
// unexplained grey button — the "explain a disabled submit button" discipline
// already applied by model-provider-submit-state.js / submit-hint.js. This
// matters most here because QuickStart is the first page a new user meets: a
// button that greys out with no reason reads as "broken", not "one thing left
// to do".
//
// Parity with canSubmitQuickstart is a hard invariant (asserted in the test):
// reasons.length === 0 iff canSubmitQuickstart returns true — the checklist and
// the button can never disagree. The reason order follows the form's own
// top-to-bottom field order so the list reads in the sequence the user fills in.
export function quickstartSubmitReasons({
  url,
  hasTokens,
  hasSshKeys,
  hasLlmEndpoints,
  displayName,
  selectedLlmId,
  canAddProvider,
}) {
  // No usable provider ⇒ the form is locked, so the provider is the ONLY thing
  // worth reporting (#2084). Listing "Enter a name for your assistant." first
  // — as this did before — asks the user to fill a field that cannot lead
  // anywhere, and buries the one item that actually blocks them.
  if (!hasLlmEndpoints) {
    return {
      canSubmit: false,
      reasons: [{ field: 'provider', message: providerBlockerMessage(canAddProvider) }],
    };
  }
  const reasons = [];
  if (hasRepoUrl(url)) {
    // Repo path: the backend auto-binds the default model provider, so the gate
    // is only the two GitHub prerequisites. Field order matches the form — the
    // SSH-key picker is rendered above the token picker.
    if (!hasSshKeys) {
      reasons.push({
        field: 'ssh-key',
        message: 'Add an SSH key — the repository is cloned over SSH.',
      });
    }
    if (!hasTokens) {
      reasons.push({
        field: 'github-token',
        message: 'Add a GitHub token — a repository-backed agent needs one for pull requests and event polling.',
      });
    }
  } else {
    // Repo-less path: a name, and a provider CHOICE — that at least one exists
    // is guaranteed by the lock above.
    if (!(displayName || '').trim()) {
      reasons.push({ field: 'name', message: 'Enter a name for your assistant.' });
    }
    if (!selectedLlmId) {
      reasons.push({ field: 'provider', message: 'Choose a model provider.' });
    }
  }
  return { canSubmit: reasons.length === 0, reasons };
}

// --- Copy: Phase D framing (#1667, decision D5 — "a single agent is a team of
// one") ---
//
// The fast lane produces ONE assistant: the smallest possible team, not a
// separate "mode" the user picked instead of "team". So the heading and the
// forward link frame a team as this same thing SCALED UP ("grow into a full
// team") — never as an either/or the user must classify up front. Held here as
// data so the reframing is unit-testable and QuickStart.jsx stays a thin
// renderer (#651 convention).
// E14 of epic #1870 (#1888) removed the second, near-duplicate paragraph
// (`detail`) and shortened the team-of-one note: what the two submit paths
// actually create — which fields each one uses, the environment/agent reuse, the
// prerequisites — is the `create` help topic, reachable from the page's "?".
// #2045 then removed the team-of-one note and its `growCtaLabel` forward link
// entirely: a second call-to-action under the form competed with the one action
// this page exists for. Only the heading and the intro are left, so this object
// is now the page's title copy and nothing else.
export const QUICKSTART_COPY = {
  heading: 'Chat with one assistant',
  intro:
    'Name your assistant, pick a model provider, and start chatting. Point it at a '
    + 'GitHub repository if you want it to read code — that part is optional.',
};

// AC3 guard (#1667): none of the launcher-path (fast-lane) copy may frame
// single-vs-team as a forced, up-front choice. It rejects the tell-tale
// mode-picker phrasings that were removed ("…team instead", "…for that",
// "agent vs team"). Expressed as a predicate so the reframe is asserted, not
// eyeballed.
//
// It no longer *requires* the "a single agent is a team of one" wording to be
// present. #2045 removed the note that carried it, so the requirement would
// have kept a string alive purely to satisfy a guard — which is what a
// dead-copy check looks like once its surface is gone. The framing itself is
// unaffected: the launcher hero still promises growing into a team where the
// choice is actually made (#2027, guarded in onboarding-help-copy.test.js) and
// the `create` topic still owns the reasoning in its own chapter. What this
// guard protects is the thing that could still regress here — the heading and
// intro drifting back into "agent or team, pick now" phrasing.
export function fastLaneCopyForcesModeChoice(copy = QUICKSTART_COPY) {
  const blob = Object.values(copy).join(' ').toLowerCase();
  const forcedFraming = [
    'agent vs team',
    ' vs team',
    'team instead',
    'teams instead',
    'for that', // "…use the Agent Team Wizard for that"
    'single agent vs',
  ];
  return forcedFraming.some((p) => blob.includes(p));
}
