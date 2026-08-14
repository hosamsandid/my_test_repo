# Agent Studio walkthrough

**Reading the tour?** Start here and go in order — it follows one realistic story
end to end:

1. [Team Setup — the "+ Create" launcher & the wizard](01-team-setup.md)
2. [Working with agents — the IBAN story](02-working-with-agents.md)
3. [Triggers — making agents autonomous](03-triggers.md)
4. [Flows — the visual editor](04-flows.md)
5. [Agent Templates](05-agent-templates.md)
6. [Knowledge](06-knowledge.md)

← Back to the [documentation index](../README.md).

---

## For maintainers — this is also the narrative source

**This directory is the authoritative, in-repo source of the product walkthrough
storyline.** It was extracted verbatim from the hand-authored demo deck
`2026-07-14-Agent-Studio-IBAN-Demo.pptx` (speaker notes; the deck itself is *not*
committed) and exists so that journey authors — human or agent — have the full
narrative without needing the PowerPoint.

Consumed by the journey-spec pipeline (`docs/journey-spec-concept.md`): each chapter's
prose becomes the `narrative` fields of a journey under `e2e/journeys/`, and the
generated user guide / PPTX deck reproduce it (phases J1–J3, epic #704).

| Chapter | File | Maturity |
|---|---|---|
| Team Setup ("+ Create" launcher & wizard) | `01-team-setup.md` | mature |
| Working with agents — the IBAN story | `02-working-with-agents.md` | mature |
| Triggers | `03-triggers.md` | mature |
| Flows (visual editor) | `04-flows.md` | mature |
| Agent Templates | `05-agent-templates.md` | mature |
| Knowledge | `06-knowledge.md` | drafted (speaker text final, screenshots described but not yet taken) |
| Skills Registry | — | TODO (deck slides empty; §2 of `06-knowledge.md` covers the registry) |
| App Modernization, Model Provider, Git & GitHub, Token Usage, Maintenance Mode, Technical Deep Dive | — | TODO (deck chapters are title-only) |

Conventions: one `##` section per demo beat (original slide number in parentheses for
provenance). Lines starting with **Screenshot:** are staging directions for the visual
at that beat — they tell a journey author where the named screenshot point belongs.
