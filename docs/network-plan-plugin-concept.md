# Network Plan — an editable planning board as a UI-bearing plugin

> Status: concept — epic #1554, phases #1561 (manifest contract), #1562 (§4.8 live
> UI-extension stack), #1563 (the plugin — usable on Podman), #1564 (remaining panel
> primitives), #1565 (Kubernetes plugin sidecars), #1566 (content migration).
> Decision 2026-08-10: team planning boards (streams, milestones, owners,
> dependency lines) become an **installable, team-grantable plugin** whose UI is
> served from its sidecar and proxied by the console — the shape
> `plugin-system-concept.md` §4.8 already anticipates — rather than a bespoke
> console page. Agent write access is **configurable and off by default**, on an
> explicit ladder from humans-only to full agent control. Reaching this requires
> the two platform halves §4.8 and #1547 deliberately deferred: the live
> UI-extension stack, and Kubernetes plugin sidecars.

## 1. Problem

Team-level network plans are maintained today as a hand-edited standalone HTML
file: one SVG swimlane rendered from five hard-coded JavaScript constants
(`LANE_DATA`, `ZONE_STYLE`, `DEFAULTS`, `ETL_MOCK`, `SP_MOCK`), with ~1000
further lines of renderers for panels a previous edit stripped out of the body
and never removed from the script. Three things are structurally wrong with it,
and none is a configuration problem:

- **Every structural change is a code edit.** A new stream, a renamed milestone,
  a new owner, another requirement line — all of them mean editing JS constants
  by hand. The people who own the streams are not the person who can edit the
  file, so the board lags reality by however long that round trip takes.
- **Status has no home.** Milestone ticks are clickable but persist only in the
  viewer's `localStorage`, and the lookup prefers the stored value over the
  in-file default. So once anyone has clicked, edits to the file are invisible to
  them, and no two viewers necessarily see the same board. There is no shared
  truth to review, diff, or point at in a meeting.
- **The data model actively resists editing.** Statuses are positional arrays
  (`[1,1,0,0,0,0]`) and requirement targets are positional indices, so inserting
  a milestone silently shifts every status and every target in that lane. The
  source carries the scars as comments — *"index shifted by +1: info gathering
  added at 0"*, *"shifted by +1: Mock ideation prepended at 0"*. An editor cannot
  responsibly offer insert or reorder on top of that representation.

Meanwhile Agent Studio already owns every adjacent concept: flows and stages,
labels and gates, teams and memberships, anomalies, improvement cards, human
touchpoints. A planning board that tracks the same work belongs inside the
platform, sharing its team scoping, audit trail and identity model, rather than
beside it as an artifact somebody mails around.

## 2. Why a plugin, and not a console page

A bespoke console page would be less work. It is the wrong shape for three
reasons:

- **The content is engagement-specific, the tool is not.** Shipping one
  engagement's planning board as a product page bakes a customer's project into
  the product. As a plugin it is installed by a System Admin who wants it and
  granted to the teams that use it — the same deliberate human action that
  already governs `podman-sandbox` and `test-mgmt`.
- **§4.8 exists and is unbuilt.** The plugin concept already specifies UI-bearing
  plugins ("A plugin may serve a web UI from its sidecar; the console proxies it
  at `/plugins/:id/ui`"), and its decidable core shipped with plugin #2. What has
  been missing is a product driver. This is one — and building it here means the
  next UI-bearing plugin (an embedded QE UI for `test-mgmt`, whose manifest
  already declares three routes) inherits a working stack instead of paying for
  it again.
- **A UI plugin's sidecar is not dead weight.** It is the UI *host* and the
  document store. The privilege-boundary framing that justifies a broker for
  `podman-sandbox` does not apply, but §4.8's framing does: the sidecar serves
  the app, the console proxies it, the iframe boundary is the contract.

## 3. Prior art this design reuses

This design is unusually reuse-heavy: almost every mechanism it needs already
exists, and two of them exist but are wired to nothing.

| Building block | Where | Reused for |
|---|---|---|
| Plugin registry, install, grant, sidecar lifecycle | Phases 1–7 (#1517–#1547): `orchestrator/plugin-registry.js`, `plugin-runtime.js`, `plugin-grants.js` | the whole install/grant/run substrate |
| `minRole` route enforcement, scope discovery, signed viewer identity | `admin-console/api/plugin-ui-proxy.js` — **written, unit-tested, referenced by nothing but its own test** | the §4.8 proxy's decidable core |
| Broker obligations (token verify, audit, health, teardown, approval pen) | `broker-sdk/` | the plugin's sidecar |
| Plugin-neutral env contract (`AEE_PLUGIN_*`) | `broker-sdk/broker-config.js`, set in `plugin-runtime.js` | how the sidecar learns its port, secret, quota, dirs |
| Per-plugin persistent named volume | `auditVolumeName` → `AUDIT_MOUNT` (`plugin-runtime.js`) | the pattern a **state** volume follows |
| Editable JSON document + CRUD + atomic write + slug ids | `/api/process/drafts` (`admin-console/api/api.js`), `writeJsonAtomic`, `readJsonFile` | the document store's shape |
| Iframe-embedded artifact as a console page | `admin-console/src/pages/SdlcCatalogPage.jsx` → `/patterns/sdlc` | the nav + iframe mount |
| Team scoping of list endpoints and mutations | `admin-console/api/scope.js` (`computeScope`, `visibleTeam`, `canManageTeam`) | who sees which board |
| Numbered humans-first autonomy ladder | `hillClimb.autonomy` (0 collector-only → 2 apply), knowledge autonomy levels | `settings.agentAutonomy` |
| Selection-driven inspector over a canvas | `ProcessCanvas` `NodeInspector` | the board's editing surface |
| Audit line keeping `agentId` distinct from `scopeId` | `orchestrator/plugin-audit.js` (`buildPluginAuditLine`) | naming the agent that wrote |
| Per-subcommand authorisation by calling scope | `broker-sdk/authz.js` (`authorizeAction`, `isActionPermitted`) | gating agent writes |
| Dependency-free CLI facade contract | `plugins/CONTRACT.md` §4.5 | `aee-plan` |
| Raw-HTTPS Kubernetes API access, no client library | `orchestrator/spawn-kubernetes-pod.js` (`k8sRequest`) | the k8s sidecar port |
| Two-sided guard for a duplicated validator | `orchestrator/plugin-manifest.js` ↔ `admin-console/api/plugin-manifest.js` | the one manifest change |

## 4. The document model

Everything the board shows is one JSON document. Panels are an ordered list, so
adding, removing and reordering a panel is a UI action rather than an edit to a
renderer.

```
PlanDoc {
  version, id, name, teamId, createdAt, updatedAt,
  settings: { agentAutonomy: 0 | 1 | 2 },     // §8
  owners:   [ { id, name, color } ],
  panels:   [ Panel, ... ]
}
```

The load-bearing decision is small and fixes §1's third problem outright:
**statuses and requirement targets key on milestone ids, never array indices.**

```
Milestone  { id, label, done }
Lane       { id, zoneId, title, sub, ownerId, milestones: [ Milestone, ... ] }
Requirement{ id, label, color, on, targets: { <laneId>: <milestoneId> } }
```

A positional model makes insert and reorder destructive, which is why today's
file has neither and why its comments track manual index arithmetic. With ids,
inserting a milestone mid-lane changes nothing else; deleting one only has to
drop the requirement targets that pointed at it. That is the difference between
an editor that can offer structural editing and one that can only offer
renaming.

Owners are referenced by id rather than repeated per lane, so renaming a person
or changing their colour is one edit — today the owner name is a string in every
lane and the colour lives in a separate lookup keyed by that string.

## 5. Four panel primitives, not six renderers

The source file contains six distinct diagram renderers. They are less distinct
than they look: the executive swimlane (`#lanes`) is a smaller streams swimlane
(`#streams`); the wave graph (`#hero`), the detail network plan (`#net`) and the
package graph (`#pkgStage`) are all "typed nodes in horizontal bands with
dependency edges and hover highlighting". Reviving six renderers means writing
and maintaining six editors.

| Primitive | Replaces | Editable |
|---|---|---|
| `swimlane` | `#streams`, `#lanes` | zones (name, hint, colour, OR-flag, secondary), lanes (title, sub, owner, zone, order), milestones (label, order, done), step-column labels, requirement lines |
| `graph` | `#hero`, `#net`, `#pkgStage` | bands, nodes (label, sub, owner, status, type, band), typed dependency edges, hover highlight |
| `bipartite` | `#smap` | left and right entries, typed edges, muted flag |
| `blocks` | cover slide, KPI tiles, callout, card columns | heading, subtitle, body, chips, tiles, meta |

Two details of the `swimlane` primitive are worth naming because they carry
meaning a generic grid would lose:

- **OR zones.** A zone may be marked substitutable: any one lane reaching a given
  milestone satisfies it for the whole zone. Today this is expressed by a
  hard-coded index check plus a sibling-lane scan, and drawn as a pale fill.
  Zone-level configuration replaces the hard-coding; the pale fill stays, because
  "already covered by a sibling" is genuinely different from "done here".
- **Requirement lines.** A named, coloured staircase cutting the board into "left
  of this line is needed for milestone X". Today there are exactly two, defined as
  constants. They become a list: add a third, set its label and colour, and set
  per-lane targets by clicking a milestone. The existing click-the-badge-to-toggle
  behaviour is kept.

**Accepted trade:** consolidating six renderers into four primitives means the
restored panels are *normalised* versions of the originals, not pixel-identical
reproductions. Anyone expecting the old cover slide or KPI strip back byte-for-byte
will notice. This is a deliberate exchange of fidelity for an editable,
maintainable surface.

## 6. Plugin shape

```
plugins/netzplan/
  plugin.json          # manifest
  bin/aee-plan         # dependency-free CLI facade (CONTRACT.md §4.5)
  broker/              # sidecar: serves the board UI + the document store
```

Manifest, in the terms the validator already understands:

| Field | Value | Why |
|---|---|---|
| `ui.title` | `Network Plan` | nav label |
| `ui.routes` | `/` at `team-member`, `/admin` at `team-admin` | everyone reads and ticks; only a Team Admin changes settings |
| `scopes` | `["team"]` | one board serves a team; `resolveScopeId` maps every member to the team's id |
| `capabilities` | `[]` | no privilege: no host socket, no host mount |
| `platforms` | `["podman", "kubernetes"]` | works on both, once §9 lands |
| `quota` | `maxObjects` | bounds documents per scope |
| `cli` | `aee-plan` | the gated agent surface (§8) |

The broker is thin: it `require`s `broker-sdk` for `verifyScopeToken`,
`auditWriter`, `healthEndpoint`, `teardownScopeEndpoint` and
`verifyViewerHeaders`, and adds only the document store and the board assets. It
persists to the **state volume** (§7), not the audit volume.

`scopes: ["team"]` deserves one note. The board is per-team by design, so the
scope token's granularity is team — but the audit line keeps `agentId` separate
from `scopeId` (`buildPluginAuditLine`), so a team-scoped board still records
*which agent* wrote. That property is what makes §8's ladder auditable without
forcing agent granularity on the document.

## 7. The §4.8 live UI-extension stack

§4.8's decidable core shipped with plugin #2 and is wired to nothing:
`enforceUiRoute` (longest-prefix `minRole` match over `ui.routes`),
`deriveScopeList` (scope discovery derived from the resolved grant, so a plugin
can only ever enumerate scopes it was granted to) and
`signViewerHeaders`/`verifyViewerHeaders` (signed viewer identity and effective
role). This phase makes them live. Nothing in the pure core needs to change.

**Console side.**

- `ALL /plugins/:id/ui/*` — the proxy, behind the normal session gate, with
  `enforceUiRoute` on the sub-path and `signViewerHeaders` forwarding the
  authenticated console user and effective role. Streamed rather than buffered, so
  document `PUT`s and any future upload work.
- `GET /api/plugins/:id/scopes` — `deriveScopeList` over the resolved grant.
- `GET /api/plugins` grows the `ui` block, so the nav can list UI-bearing
  installed plugins.
- A page that iframes `/plugins/:id/ui`, plus dynamic nav entries. Modelled on
  `SdlcCatalogPage.jsx`. **No React injection** — the iframe boundary is the
  contract, per §4.8. A plugin UI inherits no console state; identity arrives as
  signed headers.

**Sidecar address.** `plugin-runtime.js` already builds
`http://<sidecarContainerName>:<internalPort>`, but it lives in the orchestrator
and the admin-console image copies only `api/*.js`. Rather than duplicate the
naming rule into a second image, the console asks: a new
`GET /internal/plugins/:id/ui-endpoint`. The orchestrator owns sidecar truth
because it starts them — and on Kubernetes the address is a Service name, not a
container name, so a lookup is the only form that survives §9.

**Sidecar state.** Every sidecar already gets one persistent named volume, for
audit JSONL. A UI plugin needs somewhere to keep its documents, and using the
audit mount for that would be an abuse of a mount with its own retention
semantics. So: a second, generic volume exposed as `AEE_PLUGIN_STATE_DIR`,
platform-set and never overridable from the manifest's own `sidecar.env` — the
same discipline that already prevents a plugin from raising its own quota or
supplying its own signing secret.

**Verification target.** `plugins/test-mgmt/plugin.json` already declares `/`,
`/runs` and `/admin` at two different roles, so the `minRole` contract can be
exercised end-to-end before this plugin's own UI exists.

## 8. Agent autonomy — configurable, off by default

The board is a human planning artifact today and agents should eventually
maintain it. Both are true, so the ladder is explicit rather than a flag:

| `settings.agentAutonomy` | Agents may | Default |
|---|---|---|
| `0` | read the board (`aee-plan show`) | ✅ |
| `1` | additionally tick milestones done or undone | |
| `2` | additionally edit structure — lanes, milestones, owners, requirement lines | |

Set on the Team-Admin-gated `/admin` route, stored on the document. The numbering
deliberately mirrors `hillClimb.autonomy`, which already expresses "observe →
propose → act" for the improvement loop; a reader who knows one knows the other.

Four properties make climbing the ladder safe:

- **The CLI exists from day one.** `aee-plan` ships at level 0, where it can read
  but not write. A capability that only appears when someone raises a setting is
  a capability nobody has tested; this way level 1 is a setting change, not a
  deployment.
- **Enforcement is server-side.** The broker decides, through the SDK's
  `authorizeAction`, reading the document's current level. The CLI also refuses
  early for a clear error message — two defense lines, exactly as the platform
  treats network truth versus token truth.
- **Reads are never gated.** An agent knowing which milestone it is working
  toward is useful context and cannot corrupt anything. Level 0 means *no agent
  writes*, not *no agent access*.
- **Every write is attributed.** One audit line per call, naming the calling
  agent, the subcommand and the outcome. Raising the level is reversible and
  reviewable — which is the whole argument for shipping the ladder rather than
  waiting until agents are trusted enough to be given everything at once.

`aee-plan` follows `CONTRACT.md` §4.5: a single dependency-free file, `--json` on
every subcommand, `--help`, and exit codes `0` success / `1` error / `2` usage /
`3` broker unreachable. All operations are synchronous, so no submit-then-poll
verb is needed.

## 9. Kubernetes plugin sidecars

*Shipped — #1565.* `orchestrator/spawn-kubernetes-plugin.js` is a sibling behind
the `container-runtime.js` seam; `plugin-runtime.js` delegates
`reconcilePluginSidecars` / `reconcilePluginAttachments` / `listLiveSidecars` to
it when `AEE_CONTAINER_RUNTIME=kubernetes`. Each installed UI-bearing plugin
becomes a **Deployment + Service + state PVC**; the state volume is a **PVC, not
`emptyDir`** (audit is an `emptyDir` here — a per-plugin audit PVC on k8s is a
separable follow-up). RBAC gained namespaced `apps/deployments` + `services` +
`persistentvolumeclaims` (+ `networkpolicies`, reserved). The broker-plugin
per-grant `NetworkPolicy` reachability is split out (see below):
`reconcilePluginAttachments` is a no-op on k8s. The design that got there:

Plugin sidecars were Podman-only: `spawn-kubernetes-pod.js` set
`PLUGIN_SIDECARS_SUPPORTED: false` and every entry point in `plugin-runtime.js`
short-circuited. Workspace seeding still happened, so on a hosted stack a plugin
could be installed and granted but no broker answered and its CLI exited `3`.

For this concept that is decisive rather than cosmetic: a plugin-hosted board
would not open on the GKE console at all. So the port is in scope, and
`spawn-kubernetes-pod.js` already specifies it in its own deliberate-differences
note — "the k8s equivalent is a Deployment + Service + NetworkPolicy per plugin,
and the grant-driven reachability that per-agent networks give for free has to
become policy objects."

- A sibling runtime module behind the existing `container-runtime.js` seam:
  **Deployment + Service** per installed plugin, in the same raw-HTTPS
  `k8sRequest` style, with no client library.
- **PVC, not `emptyDir`,** for the state volume. An `emptyDir` would silently lose
  the board on pod restart — the failure mode would look like data corruption
  rather than a missing volume.
- **RBAC.** The orchestrator's namespaced Role currently holds only `pods`,
  `pods/log` and `pods/exec`. It gains `apps/deployments`, `services`, and — for
  broker plugins — `networking.k8s.io/networkpolicies`.
- **Reachability splits by plugin kind.** A UI-only plugin needs **no**
  NetworkPolicy: no agent talks to it, and the console reaches its Service
  in-namespace. Broker plugins, whose whole isolation story is "reachable only
  from granted agents' networks", need policy objects to reproduce what per-agent
  networks give for free on Podman. The UI half is therefore substantially
  cheaper, and is what this epic needs.

**Honest limit.** `capabilities: ["podman-socket"]` has no Kubernetes equivalent —
mounting a host container socket into a pod is not a thing one does. So
`plugins/podman-sandbox/` stays `platforms: ["podman"]` permanently, and
"Kubernetes plugin sidecars" must not be read as "every plugin now works on GKE".
The `platforms` field is precisely the gate for this, and the Plugins page already
surfaces it.

## 10. Contract change

Exactly one, and it is small: `PLATFORMS` in `admin-console/api/plugin-manifest.js`
is `['podman', 'any']` and gains `kubernetes`. The change is mirrored into
`orchestrator/plugin-manifest.js`, whose existing two-sided guard test keeps the
two copies byte-identical.

An earlier draft of this design also needed `cli` to become optional, because a
humans-only plugin has no agent-facing CLI and a stub would have been dishonest.
The autonomy ladder (§8) removes that: `aee-plan` exists from day one so it can be
gated, so the manifest's mandatory `cli` is satisfied truthfully and needs no
relaxing. Recorded here because "we considered widening the manifest and then
didn't need to" is worth knowing when the next UI-only plugin appears — that one
may well need it.

## 11. Phasing

Ordered so the board is usable before the Kubernetes work lands.

| Phase | Content | Ends with |
|---|---|---|
| 1 (#1561) | `PLATFORMS` gains `kubernetes`; two-sided guard green | manifest can express the plugin |
| 2 (#1562) | §4.8 live stack: proxy, `minRole`, scope discovery, nav + iframe, endpoint lookup, state volume *(shipped — #1562)* | `test-mgmt`'s three routes serve and refuse correctly |
| 3 (#1563) | The plugin: manifest, broker on the SDK, document store, `swimlane` primitive at parity *(shipped — #1563; the id-keyed document model, `aee-plan` CLI + autonomy ladder, the on-SDK broker with a state-volume store, and a minimal served board (view + tick + `/admin`) — the rich swimlane editor is the completion step)* | **board usable on Podman** |
| 4 (#1564) | `graph`, `bipartite`, `blocks` primitives + panel add/remove/reorder *(shipped — #1564; all three primitives in the id-keyed `plan-doc.js` model with referential repair, `add-panel`/`delete-panel`/`reorder-panels`/`set-panel-title` composition, a shared level-2 authorisation path, `graphNeighbors` hover helper, and a served board whose Edit mode adds/edits/reorders/removes every primitive; the direct-manipulation polish is a UI refinement over the same mutations)* | full editability |
| 5 (#1565) | Kubernetes: Deployment + Service + PVC, RBAC, flag flip *(shipped — #1565; `spawn-kubernetes-plugin.js` behind the `container-runtime.js` seam, state PVC (audit emptyDir), RBAC + flag flipped, UI-only reachability needs no NetworkPolicy — the broker-plugin per-grant NetworkPolicy is split out)* | board reachable on GKE |
| 6 (#1566) | Content migration: export the existing plan, round-trip import | today's board reproduced |

Phase 3 is the first point where anything is worth showing, and Phase 5 is the
first point where the hosted stack can show it. Phase 4 can slip past Phase 5
without blocking anyone.

## 12. Non-goals

- **No React injection into the console.** The iframe boundary is the contract
  (§4.8). A plugin UI does not import console components or read console state.
- **No engagement content in the product repo.** The plugin ships an empty board;
  a specific plan is an importable document.
- **No pixel-identical panel restoration** (§5).
- **No agent-authored plan structure at level 0** — and no automatic promotion up
  the ladder. Raising `agentAutonomy` stays a human decision; nothing in this
  design proposes a heuristic that raises it.
- **`podman-sandbox` on Kubernetes** (§9) — out of reach by nature, not deferred.
