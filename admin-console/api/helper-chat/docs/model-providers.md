# Model Providers

The **Model Providers** page (`/models`) manages the LLM endpoints Agent Studio routes traffic to, independently of individual agents.

## What you can do

- **Register multiple providers** — e.g. a LiteLLM proxy, an Azure AI Foundry gateway, or the public Anthropic API
- **Test connection** before saving to verify the provider is reachable and the credentials are valid
- **Monitor provider health continuously** — a background poller probes each provider on a schedule (default every ~5 minutes) and the **Health** column shows the last-known status (OK, or Error with the reason, or Unknown when never probed) and when it was last checked, so a broken endpoint is visible before an agent runs against it. Saving a provider re-probes it immediately, and an agent whose bound provider is currently unreachable shows a non-blocking warning in its chat.
- **Discover models** — the console probes the provider's `/v1/models` route and populates the model catalog automatically. If that route doesn't exist (404/405 — some Anthropic-compatible gateways, e.g. Azure AI Foundry, expose `/v1/messages` but no model-listing route), **Test connection** and **Discover models** both fall back to a free `/v1/messages/count_tokens` probe to confirm the endpoint is reachable and authenticated; Discover models then tells you to enter the model name(s) manually instead of reporting a raw failure
- **Set a default model** per provider; agents can override this on a per-agent basis from the model selector in the agent's chat header (Agent Chat, `/chats`)
- **Re-point a group of agents** — environments bind to a provider, so editing one environment redirects all agents in it to a new model without touching each agent individually

## Configuration

The global fallback provider is set via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `.env`. The Model Providers page overrides these at the environment or individual agent level — but an `api-key` provider overrides only the values it actually carries. The agent container inherits the platform's `.env` environment, so a provider saved **without a token of its own repoints the Base URL and leaves the shared `ANTHROPIC_AUTH_TOKEN` in place**: the agent still sends a credential, the platform-wide one, to whatever endpoint you named. Only `oauth-token` providers clear the inherited variables (see below).

Any endpoint that speaks the Anthropic Messages API is supported. This includes:
- Direct Anthropic API (`https://api.anthropic.com`)
- LiteLLM proxy
- Azure AI Foundry with an Anthropic-compatible wrapper
- Any internal enterprise gateway that exposes the Anthropic Messages API

## Authentication types

Each registered provider carries an `authType` that controls how the orchestrator authenticates agents:

### `api-key` (default)

A Bearer token sent against the provider's `baseUrl`. This covers every gateway, proxy, or direct Anthropic API endpoint. Set the token at registration time; it is stored at mode 0600 and never returned by the API after creation.

Legacy providers without an `authType` field behave identically to `api-key`.

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

An individual agent's model can be overridden from the model/provider selector in that agent's chat header in **Agent Chat** (`/chats`) — it is a runtime control, not a form field, so the change applies live rather than on save (switching the *provider* restarts the agent container; switching only the model does not). The Agents page that used to host this was removed in #1930. The per-agent override takes precedence over the environment's default, which in turn takes precedence over the global `.env` setting.
