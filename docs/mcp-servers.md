# MCP Server Configuration

Agentic Studio supports **Model Context Protocol (MCP)** servers, which extend Claude's capabilities with additional tools — for example, database access, internal APIs, or custom integrations.

## How it works

MCP servers are configured in the Claude settings file (`.claude/settings.json`) inside each agent's workspace. The Admin Console's **MCP Servers** page (`/mcp`) reads and displays the configured servers for inspection — it shows which servers are registered and their connection details.

## Configuring an MCP server

Edit `.claude/settings.json` in the agent's workspace directly (use the Workspace Browser in Agent Chat or upload a modified file). The format follows the standard Claude Code MCP configuration:

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
