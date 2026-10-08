// Role memory requirement (#2813) — browser (ESM) copy.
//
// Same logic as the CJS twin `admin-console/api/memory-limit.js` /
// `orchestrator/memory-limit.js` (kept in sync; change together — the
// behaviour parity is asserted by memory-limit-view.test.js). See the CJS
// module header for the role → toolchain → platform contract.

export const DEFAULT_MEMORY_CEILING = '8g';
export const DEFAULT_PLATFORM_MEMORY = '2g';

const UNIT_BYTES = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
// "4g", "4G", "4gb", "4Gi", "512m", "512Mi" — a unit is required so a bare
// "4" (four bytes) is never mistaken for four gigabytes.
const SIZE_RE = /^(\d+)\s*([kmgt])(?:i?b?)$/i;

/** Bytes for a size string, or 0 when it is not a positive size. */
export function parseMemoryLimit(value) {
  const m = SIZE_RE.exec(String(value == null ? '' : value).trim());
  if (!m) return 0;
  return Number(m[1]) * UNIT_BYTES[m[2].toLowerCase()];
}

/** Canonical podman-style form ("4g", "512m"), or null when not a valid size. */
export function normalizeMemoryLimit(value) {
  const m = SIZE_RE.exec(String(value == null ? '' : value).trim());
  if (!m || Number(m[1]) <= 0) return null;
  return `${Number(m[1])}${m[2].toLowerCase()}`;
}

/** Human form of a byte count: the largest whole unit ("4g", "1536m"). */
export function formatMemoryBytes(bytes) {
  const n = Number(bytes) || 0;
  for (const u of ['t', 'g', 'm', 'k']) {
    if (n >= UNIT_BYTES[u] && n % UNIT_BYTES[u] === 0) return `${n / UNIT_BYTES[u]}${u}`;
  }
  return `${n}b`;
}

/** The operator ceiling as a canonical size (env AEE_AGENT_MEM_CEILING). An
 * unparseable value falls back to the default rather than lifting the cap. */
export function memoryCeiling(env) {
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
export function memoryLimitError(value, opts = {}) {
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
export function resolveEffectiveMemory({ role, toolchain, platform, ceiling } = {}) {
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

// ── UI-only helpers (not in the CJS twin) ─────────────────────────────────

export const MEMORY_SOURCE_LABELS = Object.freeze({
  role: 'role setting',
  toolchain: 'toolchain',
  platform: 'platform default',
});

export const MEMORY_NEXT_START_NOTE = 'A change applies on the next container start; running containers (and running pool instances) keep their current limit.';

/**
 * The one-line "effective limit" read-out for an editor: the live value the
 * user is typing (`role`) resolved against the toolchain/platform values the
 * server reported (`info` = GET /api/agents/:id/memory or the platform block).
 * Edge case (#2813): a role value beats a LARGER toolchain value — both are
 * shown so the downgrade is visible.
 */
export function effectiveMemoryText(role, info = {}) {
  const eff = resolveEffectiveMemory({
    role,
    toolchain: info.toolchain,
    platform: info.platform,
    ceiling: info.ceiling,
  });
  let text = `Effective limit: ${eff.limit} (${MEMORY_SOURCE_LABELS[eff.source]})`;
  if (eff.clamped) text += ` — capped at the platform ceiling ${eff.ceiling}`;
  if (eff.source === 'role' && eff.toolchain) text += ` · toolchain: ${eff.toolchain}`;
  if (eff.source !== 'platform') text += ` · platform default: ${eff.platform}`;
  return text;
}
