# Workflow — Jira from a fresh install to a working chat

Reference: `docs/jira-plugin.md`. This workflow walks the documented setup path
**in order, as each persona**, and probes every step for gaps. The steps are
deliberately done by the persona who is supposed to do them — the interesting
bugs are hand-over points ("the Team Admin did X, why does the Member still
see Y?").

## Preconditions

- A Jira Cloud test site with at least one project, provided by the human.
  Access is **read-only**: no comments, transitions, updates, attachments,
  custom-field writes or epics — neither by the tester nor by an agent.
  Every wake instruction and chat prompt in this workflow must say so
  explicitly ("read only, do not change anything in Jira").
- Credentials (site, e-mail, API token) are passed as env vars at run time;
  never stored in scripts, reports or memory.
- Personas: System Admin, Team Admin of a `uitest-` team, Member of that team,
  Outsider (see `../README.md`). Without `AUTH_ENABLED` only the System-Admin
  path can be walked; record that.
- Runtime: the manifest declares Podman and Kubernetes. On Kubernetes, check
  first that the broker can reach the orchestrator (a CLI read such as
  `aee-jira projects`, not only `whoami`) and that the installed manifest is
  current (a stale plugin pool installs an old contract). Record the runtime
  in the pass status.

## Steps and probes

### 1. Install (System Admin)

- `/plugins` → install Jira. Status while the broker starts; failure display.
- "Broker running" is not proof of a working plugin: the CLI path
  (agent → broker → orchestrator credential grant) can still fail.
- Member/Team Admin/Outsider: install not offered or refused with a reason.
- Installing grants nothing: the `uitest-` team's agents have no `aee-jira` yet.

### 2. Grant to the team (Team Admin)

- Agent Chat → Settings → Plugins, and the wizard's Knowledge step.
- `aee-jira` appears in each member's workspace without respawn; a member added
  later receives it too; revoke removes it.
- Member tries to grant → denied with a reason.

### 3. Team connection and service account (Team Admin)

- Settings → Plugins → "Plugin service accounts": **Connection** (site) and
  **Service account** (e-mail + API token) are clearly separated.
- Site input variants: `acme`, `https://acme.atlassian.net`, trailing slash,
  `http://`, wrong host, empty. Which are accepted, normalised, rejected?
- Service account left empty (chat-only team) → no errors elsewhere.
- Wrong token / scoped token without `read:jira-work` → readable error, where?
- Secrets never shown back, not in API responses, audit log or console.
- Watched projects (step 4 of the doc): add/remove a project key, unknown key.

### 4. Personal token (every Member)

- Connections → Plugin Tokens: add e-mail + token.
- Warning when the team site is not set yet (test by doing step 4 before 3).
- Member of two teams with different sites: which site applies?
- Outsider: token page works, but no Jira agent is reachable.

### 5. Use it in chat (Member)

- Ask the agent to list projects, list issues of a project, show one issue,
  run a JQL search, list statuses, fetch an attachment (read commands only).
- Results reflect the **Member's** Jira permissions (compare with a Member whose
  account sees fewer projects, if available).
- Incomplete setup: remove the personal token / team site one at a time — the
  agent's first reply lists **everything** missing at once, says who fixes it
  and where.
- Ask for a write ("add a comment") → must not happen (read-only
  site/permissions); how is the refusal presented?

### 6. Automated run (service account)

- A cron trigger on the `uitest-` agent with a read-only Jira prompt → runs as
  the service account; without a service account → clear error in the run.
- `plugin-event` trigger form: field picker lists the payload keys,
  `payloadFilter` rows, no-condition case.
- Wake on a real status change needs a write in Jira → only if the human
  performs the transition manually; otherwise record as untested.

### 7. Tear down

- Remove personal tokens, service account and site, revoke the grant,
  uninstall the plugin **only if it was installed in this pass**.
- After uninstall: no leftover CLI in workspaces, no dangling triggers
  (`plugin-event` triggers of a removed plugin — how are they shown?).

## Risk spots

- `orchestrator/plugin-credential-store.js`, `plugin-event.js`,
  `POST /internal/plugin-event`, `plugins/jira/` broker (credential tiers per
  call), `plugin-sync.js` (`planCliRefresh`).
