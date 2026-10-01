---
id: about
routes: ["/about"]
title: About this build
summary: What exactly you are running — the git commit the console was built from, who contributed to it, the third-party model attributions — and where to turn when you need help or want to report a problem.
seeAlso:
  - { label: "GitHub Event Log", to: "/github-events" }
  - { label: "Maintenance Mode", to: "/maintenance-mode" }
  - { label: "Token Usage", to: "/token-usage" }
  - { label: "Agent Chat", to: "/chats" }
askPrompts:
  - "What exactly is the version string on this page?"
  - "What does the -dirty suffix on the version mean?"
  - "Where do I report a problem or give feedback?"
  - "Why is my name missing from the contributors list?"
  - "Which speech-to-text model does the console use?"
  - "Why does the sidebar show a date but this page shows a hash?"
---

## What this page is

Agent Studio's **identity card**: the copyright, the humans who built this
build, the third-party model attributions the licences require, and the exact
version you are looking at. Nothing here is configurable — it is the page you
open when you need to *say which build you are on*, or when you want to know
what the console is legally built from.

Everything on it is decided when the console is **built**, not when you load it.
There is no setting, no refresh and nothing to save; the only interactive things
are the attribution links and this help button.

## The version string

The version at the bottom of this page is **the git commit the console bundle
was built from** — a short hash, not a release number. There is no semantic
version to quote, so the hash *is* the version.

| What you see | What it means |
|---|---|
| `a1b2c3d` | The console was built from exactly that commit. |
| `a1b2c3d-dirty` | The build tree had **uncommitted changes** — the running code is *not* exactly that commit, so the hash alone cannot reproduce it. |
| `unknown` | The build had no git metadata available at all (a build context stripped of `.git`). |

The hash is embedded **at build time** and never looked up at runtime, so it
describes the bundle in your browser, not the state of any repository right now.
Rebuilding is what changes it — reloading the page never will. There is no API
that reports a version either, which is why this page is the place to read it.

The sidebar footer shows the **commit's own timestamp** rather than the hash
(formatted in the timezone it was committed in, so it never shifts to yours).
The two together — timestamp in the footer, hash here — are what pins a build
down; quote the hash, since two builds can share a day but never a commit.

## Contributors

The contributor list is derived from the **repository's git history at build
time**, not from any user directory or the Users page. It is a credit roll, not
an access list: being on it grants nothing, and being absent from it takes
nothing away.

Consequences worth knowing:

- **Only humans are listed.** Commits authored by this stack's own agents are
  filtered out by their internal, non-routable e-mail domains (any `.local`
  domain such as `…@agents.local` or `…@agent-studio.local`, its `.local.test`
  variant, and a bare `…@agent`) and by a `[bot]` marker in the name.
- **Identities are merged.** The same person committing under several e-mail
  addresses or name spellings collapses into one entry, and the spelling shown is
  the most complete one found — a full name with a space wins over a login-style
  handle.
- **Order is by commit count**, descending, ties alphabetical — but the count
  itself is deliberately never shown. It ranks the list; it does not score
  anybody.
- The whole section **hides itself** when the build had no git metadata, which
  is also why it can be empty on a stripped build even though the repository has
  a long history.

So a missing name almost always means one of two things: the commits were
authored under an internal-looking e-mail address, or this build was made
without git history.

## Third-party attributions

Voice input in the console — the composer's mic and the meeting note-taker — is
transcribed by an ONNX conversion of **NVIDIA Parakeet TDT 0.6B v3**, run
locally by the `onnx-asr` runtime. Three things are credited because three
things are used, and the page links each to its own licence: the **model**
(CC-BY-4.0, NVIDIA), the **ONNX conversion** of it (CC-BY-4.0) and the
**inference library** (MIT).

CC-BY-4.0 *requires* the attribution to be carried with the work, which is why
this lives on a page of its own rather than in a footnote. The model is used
**as published**: no retraining and no fine-tuning were performed, which is the
claim the last line of the section makes explicitly.

## Where to get help

Help is in the panel you are reading:

- **This page** — curated help for whichever page you are on. Open it with the
  header **Help** button or the small **?** next to a page's title.
- **Ask** — free-text questions, answered with the current page's help topic and
  the platform documentation as grounding. Use it when the curated page has not
  answered you.
- **Tour** — a guided walk-through of the console for a first-time user.
- **← Overview** — the big picture of the core concepts, from any page.

## Reporting a problem

There is **no in-app feedback form**, no support address on this page and no
issue tracker the console can reach. Report problems to whoever operates your
stack, and give them three things:

1. **The version from this page** — the hash (including any `-dirty` suffix).
   Without it, "the console is broken" cannot be matched to any code.
2. **The page or route** it happened on.
3. **The relevant evidence surface**, if there is one: **GitHub Event Log** when
   an agent did not wake up on a GitHub event, **Token Usage** for spend and
   attribution questions, and the agent's own session log in **Agent Chat** for
   anything the agent itself did.

If the whole platform looks deliberately paused rather than broken, check
**Maintenance Mode** first — an active maintenance window suppresses scheduled
runs and locks every chat composer on purpose, and that is not a fault to
report.
