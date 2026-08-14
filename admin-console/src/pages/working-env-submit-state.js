// Pure submit-gate helper for the Working Environment create/edit form
// (WorkingEnvironments.jsx).
//
// Before this module the gate lived inline as a single boolean:
//
//   const reposValid = form.repositories.every(r => r.url.trim());
//   const canSubmit  = form.id && form.name && reposValid;
//
// so the "Create environment" / "Save changes" button just went grey with no
// explanation. The non-obvious case is `reposValid`: a user fills in Name and
// ID, clicks "Add repository", then leaves the URL blank — and the button
// silently disables with every visible required field apparently filled. That
// is the exact "the platform isn't self-explanatory" friction the disabled-
// submit-button pattern addresses (ModelRegistry model-provider-submit-state.js
// #1302, Agents agent-create-submit-state.js #1773).
//
// This derives the SAME gate PLUS the ordered list of specific unmet
// requirements from ONE place, so the disabled button and the "why is this
// disabled" hint can never disagree. Kept pure (no React) so it is unit-tested
// in working-env-submit-state.test.js.

// Match the original gate exactly for Name / ID: they were checked truthy
// (`form.id && form.name`), not trimmed — the IdField already slug-sanitises
// the id, so a whitespace-only id cannot occur, and preserving the truthy check
// keeps `canSubmit` byte-equivalent to the prior inline expression.
const present = v => Boolean(String(v ?? ''));

/**
 * Derive whether the Working Environment form can be submitted and, when it
 * cannot, the ordered list of unmet requirements to surface to the user. The
 * order follows the form top-to-bottom (Name → ID → Repositories).
 *
 * @param form.name          raw Name field
 * @param form.id            raw ID field (auto-derived from the name)
 * @param form.repositories  array of { url, branch, sshKeyId } repository rows
 * @returns {{ canSubmit: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeWorkingEnvSubmitState(form = {}) {
  const { name, id } = form;
  const repositories = Array.isArray(form.repositories) ? form.repositories : [];

  const reasons = [];

  if (!present(name)) {
    reasons.push({ field: 'name', message: 'Enter a name.' });
  }
  if (!present(id)) {
    reasons.push({ field: 'id', message: 'Enter an ID (auto-derived from the name).' });
  }
  // Every *added* repository row must carry a URL. An environment with no repo
  // rows at all is valid (LLM-only / credential-free agents) — the block is
  // specifically a row that was added but left blank.
  const hasEmptyRepo = repositories.some(r => !String(r?.url ?? '').trim());
  if (hasEmptyRepo) {
    reasons.push({
      field: 'repositories',
      message: 'Give every added repository a URL, or remove the empty row.',
    });
  }

  return { canSubmit: reasons.length === 0, reasons };
}
