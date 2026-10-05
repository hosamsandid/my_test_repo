'use strict';

// memory-limit.js — the one definition of a role's portable memory
// requirement (#2813). Byte-identical in orchestrator/ and admin-console/api/
// (parity-tested in admin-console/api/memory-limit.test.js); the console's
// browser copy is admin-console/src/pages/memory-limit-view.js.
//
// A role may carry `memoryLimit` (e.g. "4g", "512m"). Empty means "platform
// default". The effective container/pod limit at start is: the role's value,
// else the toolchain's `resources.memoryLimit`, else the fleet default
// (AEE_AGENT_MEM_LIMIT). An operator-configurable ceiling
// (AEE_AGENT_MEM_CEILING, default 8g) bounds what a role may ask for: a value
// above it is rejected on save / bundle validation, and clamped (with a
// warning) when a bundle is materialised or a container starts.

const DEFAULT_MEMORY_CEILING = '8g';
const DEFAULT_PLATFORM_MEMORY = '2g';

const UNIT_BYTES = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
// "4g", "4G", "4gb", "4Gi", "512m", "512Mi" — a unit is required so a bare
// "4" (four bytes) is never mistaken for four gigabytes.
const SIZE_RE = /^(\d+)\s*([kmgt])(?:i?b?)$/i;

/** Bytes for a size string, or 0 when it is not a positive size. */
function parseMemoryLimit(value) {
  const m = SIZE_RE.exec(String(value == null ? '' : value).trim());
  if (!m) return 0;
  return Number(m[1]) * UNIT_BYTES[m[2].toLowerCase()];
}

/** Canonical podman-style form ("4g", "512m"), or null when not a valid size. */
function normalizeMemoryLimit(value) {
  const m = SIZE_RE.exec(String(value == null ? '' : value).trim());
  if (!m || Number(m[1]) <= 0) return null;
  return `${Number(m[1])}${m[2].toLowerCase()}`;
}

/** Human form of a byte count: the largest whole unit ("4g", "1536m"). */
function formatMemoryBytes(bytes) {
  const n = Number(bytes) || 0;
  for (const u of ['t', 'g', 'm', 'k']) {
    if (n >= UNIT_BYTES[u] && n % UNIT_BYTES[u] === 0) return `${n / UNIT_BYTES[u]}${u}`;
  }
  return `${n}b`;
}

/** The operator ceiling as a canonical size (env AEE_AGENT_MEM_CEILING). An
 * unparseable value falls back to the default rather than lifting the cap. */
function memoryCeiling(env) {
  const raw = env && env.AEE_AGENT_MEM_CEILING;
  return normalizeMemoryLimit(raw) || DEFAULT_MEMORY_CEILING;
}

function isEmpty(value) {
  return value == null || String(value).trim() === '';
}

/**
 * Validate a role memory requirement. Empty is valid (platform default).
 * Returns null when valid, else a message naming the role when one is given.
 */
function memoryLimitError(value, opts = {}) {
  if (isEmpty(value)) return null;
  const prefix = opts.role ? `role ${opts.role}: ` : '';
  const text = String(value).trim();
  if (/^-/.test(text)) return `${prefix}memory limit "${text}" must be greater than zero`;
  const m = SIZE_RE.exec(text);
  if (!m) return `${prefix}memory limit "${text}" is not a size (use e.g. 4g or 512m)`;
  if (Number(m[1]) <= 0) return `${prefix}memory limit "${text}" must be greater than zero`;
  const ceiling = normalizeMemoryLimit(opts.ceiling) || DEFAULT_MEMORY_CEILING;
  if (parseMemoryLimit(text) > parseMemoryLimit(ceiling)) {
    return `${prefix}memory limit "${text}" exceeds the platform ceiling of ${ceiling}`;
  }
  return null;
}

/**
 * The effective memory limit and where it came from:
 *   role → toolchain → platform. A role value above the ceiling is clamped to
 * the ceiling (`clamped: true`); an unparseable role/toolchain value is skipped.
 * Returns { limit, bytes, source: 'role'|'toolchain'|'platform', clamped,
 *           role, toolchain, platform, ceiling }.
 */
function resolveEffectiveMemory({ role, toolchain, platform, ceiling } = {}) {
  const cap = normalizeMemoryLimit(ceiling) || DEFAULT_MEMORY_CEILING;
  const roleNorm = normalizeMemoryLimit(role);
  const toolNorm = normalizeMemoryLimit(toolchain);
  const platNorm = normalizeMemoryLimit(platform) || DEFAULT_PLATFORM_MEMORY;
  const base = { role: roleNorm, toolchain: toolNorm, platform: platNorm, ceiling: cap };
  if (roleNorm) {
    const clamped = parseMemoryLimit(roleNorm) > parseMemoryLimit(cap);
    const limit = clamped ? cap : roleNorm;
    return { ...base, limit, bytes: parseMemoryLimit(limit), source: 'role', clamped };
  }
  if (toolNorm) return { ...base, limit: toolNorm, bytes: parseMemoryLimit(toolNorm), source: 'toolchain', clamped: false };
  return { ...base, limit: platNorm, bytes: parseMemoryLimit(platNorm), source: 'platform', clamped: false };
}

module.exports = {
  DEFAULT_MEMORY_CEILING,
  DEFAULT_PLATFORM_MEMORY,
  parseMemoryLimit,
  normalizeMemoryLimit,
  formatMemoryBytes,
  memoryCeiling,
  memoryLimitError,
  resolveEffectiveMemory,
};
