---
id: models
routes: ["/models"]
title: Model Providers
summary: The LLM endpoints Agent Studio routes model traffic to — each with a URL, a credential and a catalog of models your agents can pick from.
seeAlso:
  - { label: "Environment Templates", to: "/environment-templates" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Token Usage", to: "/token-usage" }
askPrompts:
  - "What is the difference between API key / proxy and Anthropic subscription auth?"
  - "Why is an OAuth subscription provider single-user only?"
  - "Which model does an agent actually use?"
  - "Why does the connection test fail with a 401?"
  - "What does the Health column mean when it says Unknown?"
  - "Why do agents have to restart after I change a provider's token?"
---

## What a Model Provider is

A **Model Provider** is one endpoint Agent Studio sends model traffic to. It
carries three things: a **URL**, an **auth credential**, and a **catalog of
models** the console discovers from it. Nothing binds to a model directly: a
[Environment](/chats) — or an individual agent — binds to a
*provider* and picks a default model out of its catalog. That indirection is the
point: re-pointing one environment at a new provider moves every agent in it at
once, without editing each agent.

Any endpoint that speaks the **Anthropic Messages API** works — the Anthropic API
itself, a LiteLLM proxy, an Azure AI Foundry wrapper, or an internal enterprise
gateway.

The table on this page is that list of providers, one row each: its
**Name**, the **Scope / Teams** that owns it (a *Team* provider belongs to one
team; a *System* provider is assigned to the teams listed beside it, or reads
*Unassigned*; a **Global** provider shows a single *Global* pill because it
belongs to no team at all and every user and agent can reach it — see *A
provider available to everyone* below), the **Base URL** — replaced by a
*Subscription (OAuth)* badge
when the provider uses subscription auth, which is also why it has no URL to
show — a short preview under **Token** (the full fingerprint is in the
provider's own editor), how many **Models** the catalog holds and which one is
the default, the **Health** of the endpoint, and when it was **Added**. Click
any row you can manage to open its editor.

Two rows are not editable and say so with a padlock rather than failing on
click. A **`.env` fallback** row is a synthetic record reflecting the global
`.env` settings rather than a registered provider — change it by editing `.env`
and restarting — and its Health reads `—` because nothing probes it. A
**System-scoped** provider that a Team Admin can see but not manage shows the
same padlock: you may use it, only a System Admin may change it — and a
**Global** provider is that same story taken to its limit, usable by everyone
and editable only by a System Admin.

### A provider available to everyone

Most providers are reachable only by the team that owns them (or the teams a
System-scoped one is assigned to). A **Global provider** is the exception: it
belongs to no team at all and is usable by **every** user and every agent —
including someone who is in no team yet, which is the point, since it is what
lets a plain user's AI helpers bill against a model without wiring up a provider
first. Turn it on with the **Global provider** checkbox in the editor, which
**only a System Admin sees**: publishing a provider to the whole installation is
a System-Admin act, so a Team Admin may *use* a global provider but never create
or retract one. A global provider carries no team assignment, so the team picker
disappears while the box is ticked and the table shows a single **Global** pill
in place of the usual scope/teams detail. Two limits are worth knowing: a
**subscription (OAuth)** provider can never be global — a subscription seat is
single-user by its terms, so the checkbox is disabled for that auth type — and
going global changes only *who may reach* the provider, never who may manage it
(still a System Admin only) nor whether the token is exposed (it never is).

### Which model an agent actually uses

Three levels, most specific wins:

| Level | Set on | Beats |
|---|---|---|
| **Agent override** | Agents → Edit → Model | everything below |
| **Environment default** | the bound environment | the global fallback |
| **Global fallback** | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `.env` | — |

So an agent that looks like it is ignoring a provider change is usually reading
an override one level above the thing you edited.

### The two ways a provider authenticates

You choose the authentication method when you add a provider, and the choice is
not a cosmetic setting — the two paths reach Anthropic differently and carry
different terms of use. They are the next two chapters. In short: **API key /
proxy** is the standard, shareable setup; **Anthropic subscription** spends your
own Claude seat and is single-user only.

## API key / proxy authentication

`api-key` is the default. The credential is a secret token sent as a
**Bearer header to a Base URL you provide** — the Anthropic API itself, or any
proxy or gateway in front of it that speaks the Anthropic Messages API. This is the right
pick for a **shared org key, a team budget, or any non-Anthropic gateway**,
because nothing about it is tied to one person.

Two properties worth knowing:

- **The token is write-only.** It is stored at mode `0600` and is never returned
  by the API after creation — the page shows a short preview and a fingerprint so
  you can tell two tokens apart, and you can replace it, but you can never read
  it back.
- **The token is optional, but "no token" does not mean "no credential".** An
  endpoint saved without one is *probed* unauthenticated — **Test connection**
  and **Discover models** send no `Authorization` header, which is a legitimate
  setup for a proxy that authenticates by network position, and the form says so
  rather than pretending the field is required. A **running agent is a different
  story**: the agent container inherits the platform's own
  `ANTHROPIC_AUTH_TOKEN` from the stack's `.env`, and a provider without a token
  of its own only overrides the *Base URL*. So the agent still sends a
  credential — the platform-wide one — to whatever endpoint you named. Only
  subscription auth clears those inherited variables. Worth knowing before you
  point a tokenless provider at a third party: it will receive the shared token.

A legacy provider saved before this choice existed behaves exactly like
`api-key`.

## Anthropic subscription authentication

`oauth-token` uses **your own Claude subscription seat** (Pro / Max / Enterprise)
instead of an API key. The credential is a long-lived (~1 year) token minted by
`claude setup-token`. There is **no Base URL**: agents bound to such a provider
talk straight to `api.anthropic.com`. The orchestrator injects the token as
`CLAUDE_CODE_OAUTH_TOKEN` and *strips* `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` — which would otherwise win in the
CLI — so this path **bypasses any proxy you have configured**, and with it any
gateway-side logging or budget. If your organisation routes model traffic through
a gateway for a reason, that reason does not apply to agents on this auth type.

The console can drive the whole login in the browser: the orchestrator runs
`claude setup-token` under a pseudo-terminal, you approve the request on
`claude.ai`, and the one-time code is redeemed **server-side** — the token itself
never passes through the browser. Pasting an `sk-ant-oat…` token you generated
elsewhere is the manual alternative, and it wins over a pending login if you do
both.

A completed login is only *claimed* when you save. Until then the token does not
exist on this provider yet, which is why **Test connection** and **Discover
models** are blocked while a login is pending rather than quietly testing the
token the login is about to replace.

### Single-user only — the compliance constraint

Anthropic's Consumer Terms permit OAuth tokens from Free/Pro/Max subscriptions
**solely for the subscription owner's own use**; they must not serve other users
or third parties. That is why the console demands an explicit single-user
confirmation before a subscription provider is created or re-keyed, and records
who confirmed it and when on the provider entry. Consequences worth knowing:

- **For a team, don't share one seat.** Use per-seat Enterprise tokens — *one
  provider per seat* — or an API key.
- **Rate limits are shared** with your own interactive Claude sessions, so a busy
  agent and your own work slow each other down.
- **Server-side assist calls skip subscription providers** on purpose (the
  console's own LLM-assisted drafting needs an API-key provider), to avoid
  turning one person's seat into a multi-user service.

## Test connection and Discover models

Both buttons probe the provider *before* you commit to it, from the values
currently in the form. For an **API key / proxy** provider both send the same
request — a `GET` of the endpoint's **`/v1/models`** route — and differ only in
what they do with the answer (a **subscription** provider takes a different route
entirely; see below):

- **Test connection** reports the HTTP result and nothing else. It is the fastest
  way to separate "wrong URL" from "wrong token", and it works even against an
  endpoint whose model list you do not intend to import.
- **Discover models** parses the same response into a catalog and offers it as a
  suggestion. You then decide: **Merge into catalog** keeps what you have already
  curated and adds the rest, **Replace catalog** takes the endpoint's list
  wholesale, and **Dismiss** throws the suggestion away. Nothing is written until
  you save the provider.

**A `404`/`405` from `/v1/models` doesn't end the probe.** Some Anthropic-compatible
gateways — an Azure AI Foundry endpoint is the concrete case — serve `/v1/messages`
but expose no model-listing route at all, which used to read as a broken provider.
Both buttons now fall back to a `POST` of `/v1/messages/count_tokens` with a
placeholder model name that is never actually served: a `400` (or `2xx`) means the
endpoint is reachable and your credential works, just with no catalog to offer; a
`401`/`403` still means a real auth failure. A `404` is the subtle case, because
the endpoint returns it both when the route is genuinely absent *and* when it
reaches the route but rejects the never-served placeholder model: a `404` that
names the model as unknown (an Anthropic `not_found_error` body) counts as
reachable and authenticated — the credential was accepted *before* the model was
checked — while an opaque `404` with no such body still means the Base URL itself
is wrong. On a successful fallback, **Test connection** reports OK
and **Discover models** tells you to enter the model name(s) manually instead of
showing an empty list or a raw HTTP error. An API-key provider whose `/v1/models`
already works is completely unaffected — for it the fallback only fires on a
route-missing status.

**A subscription (OAuth) provider skips `/v1/models` altogether.** Its token is
honoured only on Anthropic's Claude Code *messages* flow, and the model-list
route always answers a subscription token with `401 invalid x-api-key`. So both
buttons go straight to a free `/v1/messages` probe against `api.anthropic.com`
(a placeholder model that `404`s after auth, so nothing is billed; not
`count_tokens`, which rejects OAuth tokens) — the only path — and **Discover
models** always asks you to enter the model name(s) manually. The same probe
backs the health poller, so the **Health** column stays green.

**A probe always names the credential it used**, in a line under the two buttons,
because a `401` means something completely different depending on which one it
was. There are three cases:

| The line says | Which credential | What a failure means |
|---|---|---|
| a **pasted** token | the one typed into the token field, not yet saved | the token you just pasted is wrong or expired |
| the **stored** token | the one already on file for this provider | the saved credential has gone stale — re-key it |
| **no** token | nothing — the probe runs unauthenticated | fine for a proxy that authenticates by network position; a `401` here means it does not |

The probe is also blocked outright in the three states where it would be
misleading: while a subscription login is pending (see above); for a
subscription provider that has **no token at all** — the state a fresh create
sits in from the moment you pick *Anthropic subscription* until you either log
in or paste one, where there is simply nothing to send; and for an `api-key`
provider with no Base URL to probe. The line then says why rather than leaving a
dead button.

## Health: the poller and the Health column

Testing a provider once tells you it worked once. Beyond that, a background
poller re-probes **every** registered provider on a schedule (~5 minutes) and
persists the last-known result, so a dead endpoint is visible on this page before
an agent runs into it. A provider that keeps failing is retried on an
exponentially growing delay rather than hammered. Saving a provider probes it
immediately, so a freshly-broken endpoint is flagged on save instead of up to a
poll interval later.

The **Health** column shows that last result and when it was taken. It is current
on page load and needs no click:

| Health | Meaning |
|---|---|
| **OK** | the last probe reached the endpoint; hover for the HTTP status |
| **Warning** (orange) | the endpoint is reachable, but its spending budget is nearly used up — see *Budget and the Warning state* below |
| **Error** | the last probe failed, or the budget is fully used; the reason is shown under the label and in full on hover |
| **Unknown** | no probe result is on file for it yet |

**`Unknown` is honest, not a warning.** A provider with no result on file — one
registered before health was tracked, or one whose save-probe has not landed by
the time you look — reports `Unknown` rather than a guessed green; the column
never claims a reachability it has not measured. It is not a third failure mode
to investigate, and the next poll normally replaces it on its own. The `.env`
fallback row shows `—` for a related reason: it is not a registered endpoint, so
nothing probes it at all.

Health is a **signal, not a gate**. Nothing here blocks an agent from starting;
an agent whose provider is currently red shows a non-blocking warning in its chat
and is left to try anyway.

### Budget and the Warning state

A LiteLLM proxy can give a key — and the team the key belongs to — a spending
budget, and stops answering once it is used up. Every health probe (and every
save or **Test connection**) also reads that budget through LiteLLM's free
`/key/info` and `/team/info` reads; no billable request is made, and the token is
never shown or logged.

The **Budget** column shows the spend against the limit in the proxy's currency
units (e.g. `$291.94 / $2,000`), the share used, and whether it is the **key**
or the **team** budget. When both carry a budget, the one with the higher share
used is shown, because it is the one that stops work first. Hover for the budget
period and the date it resets. The read-only `.env` row gets the same column.

A `—` means there is no budget to show: the provider has no budget API (a
subscription seat, Anthropic direct, Azure AI Foundry and other proxies), or
neither the key nor its team has a limit set. That is not a problem and does not
change Health. `—` with **Budget unavailable** underneath means the budget read
itself failed (timeout or an HTTP error); Health is unaffected by that too.

Health turns **Warning** (orange) once a reachable provider has used **90 %** or
more of its budget, with the reason on the detail line, e.g.
`Budget 92 % used ($1,840 / $2,000, team)`. At **100 %** it shows **Error**, as it
does when the proxy rejects requests for a used-up budget. The threshold is set
with the `AEE_LLM_HEALTH_BUDGET_WARN_PCT` environment variable on the admin
console (default `90`), next to the other `AEE_LLM_HEALTH_*` poller settings. A
Warning provider keeps the normal poll interval — it is not backed off like a
failing one — so raising the budget shows up at the next poll. Budgets are read
only: change them on the proxy.

Agents bound to a Warning provider show a non-blocking orange banner in their
chat that names the provider and how much of the budget is used.

## Changing credentials and deleting

An agent receives its credentials **when it starts**, so a re-keyed provider only
reaches the already-running agents bound to it once they are restarted — the
console offers to do that for you, and skipping it means those agents keep using
the old credential until you disable and re-enable them. A provider that a
environment still uses cannot be deleted; detach it there first.
