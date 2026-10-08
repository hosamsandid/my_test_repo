'use strict';

// ─── Per-agent MCP server materialization (#2289) ────────────────────────────
//
// An agent's MCP servers come from its Working Environment's `mcpServers`
// (`[{ serverId, credentialId }]`), or verbatim from a team-member's own
// `mcpServersOverride` when it carries one. Each ref is resolved against the
// registry (`<serversDir>/<id>/server.json`) and the credentials store, and the
// resulting stanza is written into the agent's workspace.
//
// ── Where the CLI actually reads MCP servers from ────────────────────────────
//
// Claude Code does NOT read `mcpServers` from `.claude/settings.json` —
// verified with `claude mcp list` (CLI 2.1.212, re-checked on 2.1.293): a server there is ignored
// ("No MCP servers configured"). What it does read is two files:
//
//   <workspace>/.mcp.json               { "mcpServers": { <id>: <stanza> } }
//   <workspace>/.claude/settings.json   { "enabledMcpjsonServers": [<id>, …] }
//
// The second is the headless approval: a `.mcp.json` server that is not listed
// there sits at "Pending approval" and never loads. The agent's `claude` runs
// with the workspace as its cwd and is spawned fresh per turn, so rewriting
// both files is enough for a change to land on the agent's next turn.
//
// ── Reconciling, not additive ────────────────────────────────────────────────
//
// The seed used to run once, at creation, into an empty file, so a purely
// additive write was enough. It now also runs whenever the set changes, which
// needs two more guarantees:
//
//   - a server dropped from the set is removed from the agent (and an explicit
//     empty set applies as "no MCP servers", distinct from inherit);
//   - nothing the platform did not write is ever removed. Both files can carry
//     entries an operator (or a skill) added by hand, and settings.json carries
//     many unrelated keys.
//
// Which entries are the platform's is RECORDED, not inferred: the manifest
// `<stateDir>/seeded-mcp.json` lists the server ids the last seed wrote, the
// same "activation truth" pattern as seeded-skills.json / seeded-commands.json.
// Only ids in that list are ever removed.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9-]+$/;
const TRANSPORTS = ['stdio', 'http', 'sse'];

const MCP_JSON_FILE = '.mcp.json';
const SETTINGS_REL = path.join('.claude', 'settings.json');
const SEEDED_MCP_FILE = 'seeded-mcp.json';
// The workspace-relative files an apply rewrites — the paths a running agent's
// dedicated volume has to be re-mirrored with (reseedAgent).
const MCP_RESEED_PATHS = ['.mcp.json', '.claude/settings.json'];

/**
 * The refs an agent should carry right now: a team-member's own override wins
 * verbatim (an empty array is a deliberate "no MCP servers"), otherwise its
 * environment's list.
 */
function effectiveMcpRefs(cfg, env) {
  if (cfg && Array.isArray(cfg.mcpServersOverride)) return cfg.mcpServersOverride;
  return env && Array.isArray(env.mcpServers) ? env.mcpServers : [];
}

/**
 * Resolve refs into Claude Code MCP stanzas. A ref that cannot be resolved
 * (bad id, unregistered server, unreadable credential, unsupported transport)
 * is skipped with a warning — and, because it is then absent from the result,
 * a reconcile removes a previously seeded copy of it.
 *
 * @returns {{ stanzas: Object<string, object>, seeded: string[] }}
 */
function buildMcpStanzas(mcpRefs, { serversDir, credentialsKeysDir }, warnings) {
  const stanzas = {};
  const seeded = [];
  for (const ref of Array.isArray(mcpRefs) ? mcpRefs : []) {
    const serverId = ref?.serverId;
    const credId = ref?.credentialId || null;
    if (!serverId || !ID_RE.test(serverId)) {
      warnings.push(`mcp: invalid serverId in env ref: ${JSON.stringify(ref)}`);
      continue;
    }
    let server;
    try {
      server = JSON.parse(fs.readFileSync(path.join(serversDir, serverId, 'server.json'), 'utf8'));
    } catch (err) {
      warnings.push(`mcp: server '${serverId}' not found in registry (${err.message})`);
      continue;
    }

    let secret = '';
    if (credId) {
      if (!ID_RE.test(credId)) {
        warnings.push(`mcp: invalid credentialId for server '${serverId}': ${credId}`);
        continue;
      }
      try {
        secret = fs.readFileSync(path.join(credentialsKeysDir, credId), 'utf8').trim();
      } catch (err) {
        warnings.push(`mcp: cannot read credential '${credId}' for server '${serverId}' (${err.message})`);
        continue;
      }
    }

    // Different transports carry the substitution template under different
    // keys: stdio servers get `env` (process environment), http/sse servers
    // get `headers` (HTTP request headers). The substitution mechanics are
    // identical — only the destination key changes.
    const transport = server.transport || 'stdio';
    if (!TRANSPORTS.includes(transport)) {
      warnings.push(`mcp: server '${serverId}' has unsupported transport '${transport}'`);
      continue;
    }
    const tplKey = transport === 'stdio' ? 'env' : 'headers';
    const template = (server[tplKey] && typeof server[tplKey] === 'object') ? server[tplKey] : {};

    const resolved = {};
    let placeholderUsed = false;
    for (const [k, v] of Object.entries(template)) {
      if (typeof v !== 'string') { resolved[k] = v; continue; }
      if (v.includes('${credential}')) {
        placeholderUsed = true;
        if (!secret) {
          warnings.push(`mcp: server '${serverId}' ${tplKey} key '${k}' uses \${credential} but no credential is bound`);
          // Drop the key rather than leak the literal placeholder into the agent.
          continue;
        }
        resolved[k] = v.split('${credential}').join(secret);
      } else {
        resolved[k] = v;
      }
    }
    if (!placeholderUsed && credId) {
      warnings.push(`mcp: server '${serverId}' has a credential bound but no \${credential} placeholder in ${tplKey} — credential ignored`);
    }

    // Stanza shape per Claude Code's MCP config schema:
    //   stdio   → { command, args, env }                  (no `type` field — stdio is the default)
    //   http    → { type: "http", url, headers }
    //   sse     → { type: "sse",  url, headers }
    stanzas[serverId] = transport === 'stdio'
      ? { command: server.command, args: Array.isArray(server.args) ? server.args : [], env: resolved }
      : { type: transport, url: server.url, headers: resolved };
    if (!seeded.includes(serverId)) seeded.push(serverId);
  }
  return { stanzas, seeded };
}

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The pure reconcile. Given the current file contents, the ids the previous
 * seed recorded, and the stanzas wanted now, return the next contents.
 *
 *   - `.mcp.json` `mcpServers`: every wanted stanza is (over)written; a
 *     previously-seeded id that is no longer wanted is removed; every other
 *     entry is left exactly as it was.
 *   - settings.json `enabledMcpjsonServers`: same rule for the id list; all
 *     other settings keys are untouched. The key is not introduced for an
 *     agent that has nothing to enable.
 *
 * @param {object} args
 * @param {object} args.mcpJson   parsed `.mcp.json` ({} when absent)
 * @param {object} args.settings  parsed `.claude/settings.json` ({} when absent)
 * @param {string[]} args.previous ids the last seed wrote ([] when none)
 * @param {Object<string, object>} args.stanzas the wanted servers, by id
 * @returns {{ mcpJson: object, settings: object, seeded: string[], removed: string[] }}
 */
function reconcileMcpConfig({ mcpJson, settings, previous, stanzas }) {
  const wanted = Object.keys(stanzas || {});
  const prev = Array.isArray(previous) ? previous : [];
  const removed = prev.filter(id => !wanted.includes(id));

  const nextMcpJson = isPlainObject(mcpJson) ? { ...mcpJson } : {};
  const servers = isPlainObject(nextMcpJson.mcpServers) ? { ...nextMcpJson.mcpServers } : {};
  for (const id of removed) delete servers[id];
  for (const id of wanted) servers[id] = stanzas[id];
  nextMcpJson.mcpServers = servers;

  const nextSettings = isPlainObject(settings) ? { ...settings } : {};
  const hadEnabled = Array.isArray(nextSettings.enabledMcpjsonServers);
  const enabled = (hadEnabled ? nextSettings.enabledMcpjsonServers : []).filter(id => !removed.includes(id));
  for (const id of wanted) if (!enabled.includes(id)) enabled.push(id);
  if (hadEnabled || enabled.length > 0) nextSettings.enabledMcpjsonServers = enabled;

  return { mcpJson: nextMcpJson, settings: nextSettings, seeded: wanted, removed };
}

// Read a JSON object file. Absent → `{}`; present but unparseable → `null`, so
// the caller can refuse to write over it rather than silently wiping it.
function readJsonObject(p) {
  if (!fs.existsSync(p)) return {};
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return isPlainObject(v) ? v : null;
  } catch { return null; }
}

function writeJsonAtomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

function readSeededMcp(stateDir) {
  const m = readJsonObject(path.join(stateDir, SEEDED_MCP_FILE));
  return m && Array.isArray(m.servers) ? m.servers.filter(id => typeof id === 'string') : [];
}

/**
 * Reconcile an agent workspace's MCP files against `stanzas` and record what
 * was seeded. Safe to call repeatedly — this is both the one-time seed and
 * every later re-application.
 *
 * An existing `.mcp.json` or `settings.json` that cannot be parsed is NOT
 * overwritten (the old one-time seed did that; on a path that now runs on every
 * MCP change it would wipe whatever else the file held) — the call fails with
 * a warning instead and leaves every file as it was.
 *
 * @returns {{ ok: boolean, seeded: string[], removed: string[], error?: string }}
 */
function writeAgentMcpConfig(dest, stanzas, warnings, { stateDir }) {
  const mcpJsonPath = path.join(dest, MCP_JSON_FILE);
  const settingsPath = path.join(dest, SETTINGS_REL);
  const mcpJson = readJsonObject(mcpJsonPath);
  const settings = readJsonObject(settingsPath);
  const unreadable = [mcpJson === null && MCP_JSON_FILE, settings === null && SETTINGS_REL].filter(Boolean);
  if (unreadable.length) {
    const error = `cannot parse existing ${unreadable.join(' and ')} — left unchanged, MCP servers not applied`;
    warnings.push(`mcp: ${error}`);
    return { ok: false, seeded: [], removed: [], error };
  }
  const previous = readSeededMcp(stateDir);
  const next = reconcileMcpConfig({ mcpJson, settings, previous, stanzas });
  try {
    // An agent that never had an MCP server keeps a workspace with no
    // `.mcp.json` at all; once one exists it is always rewritten, so a removal
    // down to the empty set is written (and mirrored) too.
    if (fs.existsSync(mcpJsonPath) || next.seeded.length > 0) writeJsonAtomic(mcpJsonPath, next.mcpJson);
    if (fs.existsSync(settingsPath) || Array.isArray(next.settings.enabledMcpjsonServers)) {
      writeJsonAtomic(settingsPath, next.settings);
    }
    // Always written (even empty), last: it records what the files now hold.
    writeJsonAtomic(path.join(stateDir, SEEDED_MCP_FILE), {
      servers: next.seeded,
      seededAt: new Date().toISOString(),
    });
  } catch (err) {
    const error = `cannot write MCP configuration (${err.message})`;
    warnings.push(`mcp: ${error}`);
    return { ok: false, seeded: [], removed: [], error };
  }
  return { ok: true, seeded: next.seeded, removed: next.removed };
}

/**
 * One agent's apply outcome, from the file write and the volume mirror:
 *
 *   applied — the files are in place where the agent reads them: its next
 *             turn uses the new set (shared volume, or a mirrored dedicated one)
 *   stored  — written to the agent's workspace, but the agent is not running;
 *             it is mirrored into its volume when the agent next starts
 *   failed  — the write or the mirror failed; `detail` says why
 */
function describeApplyOutcome(id, write, reseed) {
  if (!write || !write.ok) {
    return { id, status: 'failed', detail: (write && write.error) || 'MCP configuration was not written' };
  }
  const base = { id, servers: write.seeded };
  if (reseed && reseed.error) return { ...base, status: 'failed', detail: `could not reach the running agent: ${reseed.error}` };
  if (reseed && reseed.skipped === 'not-running') return { ...base, status: 'stored' };
  return { ...base, status: 'applied' };
}

/**
 * Which agents an environment's MCP change reaches (D3). An agent is in scope
 * when it is bound to the environment and is not the team record itself (a
 * `role: 'team'` agent has no workspace). Of those:
 *
 *   keep-override — carries its own `mcpServersOverride`; left untouched
 *   pending       — not materialized yet; picks the set up at its first seed
 *   apply         — gets the new set now
 *
 * @param {Array<{id: string, cfg: object|null}>} agents
 */
function planEnvironmentMcpApply(agents, envId) {
  const plan = [];
  for (const { id, cfg } of Array.isArray(agents) ? agents : []) {
    if (!cfg || cfg.environmentId !== envId || cfg.role === 'team') continue;
    if (Array.isArray(cfg.mcpServersOverride)) plan.push({ id, action: 'keep-override' });
    else if (!cfg.token) plan.push({ id, action: 'pending' });
    else plan.push({ id, action: 'apply' });
  }
  return plan;
}

/**
 * Fold per-agent outcomes into the report the API returns — every member is
 * accounted for in exactly one bucket, nothing is swallowed (AC10).
 */
function summarizeMcpApply(outcomes) {
  const out = { applied: [], stored: [], pending: [], keptOverride: [], failed: [] };
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || !o.id) continue;
    if (o.status === 'applied') out.applied.push(o.id);
    else if (o.status === 'stored') out.stored.push(o.id);
    else if (o.status === 'pending') out.pending.push(o.id);
    else if (o.status === 'keep-override') out.keptOverride.push(o.id);
    else out.failed.push({ id: o.id, error: o.detail || 'failed' });
  }
  return out;
}

module.exports = {
  MCP_JSON_FILE,
  SEEDED_MCP_FILE,
  MCP_RESEED_PATHS,
  effectiveMcpRefs,
  buildMcpStanzas,
  reconcileMcpConfig,
  readSeededMcp,
  writeAgentMcpConfig,
  describeApplyOutcome,
  planEnvironmentMcpApply,
  summarizeMcpApply,
};
