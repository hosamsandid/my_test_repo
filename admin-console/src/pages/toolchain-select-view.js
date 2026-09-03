// Pure view decisions for the "Agent toolchain" field on the Working
// Environment create/edit form (WorkingEnvironments.jsx, #1940).
//
// The field is a SELECT over the operator registry (`GET /api/toolchains`), not
// a text input, because an image reference is a privilege: an agent container
// receives the environment's SSH key, GitHub PAT and model credential, so a Team
// Admin who could type an image reference could run arbitrary code with those
// secrets. A System Admin registers; everyone else picks. The server re-enforces
// both halves — this module only decides what the form SHOWS.
//
// Three decisions live here rather than inline in the JSX, so they are
// unit-tested (#651: node --test cannot load JSX):
//   - which options to offer, given the stack's own container runtime;
//   - whether saving will interrupt running agents, and the exact warning;
//   - what to say when the registry is empty (which is the normal state until
//     #1941 ships the first variant — an empty select must read as "nothing
//     registered yet", never as a broken page).

// Option rows for the select. A toolchain whose `platforms` exclude this
// stack's runtime is still LISTED but not selectable: hiding it would make an
// environment's already-saved-but-now-unofferable toolchain vanish silently,
// and an operator wondering why the JVM toolchain is missing deserves the
// reason (its image is a `localhost/…` tag that a cluster cannot pull).
export function toolchainOptions(toolchains, runtime) {
  const rt = runtime === 'kubernetes' ? 'kubernetes' : 'podman';
  return (Array.isArray(toolchains) ? toolchains : [])
    .filter(t => t && t.id)
    .map(t => {
      const platforms = Array.isArray(t.platforms) && t.platforms.length
        ? t.platforms
        : ['podman', 'kubernetes'];
      const available = platforms.includes(rt);
      return {
        id: t.id,
        label: t.name || t.id,
        image: t.image || '',
        available,
        // The honest reason, shown on the row itself — the operator does not
        // have to open the Toolchains list to work out why it is greyed.
        hint: available
          ? (t.description || '')
          : `not available on ${rt} (built for ${platforms.join(', ')})`,
      };
    });
}

// The empty / no-choice state. `canManage` is the caller's System-Admin flag
// from the same payload, so the message points the right person at the right
// next step instead of at a page they cannot use.
export function toolchainEmptyState(toolchains, { canManage = false, defaultImage = '' } = {}) {
  const list = Array.isArray(toolchains) ? toolchains : [];
  if (list.length > 0) return null;
  return canManage
    ? `No toolchains are registered, so every agent runs the default image${defaultImage ? ` (${defaultImage})` : ''}. Register one to offer a language stack (for example a JVM build image) to a team.`
    : `No toolchains are registered, so every agent runs the default image${defaultImage ? ` (${defaultImage})` : ''}. A System Admin adds them.`;
}

// Does saving this form change the toolchain — and therefore recreate the
// environment's running agents? A spawn-time image is immutable for a
// container's lifetime, so a change can only reach a running agent by replacing
// it, exactly as a rotated `githubTokenId` does. The console has to say so
// BEFORE the click (AC5), the way the personal-credential rotate panel does.
export function toolchainChangeWarning({ isEdit = false, initialToolchainId = null, toolchainId = null, agentCount = 0 } = {}) {
  const before = initialToolchainId || null;
  const after = toolchainId || null;
  if (!isEdit || before === after) return null;
  // Nothing to interrupt: the wording must not threaten an interruption that
  // cannot happen, or the real warning stops being believed.
  const who = agentCount > 0
    ? `${agentCount} agent${agentCount === 1 ? '' : 's'} in this environment`
    : null;
  const action = after
    ? (before ? `switch the toolchain to '${after}'` : `move this environment onto toolchain '${after}'`)
    : 'return this environment to the default agent image';
  return who
    ? `Saving will ${action} and restart ${who}. A container's image is fixed for its lifetime, so running agents have to be recreated — any work in flight is interrupted. Save at a quiet moment.`
    : `Saving will ${action}. It takes effect the next time an agent in this environment starts.`;
}

// ── The shipped variants, #1941 ─────────────────────────────────────────────
//
// `GET /api/toolchains` now also returns `available`: the toolchains this
// repository SHIPS (`toolchains/<id>/toolchain.json`, seeded into the pool by
// `make seed-toolchains`) that are not installed yet. Installing one is a bare
// `POST /api/toolchains { id }` — the image reference comes from the manifest,
// so the operator never retypes it and cannot typo it.
//
// The hand-registration form stays: this repository does not ship every stack a
// customer runs. What the two doors share is the gatekeeper, not the UI.

// Rows for the "Available to install" list. An entry whose manifest failed
// validation is KEPT, carrying its errors — "where is the JVM toolchain?" must
// have an answer, and a silently shorter list is the one shape that cannot
// answer it. `installable` is false for those and for a variant this stack's
// runtime cannot pull, so the button state is decided here rather than inline.
export function availableToolchains(available, runtime) {
  const rt = runtime === 'kubernetes' ? 'kubernetes' : 'podman';
  return (Array.isArray(available) ? available : [])
    .filter(t => t && t.id)
    .map(t => {
      if (t.ok === false) {
        return {
          id: t.id,
          name: t.id,
          broken: true,
          installable: false,
          reason: `Manifest is invalid: ${(t.errors || []).join('; ')}`,
        };
      }
      const platforms = Array.isArray(t.platforms) && t.platforms.length ? t.platforms : [];
      const supported = platforms.includes(rt);
      return {
        id: t.id,
        name: t.name || t.id,
        description: t.description || '',
        // What the runtime will ACTUALLY pull here — on a cluster that is the
        // Artifact Registry path under the pinned release tag, not the bare tag
        // the manifest declares. Shown so an install review is honest about it.
        image: t.effectiveImage || t.image || '',
        platforms,
        // Carried through so the row is the ONE shape the JSX renders — the
        // version story is what an operator is meant to read before installing
        // (`versionSourceLine` below), so it must not need a second lookup.
        versionSource: t.versionSource || '',
        versionManager: t.versionManager || '',
        baseline: t.baseline || '',
        broken: false,
        installable: supported,
        reason: supported
          ? ''
          : `Declares platforms [${platforms.join(', ') || 'none'}], so it is not available on the '${rt}' runtime this installation uses.`,
      };
    });
}

// One line describing where the runtime version comes from — the field that
// decides whether a JDK update is a commit in the project repo or a platform
// release, so it belongs in front of the operator BEFORE they install, not in
// the concept doc.
export function versionSourceLine(entry) {
  const t = entry || {};
  if (t.versionSource === 'baked') {
    return `Runtime version is fixed in the image${t.baseline ? ` (${t.baseline})` : ''} — updating it is a platform release. Intended for airgapped installations.`;
  }
  if (t.versionSource === 'bootstrap') {
    const mgr = t.versionManager ? ` via ${t.versionManager}` : '';
    const base = t.baseline ? ` A repository that pins nothing gets ${t.baseline}.` : '';
    return `Each repository pins its own runtime version${mgr}, so updating it is a commit in that repository — no image rebuild.${base}`;
  }
  return '';
}
