---
id: settings
routes: ["modal:settings"]
title: Settings
summary: Your three personal preferences — how the chat composer sends, which Model Provider AI helpers bill against, and how the console looks. All of them are per-person; none of them changes what an agent runs on.
seeAlso:
  - { label: "Model Providers", to: "/models" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Token Usage", to: "/token-usage" }
  - { label: "Access", to: "/teams" }
askPrompts:
  - "Does the Assist model change which model my agents run on?"
  - "Why is the Assist model picker highlighted?"
  - "Will my theme and send-key choice follow me to another browser?"
  - "What is the difference between IDE style and Chat style?"
  - "Why can I not pick a subscription (OAuth) provider for assist calls?"
---

## What this dialog is

Three **personal** preferences, reached from the account menu. Nothing here is
platform configuration: no other person's console changes, and no agent's
behaviour changes. Everything applies immediately — there is no Save button and
nothing to confirm.

## Behavior — how the composer sends

One choice, the **send keybinding**, shared by every Agent Chat composer:

| Preset | Enter | Send |
|---|---|---|
| **IDE style** (default) | inserts a newline | `Cmd`/`Ctrl` + `Enter` |
| **Chat style** | sends | `Shift` + `Enter` for a newline |

The change reaches an already-open chat immediately — the composer listens for
the change rather than reading the preference once at mount, so you do not need
to reload or switch agents.

## Model — which provider AI helpers bill against

The **Assist model** is the Model Provider *and* model that the console's own
one-shot AI helpers use: Flow Copilot, *Generate agent prompt*, the wiring
suggestions, the improvement analyst and the **Ask** tab of this help panel.

**It is not the model your agents run on.** An agent's model comes from its
Working Environment's provider, or from the per-agent override in the Agent Chat
header — changing the Assist model never restarts an agent or alters a running
one. The two selectors deliberately look alike (they are the same popover
component) but they answer different questions.

Things worth knowing:

- The selection is sent as a header on every console request, so a helper call
  always bills against the provider you picked, not a server default.
- With **exactly one** provider available it is picked for you. With **two or
  more** and none picked the control is highlighted, and an assist call refuses
  rather than guessing — which is why an error can open this dialog on the Model
  section by itself.
- If the server refuses your stored choice (the provider is no longer visible to
  your team), the selection is dropped and the list refetched — so a stale pick
  cannot keep failing silently.
- **Subscription (`oauth-token`) providers are not offered here.** Server-side
  assist calls skip that auth type on purpose; those seats are single-user, so a
  shared console helper must not spend one.
- With no providers registered at all, the console falls back to the built-in
  `.env` credentials and the control says so instead of pretending to be a
  choice.

## Display — theme and transcript size

**Theme** switches the console colour scheme (dark, light, high contrast) and
takes effect on the spot. **Chat font size** steps the Agent Chat transcript
between 10 and 18 px (default 12) and reaches the open chat immediately.

## Where these preferences live

| Preference | Stored |
|---|---|
| Send keybinding | in this browser only |
| Theme | in this browser only |
| Assist model | in this browser, per signed-in username |
| Chat font size | on **your user record** (server), with a browser fallback |

So the font size follows you to another browser once you sign in, and the other
three do not — a fresh browser starts at the defaults. This is also why the
environment's single built-in admin, which has no user record, keeps even the
font size locally.
