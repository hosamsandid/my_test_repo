# Host-folder context mount

*Give one agent live access to a folder on the host machine — read-only by default,
or read-write when explicitly enabled.*

## What it is

An admin can point an agent at a **single directory on the host** — for example a
SharePoint folder that a background sync keeps up to date on your local disk. That
directory is bind-mounted into the agent's container at a fixed, documented path:

```
/context
```

From then on the agent always sees the **current** contents of that folder as
ordinary files under `/context` — no more uploading the same files into the chat
every time they change. Because the mount is live, whatever your sync writes to
the folder on the host is immediately available to the agent on its next access.

By default the mount is **read-only**. An admin may instead enable **read-write**
(#1289), so the agent can create, modify and delete files under `/context` and those
changes land on the host folder — e.g. dropping a generated summary into the synced
folder so it propagates to colleagues. Read-only stays the default and read-write is
a deliberate, per-agent opt-in (see [Read-write access](#read-write-access-1289) below).

Scope is deliberately small and safe:

- **read-only by default**, read-write only when explicitly enabled per agent;
- **admin-only** — only someone with management rights over the agent's team can set it;
- **one folder per agent** — multiple mounts are a possible follow-up;
- **local / self-hosted only** — it is unavailable on the hosted (GKE/IAP) stack.

## How to set it

1. Open the **Agents** page, edit the agent, and find **Host context folder**.
2. Enter an absolute host path (e.g. `/home/me/SharePointSync/ProjectX`). Leave
   **Mount read-write** unchecked for read-only access (the default), or check it to
   let the agent write back to the folder. Click **Save & re-provision**.
3. The agent's container is re-created so the mount takes effect. The panel reports
   whether the re-provision happened, and in which access mode.

To remove it, click **Clear**.

On the hosted stack the control is shown but disabled, with an explanation — a host
bind-mount has no meaning there.

## Read-write access (#1289)

Read-write is **off by default** — an agent without it explicitly enabled behaves
exactly as a read-only mount, and an agent with no mount at all is completely
unaffected. When enabled:

- the bind mount is created `rw` (instead of `ro`); the SELinux relabel `z` still
  applies, so the agent may both read *and* write on Fedora-family hosts;
- the agent can create, modify and delete files under `/context`, and the changes
  are observable on the host folder;
- changing the option re-provisions the agent's container (like setting or clearing
  the path), because the access mode is baked at container-create time.

**Trust boundary is unchanged.** Read-write carries the same gates as the read-only
mount: **admin-only** and **local / self-hosted only**. It is a per-agent opt-in on
top of an already-scoped feature.

### Risks — read before enabling

- **The agent can delete or overwrite host files.** Everything under the folder is
  writable by the agent, including files your background sync (SharePoint, OneDrive,
  …) also writes. There is **no conflict resolution or locking** against the host
  sync touching the same file concurrently — last writer wins.
- **Write-through to the cloud is the host's own sync**, not this feature. A file the
  agent writes propagates only if and when the host's background sync uploads it.
- **Online-only / not-materialised files** (e.g. an un-downloaded OneDrive placeholder)
  may fail to write, just as they may fail to read — behaviour is no worse than, and
  consistent with, the read-only path.
- **Host path not writeable by the container's UID** surfaces as a normal write error
  to the agent, not a silent failure.

Because of the above, keep the exposed folder scoped to exactly what the agent needs
to write, and prefer read-only whenever the workflow only reads.

## Using it from an agent / a prompt

The folder is always at `/context`, so a prompt can rely on it:

> Read the latest requirements from `/context` and summarise what changed since last week.

**The agent is told about it automatically** (#1286). When an agent carries a mount, its
seeded `CLAUDE.md` gains a **Read-only Context Folder** section naming the path, the host
location, and the two things an agent otherwise gets wrong: the folder is a *live view*
(re-read it, don't trust what it said last run) and it is *not part of any repository*
(copy before keeping). An agent without a mount never sees the section — the block is
gated in `prompt-assembly.js` exactly like Git/Skills/Trigger-management, and the Prompt
tab shows a `context folder` badge when it is active. Setting or clearing the mount
rebuilds and reseeds `CLAUDE.md` before the respawn, so the prompt and the container
never disagree.

## Browsing it from the console

The mount shows up in the **Workspace** tab of Agent Chat as a `context` root next to the
agent's own files, marked `host · read-only`. Expanding it lists the folder's *current*
contents — a file the host sync writes appears on the next expand, no respawn needed.
Directories navigate, text files open in the viewer, images preview inline, anything else
downloads.

It is read-only all the way down: there is no upload, delete or drag-move for that
subtree in the UI, and no API route that could write there.

**How it works** (and why it isn't a second mount): the host folder is bind-mounted into
the *agent's* container only. The admin console reads the pool volume from its own
container and has no view of it — re-mounting the folder under
`/workspace/agents/<id>/context` would not help either, because a bind mount inside the
agent container never appears in the pool volume the console reads. So the listing and
the read happen where the folder actually is:

```
Workspace tab  →  GET /api/agents/:id/context/{status,tree,file,image,download}
               →  GET /internal/agents/:id/context/{tree,file,download}   (orchestrator)
               →  one-shot exec in the agent's container (libpod)         (container-exec.js)
               →  `list` / capped `read` under /context                   (context-browse.js)
```

Consequences worth knowing:

- **The agent must be running.** A stopped agent has no container to read through, so the
  console answers `409` and the tree shows the error rather than pretending the folder is
  empty.
- **Downloads are capped at 25 MB.** The bytes travel base64-encoded through the exec
  pipe, not as a file stream; a larger file is refused outright rather than silently
  truncated. The viewer keeps the same 512 KB read cap as the workspace browser.
- **Online-only (cloud placeholder) files cannot be read** — by the browser *or* by the
  agent. A OneDrive/iCloud file that the host has not downloaded lists with its real name
  and size but fails to open from inside the container (`EDEADLK`); the browser reports
  *"file is online-only on the host and was not downloaded"* instead of a generic error.
  The fix is on the host: mark the folder **Always keep on this device**.
- **Containment is enforced twice.** The request-side guard refuses `..`, absolute paths
  and control characters; inside the container every path is resolved with `realpath` and
  must stay under `/context`. A symlink pointing outside the folder is *listed* (so the
  tree is honest about what is there) but is not navigable and cannot be read.

## Path validation

The host path is validated server-side before any mount is created (basic guard, not
a full sandbox). Rejected:

- non-absolute paths and paths containing `..` traversal segments;
- the filesystem root and obviously-unsafe system directories
  (`/etc`, `/root`, `/proc`, `/sys`, `/dev`, `/usr`, `/var/lib`, …);
- paths with control characters, or absurdly long paths.

The validator is the pure module `orchestrator/context-mount.js` (unit-tested;
duplicated byte-identically at `admin-console/api/context-mount.js` because the two
container images ship disjoint file sets). The mount is applied in
`orchestrator/spawn-container.js` as a libpod OCI bind mount with options
`ro,z` — or `rw,z` when read-write is enabled (`buildContextMountSpec(path,
{ readWrite })`). Either way the `z` relabels for SELinux so the mount works on
Fedora-family hosts without breaking container startup (the relabel permits both
reads and writes).

## How it is wired

| Layer | What happens |
|---|---|
| **Config** | `contextMount` (absolute host path string) is persisted on the agent's `config.json`; `contextMountRw: true` is added only when read-write is enabled (a read-only mount carries no flag, so its config is byte-identical to a pre-#1289 agent). |
| **API** | `PATCH /api/agents/:id/context-mount` validates the path, writes config (including the `readWrite` flag), rebuilds the prompt and best-effort respawns the agent. `GET /api/context-mount/capability` tells the UI whether the feature is offered here. Both admin-gated / local-gated. |
| **Provisioning** | `startAgentProcess` reads `config.contextMount` + `config.contextMountRw` (podman runtime only) and passes them to `spawnContainer`, which adds the bind mount at `/context` in the requested access mode. Mounts are baked at container-create time, so a change requires a respawn. |
| **Prompt** | `prompt-assembly.js` emits the gated **Read-only Context Folder** section; `POST /internal/agents/:id/prompt-rebuild` rebuilds + reseeds `CLAUDE.md` when the mount is set or cleared. |
| **Browsing** | `GET /api/agents/:id/context/{status,tree,file,image,download}` → `/internal/agents/:id/context/*` → a one-shot read-only exec in the agent's container (`container-exec.js`) running the `list`/`read` program from the pure `context-browse.js`. |

## Known limits (v1)

- **Existence isn't pre-checked.** The orchestrator runs in a container and cannot
  stat host paths, so a path that doesn't exist on the host is caught by the
  container engine at provisioning time (the agent fails to start) rather than by an
  up-front validation error. Point the mount at a folder that already exists.
- **One folder per agent.** Multiple mounts and any allowlist-management UI are
  explicit follow-ups.
- **Not portable.** A host path is tied to this local host by design; it does not
  travel with an exported process template or across environments.
- **Symlinks inside the folder** that point outside it resolve on the host as usual for
  the *agent* — keep that in mind when choosing what to expose. The console's browser is
  stricter: it refuses to follow a symlink out of `/context`.
- **Browsing needs a running agent** and reads through an exec, so a very large folder
  lists more slowly than the workspace tree, and downloads are capped at 25 MB.
- **Cloud-sync placeholders are unreadable** for the agent as well as the console (see
  above) — if the mount points at a OneDrive/iCloud folder, keep it available offline.

Precedent: this generalises the commented `${ACE_REPO_PATH}:/ace` bind-mount in
`docker-compose.yml` to be per-agent, read-only, and configurable from the console.
