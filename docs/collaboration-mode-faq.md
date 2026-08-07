# Collaboration Mode FAQ — Open Points & Resolutions

Answers to the questions commonly raised about **team collaboration after deploying Agent Studio**. Each point states the question, the concrete resolution, and — where something is genuinely missing — the known gap and its tracking issue.

---

## 1. Concurrency

**Question:** One container per agent — messages queue. Two people can't use the same agent at the same time. How do we handle a team of N people hitting the same agent set?

**Resolution:**
The design assumption is intentional: at any given time, exactly one person works with one agent. This follows directly from how the interface is built (a 1:1 human ↔ agent chat). Parallelism is achieved not by sharing a single agent, but in one of two ways:

1. **Clone the agent.** The Studio makes cloning an existing agent trivial — a single click in the agent-management UI. Example: we have a Developer agent we're confident is the right one; two people want to work in parallel, so each gets their own clone. The clones will naturally diverge over time, which is fine — each works a different task and therefore has a different local memory. So that both still benefit from the same experiences, learned knowledge is exchanged through the **Knowledge system**.

2. **Materialize a personal team from a shared Flow (the more natural pattern).** We define a Flow once; each person materializes their own personally-assigned team from that Flow. Because the Knowledge base is git-versioned, cross-team knowledge is exchanged through the repository — and later through skills.

In short: don't scale by putting N people on one agent; scale by cloning agents / materializing per-person teams, and share learning via the git-versioned Knowledge system (and skills).

---

## 2. KB Quality

**Question:** Agents auto-commit to shared knowledge (autonomy level 1). Bad or wrong facts propagate to everyone. Who reviews? When?

**Resolution:**
Besides the autonomy level, the Knowledge configuration has an explicit **Review flag**, **off by default** — so team knowledge is shared automatically and immediately. Turn Review **on** and nothing is shared until a human manually approves each fact / convention. This setting is part of the git repo and is therefore shared across the team.

The default (Review off) is a deliberate, experience-based choice:

- **Volume makes per-fact review impractical.** Agents work very fast and in parallel. The Knowledge system is less than two weeks old and the dogfooding Agent Studio team has already learned 500+ knowledge snippets. Reviewing every single one would be a full-time job in itself.
- **Snippets are often not meaningfully human-reviewable.** Many are somewhat context-free and not really understandable to a human out of context. (Fair to ask whether such a fact is even useful — but that mirrors how humans actually work in a team.)
- **Analogy to a human team.** In a 10-person team, everyone learns something a little differently every day. Today there is no way to exchange that tacit team knowledge at all. Pooling every member's snippets — however small — is still valuable.
- **A single pool doesn't automatically form a coherent picture — and it isn't meant to.** That's the job of the next aggregation level: snippets are consolidated into **skills** that hold the actual collected knowledge.
- **Occasional wrong facts are tolerable.** Not desirable, but as in a real team not everyone knows every fact. With ~90–95% correct facts, standard software-engineering mechanisms still let us produce a high-quality result.

Bottom line: manually approving 500 tiny facts is not realistic, so automatic sharing is the sensible default — but if a team wants strict gating, the Knowledge config provides exactly that (Review flag on), and the choice travels with the repo.

---

## 3. Shared Credentials

**Question:** One GitHub PAT per Working Environment, shared by all agents. Single point of failure. Who owns it, who rotates it?

**Resolution:**
Credentials can be assigned **per agent team**. Under the scaling assumption from Point 1 — one agent team per human — this yields a clean mapping: each human-assigned agent team can manage its own individual key. Ownership and rotation of that key therefore sit with the respective human and their team, not with a shared pool.

As noted, having multiple humans work on a single agent team is currently not really the intended model; whether that holds up long-term remains to be seen. The multi-user capability is recent — the last two to three weeks were spent intensively pulling things apart to support multi-user operation. It is certainly not fully end-to-end yet, so if real gaps surface, flag them and we'll follow up.

---

## 4. KB Git Conflicts

**Question:** Multiple agents pushing to the shared knowledge file concurrently will conflict. JSONL appends are line-atomic but pushes aren't. Needs a strategy.

**Resolution:**
Conceptually already solved. There is **no shared file that agents write to directly** — each agent writes only to its **own shard**, which should push conflict-free. We also do not allow parallel sessions on a single agent. The canonical **merged view is written by a single writer — the orchestrator** — so there is one central point of write, and merge conflicts should be conceptually excluded (as long as we run the hosted variant).

If an actual problem is found here, flag it and we'll sharpen it.

---

## 5. Config Changes Are Instant and Global

**Question:** Editing the team system prompt rewrites every agent's CLAUDE.md immediately. No staging. One bad edit breaks all agents at once.

**Resolution:**
In practice the harder problem has been the opposite direction — making sure a changed prompt actually becomes active inside the individual containers. For the per-agent prompts, being able to change things quickly is in fact desirable.

Agreed on the gap: there is currently **no rollback and no undo**, and that does need to be sharpened. A clean version history, undo, rollback to a previous version, or even a staging concept would be ideal — but so far this has not been very high on the priority list. *Tracked as #990.*

For the **team-wide system prompt** specifically: the intention is to likely **remove it mid-term**, since it is overridden by the more specific individual agent prompts anyway.

And under the one-team-per-human premise (Point 1), the blast radius of a bad edit is largely contained to that person's own team, which defuses the concern considerably.

---

## 6. Skill Updates Don't Propagate to Running Agents

**Question:** When a global skill is updated, running agents don't pick it up automatically — you need to deactivate then reactivate the skill per agent. No notify-on-update. Who triggers the resync and when?

**Resolution:**
A skill update of a global skill **can be propagated to the individual agents via the Skill Registry** — this should already be implemented (no deactivate/reactivate dance needed). The one case that doesn't apply immediately is when an agent is currently **in-flight in a session**: the change is not injected mid-session. But as soon as the **next prompt is sent or the next trigger fires**, the updated skill should be active (skills are static files read fresh per invocation).

If that turns out not to be the case, flag it — then there's a real bug — but conceptually this is solved.

---

## 7. Skill Drift Resolution Requires Manual Intervention

**Question:** If a team-level skill diverges from the global version, the system detects it (diverged/conflict states) but only outdated copies can be auto-resynced. Diverged/conflicting copies need manual side-by-side review. What's the agreed workflow mid-project?

**Resolution:**
A lot of recent work went into skills: automatic aggregation, promoting skills up from the agent level to the team level and on to the global level, the versioning and hashing, the traceability of what is active where, and re-applying skills.

The specific case described here — resolving **diverged / conflicting** copies — is indeed **still a gap with no automatic mechanism**. For now this is **manual work** (side-by-side review by hand). *Tracked as #991.*

---

## 8. No Formal Skill Import from External Sources

**Question:** Importing a skill from outside means manually dropping files into the pool and running `make seed-pool`. There's no in-app import from URL or cross-team sharing flow. How do we share skills across projects or bring in skills from other teams?

**Resolution:**
This is already covered in the UI. The Skill Registry has both an **Export** button and an **Import** button for sharing skills — **no `make seed-pool` required**.

- **Export**: downloads the whole skill directory as a ZIP (`SkillsRegistry.jsx` → "Export ZIP", `GET /api/skills/:name/export`).
- **Import**: uploads a skill file into the global pool or a specific team tier (`SkillsRegistry.jsx` → "Import skill", `POST /api/skills/import`).

Crucially, the import accepts skills in the **classic skill format** produced by other tools. So it's interoperable both ways: you can author a skill in, e.g., the Claude Desktop app and import it into the Studio, or take a skill exported from the Studio and import it into Claude Desktop or other tools.

(The only thing that genuinely doesn't exist is import *from a URL* — import is file-upload-based. Cross-team sharing is handled by export/import plus the promote-up-the-tiers flow from Point 7.)

---

## 9. Access Control

**Question:** Admin Console ships with one shared login. Anyone with it can change any config, see all sessions, access all credentials. No role separation out of the box.

**Resolution:**
Access control is no longer a single shared login. Under the Team area we can **create users and give each user an individual password**, and assign users to agent teams. There are **three roles — System Admin, Team Admin, and normal Team Member** — which are allowed to see different things in the Studio (visibility scoping).

**SSO integration is designed for but not yet implemented** (currently being built by a colleague); the same work covers assignment of users to agent teams.

This functionality is fairly new, so there may still be gaps and it needs to be carried through conceptually — but the fundamentals are in place today: **visibility restriction by role and the ability to work with multiple individual logins are already implemented**, and SSO is pre-planned.

> **Known gap to carry through (from code review):** read/visibility scoping and credential-write authorization (create/rotate/reassign keys) are enforced by role. However, the core agent- and environment-**config write endpoints** (`PUT/POST/DELETE /api/agents/:id`, agent triggers, environment CRUD) are currently authenticated-only with no per-role/per-team authorization check — any logged-in user can mutate them. This is the concrete item to close as the RBAC model is finished. *Tracked as #989.*
