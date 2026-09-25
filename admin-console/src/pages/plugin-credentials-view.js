// ─── pure decisions for the Plugins-page per-team Credentials section (§5) ────
//
// The section renders one field-set per team the plugin is granted to (the
// `scopes` from GET /api/plugins/:id/credentials), each carrying the metadata
// the orchestrator returned (`keys[key].set/preview`, `complete`, `setBy`,
// `setAt`, `canManage`). No raw values ever cross the wire — a field starts
// blank and empty means "leave unchanged".
//
// admin-console-src CI job — dependency-free ESM, unit-tested.

// Field-type hint from the credential key: anything secret-shaped is a password
// input (mirrors admin-console/api/plugin-credential-view.js's server copy).
export const SECRET_KEY_RE = /(token|secret|password|key|pat|apikey)/i;

export function fieldType(key) {
  return SECRET_KEY_RE.test(String(key || '')) ? 'password' : 'text';
}

// The descriptor list the form renders, from the `credentials` array
// (`[{ key, required, description, secret? }]`) and one scope's `keys` metadata.
// A `secret: false` field (#2449) discloses its real stored value (`meta.value`)
// so the input pre-fills editable rather than showing a masked keep-hint; a
// secret field keeps the write-only, preview-only behavior.
export function fieldDescriptors(credentials, scopeKeysMeta = {}) {
  return (Array.isArray(credentials) ? credentials : []).map((c) => {
    const meta = scopeKeysMeta[c.key] || {};
    // A field is secret (write-only, masked, byte-identical to pre-#2449) UNLESS
    // the manifest explicitly opts out with `secret: false`. The name-based
    // heuristic (SECRET_KEY_RE via fieldType) is only the password/text input
    // hint for a secret field — never what decides masking.
    const secret = !(meta.secret === false || c.secret === false);
    const storedValue = (!secret && typeof meta.value === 'string') ? meta.value : '';
    return {
      key: c.key,
      required: c.required === true,
      description: c.description || meta.description || null,
      type: secret ? fieldType(c.key) : 'text',
      secret,
      set: !!meta.set,
      preview: meta.preview || null,
      storedValue,
      placeholder: secret && meta.set
        ? `Stored (${meta.preview || '••••'}) — leave blank to keep`
        : (c.required ? 'Required' : 'Optional'),
    };
  });
}

// One-line status for a scope's row.
export function scopeStatusLabel(scope) {
  if (!scope) return '';
  if (scope.complete) {
    return `Configured — set by ${scope.setBy || 'someone'}${scope.setAt ? ` on ${new Date(scope.setAt).toLocaleDateString()}` : ''}`;
  }
  const missing = Array.isArray(scope.missingRequired) ? scope.missingRequired : [];
  if (missing.length && Object.values(scope.keys || {}).some((k) => k && k.set)) {
    return `Incomplete — still needs: ${missing.join(', ')}`;
  }
  return 'Not configured';
}

export function scopeStatusTone(scope) {
  if (!scope) return 'muted';
  if (scope.complete) return 'ok';
  if (Object.values((scope && scope.keys) || {}).some((k) => k && k.set)) return 'warn';
  return 'muted';
}

// The PUT body from the form's draft: only non-blank entries (blank = keep), and
// an emptied field that was previously set is sent as "" (explicit clear).
export function buildCredentialSubmit(draft, descriptors) {
  const values = {};
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    const raw = draft && Object.prototype.hasOwnProperty.call(draft, d.key) ? draft[d.key] : undefined;
    if (raw === undefined) continue;
    const trimmed = String(raw).trim();
    if (trimmed) values[d.key] = trimmed;
    else if (d.set) values[d.key] = '';
  }
  return { values };
}

// Is there anything to save? (a non-blank new value, or an explicit clear.)
export function isCredentialDraftDirty(draft, descriptors) {
  return Object.keys(buildCredentialSubmit(draft, descriptors).values).length > 0;
}
