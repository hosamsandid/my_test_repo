# ACE Plugin Installation

> **When is this needed?** The ACE plugin is only required if your project uses **ACE BriefingPacks** and `bp-instance` / `bp-orchestrator` agents. The core AEE stack (Admin Console, Orchestrator, agents, teams) works without it. If you are not using BriefingPacks, skip this guide.
>
> The plugin provides the `i-sase-marketplace` engineering skill that `make seed-pool` copies into the agent skill pool. Without it, `make seed-pool` will warn and skip the engineering skill — everything else seeds normally.

Install the ACE plugin into your **local Claude Code CLI** (the one you use to work on this repository, not the agents' runtime).

**1. Open the plugin manager:**

```
/plugins
```

![Running /plugins command in Claude Code CLI](assets/ace-plugin/01-plugins-command.png)

**2. Navigate to the Marketplaces tab and add the ACE plugin repository:**

```
https://github.com/AccentureCodeFoundry/314092_agent-command-environment.git
```

![Adding ACE marketplace in /plugin UI](assets/ace-plugin/02-marketplace-add.png)

**3. Reload plugins:**

```
/reload-plugins
```

![/reload-plugins output showing 1 plugin, 9 commands, 9 agents loaded](assets/ace-plugin/03-reload-plugins.png)

**4. Verify the ACE plugin is enabled:**

```
/plugins
```

Navigate to the **Installed** tab — `ace Plugin · i-sase-marketplace · enabled` should appear.

![ACE Plugin shown as enabled in Installed tab](assets/ace-plugin/04-verify-installed.png)

**5. Confirm available ACE commands:**

```
/ace
```

Typing `/ace` lists all commands provided by the plugin.

![/ace listing available ACE commands](assets/ace-plugin/05-ace-commands.png)
