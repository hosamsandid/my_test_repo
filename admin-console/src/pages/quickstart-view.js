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
