# Agent Templates

## Chapter intro (slide 33)

Building agents from scratch, one generated prompt at a time, is powerful — but you don't want to reinvent the same Business Analyst or Code Reviewer every time you design a new flow. That's where Agent Templates come in.

An Agent Template is a ready-made, reusable agent definition — its persona prompt, its session behaviour, its triggers — packaged so you can drop it straight into a flow. Think of them as the building blocks the platform ships with, plus any you create yourself. In this short chapter I'll show two things: how templates let you assemble a flow in seconds instead of writing each agent by hand, and where you manage the template library itself.

## From a template (slide 34)

Screenshot: Add agent panel — "From a template" tab, catalog list with short descriptions; Architect selected, its full prompt shown as preview with the bundled-trigger note.

This is the same Add agent panel we used in the Flow editor a moment ago — but this time I stay on the From a template tab instead of building from scratch. Now, rather than typing a note and generating a prompt, I simply pick a pre-built role from the catalog.

The panel lists the available templates with a short description of each — here you can see an Architect that talks through system design before issues are written, a Backlog Hygiene agent that keeps the issue backlog clean, a Business Analyst that refines requirements into GitHub issues, and many more. When I select one — the Architect — the panel immediately shows its full, professionally-written agent prompt as a preview, and even notes what comes bundled with it, in this case one trigger. I can rename it if I like, then click Add agent, and a complete, battle-tested agent lands on the canvas — no prompt-writing required. That's the shortcut: instead of authoring every role, you compose your flow from proven templates and only fall back to "from scratch" for the roles that are genuinely unique to you.

## The template library (slide 35)

Screenshot: Agent Templates management page — table rows with ID, category (chat/reactive), session policy, source; the "New template" action visible.

And this is where those templates live: the Agent Templates management page. It's the single catalog of every predefined agent the platform offers — the same ones the Team-Setup wizard and the Flow editor draw from.

Each row is one template, with its ID, its category — chat or reactive — its session policy, and its source. You get the whole library out of the box: Architect, Backlog Hygiene, Business Analyst, Code Reviewer, Developer, Dispatcher, Documentation Sync, Issue Triage, and more — each a mature, ready-to-use role. The built-in ones ship as read-only defaults, but the important part is up here: New template. You can author your own reusable agents — capture a role you've refined, or a persona specific to your organisation — and from then on it appears in this catalog and in every flow's template picker. There are two ways to add one: **New template** here, or — once a live agent has proven itself — **Save as template** in Agent Chat's row context menu (next to Clone/Export on a standalone agent or a team member; the Agents page that used to carry it was removed in #1930), which snapshots that agent's prompt, skills and configuration into a new Custom template in one step. One note worth making: editing a template only affects future agents created from it; agents you've already spawned keep running independently. So Agent Templates are really about reuse at scale — define a good agent once, and reuse it across every team and every flow you build.
