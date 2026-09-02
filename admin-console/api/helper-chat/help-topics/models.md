---
id: models
routes: ["/models"]
title: Model Providers
summary: The LLM endpoints Agent Studio routes model traffic to — each with a URL, a credential and a catalog of models your agents can pick from.
seeAlso:
  - { label: "Working Environments", to: "/environments" }
  - { label: "Agents", to: "/agents" }
  - { label: "Token Usage", to: "/token-usage" }
askPrompts:
  - "What is the difference between API key / proxy and Anthropic subscription auth?"
  - "Why is an OAuth subscription provider single-user only?"
  - "Which model does an agent actually use?"
  - "Why does the connection test fail with a 401?"
  - "Why do agents have to restart after I change a provider's token?"
---

## What a Model Provider is

A **Model Provider** is one endpoint Agent Studio sends model traffic to. It
carries a **URL**, an **auth credential** and a **catalog of models** the console
discovers from it. Nothing binds to a model directly: a
[Working Environment](/environments) — or an individual agent — binds to a
*provider* and picks a default model out of its catalog. That indirection is the
point: re-pointing one environment at a new provider moves every agent in it at
once, without editing each agent.

Any endpoint that speaks the **Anthropic Messages API** works — the Anthropic API
itself, a LiteLLM proxy, an Azure AI Foundry wrapper, or an internal enterprise
gateway.

## Which model an agent really uses

Three levels, most specific wins:

| Level | Set on | Beats |
|---|---|---|
| **Agent override** | Agents → Edit → Model | everything below |
| **Environment default** | the bound Working Environment | the global fallback |
| **Global fallback** | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `.env` | — |

## The two ways a provider authenticates

You choose the authentication method when you add a provider. It is not a
cosmetic setting — the two paths reach Anthropic differently and carry different
terms of use.

### API key / proxy (`api-key`, the default)

A secret token sent as a **Bearer header to a Base URL you provide**. This is the
standard setup and the right pick for a **shared org key, a team budget, or any
non-Anthropic gateway**. The token is stored at mode `0600` and is never returned
by the API after creation — you can replace it, not read it back. A legacy
provider saved before this choice existed behaves exactly like `api-key`.

### Anthropic subscription (`oauth-token`)

Uses **your own Claude subscription seat** (Pro / Max / Enterprise) instead of an
API key. The credential is a long-lived (~1 year) token minted by
`claude setup-token`. There is **no Base URL**: agents bound to such a provider
talk straight to `api.anthropic.com`. The orchestrator injects the token as
`CLAUDE_CODE_OAUTH_TOKEN` and *strips* `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` — which would otherwise win in the
CLI — so this path **bypasses any proxy you have configured**, and with it any
gateway-side logging or budget.

The console can drive the whole login in the browser: the orchestrator runs
`claude setup-token` under a pseudo-terminal, you approve the request on
`claude.ai`, and the one-time code is redeemed **server-side** — the token itself
never passes through the browser. Pasting an `sk-ant-oat…` token you generated
elsewhere is the manual alternative.

### Single-user only — the compliance constraint

Anthropic's Consumer Terms permit OAuth tokens from Free/Pro/Max subscriptions
**solely for the subscription owner's own use**; they must not serve other users
or third parties. That is why the console demands an explicit single-user
confirmation before a subscription provider is created or re-keyed, and records
it on the provider entry. Consequences worth knowing:

- **For a team, don't share one seat.** Use per-seat Enterprise tokens — *one
  provider per seat* — or an API key.
- **Rate limits are shared** with your own interactive Claude sessions, so a busy
  agent and your own work slow each other down.
- **Server-side assist calls skip subscription providers** on purpose (the
  console's own LLM-assisted drafting needs an API-key provider), to avoid
  turning one person's seat into a multi-user service.

## Testing, discovery and health

**Test connection** and **Discover models** probe the provider before you commit:
discovery reads its `/models` route and fills the catalog. A probe always names
the credential it used, because a `401` against a *stored* token means something
different than a failed fresh login. While a subscription login is pending the
probe is blocked rather than silently testing the old token.

Beyond that a background poller re-probes every provider on a schedule (~5 min)
and the **Health** column shows the last result and when it was taken — so a dead
endpoint is visible before an agent runs into it. Saving a provider re-probes it
immediately, and an agent whose provider is unreachable shows a non-blocking
warning in its chat.

## Changing credentials and deleting

An agent receives its credentials **when it starts**, so a re-keyed provider only
reaches the already-running agents bound to it once they are restarted — the
console offers to do that for you, and skipping it means those agents keep using
the old credential until you disable and re-enable them. A provider that a
Working Environment still uses cannot be deleted; detach it there first.
