# Exploratory UI test plan

A **repeatable** plan for structured, exploratory bug hunting across the Admin
Console. It complements the executable journeys in `e2e/journeys/` (which prove
known-good paths deterministically): this plan tells a tester — human or agent —
**which corners to probe and how**, so that each pass finds what the happy-path
journeys cannot.

The plan carries **no status**. Progress, findings and filed issues of a given
pass live with the tester (e.g. an agent's unversioned workspace), never here.
Change a file here only when the product changes or a charter turns out to miss
something.

## Layout

| Path | Content |
|---|---|
| `README.md` | this file — method, personas, guardrails, session protocol |
| `heuristics.md` | generic probes applied in **every** area (validation, errors, roles, a11y, …) |
| `areas/NN-*.md` | one charter per UI area: scope, preconditions, persona matrix, specific probes, known risk spots, cleanup |
| `workflows/*.md` | cross-area end-to-end journeys (e.g. Jira from install to chat) |

Suggested order = the `NN` prefix (roughly by risk). Every area is self-contained,
so any subset can be run in any order.

## Personas

Every area is tested from the **least privileged persona first**. The admin view
is the easy case; the interesting bugs sit where a normal user hits a gate.

| Persona | How to get it | What to look for |
|---|---|---|
| **Member** | a user with Team Member role on the test team only | what can they see, what can they do, where do they get stuck, are denials explained |
| **Team Admin** | Team Admin of the test team, not System Admin | team-scoped management works, nothing of other teams leaks |
| **Outsider** | a user with no membership in the test team | test team's agents/chats/credentials return a uniform 404/denial, also via direct URL and API |
| **System Admin** | a System-Admin account | only for steps that require it (plugin install, templates, administration) |

> **Prerequisite:** role gating only exists with `AUTH_ENABLED` on
> (`admin-console/api/auth-mode.js`). With it off, *every* logged-in user is an
> implicit System Admin and the Member/Team-Admin/Outsider rows cannot be
> tested — record that as a limitation of the pass, not as a pass.

## Guardrails

1. Use dedicated test accounts only. Passwords and tokens are passed via
   environment variables at run time; never written into scripts, reports,
   memory or this repo.
2. Every object created gets the prefix **`uitest-`**, is recorded in the
   tester's session status, and is removed at the end of the session.
3. Never modify or delete objects the tester did not create. Other teams'
   agents must keep running.
4. External systems: read-only unless the charter says otherwise and the human
   explicitly allowed it (Jira: **read only**; GitHub: no writes to real repos).
5. No load testing, no security testing. A suspected security hole is reported
   **only to the human, privately** — never in an issue or report.
6. System-wide switches (maintenance mode, auth mode, plugin install/uninstall,
   model providers) only with explicit approval for that pass.

## Session protocol

One session = one area (or one workflow), ~30–90 min.

1. **Start:** read this README, `heuristics.md` and the area file; read the
   tester's status of previous passes (known issues, leftovers to clean up).
2. **Check known issues:** `gh issue list --search "<area keywords>"` so
   duplicates are not re-filed.
3. **Explore:** work through the charter's probes per persona, then the
   generic heuristics. Read the code behind every anomaly — a finding with its
   root cause is worth three without.
4. **Record** each finding with: steps, expected, actual, evidence
   (screenshot/API response), severity (high/medium/low), root cause if known.
5. **Clean up** every `uitest-` object; verify it is gone.
6. **File issues grouped by implementation** — one issue per fix site (e.g.
   "form", "API", "scheduler"), not one per symptom; no labels (labels can wake
   flow agents — the human triggers).
7. **Update the status** (outside this repo): date, area, findings → issues,
   untested probes and why.

## Tooling notes

- Playwright with headless Chromium; log in once, reuse `storageState`.
- The console is served over plain HTTP → not a secure context:
  polyfill `crypto.randomUUID` via `context.addInitScript` to get past chat
  sending; clipboard-based features cannot work there (a finding in itself).
- Viewports: 1440×900, 1024×768, 390×844.
- Themes: dark (default), light, high-contrast.
