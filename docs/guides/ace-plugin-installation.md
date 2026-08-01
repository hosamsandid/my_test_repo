# ACE Plugin Installation

> **When is this needed?** The ACE plugin is only required if your project uses **ACE BriefingPacks** and `bp-instance` / `bp-orchestrator` agents. The core AEE stack (Admin Console, Orchestrator, agents, teams) works without it. If you are not using BriefingPacks, skip this guide.
>
> The plugin provides the `i-sase-marketplace` engineering skill that `make seed-pool` copies into the agent skill pool. Without it, `make seed-pool` will warn and skip the engineering skill — everything else seeds normally.

Install the ACE plugin into your **local Claude Code CLI** (the one you use to work on this repository, not the agents' runtime).

**1. Open the plugin manager:**

```
/plugins
```

**2. Navigate to the Marketplaces tab and add the ACE plugin repository:**

```
https://github.com/AccentureCodeFoundry/314092_agent-command-environment.git
```

**3. Reload plugins:**

```
/reload-plugins
```

**4. Verify the ACE plugin is enabled:**

```
/plugins
```

Navigate to the **Installed** tab — `ace Plugin · i-sase-marketplace · enabled` should appear.

**5. Confirm available ACE commands:**

```
/ace
```

Typing `/ace` lists all commands provided by the plugin.

