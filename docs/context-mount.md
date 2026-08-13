# Host-folder context mount

*Give one agent live access to one or more folders on the host machine —
read-only by default, or read-write when explicitly enabled.*

## What it is

An admin can point an agent at **one or more directories on the host** — for example
a SharePoint folder that a background sync keeps up to date on your local disk, plus a
second folder of design assets. Each directory is bind-mounted into the agent's
container at its own fixed, documented path (see
[Mount-path scheme](#mount-path-scheme-1290) below):

```
/context                 (a single, legacy folder)
/context/<name>          (each folder in a multi-folder set)
```

From then on the agent always sees the **current** contents of each folder as
ordinary files under `/context` — no more uploading the same files into the chat
every time they change. Because the mounts are live, whatever your sync writes to a
folder on the host is immediately available to the agent on its next access.

By default each folder is **read-only**. An admin may instead enable **read-write**
(#1289), so the agent can create, modify and delete files in that folder and those
changes land on the host — e.g. dropping a generated summary into the synced folder so
it propagates to colleagues. Read-only stays the default and read-write is a deliberate,
per-folder opt-in (see [Read-write access](#read-write-access-1289) below).

Scope is deliberately small and safe:

- **read-only by default**, read-write only when explicitly enabled per folder;
- **admin-only** — only someone with management rights over the agent's team can set it;
- **one or more folders per agent** (#1290) — each at a distinct, stable path;
- **local / self-hosted only** — it is unavailable on the hosted (GKE/IAP) stack. On
  a local Kubernetes runtime (kind) it takes an explicit operator opt-in
  (`AEE_K8S_CONTEXT_HOSTPATH=1`, #1319 — see [Kubernetes (kind) support](#kubernetes-kind-support-1319)).

## How to set it

1. Open the **Agents** page, edit the agent, and find **Host context folders**.
2. Click **+ Add folder** and enter an absolute host path
   (e.g. `/home/me/SharePointSync/ProjectX`). Leave **Mount read-write** unchecked for
   read-only access (the default), or check it to let the agent write back to that
   folder. Add as many folders as you need, then click **Save & re-provision**.
3. The agent's container is re-created so the mounts take effect. The panel reports how
   many folders mounted, each folder's in-container path, and whether the re-provision
   happened.

To remove one folder, click its **Remove** and save. To remove them all, click
**Clear all**.

## Mount-path scheme (#1290)

Each folder is mounted at a **distinct, stable** location under `/context`:

- A **single legacy folder** (an agent configured before #1290, or via the single-path
  API body) keeps the bare `/context` target unchanged — so an existing single-folder
  agent keeps working with no reconfiguration.
- Each folder configured through the multi-folder control mounts at **`/context/<slug>`**,
  where `<slug>` is derived from the folder's basename (lowercased, non-`[a-z0-9._-]`
  runs collapsed to `-`), de-duplicated with a numeric suffix (`docs`, `docs-2`, …) so
  two folders with the **same basename**, or the **same host path added twice**, never
  collide. The slug is assigned once and persisted, so a folder's path stays **stable**
  even when other folders are added or removed, or when its own host path is repointed.

Folders are **siblings**, never nested: a folder is never mounted *inside* another
folder's target (which would shadow that folder's contents and break the read-only
guarantee), which is why the scheme uses sibling `/context/<slug>` paths rather than
placing extra folders beneath a bare `/context` mount.

On the hosted stack the control is shown but disabled, with an explanation — a host
bind-mount has no meaning there.

## Read-write access (#1289)

Read-write is **off by default** — a folder without it explicitly enabled behaves
exactly as a read-only mount, and an agent with no mount at all is completely
unaffected. It is a **per-folder** opt-in (#1290): in a multi-folder set each folder
carries its own read/write mode, so you can expose one folder read-write and keep the
rest read-only. When enabled for a folder:

- the bind mount is created `rw` (instead of `ro`); the SELinux relabel `z` still
  applies, so the agent may both read *and* write on Fedora-family hosts;
- the agent can create, modify and delete files under that folder's path, and the
  changes are observable on the host folder;
- **the console workspace browser** gains upload, delete and drag-move for that
  folder's subtree (a read-only folder stays browse-only). The mutation runs inside
  the agent's container — the console proxies `DELETE/POST /api/agents/:id/context/{file,move,upload}`
  to the orchestrator, which runs a containment-checked `WRITE_PROGRAM`
  (`orchestrator/context-write.js`) for delete/move and streams upload bytes in via
  the libpod archive endpoint. A drag-move is a rename within **one** folder; the
  mount root itself is never deletable. The kernel EROFS on a read-only bind mount is
  the ultimate backstop, so a write can never land on a folder mounted `ro`;
- changing the option re-provisions the agent's container (like adding or removing a
  folder), because the access mode is baked at container-create time.

**Trust boundary is unchanged.** Read-write carries the same gates as the read-only
mount: **admin-only** and **local / self-hosted only**. It is a per-folder opt-in on
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

Each folder is at a stable path under `/context`, so a prompt can rely on it:

> Read the latest requirements from `/context/projectx` and summarise what changed since last week.

**The agent is told about it automatically** (#1286). When an agent carries mount(s), its
seeded `CLAUDE.md` gains a **Context Folder(s)** section naming each folder's in-container
path and host location, and the two things an agent otherwise gets wrong: a folder is a
*live view* (re-read it, don't trust what it said last run) and it is *not part of any
repository* (copy before keeping). The section is **access-mode aware** (#1289) and
enumerates **every** folder (#1290): a read-only folder is told it cannot write; a
read-write folder is told its writes flow back to the host — so the agent never declines
to write to a folder the admin made writable. A single legacy folder at bare `/context`
keeps its original single-folder wording (headed *Read-only Context Folder* /
*Host Context Folder*); two or more folders (or one at a `/context/<slug>` path) render as
an enumerated **Context Folders** list. An agent without a mount never sees the section —
the block is gated in `prompt-assembly.js` exactly like Git/Skills/Trigger-management.
Setting or clearing the mount rebuilds and reseeds `CLAUDE.md` before the respawn, so the
prompt and the container never disagree.

## Browsing it from the console

Each mounted folder shows up in the **Workspace** tab of Agent Chat as its own read-only
root next to the agent's own files (#1290), marked `host · read-only`. A single legacy
folder appears as the `context` root; each folder in a multi-folder set appears under its
label. Expanding a root lists that folder's *current* contents — a file the host sync
writes appears on the next expand, no respawn needed. Directories navigate, text files open
in the viewer, images preview inline, anything else downloads.

Every context root is read-only all the way down **in the console** — there is no upload,
delete or drag-move for those subtrees in the UI, and no API route that could write there —
regardless of whether the *agent's* mount is read-write. (The read-write opt-in governs the
agent, not the console browser.)

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
| **Config** | A single legacy folder persists as `contextMount` (absolute host path string) + optional `contextMountRw: true`. Multiple folders (#1290) persist as `contextMounts: [{ path, name, slug, readWrite? }]` (the two shapes never coexist — writing one drops the other). `readWrite` is stored only when true, and an agent with no folder carries neither key, so its config is byte-identical to a pre-feature agent. `resolveContextMounts(cfg)` (in `context-mount.js`) resolves either shape to the ordered list of folders + in-container targets. |
| **API** | `PATCH /api/agents/:id/context-mount` accepts either a single-path body (`{ path, readWrite }`) or a `{ mounts: [...] }` array (validated + slug-assigned by `normalizeContextMountsInput`); it writes config, rebuilds the prompt and best-effort respawns the agent. `GET /api/context-mount/capability` tells the UI whether the feature is offered here. `GET /api/agents/:id/context/status` returns one `mounts[]` entry per folder. All admin-gated / local-gated. |
| **Provisioning** | `startAgentProcess` calls `resolveContextMounts(config)` (podman runtime, or k8s behind the `AEE_K8S_CONTEXT_HOSTPATH` opt-in — #1319) and passes the list to `spawnContainer`. Podman adds one libpod bind mount per folder (`buildContextMountSpecs`); Kubernetes renders one `hostPath` volume + volumeMount per folder (`buildContextHostPathVolumes` in `spawn-kubernetes-pod.js`, `readOnly` unless the folder opts into read-write). Mounts are baked at container-create time, so a change requires a respawn; an invalid folder is skipped without blocking the others. |
| **Prompt** | `prompt-assembly.js` emits the gated context section — the single-folder *Read-only Context Folder* / *Host Context Folder* wording for a lone `/context` folder, or an enumerated **Context Folders** list for a multi-folder set (#1290); `POST /internal/agents/:id/prompt-rebuild` rebuilds + reseeds `CLAUDE.md` when the mounts are set or cleared. |
| **Browsing** | `GET /api/agents/:id/context/{status,tree,file,image,download}` → `/internal/agents/:id/context/*` → a one-shot read-only exec in the agent's container running the `list`/`read` program from the pure `context-browse.js`. The exec transport is runtime-selected (`container-exec-runtime.js`, #1319): the libpod socket on podman (`container-exec.js`), the Kubernetes `pods/exec` API on k8s (`pod-exec.js`). The browse program lists under `/context`, so each folder's `/context/<slug>` target is reached by a `<slug>/…` relative path with no per-folder branch. |

## Kubernetes (kind) support (#1319)

On the Kubernetes runtime the mount renders as a **`hostPath` volume** in the agent's
pod — which changes what "host" means and who should enable it:

- **Opt-in, off by default.** Set `AEE_K8S_CONTEXT_HOSTPATH=1` in the stack's env
  (kind: `.env.k8s`, re-run `kind-up.sh`) to enable it; without the flag the console
  reports the feature unsupported and the orchestrator renders no mount. The IAP gate
  stays hard-off regardless, so hosted GKE can never enable it — a hostPath on a
  multi-node cluster points at whichever node schedules the pod, which is the wrong
  tool (a hosted design would need its own concept).
- **"Host" is the node.** On kind, that is the cluster's node *container*
  (`agent-studio-control-plane`) — a Mac folder needs a kind `extraMounts` entry at
  cluster creation. See `deploy/k8s/README.md` ("Context mounts on kind") for both
  recipes.
- **Fail-closed rendering, `type: Directory`.** Each folder is re-validated at the
  point of use (same `validateHostMountPath` as podman; a bad entry drops that mount
  only), and the volume uses `hostPath.type: Directory`, so a folder missing on the
  node leaves the pod Pending on a `FailedMount` event rather than mounting nothing.
- **Browse/write travel over `pods/exec`** (`orchestrator/pod-exec.js`, selected by
  `container-exec-runtime.js`), which needs `pods/exec [create]` on the
  orchestrator's Role (`deploy/k8s/base/core/10-rbac.yaml`). Uploads stream the tar
  archive over exec stdin instead of the libpod archive endpoint; semantics (caps,
  error codes, kernel EROFS backstop on read-only mounts) are unchanged.
- **Covered by e2e**: the kind-lane `context-mount` journey
  (`e2e/journeys/context-mount.yaml`, `make e2e-kind`) seeds a node folder, mounts it
  read-write, browses it in the workspace browser and writes back through the console.

## Known limits (v1)

- **Existence isn't pre-checked.** The orchestrator runs in a container and cannot
  stat host paths, so a path that doesn't exist on the host is caught by the
  container engine at provisioning time (the agent fails to start) rather than by an
  up-front validation error. Point each mount at a folder that already exists — a
  missing source can fail the whole container create, so a bad folder does not fail
  in isolation the way an *invalid* (rejected) path is skipped. Fix or remove it and
  re-provision.
- **Allowlist-management UI** is still an explicit follow-up (kept out by #1283).
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
`docker-compose.yml` to be per-agent, multi-folder, read-only-by-default, and
configurable from the console.
