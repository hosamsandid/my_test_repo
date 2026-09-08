# MCP Server Configuration

Agent Studio supports **Model Context Protocol (MCP)** servers, which extend Claude's capabilities with additional tools — for example, database access, internal APIs, or custom integrations.

## How it works

MCP servers follow a three-part model: **servers** describe how to launch a backend and use `${credential}` as a placeholder in their `env`/`headers` template to mark where a secret goes; **credentials** carry the raw secrets (stored separately at `/workspace/mcp-credentials/_keys/`); a **Working Environment** pairs a server with a credential. At workspace seed time the orchestrator substitutes `${credential}` with the bound credential's secret and writes the merged stanza into each agent's own `.claude/settings.json`.

The Admin Console's **MCP Servers** page (`/mcp`) lists the registered servers. The **Credential** column shows **required** for any server whose template references `${credential}` — this status is derived automatically from the server's template (field `requiresCredential`). A *required* server must have a credential bound in the Working Environment before agents can use it.

## Configuring an MCP server

Register the server via the **MCP Servers** admin page, then bind it to a Working Environment (with an optional credential). Registering, editing or deleting a server requires **Team Admin** rights over the team that owns it. Each server is owned by a single **team** or can be marked **shared** across several teams — a shared server appears in every assigned team's pickers; a System Admin decides which teams it reaches. The server template format for stdio servers follows the standard Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "..."
      }
    }
  }
}
```

MCP servers configured this way are available to the agent on its next invocation. Each agent can have a different set of MCP servers depending on its role and the tools it needs.

## Use cases

- **Database access:** Connect an agent to a PostgreSQL or DB2 instance so it can query schemas directly
- **Internal APIs:** Give an agent read or write access to internal REST services
- **Custom tools:** Wrap any CLI or service in an MCP server to make it available as a Claude tool
