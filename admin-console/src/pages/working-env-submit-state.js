// Pure submit-gate helper for the Working Environment create/edit form
// (EnvironmentTemplates.jsx).
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

// First value that occurs more than once, or null. Order-preserving so the
// message names the id the user sees first.
function firstDuplicate(values) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

/**
 * Derive whether the Working Environment form can be submitted and, when it
 * cannot, the ordered list of unmet requirements to surface to the user. The
 * order follows the form top-to-bottom (Name → ID → Repositories → MCP servers).
 *
 * @param form.name          raw Name field
 * @param form.id            raw ID field (auto-derived from the name)
 * @param form.repositories  array of { url, branch, sshKeyId } repository rows
 * @param form.mcpServers    array of { serverId, credentialId } picker rows (#2051)
 * @returns {{ canSubmit: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeWorkingEnvSubmitState(form = {}) {
  const { name, id } = form;
  const repositories = Array.isArray(form.repositories) ? form.repositories : [];
  const mcpServers = Array.isArray(form.mcpServers) ? form.mcpServers : [];

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
  reasons.push(...describeMcpRowBlockers(mcpServers));

  return { canSubmit: reasons.length === 0, reasons };
}

/**
 * The MCP picker rows' own blockers, in form order. Shared by every surface
 * that renders the picker — the Working Environment form, the team's MCP tab
 * and a team-member's Custom MCP set (#2289) — so the same rows are blocked
 * for the same reasons everywhere, inline, before the API sees them.
 *
 * @param rows  array of { serverId, credentialId } picker rows
 * @returns {Array<{field: string, message: string}>}
 */
export function describeMcpRowBlockers(rows) {
  const mcpServers = Array.isArray(rows) ? rows : [];
  const reasons = [];
  // Like an empty repository row (#2051): an "Add MCP server" click leaves
  // a blank row behind, and the API silently DROPS an entry with no serverId
  // (normalizeMcpServersInput), so a user who picked a credential but forgot the
  // server would otherwise save and lose it without a word.
  const hasEmptyMcp = mcpServers.some(r => !String(r?.serverId ?? '').trim());
  if (hasEmptyMcp) {
    reasons.push({
      field: 'mcpServers',
      message: 'Choose a server for every added MCP row, or remove the empty row.',
    });
  }
  // Nothing on the server side dedupes: `mcpServers` is stored in order and the
  // seeder writes one stanza per entry into the agent's .mcp.json, so a repeated
  // server means the later row silently wins. Block it here rather than let the
  // form express something whose outcome it cannot show.
  const duplicateMcp = firstDuplicate(mcpServers.map(r => String(r?.serverId ?? '').trim()).filter(Boolean));
  if (duplicateMcp) {
    reasons.push({
      field: 'mcpServersDuplicate',
      message: `List each MCP server once — '${duplicateMcp}' is added twice.`,
    });
  }
  return reasons;
}
