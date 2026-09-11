// Pure decisions for the Team Settings "Environment" tabs (#2167).
//
// A `role: 'team'` agent has no content of its own beyond its bound Working
// Environment (`cfg.environmentId`), which until now was reachable only from
// the separate Working Environments page. This module derives the form state
// and the PUT body for editing that SAME environment record in place — the
// fields it edits (repositories / GitHub token / model provider / toolchain /
// MCP servers / additional context) map 1:1 onto what `POST`/`PUT
// /api/environments` already accepts (no data-model change).
//
// `githubTokenId` joined this form in #2170 (epic #2166 A4): the standalone
// Working Environments page — the ONLY surface that could set it — was
// retired, so without this the field would have become unreachable for an
// ordinary team the moment the page disappeared (a real regression, not a
// scope trim; #2167/A1 left it there deliberately, on the assumption that
// page would keep existing).
//
// Deliberately NOT carried here: Name/ID (the environment already has them —
// this surface edits content, not identity) and ownership/team (the
// environment already belongs to this team; editing its content is not a
// re-tier, #2083's own rule — see docs/decentralised-access-concept.md D7).
import { initialMcpRows, mcpSubmitValue } from '../working-env-mcp-view.js';

export const TEAM_ENV_TABS = [
  { id: 'repositories', label: 'Repositories' },
  { id: 'provider', label: 'Model provider' },
  { id: 'toolchain', label: 'Toolchain' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'context', label: 'Additional context' },
];

// Mirrors EnvironmentTemplates.jsx's initialRepositories() so the two forms
// read a stored environment identically.
function initialRepositories(env) {
  if (Array.isArray(env?.repositories) && env.repositories.length > 0) {
    return env.repositories.map(r => ({
      url: r.url || '',
      branch: r.branch || '',
      sshKeyId: r.sshKeyId || '',
      readOnly: r.readOnly === true,
    }));
  }
  if (env?.repository?.url) {
    return [{
      url: env.repository.url,
      branch: env.repository.branch || '',
      sshKeyId: env.repository.sshKeyId || '',
      readOnly: env.repository.readOnly === true,
    }];
  }
  return [];
}

export function initialTeamEnvForm(env) {
  return {
    repositories: initialRepositories(env),
    mcpServers: initialMcpRows(env),
    githubTokenId: env?.githubTokenId || '',
    llmEndpointId: env?.llmEndpointId || '',
    defaultModelId: env?.defaultModelId || '',
    toolchainId: env?.toolchainId || '',
    additionalContext: env?.additionalContext || '',
  };
}

// The PUT body — every field is applied by the server only `if (x !==
// undefined)`, so omitting Name/ID/description/ownership here leaves them
// untouched rather than needing to round-trip them through this form.
export function teamEnvSubmitBody(baseline, form) {
  const mcpValue = mcpSubmitValue(baseline, form.mcpServers);
  return {
    ...(mcpValue === undefined ? {} : { mcpServers: mcpValue }),
    repositories: (form.repositories || [])
      .filter(r => r.url.trim())
      .map(r => ({
        url: r.url.trim(),
        branch: r.branch.trim() || null,
        sshKeyId: r.sshKeyId || null,
        readOnly: r.readOnly === true,
      })),
    githubTokenId: form.githubTokenId || null,
    llmEndpointId: form.llmEndpointId || null,
    defaultModelId: form.defaultModelId || null,
    toolchainId: form.toolchainId || null,
    additionalContext: form.additionalContext,
  };
}

export default { TEAM_ENV_TABS, initialTeamEnvForm, teamEnvSubmitBody };
