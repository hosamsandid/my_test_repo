---
id: skills
routes: ["/skills"]
title: Skills
summary: The reusable instruction packages your agents load — kept in a global and a per-team pool, granted to whoever needs them.
seeAlso:
  - { label: "Knowledge", to: "/knowledge" }
  - { label: "Agents", to: "/agents" }
  - { label: "Agent Team Wizard", to: "/team-setup" }
  - { label: "Role Templates", to: "/role-templates" }
askPrompts:
  - "What is the difference between granting a skill and installing it into an agent?"
  - "When are granted skills actually copied into an agent's workspace?"
  - "Should this skill live in the global pool or in a team pool?"
  - "How do I share a skill that only exists inside one agent?"
  - "What happens to grants when I merge two skills?"
  - "What is the difference between Skills, Knowledge and Memory?"
---

## What a skill is

A skill is a **reusable instruction package**: one `SKILL.md` plus any helper
scripts or assets that belong with it. An agent loads the skills it was given
and follows them when the task calls for it — so a skill is how you teach every
agent the same procedure once instead of repeating it in each system prompt.

This page shows every skill in the shared **pool** as well as the copies living
inside individual **agents**. Click a skill to browse its files, its revision
history and where it came from.

## Two tiers: Global and Team

| Tier | Who can use it | Editable here |
|---|---|---|
| **Global** | Every team. The house-wide pool. | Yes |
| **Team** | One team only — that team's own pool. | Yes |
| **Agent** | The single agent it lives in. | No — read-only |

When an agent is set up, each skill it was granted is resolved from **its own
team's pool first, then from the global pool** — so a team can override a global
skill by keeping a skill of the same name in its own pool.

**Agent** skills are read-only because they are a copy inside a workspace, not a
pool entry. To share one, copy it into a team pool first (from the Knowledge
page), then promote that team skill to global. Both steps write provenance and
`skill.json` lineage, so you can always see where a skill came from.

## Grant vs activation vs install — three different things

The verbs on this page hide three genuinely different mechanics. Mixing them up
is the usual source of "why doesn't my agent have that skill?":

- **Grant** — the *list of names* an agent (or its whole team) is entitled to.
  You grant on the **Agents** page, in the **Agent Team Wizard**, or on the
  **Knowledge** page. A grant is a declaration, not a file copy. (Working
  Environments don't carry skills.)
- **Seeding / activation** — the moment those files are actually **copied into
  the agent's workspace**. The agent reads them on its next message, so a fresh
  grant becomes effective when the workspace is next seeded.
- **Install into agent** — a **one-off push** of a single skill into a running
  agent. Handy for a quick trial. But a later workspace reset re-seeds only the
  **granted** skills, so an install that isn't also granted won't survive.

The rule of thumb: **grant** for permanent, **install** for a trial.

## Moving a skill between the tiers

Everything else on this page just moves a skill around:

| Action | What it does |
|---|---|
| **Promote to global** | Copies a team skill into the global pool; the team-tier copy stays put. |
| **Move to global** | Relocates a team skill into the global pool and retires the team copy (a recoverable snapshot is archived). |
| **Adopt** | Copies a global skill into one team's pool (activated by default) so that team owns a curatable copy. |
| **Move to team** | Relocates a global skill into a team pool and retires the global copy (recoverable snapshot; System Admin only). |
| **Install into agent** | Pushes a global skill into one running agent — see above. |
| **Distill** | Re-synthesises a single skill from everything that accumulated in it: dedupe, restructure, re-abstract. Shows a diff before applying. |
| **Merge** | Folds several skills into one. |
| **Import / Export** | A skill travels as a `.zip` / `.skill` archive of its whole directory. |

### Overwriting

Every transfer, install and merge asks before it replaces an existing skill of
the same name at the destination, because an overwrite **replaces the entire
skill directory** there — not just `SKILL.md`. Extra files the old version
carried are gone. The previous content stays in the skill's revision history, so
you can see what it was, but the safe move when in doubt is to pick a different
target name.

### What merging does to grants and provenance

Merging is more than concatenating text. The target's **provenance unions every
source's**, extra files are **carried over**, and grants pointing at a retired
source are **migrated to the target** — so nobody loses a skill because it was
folded into another one. Leaving *Retire source skills* ticked archives the
sources (restorable) after the grants have moved; unticking it keeps them in
place. The combined `SKILL.md` is drafted for you — instantly by concatenation,
or synthesised by the model — and you edit it before the merge runs.

## Skills vs Knowledge vs Memory

Three things that are easy to confuse:

- **Memory** — what *one agent* privately remembers. Not shared.
- **Knowledge** — the lessons a team **shares**, so every agent benefits from
  what any one of them learned.
- **Skills** — this page: the polished, reusable instruction files agents load
  automatically, often **distilled from the best knowledge**.

The pipeline runs left to right: an agent learns something → it becomes team
knowledge → the strongest, converged knowledge is promoted into a skill. How
much of that happens without you is the **Knowledge** page's autonomy setting.
