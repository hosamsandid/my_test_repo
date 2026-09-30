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
      // A human display name (#jira-setup-ux) — the form shows this instead of
      // the raw kebab key; falls back to the key for a manifest without labels.
      label: c.label || c.key,
      group: c.group || '',
      requiredFor: Array.isArray(c.requiredFor) ? c.requiredFor : [],
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

// Human heading for a group slug (fallback: title-cased slug).
const GROUP_HEADINGS = {
  connection: 'Connection',
  'service-account': 'Service account',
  'custom-fields': 'Custom fields',
  account: 'Your account',
};
export function groupHeading(slug) {
  if (!slug) return 'Settings';
  return GROUP_HEADINGS[slug] || String(slug).replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// A short "who needs this" line for a group, derived from its fields' requiredFor
// (never a naming convention). Lets the form say "only for automated runs"
// instead of a blanket required, so an interactive-only team is not pushed to
// fill the service account.
export function groupNecessity(fields) {
  const modes = new Set();
  let anyRequired = false;
  for (const d of Array.isArray(fields) ? fields : []) {
    if (d.required) anyRequired = true;
    for (const m of d.requiredFor || []) modes.add(m);
  }
  if (modes.has('interactive') && modes.has('automated')) {
    return { tone: 'req', text: 'Required for all use — interactive chat and automated runs.' };
  }
  if (modes.has('interactive')) return { tone: 'req', text: 'Required for interactive chat.' };
  if (modes.has('automated')) {
    return { tone: 'opt', text: 'Only for automated runs (schedules, loops, events, hand-offs) — not needed for interactive chat.' };
  }
  if (anyRequired) return { tone: 'req', text: 'Required.' };
  return { tone: 'opt', text: 'Optional.' };
}

// The form's fields grouped by their manifest `group`, in first-seen order, each
// with a heading and a necessity line. A manifest with no groups yields one
// unnamed group — the flat list, exactly as before.
export function groupDescriptors(credentials, scopeKeysMeta = {}) {
  const descriptors = fieldDescriptors(credentials, scopeKeysMeta);
  const order = [];
  const byGroup = new Map();
  for (const d of descriptors) {
    if (!byGroup.has(d.group)) { byGroup.set(d.group, []); order.push(d.group); }
    byGroup.get(d.group).push(d);
  }
  return order.map((slug) => ({
    group: slug,
    heading: groupHeading(slug),
    necessity: groupNecessity(byGroup.get(slug)),
    fields: byGroup.get(slug),
  }));
}

// The team-scope credential keys a given run mode needs (from `requiredFor`).
function keysForMode(credentials, mode) {
  return (Array.isArray(credentials) ? credentials : [])
    .filter((c) => Array.isArray(c.requiredFor) && c.requiredFor.includes(mode))
    .map((c) => c.key);
}
function allKeysSet(scope, keys) {
  return keys.length > 0 && keys.every((k) => scope && scope.keys && scope.keys[k] && scope.keys[k].set);
}

// One-line status for a scope's row. When the manifest tags keys with
// `requiredFor`, the status is honest per mode: the connection (interactive)
// keys and the automated (service-account) keys are reported separately, so a
// site-only team reads "chat works, automation not set" rather than a blanket
// "incomplete". Falls back to the pre-#jira-setup-ux completeness label for a
// manifest without `requiredFor`.
export function scopeStatusLabel(scope, credentials) {
  if (!scope) return '';
  const interactiveKeys = keysForMode(credentials, 'interactive');
  const automatedKeys = keysForMode(credentials, 'automated');
  if (interactiveKeys.length || automatedKeys.length) {
    const connectionSet = interactiveKeys.length === 0 || allKeysSet(scope, interactiveKeys);
    const serviceAccountSet = automatedKeys.length > 0 && allKeysSet(scope, automatedKeys);
    if (!connectionSet) return 'Not connected — set the site to enable this plugin (both chat and automated runs need it).';
    if (serviceAccountSet) return `Connected, service account set — automated runs ready${scope.setBy ? ` (set by ${scope.setBy})` : ''}.`;
    return 'Connected — interactive chat works. Service account not set: automated runs (schedules, loops, events) are unavailable.';
  }
  if (scope.complete) {
    return `Configured — set by ${scope.setBy || 'someone'}${scope.setAt ? ` on ${new Date(scope.setAt).toLocaleDateString()}` : ''}`;
  }
  const missing = Array.isArray(scope.missingRequired) ? scope.missingRequired : [];
  if (missing.length && Object.values(scope.keys || {}).some((k) => k && k.set)) {
    return `Incomplete — still needs: ${missing.join(', ')}`;
  }
  return 'Not configured';
}

export function scopeStatusTone(scope, credentials) {
  if (!scope) return 'muted';
  const interactiveKeys = keysForMode(credentials, 'interactive');
  const automatedKeys = keysForMode(credentials, 'automated');
  if (interactiveKeys.length || automatedKeys.length) {
    const connectionSet = interactiveKeys.length === 0 || allKeysSet(scope, interactiveKeys);
    if (!connectionSet) return Object.values(scope.keys || {}).some((k) => k && k.set) ? 'warn' : 'muted';
    return 'ok'; // connected → interactive works; a missing service account is a non-blocking note
  }
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

// The Plugins page shows every team scope the viewer can see; the Team-Settings
// service-account surface (#2608) pins the section to ONE team (its team-agent
// id == the team-granularity scopeId). `onlyScopeId` null/absent keeps all.
export function selectScopes(scopes, onlyScopeId) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (!onlyScopeId) return list;
  return list.filter((s) => s && s.scopeId === onlyScopeId);
}
