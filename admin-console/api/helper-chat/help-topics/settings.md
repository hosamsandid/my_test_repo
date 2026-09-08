---
id: settings
routes: ["modal:settings"]
title: Settings
summary: Your four personal preferences — how the chat composer sends, which Model Provider AI helpers bill against, and how the console looks. All of them are per-person; none of them changes what an agent runs on.
seeAlso:
  - { label: "Model Providers", to: "/models" }
  - { label: "Agent Chat", to: "/chats" }
  - { label: "Token Usage", to: "/token-usage" }
  - { label: "Administration", to: "/users" }
askPrompts:
  - "Does the Assist model change which model my agents run on?"
  - "Why is the Assist model picker highlighted?"
  - "Will my theme and send-key choice follow me to another browser?"
  - "What is the difference between IDE style and Chat style?"
  - "Why can I not pick a subscription (OAuth) provider for assist calls?"
  - "Why did my colleague's theme change when I changed mine?"
---

## What this dialog is

Four **personal** preferences, reached from the account menu. Nothing here is
platform configuration: no other person's console changes, and no agent's
behaviour changes. Everything applies immediately — there is no Save button and
nothing to confirm, so closing the dialog never discards anything.

The dialog is an **overlay**, not a page: it opens on top of whatever route you
were on and hands you back to it when you close it (`Esc`, the ✕, or a click on
the backdrop). The rail on the left holds three sections — **Behavior**,
**Model** and **Display** — and it opens on Behavior unless something sent you
somewhere specific. A failed AI-helper call is the one thing that does: it opens
this dialog **on the Model section** because that is the setting it needs from
you.

Each section's "?" opens this topic at that section's chapter.

## Behavior — how the composer sends

One choice, the **send keybinding**, shared by every Agent Chat composer:

| Preset | Enter | Send |
|---|---|---|
| **IDE style** (default) | inserts a newline | `Cmd`/`Ctrl` + `Enter` |
| **Chat style** | sends | `Shift` + `Enter` for a newline |

The label you see names your own platform — `⌘+↩ sends` on a Mac, `Ctrl+↩ sends`
everywhere else. Two details the table cannot show:

- **`Cmd`/`Ctrl` + `Enter` sends in *both* presets.** IDE style only removes
  plain `Enter` as a send key; it never takes the modifier away. So the
  modifier chord is the one keystroke that always works, whatever the preset.
- **Composing with an IME never sends.** While a candidate window is open,
  `Enter` belongs to the input method — the composer stays out of the way and
  commits the text instead of dispatching it.

The change reaches an already-open chat immediately — the composer listens for
the change rather than reading the preference once at mount, so you do not need
to reload or switch agents.

## Model — which provider AI helpers bill against

The **Assist model** is the Model Provider *and* model that the console's own
one-shot AI helpers use. That is a specific, closed list: **Flow Copilot**,
*Generate agent prompt*, the port/outcome wiring suggestions, the knowledge
drafting and summary helpers, the skill-merge draft, the improvement analyst,
and the **Ask** tab of this help panel.

**It is not the model your agents run on.** An agent's model comes from its
Working Environment's provider, or from the per-agent override in the Agent Chat
header — changing the Assist model never restarts an agent or alters a running
one. The two selectors deliberately look alike (they are the same popover
component) but they answer different questions, and they are stored in different
places: an agent's model is configuration on disk that a Team Admin sets, while
the Assist model is a personal preference in your own browser that needs no
special rights at all.

Things worth knowing:

- The selection travels as a header on every console request, so a helper call
  always bills against the provider you picked, never a server default. That is
  also why it is *your* choice and not the team's.
- With **exactly one** provider available it is picked for you but not written
  down — so if a second provider appears later, you are asked to choose rather
  than silently kept on the first.
- With **two or more** and none picked the control is highlighted, and an assist
  call refuses rather than guessing — which is why an error can open this dialog
  on the Model section by itself.
- If the server refuses your stored choice (the provider is no longer visible to
  your teams), the selection is dropped and the list refetched — so a stale pick
  cannot keep failing silently.
- **Subscription (`oauth-token`) providers are not offered here.** Server-side
  assist calls skip that auth type on purpose; those seats are single-user, so a
  shared console helper must not spend one. They stay available to *agents*,
  which is why one can be missing here yet present on an agent.
- With no providers registered at all, the console falls back to the built-in
  `.env` credentials and the control says so instead of pretending to be a
  choice.

## Display — theme and transcript size

**Theme** switches the console colour scheme — **Dark** (the default), **Light**
or **High contrast** — and takes effect on the spot, with no reload.

**Chat font size** steps the Agent Chat transcript between **10 and 18 px**
(default 12) with the − / + buttons, which stop at each end rather than wrapping.
The transcript resizes as you press, including a chat you already have open. It
changes the *messages* only — the rest of the console keeps its own sizing.

## Where these preferences live

This is the part that surprises people, because the four preferences do not all
live in the same place:

| Preference | Stored |
|---|---|
| Send keybinding | in this browser only, for **anyone** who uses it |
| Theme | in this browser only, for **anyone** who uses it |
| Assist model | in this browser, **per signed-in username** |
| Chat font size | on **your user record** (server), with a browser fallback |

Three consequences:

- **The chat font size follows you.** Sign in on another machine and it is
  already right, because it is stored on your user record and read back with
  your session.
- **Theme and send keybinding do not follow you** — and they are not even tied
  to *you*. They belong to the browser profile, so on a shared or kiosk machine
  the next person inherits whatever you last chose. A fresh browser starts at the
  defaults (Dark, IDE style).
- **The Assist model is per-username but still browser-local**, so two people
  sharing a machine keep separate picks, and your own pick does not follow you to
  a different browser.

The environment's built-in single admin has **no user record** at all, so even
the font size has nowhere on the server to go — it is kept locally like the rest
and quietly does not persist across browsers. Everyone with a real user record
gets the server-backed behaviour.
