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

// Can the form be submitted?
//   - repo present: GitHub prerequisites must be met (token + SSH key) — the URL
//     itself is non-empty by definition here.
//   - repo absent : a model provider must exist and be selected, and a name given
//     (AC4 / AC6). A model provider is required in both cases (AC6), but for the
//     repo path the backend auto-binds the default provider, so — unchanged from
//     before — the repo path is not hard-blocked on the selection here (the
//     "no model provider" guidance still shows).
export function canSubmitQuickstart({
  url,
  hasTokens,
  hasSshKeys,
  hasLlmEndpoints,
  displayName,
  selectedLlmId,
}) {
  if (hasRepoUrl(url)) {
    return repoPrerequisitesMet({ hasTokens, hasSshKeys });
  }
  return !!hasLlmEndpoints && !!(displayName || '').trim() && !!selectedLlmId;
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
}) {
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
    // Repo-less path: a name, and a model provider for the agent to run on.
    if (!(displayName || '').trim()) {
      reasons.push({ field: 'name', message: 'Enter a name for your assistant.' });
    }
    if (!hasLlmEndpoints) {
      reasons.push({
        field: 'provider',
        message: 'Add a model provider — an agent needs one to run.',
      });
    } else if (!selectedLlmId) {
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
export const QUICKSTART_COPY = {
  heading: 'Chat with one assistant',
  intro:
    'Name your assistant, pick a model provider, and start chatting. Point it at a '
    + 'GitHub repository if you want it to read code — that part is optional.',
  // A single agent is simply a team of one — growing into a full team is an
  // optional next step, never a mode you should have chosen instead (AC1/AC3).
  // The framing stays on the page (it is what keeps the fast lane from reading as
  // a separate mode); the "what growing means" detail lives in the topic.
  teamOfOneNote: 'A single agent is simply a team of one.',
  growCtaLabel: 'Grow into a full team',
};

// AC3 guard: none of the launcher-path (fast-lane) copy may frame single-vs-team
// as a forced, up-front choice. Rejects the tell-tale mode-picker phrasings we
// removed ("…team instead", "…for that", "agent vs team") AND requires the
// "team of one" framing to be present. Expressed as a predicate so the reframe
// is asserted, not eyeballed.
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
  const hasForcedFraming = forcedFraming.some((p) => blob.includes(p));
  const hasTeamOfOne = blob.includes('team of one');
  return hasForcedFraming || !hasTeamOfOne;
}
