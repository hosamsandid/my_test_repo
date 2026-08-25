# Model Providers

The **Model Providers** page (`/models`) manages the LLM endpoints Agent Studio routes traffic to, independently of individual agents.

## What you can do

- **Register multiple providers** — e.g. a LiteLLM proxy, an Azure AI Foundry gateway, or the public Anthropic API
- **Test connection** before saving to verify the provider is reachable and the credentials are valid
- **Discover models** — the console probes the provider's `/models` route and populates the model catalog automatically
- **Set a default model** per provider; agents can override this on a per-agent basis via the Agents page
- **Re-point a group of agents** — Working Environments bind to a provider, so editing one environment redirects all agents in it to a new model without touching each agent individually

## Configuration

The global fallback provider is set via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `.env`. The Model Providers page overrides these at the Working Environment or individual agent level.

Any endpoint that speaks the Anthropic Messages API is supported. This includes:
- LiteLLM proxy
- Azure AI Foundry with an Anthropic-compatible wrapper
- Any internal enterprise gateway that exposes the Anthropic Messages API
- The real Anthropic API (`https://api.anthropic.com`) — see the callout below, a plain API key needs the built-in bridge, not this URL directly

## Authentication types

Each registered provider carries an `authType` that controls how the orchestrator authenticates agents:

### `api-key` (default)

A **Bearer token** (`Authorization: Bearer <token>`) sent against the provider's `baseUrl` — the transport a LiteLLM/Azure/enterprise gateway expects, since the gateway re-authenticates upstream itself. Set the token at registration time; it is stored at mode 0600 and never returned by the API after creation.

Legacy providers without an `authType` field behave identically to `api-key`.

**Plain Anthropic API keys (`sk-ant-api03-...`) do NOT work against `https://api.anthropic.com` directly under `api-key` auth.** The real Anthropic API only accepts a standard key via the `x-api-key` header — a Bearer request with the same key gets a hard `401 Invalid bearer token`, not a soft fallback. (An OAuth setup-token, `sk-ant-oat-...`, from `claude setup-token` *is* Bearer-compatible — see `oauth-token` below.)

To use a plain API key without an external gateway, point the provider's Base URL at the stack's **built-in Anthropic bridge** instead of `api.anthropic.com`: `http://orchestrator:4004` (internal-only, reachable from every agent container without extra networking — see `orchestrator/anthropic-proxy.js`). It accepts the same Bearer request the CLI already sends and re-issues it upstream as `x-api-key`, unmodified otherwise; point `ANTHROPIC_BASE_URL` (`.env`) or a Model Provider's `baseUrl` at it and keep the plain API key as the token. The `default` provider auto-migrated from `.env` on first boot is wired this way already.

### `oauth-token` — Claude subscription auth (Max / Enterprise)

Uses a long-lived OAuth token minted by `claude setup-token` — the sanctioned credential for Claude **Max** or **Enterprise** subscription seats, as opposed to an API key.

**How to set up:**

The Model Providers page can drive the entire login flow inside the browser:

1. Click **Add provider** and choose **Claude subscription (OAuth)** as the auth type.
2. Click **Login with Claude** — the orchestrator starts `claude setup-token` under a pseudo-terminal and returns the `claude.ai` authorize URL.
3. Open the URL in your browser, approve the request, and receive a one-time confirmation code.
4. Paste the code into the dialog. The token is claimed server-side and stored; it never passes through the browser.

Alternatively, you can paste an existing `sk-ant-oat-*` token value directly into the **Setup token** field.

**What happens at runtime:**

For `oauth-token` providers the orchestrator:
- Injects the token as `CLAUDE_CODE_OAUTH_TOKEN` into the agent container.
- Strips `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` (which would otherwise take precedence over the OAuth token in the CLI).
- The agent CLI therefore talks directly to `api.anthropic.com`, bypassing any configured proxy.

**Compliance note:** Consumer-subscription OAuth tokens are limited to single-user use under [Anthropic's Consumer Terms](https://www.anthropic.com/legal/consumer-terms). The Admin Console requires an explicit single-user confirmation before creating or re-keying an `oauth-token` provider. This acknowledgment is recorded on the provider entry (`complianceAck`). One-shot server-side generation (e.g. for LLM-assisted prompt drafting) deliberately skips `oauth-token` providers to avoid unintended multi-user use.

## Model overrides

An individual agent's model can be overridden in the Agents page (Edit → Model). This takes precedence over the Working Environment's default, which in turn takes precedence over the global `.env` setting.
