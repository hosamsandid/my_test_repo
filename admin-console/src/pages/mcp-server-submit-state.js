// Pure submit-gate helpers for the two "create" forms on the MCP Servers page
// (McpServers.jsx): CreateServerForm and CreateCredentialForm.
//
// Before this module each form's Save button was gated by an inline boolean
// (`canSave`) and simply went grey when a required field was empty — with no
// word about WHICH field it wanted. That is the exact "the platform isn't
// self-explanatory" complaint: a user new to the console stares at a disabled
// "Save server" / "Save credential" button and can't tell what is missing.
//
// Each helper derives the SAME gate PLUS the ordered list of unmet
// requirements from one place, so the disabled button and the "why is this
// disabled" hint can never disagree — the same discipline
// agent-create-submit-state.js (#1773) and model-provider-submit-state.js
// (#1302) apply to their forms. Kept pure (no React) so it is unit-tested in
// mcp-server-submit-state.test.js.

const trimmed = v => String(v ?? '').trim();

// http / sse transports connect to a remote URL; stdio spawns a local command.
// Mirrors the `isHttp` split in CreateServerForm.
const HTTP_TRANSPORTS = new Set(['http', 'sse']);

/**
 * Derive whether the "create MCP server" form can be submitted and, when it
 * cannot, the ordered list of unmet requirements. The order follows the form
 * top-to-bottom (Name → ID → transport-specific endpoint) so the hint reads
 * like a checklist of the visible required (`*`) fields.
 *
 * @param form.name       raw Name field
 * @param form.id         raw ID field (auto-derived from the name)
 * @param form.transport  selected transport ('stdio' | 'http' | 'sse')
 * @param form.command    raw Command field (stdio transports)
 * @param form.url        raw URL field (http/sse transports)
 * @returns {{ canSave: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeServerSubmitState(form = {}) {
  const { name, id, transport, command, url } = form;
  const isHttp = HTTP_TRANSPORTS.has(transport);

  const reasons = [];

  if (!trimmed(name)) {
    reasons.push({ field: 'name', message: 'Enter a name.' });
  }
  if (!trimmed(id)) {
    reasons.push({ field: 'id', message: 'Enter an ID (auto-derived from the name).' });
  }
  if (isHttp) {
    if (!trimmed(url)) {
      reasons.push({ field: 'url', message: 'Enter the server URL.' });
    }
  } else if (!trimmed(command)) {
    reasons.push({ field: 'command', message: 'Enter the command to run.' });
  }

  return { canSave: reasons.length === 0, reasons };
}

/**
 * Derive whether the "create MCP credential" form can be submitted and, when it
 * cannot, the ordered list of unmet requirements. Order follows the form
 * (Name → Secret); the ID is optional (auto-derived) and the default server is
 * optional, so neither gates submission.
 *
 * @param form.name    raw Name field
 * @param form.secret  raw Secret field
 * @returns {{ canSave: boolean, reasons: Array<{field: string, message: string}> }}
 */
export function describeCredentialSubmitState(form = {}) {
  const { name, secret } = form;

  const reasons = [];

  if (!trimmed(name)) {
    reasons.push({ field: 'name', message: 'Enter a name.' });
  }
  if (!trimmed(secret)) {
    reasons.push({ field: 'secret', message: 'Paste the secret (API token, bearer token, etc.).' });
  }

  return { canSave: reasons.length === 0, reasons };
}
