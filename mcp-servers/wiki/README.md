# Wiki MCP server (reference)

A minimal stdio MCP server that exposes a wiki backend to Claude agents
through two tools:

| Tool         | Args                       | Returns                      |
|--------------|----------------------------|------------------------------|
| `search`     | `query` (string), `limit?` | Up to 20 hits (id, title, snippet, url) |
| `fetch_page` | `id` (string)              | Full page text (title + body)|

It is intentionally backend-agnostic: it speaks one shape of REST that any
Confluence/Notion-flavoured wiki can fit behind a thin shim.

## Configuration

The server reads everything from the environment, no flags:

| Variable           | Default          | Notes                                     |
|--------------------|------------------|-------------------------------------------|
| `WIKI_BASE_URL`    | *(required)*     | Base URL of the wiki API                  |
| `WIKI_TOKEN`       | *(empty)*        | Bearer token; omitted from the request when empty |
| `WIKI_SEARCH_PATH` | `/search`        | Appended to base URL; expects `?q=…&limit=…` |
| `WIKI_PAGE_PATH`   | `/pages/{id}`    | `{id}` is URL-encoded                     |

The credential is supplied at agent-seed time by the orchestrator, by
substituting `${credential}` into the server's `env` template (see the MCP
section in `CLAUDE.md`).

## Backend contract

```http
GET ${WIKI_BASE_URL}${WIKI_SEARCH_PATH}?q=…&limit=…
→ { "results": [{ "id": "...", "title": "...", "snippet": "...", "url": "..." }] }

GET ${WIKI_BASE_URL}${WIKI_PAGE_PATH (with {id} substituted)}
→ { "id": "...", "title": "...", "url": "...", "body": "..." }
```

If your wiki diverges, write a small REST shim that adapts to this shape and
point `WIKI_BASE_URL` at the shim. We deliberately avoided in-server adapters
to keep the reference implementation single-file and dependency-free.

## Standalone test

```sh
WIKI_BASE_URL=https://example.invalid/api node mcp-servers/wiki/server.js
# then on stdin, line-delimited JSON-RPC:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```
