# github-issues broker

Broker sidecar for the **GitHub Issues** plugin (`plugins/github-issues/`, issue
#1633) — the first plugin that both holds a credential **and** bears a UI. It
brings the everyday, read-mostly GitHub issue actions into the Agent Studio
console so releasing work (e.g. a BA applying a `ready` gate) no longer means
switching to GitHub: **list** a repository's issues, **read** one issue's
details, and **add / remove a label**.

Built on the **Broker SDK** (`../broker-sdk/`), like `netzplan-broker` and
`test-mgmt-broker`; `server.js` is wiring.

## Credential model — pushed, never baked in

The plugin reuses the **single GitHub token bound to each granted team's Working
Environment** (there is exactly one per environment). A broker sidecar is shared
across every team it is granted to, but that token + repository list are
per-team, so they cannot be an image env-var. Instead the orchestrator resolves,
per granted team, `environment → { githubTokenId → token, repositories }`
(`orchestrator/plugin-github-creds.js`) and **pushes** a `{ scopeId: { token,
repos, teamName, flowLabels, labelAgents } }` map to `PUT
/internal/scope-credentials` (bearer-authed with a minted scope token, the same
wire shape as `teardown-scope`). `flowLabels` are the gate/outcome/wake labels the
team's flow uses (derived by `buildTeamFlowLabels` from label registry + `labelFilter`
triggers + `emits`); `labelAgents[repo][label]` maps each label to the enabled
agents it wakes in that repo (`''` = any-label listener). The broker holds the
map only in memory. The raw token **never** reaches the browser or an agent
container (AC10): the broker makes every GitHub call server-side.

## Request surfaces

- **`/ui/*`** — the console-proxied UI (`ui/`) + its data API, authed by the
  §4.8 **signed viewer headers** (`viewer-headers.js`, verbatim scheme copy). The
  broker verifies the signature, resolves the viewer's selected team (must be one
  of its signed `teamIds` — the authorization guard), and calls GitHub with that
  team's token. A repository not in the selected team's environment yields no
  token (`ScopeStore.tokenForRepo`), so a viewer can never act outside scope.
  Data routes: `GET /api/context` (authorized teams + repos + last-used),
  `GET /api/issues`, `GET /api/issue`, `GET /api/labels` (returns `{ flowLabels,
  repoLabels, labelAgents }` — flow labels suggested first, each previewing which
  agents it wakes), `POST /api/label` (add/remove, re-fetches the issue), `POST
  /api/pref` (persist last-used).
- **`/cli/*`** — the dependency-free agent CLI (`aee-issues`), scope-token authed
  and **read-only** in the MVP (`/repos`, `/list`, `/show`): agents browse
  issues; label writes are the human console action.

## Modules

| File | Role |
|---|---|
| `github-client.js` | Pure request-shaping / response-shaping / error-mapping for the GitHub REST surface + the thin `call` fetch adapter (`GITHUB_API_BASE` seam). Unit-tested. |
| `scope-store.js` | In-memory per-scope credentials + repo list (token never on disk) with `tokenForRepo` authorization guard, `flowLabels`/`labelAgents` cache (pushed by the orchestrator alongside the credential), and per-(scope,user) last-used prefs persisted on `AEE_PLUGIN_STATE_DIR`. Unit-tested. |
| `viewer-headers.js` | Verbatim §4.8 signed-viewer-header verify (copied — the build context can't reach `admin-console/api/`; SDK home is a follow-up). |
| `server.js` | Wiring: SDK health/teardown, the credential-push route, the `/ui` + `/cli` surfaces, audit. |
| `ui/markdown.js` | Dependency-free, XSS-safe GFM-subset Markdown renderer (#1642): escapes all untrusted input as text, emits only a whitelisted element set (headings/bold/italic/lists/code/tables/links/hr), protocol-validates `href`/`src` to `http`/`https`/`mailto`. No build step; exported as `window.AEEMarkdown`. Unit-tested (element coverage + XSS: `<script>`/`<img onerror>` escaped, `javascript:`/`data:` dropped). |
| `ui/` | Dependency-free console page: team/repo selectors, issue list + detail (body rendered via `markdown.js`), label add/remove with flow-label suggestions + trigger preview, loading skeleton, empty/missing-token states, last-used pre-selection. Follows the console's active theme by reading `localStorage['eb-theme']` (same origin) and listening to `storage` events; uses `--eb-*` design tokens re-declared for `admin-dark`/`admin-light`/`high-contrast`. |

Every label write is one audit line (`aee.plugin.owner=<scopeId>` + the acting
`viewer.sub`) via the SDK `auditWriter` (AC11).
