# 12 — Model providers and MCP servers

**Scope:** `/models` (providers, auth types, health, global flag, team model
selection), `/mcp` (registry, credentials, attach to environments).

**Guardrail:** do not change or delete existing providers or MCP servers;
create `uitest-` ones only with approval for the pass.

## Probes

- Read-only first: health display, error states, long names, many providers.
- Create a `uitest-` provider with an invalid URL/key: health goes red with a
  readable reason; delete it again.
- `oauth-token` flow: compliance confirmation shown; cancel mid-login.
- MCP: register a `uitest-` server (stdio/http), invalid command/URL,
  `${credential}` substitution, attach to the `uitest-` env, member override
  `[]` = none; effect on the next turn without respawn.
- Persona: which parts can Member/Team Admin see or use (global providers)?

## Risk spots

- `llm-endpoint-global.js`, `startLlmHealthPoller`, `mcp-seed.js`.

## Cleanup

Delete `uitest-` providers/MCP servers/credentials; detach from environments.
