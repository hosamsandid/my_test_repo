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
