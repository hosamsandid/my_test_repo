# Agent Studio documentation

Everything written about Agent Studio, sorted by **what you are trying to do**.

New to the project? Read the [root README](../README.md) first for the 5-minute overview,
then pick a path below.

---

## Pick your path

| I want to… | Start here | Time |
|---|---|---|
| **Understand what this is** | [Visual platform tour](platform-story.html) → [Glossary](glossary.md) | 15 min |
| **Run it on my laptop** | [macOS setup](guides/mac-setup.md) or [Windows setup](guides/windows-setup.md) | 45–60 min |
| **Host it for my team** | [Deployment & hosting options](deployment.md) | 20 min |
| **Use it — my first agent team** | [Walkthrough ch. 1: Team Setup](walkthrough/01-team-setup.md) | 30 min |
| **Extend or contribute to it** | [Key files & project layout](key-files.md) → [Design & internals](#design--internals) | 60 min |
| **Look up a word I don't know** | [Glossary](glossary.md) | 1 min |

> **Confused by a term?** The [Glossary](glossary.md) opens with *The four collisions* —
> the four words in this product that mean two different things. It is the single highest-
> value page for a newcomer.

---

## Getting started

| Document | What it gives you |
|---|---|
| [glossary.md](glossary.md) | Every term in one sentence, plus the four ambiguous words that trip everyone up |
| [platform-story.html](platform-story.html) | Scroll-animated visual tour of the whole product — open it in a browser |
| [guides/onboarding.md](guides/onboarding.md) | New-joiner path: access requests, repository access, first bring-up |
| [guides/mac-setup.md](guides/mac-setup.md) | macOS from scratch: Podman, `.env`, bootstrap, seeding, first start |
| [guides/windows-setup.md](guides/windows-setup.md) | Windows equivalent: WSL2, Podman Desktop, Git Bash, GNU Make |
| [deployment.md](deployment.md) | Where you can run this: laptop, shared server, and what a central deployment requires |

## Using Agent Studio

The walkthrough chapters are the **narrated product tour** — they follow one realistic
story end to end and are the closest thing to a user manual.

| Document | What it gives you |
|---|---|
| [walkthrough/01-team-setup.md](walkthrough/01-team-setup.md) | Standing up your first agent team with the wizard, step by step |
| [walkthrough/02-working-with-agents.md](walkthrough/02-working-with-agents.md) | The full story: chat → issue → label → PR → review → merge, and where the human decides |
| [walkthrough/03-triggers.md](walkthrough/03-triggers.md) | Making agents act on their own: cron, once, webhook, GitHub event |
| [walkthrough/04-flows.md](walkthrough/04-flows.md) | Designing a multi-agent process on the Flows canvas |
| [walkthrough/05-agent-templates.md](walkthrough/05-agent-templates.md) | Using the role-template catalog |
| [walkthrough/06-knowledge.md](walkthrough/06-knowledge.md) | Skills (top-down) vs. learned knowledge (bottom-up), and the autonomy dial |
| [walkthrough/README.md](walkthrough/README.md) | How this narrative is maintained and what feeds from it |

### Concept references

| Document | What it gives you |
|---|---|
| [agent-roles.md](agent-roles.md) | The five agent roles and when to use which |
| [working-environments.md](working-environments.md) | What a Working Environment bundles, and what happens when an agent is created |
| [triggers.md](triggers.md) | The four trigger types, cron syntax, webhook contract, GitHub polling |
| [skills-system.md](skills-system.md) | What a skill is, global vs. team tier, adding and promoting skills |
| [persistent-memory.md](persistent-memory.md) | What an agent remembers, in which files, and how to inspect it |
| [admin-console.md](admin-console.md) | Page-by-page reference for the console at `:4000` |
| [banking-insurance-use-case.md](banking-insurance-use-case.md) | A worked domain example: regulatory change management with an agent team |
| [architecture-faq.md](architecture-faq.md) | **Architecture & technical FAQ** — deep answers on context/knowledge management, state durability, cost/model governance, and integration/extensibility |

## Operating it

| Document | What it gives you |
|---|---|
| [deployment.md](deployment.md) | Hosting options, what each one costs you, and the honest limits of each |
| [credentials.md](credentials.md) | Registering SSH keys and GitHub tokens, and why both exist |
| [model-providers.md](model-providers.md) | Connecting an LLM endpoint; API-key vs. Claude-subscription auth |
| [mcp-servers.md](mcp-servers.md) | Connecting live knowledge sources via MCP |
| [context-mount.md](context-mount.md) | Giving agents live access to one or more host folders, read-only by default (local env, admin-only) |
| [agent-chat-troubleshooting.md](agent-chat-troubleshooting.md) | **"My agent doesn't answer"** — the runbook. Start here when something is broken |
| [hosting/gcp/gke-runbook.md](hosting/gcp/gke-runbook.md) | **GKE hosting runbook** — first-time bootstrap, env-file/credential model, and symptom-keyed troubleshooting for the hosted test/preprod environments |
| [collaboration-mode-faq.md](collaboration-mode-faq.md) | **Collaboration-mode FAQ** — the common questions about running Agent Studio with a team (concurrency, shared knowledge, credentials, access control), with resolutions and known gaps |
| [guides/ace-plugin-installation.md](guides/ace-plugin-installation.md) | Installing the ACE plugin (only needed for Briefing-Pack agents) |
| [guides/claude-code-vscode-setup.md](guides/claude-code-vscode-setup.md) | Claude Code in VS Code against your proxy |

## Design & internals

For contributors. These describe **how it is built** and are the design of record for
shipped behaviour.

| Document | Subject |
|---|---|
| [key-files.md](key-files.md) | Repository layout and the files that matter |
| [cli-contract.md](cli-contract.md) | The one contract every built-in agent CLI (`knowledge`, `aee-artifact`, `aee-emit`, `gh-as-agent`) follows — naming, `--help`, `--json`, exit codes |
| [teams-data-model.md](teams-data-model.md) | Teams, users, memberships; roles and resource ownership |
| [flow-connection-model.md](flow-connection-model.md) | The unified connection model behind the Flow editor *(German)* |
| [process-template-format.md](process-template-format.md) | Schema of the portable process-template bundle |
| [wizard-flow-integration.md](wizard-flow-integration.md) | How the Team wizard and the Flow designer share one artifact |
| [per-agent-volume-isolation.md](per-agent-volume-isolation.md) | Per-agent filesystem and volume isolation |
| [slash-commands.md](slash-commands.md) | Custom Claude Code slash commands: skill-carried provisioning, `.claude/commands/` projection, headless verification |
| [agent-knowledge/](agent-knowledge/) | Seeded conventions, entities and facts for agent knowledge bases |

### The knowledge subsystem

Ten documents describe one subsystem in phases. Read them in this order:

| # | Document | Phase |
|---|---|---|
| 0 | [knowledge-store.md](knowledge-store.md) | The store: entry schema, layout, the autonomy dial |
| 1 | [knowledge-cli.md](knowledge-cli.md) | The `knowledge` CLI and the harvest hook |
| 2 | [knowledge-flow.md](knowledge-flow.md) | The Knowledge Flow page and its live feed |
| 3 | [knowledge-convergence.md](knowledge-convergence.md) | Detecting independently-learned lessons and promoting them |
| 4 | [knowledge-curation.md](knowledge-curation.md) | Auto-curation, review gates, the skill ladder |
| — | [knowledge-sharing-concept.md](knowledge-sharing-concept.md) | The umbrella plan tying all phases together |
| — | [knowledge-governance.md](knowledge-governance.md) | Keeping humans in control: autonomy as a dial, veto, cross-team sharing |
| — | [knowledge-skill-activation-concept.md](knowledge-skill-activation-concept.md) | Team-owned skill grants and one-click activation |
| — | [memory-knowledge-unification-concept.md](memory-knowledge-unification-concept.md) | Merging per-agent memory with the team knowledge base |
| — | [skills-system.md](skills-system.md) | The user-facing view of the same machinery |

## Proposals & backlog

Concepts and plans of record for work that is **partly or not yet built**. Useful for
understanding intent — do not read them as descriptions of current behaviour.

| Document | Subject | State |
|---|---|---|
| [unified-create-launcher-concept.md](unified-create-launcher-concept.md) | One "Create" launcher replacing the scattered agent/team/flow entry points | shipped (Phases A–F, #1664–#1669) |
| [multi-user-concept.md](multi-user-concept.md) | Enterprise identity, SSO, isolation, audit | partly shipped (login, teams, audit); SSO open |
| [personal-credentials-concept.md](personal-credentials-concept.md) | Per-human GitHub tokens & SSH keys — agents act under their owner's identity | proposal |
| [skill-lifecycle-concept.md](skill-lifecycle-concept.md) | Skill identity, versioning, transfer | open epic |
| [skill-aggregation-concept.md](skill-aggregation-concept.md) | Domain playbooks instead of one-lesson-per-skill | proposal |
| [knowledge-skill-ux-concept.md](knowledge-skill-ux-concept.md) | Redesign of the Knowledge page's skills column | proposal |
| [cost-per-pr-concept.md](cost-per-pr-concept.md) | Token telemetry attributed to work items | proposal |
| [e2e-testing-concept.md](e2e-testing-concept.md) | Browser-driven end-to-end testing | in flight |
| [journey-spec-concept.md](journey-spec-concept.md) | One journey spec feeding tests, docs, deck and video | in flight |
| [workspace-git-diff-plan.md](workspace-git-diff-plan.md) | A git-diff view in the agent chat *(German, draft)* | proposal |

## Historical

Kept for provenance. **These describe an architecture that no longer exists** — read them
only to understand how the project got here.

| Document | Why it is superseded |
|---|---|
| [architecture-story.html](architecture-story.html) | Earlier visual tour built on the single-agent / shared-pool model. Superseded by [platform-story.html](platform-story.html) |
| [briefing-pack-integration-plan.md](briefing-pack-integration-plan.md) | Self-declared superseded; assumed a multi-agent room and a central router |
| [agent-chat-plan.md](agent-chat-plan.md) | Build plan for the agent chat, which has shipped; still describes the removed Node agent runner |
| [vergleich-valkren-vs-agent-studio.md](vergleich-valkren-vs-agent-studio.md) | April-2026 comparison whose premise (agent pool, shared room) was rolled back *(German)* |
| [manual-test-agent-deactivation.md](manual-test-agent-deactivation.md) | One-off manual test script for a closed issue |
| [manual-test-agent-recreation.md](manual-test-agent-recreation.md) | Manual test: re-creating a deleted agent with the same id (issue #1386) |
| [test-207-deactivation-stops-triggers.md](test-207-deactivation-stops-triggers.md) | Older duplicate of the above |

## Domain material

Not platform documentation — subject-matter deliverables that happen to live here.

| Document | Subject |
|---|---|
| [modernization-pattern-catalog-initial-draft.html](modernization-pattern-catalog-initial-draft.html) | COBOL / mainframe → Jakarta EE modernization pattern catalog (initial draft) |

---

## Conventions for this directory

So the set stays navigable as it grows:

- **`<topic>.md`** — reference documentation for behaviour that exists today.
- **`<topic>-concept.md` / `<topic>-plan.md`** — intent for work that is not finished.
  Listed under *Proposals & backlog*, never under reference.
- **`guides/`** — step-by-step, do-this-then-that instructions.
- **`walkthrough/`** — the narrated product tour, one chapter per product area.
- Every new document gets a row in this index **in the same commit**. A document nobody
  links to is a document nobody reads: before this index existed, 15 files here were
  unreachable from any other page.
