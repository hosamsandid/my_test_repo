# Key Files and Project Layout

## Top-level layout

```
.
├── docker-compose.yml        # Four services + named volumes
├── .env / .env.example       # Secrets and endpoint configuration
├── Makefile                  # make up / down / logs / build / ps
├── orchestrator/             # Backend service (agent lifecycle, triggers, API)
├── admin-console/            # Browser-based management UI
├── bp-explorer/              # BriefingPack metadata viewer (read-only)
├── mcp-servers/              # Model Context Protocol server configurations
├── scripts/                  # Utility and setup scripts
└── docs/                     # Technical reference documents
```

## Key files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Defines four services (conduwuit, orchestrator, admin-console, bp-explorer) and the named volumes they share |
| `.env` / `.env.example` | Secrets: Matrix admin token, LLM proxy URL and auth token, port overrides |
| `Makefile` | Convenience targets: `make up`, `make down`, `make logs`, `make build`, `make ps` |
| `orchestrator/orchestrator.js` | Agent lifecycle management, child-process spawning, environment seeding, internal HTTP API |
| `agent-image/scripts/agent-entrypoint.py` | Per-agent runtime: Matrix client, Claude CLI invocations, trigger scheduler |
| `orchestrator/github-poller.js` | GitHub Events API poller; fan-out to agents via pending-triggers |
| `orchestrator/setup.sh` | First-time setup: registers the admin Matrix user, prints the access token |
| `orchestrator/CLAUDE-template.md` | Base `CLAUDE.md` template baked into the image as a fallback |
| `admin-console/api/api.js` | Express API covering all admin operations (~60 endpoints) |
| `admin-console/src/pages/` | 16 React pages; see [docs/admin-console.md](./admin-console.md) for the full reference |

## Extending the stack

**Add a skill:** Drop a `SKILL.md` into the skill-pool volume under `skills/<name>/SKILL.md`. It becomes available to grant to a team or an agent immediately (on the Agents page, in the Team-Setup wizard, or on the Knowledge page).

**Add an agent:** Admin Console → Agents → New Agent. Choose a role, pick a Working Environment, write a system prompt, save.

**Schedule autonomous work:** Agent Chat → right rail → Triggers tab. Or manage globally via Scheduled Jobs.

**React to GitHub events:** Add a GitHub token, attach it to a Working Environment, add a `github-event` trigger to an autonomous agent.

**Add a webhook trigger:** Add an `http` trigger in the console; it generates a secret automatically. POST to the webhook endpoint with the `X-Hook-Secret` header.

**Add or switch a model provider:** Model Providers → New provider → Test Connection → Discover Models. See [docs/model-providers.md](./model-providers.md).
