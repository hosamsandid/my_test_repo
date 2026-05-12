# Model Registry

The Model Registry (`/models`) manages LLM endpoints independently of individual agents.

## What you can do

- **Register multiple endpoints** — e.g. a LiteLLM proxy, an Azure AI Foundry gateway, or the public Anthropic API
- **Test connection** before saving to verify the endpoint is reachable and the credentials are valid
- **Discover models** — the console probes the endpoint's `/models` route and populates the model list automatically
- **Set a default model** per endpoint; agents can override this on a per-agent basis via the Agents page
- **Re-point a group of agents** — Working Environments bind to an endpoint, so editing one environment redirects all agents in it to a new LLM without touching each agent individually

## Configuration

The global fallback LLM endpoint is set via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `.env`. The Model Registry overrides these at the Working Environment or individual agent level.

Any Anthropic-compatible endpoint is supported. This includes:
- Direct Anthropic API (`https://api.anthropic.com`)
- LiteLLM proxy
- Azure AI Foundry with an Anthropic-compatible wrapper
- Any internal enterprise gateway that speaks the Anthropic Messages API

## Model overrides

An individual agent's model can be overridden in the Agents page (Edit → Model). This takes precedence over the Working Environment's default, which in turn takes precedence over the global `.env` setting.
