# Admin Console Reference

The Admin Console at `http://localhost:4000` (configurable via `.env`) is the central management interface for agents, environments, credentials, and integrations.

## Navigation

| Page | Route | Purpose |
|---|---|---|
| **Dashboard** | `/` | Live agent status (Unread / Busy / Idle / Offline), aggregate stats, setup progress nudge |
| **Agent Chat** | `/chats` | 1:1 chat with any agent; session log; workspace browser; trigger editor |
| **Agents** | `/agents` | Create, edit, enable/disable, delete, export, and import agents |
| **Working Environments** | `/environments` | Reusable workspace recipes (skills, repos, GitHub token, model provider) |
| **SSH Keys** | `/ssh-keys` | Register SSH key pairs for private repository access |
| **GitHub Tokens** | `/github-tokens` | Register GitHub PATs for the GitHub event poller and HTTPS repository access |
| **Skills Registry** | `/skills` | Browse available skills; click to view skill content |
| **Scheduled Jobs** | `/jobs` | Cross-agent view of all triggers; add/edit/delete cron, one-shot, webhook, and GitHub event triggers |
| **Model Providers** | `/models` | Register and test model providers; discover available models; set per-agent model overrides |
| **MCP Servers** | `/mcp` | View Model Context Protocol servers configured in the Claude settings file |
| **Flows** | `/flows` | BriefingPack graph: visualize BP dependencies, claim/activate/deactivate orchestrator-managed BPs |

## Agent Chat

The Agent Chat page (`/chats/:agentId`) embeds a full Matrix chat client with a three-panel layout.

### Left panel — Agent list

Pick any enabled agent. The status indicator shows current state (Unread / Busy / Idle / Offline).

### Middle panel — Chat

Markdown rendering with syntax-highlighted code blocks (dual light/dark themes), sticky scroll, scroll-up backfill of older messages, and optimistic send. The session toolbar shows whether a Claude session is active and offers:

- **Reset** — drop the session pointer so the next message starts fresh
- **Reset & Learn** — send a learn prompt then auto-drop the session

### Right rail — Three tabs

Toggle with `Cmd/Ctrl+Shift+L`.

| Tab | What it shows |
|---|---|
| **Session Log** | Structured timeline of internal activity: tool calls, assistant text, errors, timings. Tool-use/tool-result pairs are folded into collapsible blocks. Filter by All / Tool Calls / Errors / Posted. |
| **Workspace Browser** | Lazy-loading file tree of the agent's workspace directory. Click any text file to view its content (up to 512 KB). Hover over any file row to reveal a per-file **Download** button (works for binary files too; no size cap). Supports file upload to the workspace (up to 500 files) and one-click ZIP export of the entire workspace. Binary files are flagged rather than displayed as garbage. |
| **Triggers** | Inline editor for the agent's trigger schedule. Add, edit, or delete any trigger type; shows next execution time, last run status, and the webhook secret for HTTP triggers. |

## Session Pinning

After every successful Claude run, the session ID is saved to a per-room pointer file. The next message resumes with `--resume <sessionId>` so Claude keeps the conversation in context. If the session is stale (e.g. after a CLI upgrade), the runner clears the pointer and retries once without it. Session pointers survive orchestrator restarts.

## Agent Export / Import

Agents can be snapshotted as a ZIP and restored on any compatible AEE instance.

**Export** — click the **Export** (download) icon on any agent card in `/agents`, or the download button in the Workspace Browser toolbar. The ZIP contains the full agent workspace (excluding `sessions/`) plus a `manifest.json` with the agent id, export timestamp, and the orchestrator image name/tag/digest recorded at export time.

API: `GET /api/agents/:id/export` → streams `agent-<id>-export.zip`.

**Import** — click **Import Agent** at the top-right of `/agents` and select a ZIP produced by export. The agent id from `manifest.json` is used as-is; the call returns `409` if an agent with that id already exists. After import, activate the agent card normally.

API: `POST /api/agents/import` (multipart `file` field, max 500 MB) → `201 { agentId, image }`.

Note: sensitive Matrix credentials are **not** included in the ZIP. After import you will need to configure them via the agent edit form or by starting a chat session.

## Hover Correlation

Every session log event carries the `correlationId` of the originating Matrix message (or a synthetic `trigger:<id>:<ts>` for scheduled runs). Hovering a chat bubble dims non-matching log rows, and vice versa — making it easy to trace which tool calls produced which reply.
