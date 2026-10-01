'use strict';

// ─── plugin registry id rules (#2649) ────────────────────────────────────────
//
// Two rules on purpose, and they must not be confused:
//
//  - PLUGIN_ID_RE is what a plugin id may BE. Every route that acts on a plugin
//    (install, UI proxy, credentials, scopes) is gated on it.
//  - REGISTRY_DIR_NAME_RE is what may merely EXIST in /workspace/plugins and
//    still be removed from the console. The orchestrator lists any directory
//    not starting with `_` or `.` (plugin-registry.js isPluginDirName), so an
//    operator's `jira.bak-20260930` shows up on the Plugins page as a broken
//    entry. Without a removal path that entry could only be deleted by hand on
//    the volume. It is still a single, dot-free-at-the-start path segment, so
//    it cannot name anything outside the registry.
//
// No I/O, no Express — unit-tested in isolation.

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REGISTRY_DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PLUGIN_ID_RULE = 'a plugin id must be 1–63 lowercase letters, digits or hyphens, starting with a letter or digit';

// The error an operator reads on the card, so it names the rule rather than
// just saying "invalid".
function invalidPluginIdMessage(id) {
  return `invalid plugin id "${id}": ${PLUGIN_ID_RULE}`;
}

function isValidPluginId(id) {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id);
}

// May DELETE /api/plugins/:id remove a registry directory with this name?
// Valid ids always; otherwise only a name the registry listing could have
// surfaced as a broken entry.
function isRemovableRegistryDirName(name) {
  return isValidPluginId(name) || (typeof name === 'string' && REGISTRY_DIR_NAME_RE.test(name));
}

module.exports = {
  PLUGIN_ID_RE,
  REGISTRY_DIR_NAME_RE,
  PLUGIN_ID_RULE,
  invalidPluginIdMessage,
  isValidPluginId,
  isRemovableRegistryDirName,
};
