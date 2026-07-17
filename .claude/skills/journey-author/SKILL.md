---
name: journey-author
description: >-
  Author and repair e2e journeys (docs/journey-spec-concept.md §11) for the
  Agent Studio admin console. Use this whenever you need to write a new journey
  YAML under e2e/journeys/, extend the step library it draws on, or fix a
  journey/step that a nightly e2e run turned red. Encodes the tight
  read-schema → read-catalog → draft → lint → dry-run → real-run → check-shots
  loop and — critically — the hard triage rule that stops an eager agent from
  "healing away" a real app regression.
---

# Skill: Authoring & repairing e2e journeys

## What a journey is

A **journey** (`e2e/journeys/*.yaml`) is thin declarative data over a finite,
named **step library** (`e2e/steps/*.js`). It composes semantic step calls
(`wizard.selectProcessTemplate`, `templates.openTemplatesPage`) plus narrative
prose and named screenshot capture points into a story that the runner executes
as an ordinary Playwright test (trace/retries/reporters all apply). Screenshots
are captured **only on a fully green run** — a failing journey publishes nothing.

Because a journey only names steps from the library, **you never write selectors
or wait logic in YAML** — that lives in the step functions. Authoring a journey
is a translation task (prose → step sequence), not a programming task. That is
what makes it safe for an agent to do.

## The authoring loop (do these in order)

Everything below runs from `e2e/`. Steps 1–4 are **podman-free** — pure Node,
feedback in seconds. Only step 5 needs the real stack (and it runs in CI, not in
this container).

1. **Read the schema.** `e2e/journey-runner/schema.js` is the structural
   contract: `journeyVersion: 1`, a slug `id` (doubles as the artifact dir), a
   `title`, optional `order`/`lanes`/`fixtures`, and a non-empty `steps` list.
   Each step is `{ id?, narrative?, action?, assert?, screenshot?, kind? }`.
   `action`/`assert` are `{ do: <step-name>, ...params }`. A prose-only step must
   be `kind: narrative-only` (and then carries no action/assert/screenshot).
   Screenshot ids are slugs and must be unique across **all** journeys.

2. **Read the catalog** — `e2e/steps-catalog.json` (generated). This is your
   **vocabulary**: every step name, its params (required vs optional), a
   description, and a copy-pasteable YAML example. Also lists the `fixtures:` you
   may name. **If the step you need is not in the catalog, it does not exist** —
   do not invent a name (the linter will reject it). Either find the right
   existing step, or add one (see *Extending the step library*).

3. **Draft the YAML.** Model it on `e2e/journeys/team-setup.yaml` (the pilot) or
   `e2e/journeys/agent-templates.yaml` (the simple, fixture-free one). Prefer a
   fixture-free, read-only page when the goal is just a validation chapter — no
   state to set up or tear down. Give each capture-worthy step an `id`, a
   `narrative`, and a `screenshot` slug.

4. **Lint, then dry-run.**
   - `npm run journeys:lint` — schema + unknown step/fixture names + unknown or
     missing params + duplicate screenshot ids + catalog freshness. Milliseconds.
   - `npm run journeys:dryrun` — resolves every step + fixture against the *live*
     registry and re-checks params. Proves the names bind to real functions and
     the catalog has not drifted. Needs `@playwright/test` installed
     (`npm install`), still no browser, no stack.

   Iterate here until both are clean. This is 90% of the work and costs seconds.

5. **Real run (CI dispatch).** You run inside an agent container with **no
   podman**, so you cannot run the browser locally. Trigger the real run in CI:
   `gh workflow run e2e.yml --ref <your-branch>`, then watch it
   (`gh run watch <id>` / `gh run view <id> --log-failed`). **If your token
   cannot dispatch workflows, ask the human to run it in your DM** — do not claim
   a journey is green without a green dispatched run.

6. **Check the captured screenshots.** A green run uploads
   `journey-artifacts` (the `e2e/artifacts/<id>/` PNGs + `manifest.json`).
   Download and eyeball each capture point: does it show the state the narrative
   describes? Screenshots are *acceptance reference*, not the spec.

## Extending the step library

When a journey needs an action the library doesn't have, add a function to the
right `e2e/steps/*.js` module (or a new module registered in
`journey-runner/step-registry.js`'s `STEP_MODULES`):

- Signature is `async function name(ctx, params)` where `ctx` bundles
  `{ page, request }`. A step driven from YAML **must take a `params` object**
  (everything except `do` is passed through), never a positional arg.
- Keep all brittle work — selectors, auto-waiting — inside the function. There
  are no data-testids in `admin-console/src`, so use id / ARIA role / visible
  text (see `steps/wizard.js` for the house style).
- **Document it with JSDoc**: a one-line description, `@param {type} params.name
  - desc` for each param (wrap optional ones as `[params.name=default]`), and an
  `@example` YAML snippet. The catalog is generated from exactly this.
- Regenerate the catalog and commit it: `npm run journeys:catalog`. CI fails if
  the committed `steps-catalog.json` is stale.

New step functions go through normal code review like any other code.

## CI

`npm run journeys:{lint,dryrun,catalog:check}` and the journey unit tests run on
**every PR** (the podman-free `e2e-journeys` job in `.github/workflows/ci.yml`) —
so a broken journey, an undocumented step, or a stale catalog is caught before
merge. The full browser run stays on the nightly + dispatch `e2e.yml` lane.

## The triage rule (READ THIS BEFORE REPAIRING A RED JOURNEY)

Journey maintenance is dominated by UI changes breaking existing journeys. A
failed run leaves a Playwright trace (DOM snapshots, network, console per step) —
your primary input. **Before you change anything, diagnose which of three cases
you are in, and act accordingly:**

| Diagnosis | Action |
|---|---|
| Journey outdated (UI intentionally changed) | update the YAML |
| Step library broken (selector rot) | fix the step function |
| **App actually broken** | **report the bug; repair nothing** |

This is the single most important rule in this skill. An eager agent that
"repairs" a journey when the **app** is actually broken will **heal away a real
regression** — the biggest risk of agent-maintained journeys. When in doubt
between "selector rot" and "app broken", assume **app broken** and report it: a
false bug report is cheap, a silently-hidden regression is not. Repair the
journey or the step only when you are confident the product change was
intentional (journey outdated) or purely a selector/DOM shift with identical
user-visible behaviour (selector rot).

## Where the human reviews

With an agent maintaining the YAML, the human reviews the rendered artifacts —
the screenshot diffs and (later) the generated markdown/deck — "is the story
right, do the pictures look right" — not the YAML lines. Keep narratives honest
and capture points meaningful.
