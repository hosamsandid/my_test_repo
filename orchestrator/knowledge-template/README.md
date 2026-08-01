# Team Knowledge Base

This directory is the **team Knowledge Base (KB)** — the shared, git-backed layer
where agents pool what they learn so the team stops re-learning the same things
independently. It is tier **T1** of the maturity ladder:

```
T0 memory/*.md   ──harvest──▶  T1 Team KB (this dir)  ──promote──▶  T2 Skill
 (per agent)        (after           (git, real-time              (curated,
                     each             queryable)                   versioned)
                     session)
```

## Layout

One canonical **JSONL** file per kind — one entry per line, appended in place:

```
facts/facts.jsonl              durable facts ("npm install is behind a permission wall")
entities/entities.jsonl        systems / components / people the team works with
conventions/conventions.jsonl  project conventions ("branch from origin/main")
knowledge.manifest.json        maps each kind to its file (override to relocate)
```

Every entry carries **mandatory provenance** — the agent, session and PR/issue it
came from — so any skill promoted out of the KB can be traced back to where it was
learned.

## How agents use it

Agents do not edit these files by hand. They use the `knowledge` CLI (added in
Phase 1) which appends provenance-stamped entries and commits + pushes them via
`gh-as-agent`, and searches the KB with ripgrep for real-time, offline lookups:

```
knowledge search "permission wall"
knowledge add fact "The live agent runtime is the Python entrypoint, not agent-runner.js"
```

The KB is human-readable and diffable: review new knowledge in git like any other
change.
