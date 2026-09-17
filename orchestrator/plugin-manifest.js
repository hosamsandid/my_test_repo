'use strict';

// ─── plugin manifest (plugin system Phase 1, #1517) ──────────────────────────
//
// A *plugin* is a governed capability extension beyond the agent container
// (docs/plugin-system-concept.md §4.1). It pairs a privilege-holding broker
// sidecar with a dependency-free CLI facade seeded into the agent workspace.
// The registry directory `/workspace/plugins/<id>/` carries `plugin.json`
// (this manifest) plus the CLI script(s) under `bin/`.
//
// This module is the pure validator/normalizer for a `pluginVersion: 1`
// manifest, in the same discipline as process-template.js — no I/O, so it is
// unit-testable in isolation and shared by the registry/install path and the
// broker SDK.
//
// NOTE: this file exists TWICE — `admin-console/api/plugin-manifest.js` (the
// install path validates before writing to the registry) and
// `orchestrator/plugin-manifest.js` (the sidecar/seed path re-validates on
// read, since a registry directory can also be placed by hand). The two build
// contexts are disjoint, so neither can require the other — the same constraint
// that duplicates plugin-scope-token.js into a broker image. The copies are
// asserted BYTE-IDENTICAL by orchestrator/plugin-manifest-mirror.test.js:
// change both in one commit.
//
// Shape (pluginVersion 1):
//   {
//     pluginVersion: 1,
//     id, name, description,
//     sidecar: { image, env?, capabilities?, internalPort },  // required unless commands present
//     cli: { name, entrypoint, runtime },                     // required unless commands present
//     credentials?: [ { key, description?, required? } ],
//     platforms?: [ "podman" | "kubernetes" | "any" ],
//     scopes?: [ "team" | "agent" ],           // granularities the broker honours
//     defaultScopeGranularity?: "team" | "agent",  // grant default within scopes (§4.4/§10)
//     quota?: { maxObjects, ttlSeconds? },      // per-scope resource cap (§4.6)
//     requiresApproval?: [ "<subcommand>" ],
//     policy?: { "<subcommand>": { scopes?: ["team"|"agent"], requiresFlowFinal?: bool } },
//     ui?: { title?, global?, routes?: [ { path, minRole } ] },
//     commands?: { namespace?: string },       // command-only plugin (#1798): no sidecar/cli needed
//     fetch?: { source: "github", repo: string, ref: string, commandsDir?: string },
//     events?: [ { name, description?, payload?: [ { key, description?, example? } ] } ],
//     companionSkill?, promptLine?, version?,
//   }

const VERSION = 1;

// Closed enum of privileged attachments the orchestrator knows how to provide
// (§4.1). `host-mount:<path>` is parameterised — the prefix is fixed, the path
// is the plugin author's declared mount point and is reviewed at install time.
const CAPABILITIES = Object.freeze(['podman-socket', 'egress']);
const HOST_MOUNT_PREFIX = 'host-mount:';

// Runtimes present in the agent image (concept §4.5: dependency-free single
// file against the runtimes already present — no compiled binaries).
const CLI_RUNTIMES = Object.freeze(['python3', 'node', 'bash']);

// Runtime requirements a plugin can declare (§4.1). `podman` = local/compose
// only (like context mounts); `kubernetes` = runs as a k8s plugin sidecar (the
// positive mirror of `podman`); `any` = no special stack requirement. A
// manifest may combine the positive declarations (e.g. ["podman","kubernetes"]).
const PLATFORMS = Object.freeze(['podman', 'kubernetes', 'any']);

// Scope granularities the broker can implement (§4.6). A grant may only choose
// a granularity the manifest's `scopes` declares.
const SCOPE_GRANULARITIES = Object.freeze(['team', 'agent']);

// Console role model forwarded to plugin UIs (§4.8). `ui.routes[].minRole` is
// validated and reserved in Phase 1; the proxy/enforcement lands in Phase 5.
const UI_ROLES = Object.freeze(['team-member', 'team-admin', 'system-admin']);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;               // registry dir name
const CLI_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;         // agent-facing command
const COMMANDS_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // command namespace slug
const PORT_MIN = 1;
const PORT_MAX = 65535;

// Allowed content sources for install-time fetch (#1798).
const FETCH_SOURCES = Object.freeze(['github']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
// An event name in a plugin's vocabulary (`events[].name`): the broker's own
// identifier, matched exactly by a `plugin-event` trigger's `eventFilter`.
// Underscore and dot are allowed (`status_changed`, `issue.created`) — the
// GitHub-style `<type>.<action>` shape is a natural fit for event sources.
const EVENT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

// A safe registry/workspace-relative path: non-empty, no absolute prefix, no
// parent-traversal, no backslash (the discipline cli.entrypoint uses inline).
function isSafeRelPath(v) {
  return isNonEmptyString(v) && !v.startsWith('/') && !v.includes('..') && !v.includes('\\');
}

// A capability is either a bare closed-enum member or a `host-mount:<path>`
// with a non-empty absolute path.
function isValidCapability(cap) {
  if (typeof cap !== 'string') return false;
  if (CAPABILITIES.includes(cap)) return true;
  if (cap.startsWith(HOST_MOUNT_PREFIX)) {
    const p = cap.slice(HOST_MOUNT_PREFIX.length);
    return p.startsWith('/') && p.length > 1 && !p.includes('..');
  }
  return false;
}

// Validate + normalize a manifest. Returns { ok, errors, manifest } — `manifest`
// is the normalized shape when ok, else null. Never throws.
function validatePluginManifest(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['manifest must be an object'], manifest: null };
  }

  if (input.pluginVersion !== VERSION) {
    errors.push(`pluginVersion must be ${VERSION}`);
  }
  if (!isNonEmptyString(input.id) || !ID_RE.test(input.id)) {
    errors.push('id must be a slug matching /^[a-z0-9][a-z0-9-]{0,62}$/');
  }
  if (!isNonEmptyString(input.name)) errors.push('name is required');
  if (!isNonEmptyString(input.description)) errors.push('description is required');

  // ── commands (optional; makes sidecar+cli optional) ──────────────────────
  // A "command-only" plugin (#1798) ships .claude/commands/* files on grant and
  // carries no broker sidecar or CLI facade — spec-kit is the first example.
  // When `commands` is present, `sidecar` and `cli` become optional.
  let commands;
  if (input.commands !== undefined) {
    if (!isPlainObject(input.commands)) {
      errors.push('commands must be an object');
    } else {
      commands = {};
      if (input.commands.namespace !== undefined) {
        if (!isNonEmptyString(input.commands.namespace) || !COMMANDS_NAMESPACE_RE.test(input.commands.namespace)) {
          errors.push('commands.namespace must be a slug matching /^[a-z0-9][a-z0-9-]{0,62}$/');
        } else {
          commands.namespace = input.commands.namespace;
        }
      }
    }
  }
  const isCommandOnly = commands !== undefined && !isPlainObject(input.sidecar);

  // ── fetch (optional; install-time content source) ────────────────────────
  // Declares where the orchestrator fetches command files at install time so
  // the content is pinned to a specific version and not pre-baked into the image.
  let pluginFetch;
  if (input.fetch !== undefined) {
    if (!isPlainObject(input.fetch)) {
      errors.push('fetch must be an object');
    } else {
      const fetchErrors = [];
      if (!isNonEmptyString(input.fetch.source) || !FETCH_SOURCES.includes(input.fetch.source)) {
        fetchErrors.push(`fetch.source must be one of: ${FETCH_SOURCES.join(', ')}`);
      }
      if (!isNonEmptyString(input.fetch.repo)) fetchErrors.push('fetch.repo is required');
      if (!isNonEmptyString(input.fetch.ref)) fetchErrors.push('fetch.ref is required');
      for (const e of fetchErrors) errors.push(e);
      if (fetchErrors.length === 0) {
        pluginFetch = { source: input.fetch.source, repo: input.fetch.repo.trim(), ref: input.fetch.ref.trim() };
        if (input.fetch.commandsDir !== undefined) {
          if (!isNonEmptyString(input.fetch.commandsDir)) {
            errors.push('fetch.commandsDir must be a non-empty string');
          } else {
            pluginFetch.commandsDir = input.fetch.commandsDir.trim();
          }
        }
        // A command-only plugin whose commands need placeholder resolution
        // (spec-kit, #1865) declares which script flavour to resolve against and
        // opts into the resolution. `resolveCommands` gates the transform so a
        // plain command plugin stays byte-passthrough.
        if (input.fetch.scriptVariant !== undefined) {
          if (!isNonEmptyString(input.fetch.scriptVariant)) {
            errors.push('fetch.scriptVariant must be a non-empty string');
          } else {
            pluginFetch.scriptVariant = input.fetch.scriptVariant.trim();
          }
        }
        if (input.fetch.resolveCommands !== undefined) {
          if (typeof input.fetch.resolveCommands !== 'boolean') {
            errors.push('fetch.resolveCommands must be a boolean');
          } else {
            pluginFetch.resolveCommands = input.fetch.resolveCommands;
          }
        }
        // Extra content trees fetched alongside the commands and seeded into the
        // agent workspace (the `.specify/` scaffold for spec-kit). Each entry
        // copies a repo directory (`repoDir`) to a workspace-relative `dest`;
        // `exec` marks a tree whose files get the execute bit; `include` is an
        // optional filename regex.
        if (input.fetch.scaffold !== undefined) {
          if (!Array.isArray(input.fetch.scaffold)) {
            errors.push('fetch.scaffold must be an array');
          } else {
            const scaffold = [];
            input.fetch.scaffold.forEach((entry, i) => {
              if (!isPlainObject(entry)) {
                errors.push(`fetch.scaffold[${i}] must be an object`);
                return;
              }
              if (!isSafeRelPath(entry.repoDir)) {
                errors.push(`fetch.scaffold[${i}].repoDir must be a safe relative path`);
                return;
              }
              if (!isSafeRelPath(entry.dest)) {
                errors.push(`fetch.scaffold[${i}].dest must be a safe relative path`);
                return;
              }
              const norm = { repoDir: entry.repoDir.trim(), dest: entry.dest.trim() };
              if (entry.exec !== undefined) {
                if (typeof entry.exec !== 'boolean') {
                  errors.push(`fetch.scaffold[${i}].exec must be a boolean`);
                  return;
                }
                norm.exec = entry.exec;
              }
              if (entry.include !== undefined) {
                if (!isNonEmptyString(entry.include)) {
                  errors.push(`fetch.scaffold[${i}].include must be a non-empty string`);
                  return;
                }
                norm.include = entry.include.trim();
              }
              scaffold.push(norm);
            });
            if (scaffold.length) pluginFetch.scaffold = scaffold;
          }
        }
      }
    }
  }

  // ── sidecar ────────────────────────────────────────────────────────────
  const sc = input.sidecar;
  const sidecar = {};
  if (!isCommandOnly && !isPlainObject(sc)) {
    errors.push('sidecar is required and must be an object (omit for command-only plugins that declare commands)');
  } else if (isPlainObject(sc)) {
    if (!isNonEmptyString(sc.image)) errors.push('sidecar.image is required');
    else sidecar.image = sc.image.trim();

    if (sc.env !== undefined) {
      if (!isPlainObject(sc.env)) errors.push('sidecar.env must be an object of string values');
      else {
        const env = {};
        let bad = false;
        for (const [k, v] of Object.entries(sc.env)) {
          if (typeof v !== 'string') { bad = true; break; }
          env[k] = v;
        }
        if (bad) errors.push('sidecar.env values must all be strings');
        else sidecar.env = env;
      }
    }

    if (sc.capabilities !== undefined) {
      if (!Array.isArray(sc.capabilities)) {
        errors.push('sidecar.capabilities must be an array');
      } else {
        const invalid = sc.capabilities.filter((c) => !isValidCapability(c));
        if (invalid.length) {
          errors.push(`sidecar.capabilities has unknown entries: ${invalid.map(String).join(', ')}`);
        } else {
          sidecar.capabilities = [...new Set(sc.capabilities)];
        }
      }
    } else {
      sidecar.capabilities = [];
    }

    if (!Number.isInteger(sc.internalPort) || sc.internalPort < PORT_MIN || sc.internalPort > PORT_MAX) {
      errors.push(`sidecar.internalPort must be an integer in [${PORT_MIN}, ${PORT_MAX}]`);
    } else {
      sidecar.internalPort = sc.internalPort;
    }
  }

  // ── cli ────────────────────────────────────────────────────────────────
  const cliIn = input.cli;
  let cli;
  if (!isCommandOnly && !isPlainObject(cliIn)) {
    errors.push('cli is required and must be an object (omit for command-only plugins that declare commands)');
  } else if (isPlainObject(cliIn)) {
    cli = {};
    if (!isNonEmptyString(cliIn.name) || !CLI_NAME_RE.test(cliIn.name)) {
      errors.push('cli.name must be a slug matching /^[a-z0-9][a-z0-9-]{0,62}$/');
    } else cli.name = cliIn.name;
    if (!isNonEmptyString(cliIn.entrypoint) || cliIn.entrypoint.includes('..') || cliIn.entrypoint.startsWith('/')) {
      errors.push('cli.entrypoint must be a registry-relative path (no "..", not absolute)');
    } else cli.entrypoint = cliIn.entrypoint.trim();
    if (!CLI_RUNTIMES.includes(cliIn.runtime)) {
      errors.push(`cli.runtime must be one of: ${CLI_RUNTIMES.join(', ')}`);
    } else cli.runtime = cliIn.runtime;
  }

  // ── credentials (optional) ───────────────────────────────────────────────
  let credentials = [];
  if (input.credentials !== undefined) {
    if (!Array.isArray(input.credentials)) {
      errors.push('credentials must be an array');
    } else {
      const seen = new Set();
      for (const c of input.credentials) {
        if (!isPlainObject(c) || !isNonEmptyString(c.key)) {
          errors.push('each credential must be an object with a non-empty key');
          continue;
        }
        if (seen.has(c.key)) { errors.push(`duplicate credential key: ${c.key}`); continue; }
        seen.add(c.key);
        const entry = { key: c.key.trim(), required: c.required === true };
        if (isNonEmptyString(c.description)) entry.description = c.description.trim();
        credentials.push(entry);
      }
    }
  }

  // ── events (optional) ────────────────────────────────────────────────────
  // The plugin's event vocabulary — what an event-source plugin may send to
  // `POST /internal/plugin-event` and which top-level string fields its
  // payload carries. Purely descriptive: the trigger form renders it so a
  // `plugin-event` listener can be authored without reading the plugin's
  // docs (a `<select>` of event names, a key picker for `payloadFilter`).
  // The platform never interprets a name or key — D5 (jira-plugin-plan §10)
  // stays intact, the plugin merely declares what the docs used to hold.
  const events = [];
  if (input.events !== undefined) {
    if (!Array.isArray(input.events)) {
      errors.push('events must be an array');
    } else {
      const seenEvents = new Set();
      input.events.forEach((ev, i) => {
        if (!isPlainObject(ev) || !isNonEmptyString(ev.name)) {
          errors.push('each event must be an object with a non-empty name');
          return;
        }
        const name = ev.name.trim();
        if (!EVENT_NAME_RE.test(name)) {
          errors.push(`events[${i}].name must be a slug matching ${EVENT_NAME_RE}`);
          return;
        }
        if (seenEvents.has(name)) { errors.push(`duplicate event name: ${name}`); return; }
        seenEvents.add(name);
        const entry = { name };
        if (isNonEmptyString(ev.description)) entry.description = ev.description.trim();
        const payload = [];
        if (ev.payload !== undefined) {
          if (!Array.isArray(ev.payload)) {
            errors.push(`events[${i}].payload must be an array`);
          } else {
            const seenKeys = new Set();
            ev.payload.forEach((p, j) => {
              if (!isPlainObject(p) || !isNonEmptyString(p.key)) {
                errors.push('each payload field must be an object with a non-empty key');
                return;
              }
              const key = p.key.trim();
              if (seenKeys.has(key)) { errors.push(`duplicate payload key: ${key}`); return; }
              seenKeys.add(key);
              const field = { key };
              if (isNonEmptyString(p.description)) field.description = p.description.trim();
              if (p.example !== undefined) {
                if (typeof p.example !== 'string') errors.push(`events[${i}].payload[${j}].example must be a string`);
                else if (p.example.trim()) field.example = p.example.trim();
              }
              payload.push(field);
            });
          }
        }
        entry.payload = payload;
        events.push(entry);
      });
    }
  }

  // ── platforms (optional, default ["any"]) ────────────────────────────────
  let platforms = ['any'];
  if (input.platforms !== undefined) {
    if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
      errors.push('platforms must be a non-empty array');
    } else {
      const invalid = input.platforms.filter((p) => !PLATFORMS.includes(p));
      if (invalid.length) errors.push(`platforms has unknown entries: ${invalid.map(String).join(', ')}`);
      else platforms = [...new Set(input.platforms)];
    }
  }

  // ── scopes (optional, default ["team"]) ──────────────────────────────────
  // Declares the granularities the broker honours; bounds the grant's choice.
  let scopes = ['team'];
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      errors.push('scopes must be a non-empty array');
    } else {
      const invalid = input.scopes.filter((s) => !SCOPE_GRANULARITIES.includes(s));
      if (invalid.length) {
        errors.push(`scopes has unknown granularities: ${invalid.map(String).join(', ')}`);
      } else if (!input.scopes.includes('team')) {
        // Every broker must honour team granularity — it is the default a grant
        // falls back to (§4.6). An agent-only broker would leave the default
        // unreachable.
        errors.push('scopes must include "team" (the default granularity)');
      } else {
        scopes = [...new Set(input.scopes)];
      }
    }
  }

  // ── defaultScopeGranularity (optional) ───────────────────────────────────
  // Which granularity a grant defaults to when the admin does not choose one
  // (§4.4). The §10 open question — one platform-wide default vs. per-manifest
  // — is decided here in favour of per-manifest: plugin #1 (the sandbox) reads
  // most naturally as `agent`, the opposite of the safe `team` default for
  // shared expensive backends, so the default is the manifest's to declare.
  // Absent → the platform default `team` (see `defaultGranularity`). It must be
  // one of the granularities the broker actually honours.
  let defaultScopeGranularity;
  if (input.defaultScopeGranularity !== undefined) {
    if (!SCOPE_GRANULARITIES.includes(input.defaultScopeGranularity)) {
      errors.push(`defaultScopeGranularity has unknown granularity "${String(input.defaultScopeGranularity)}"`);
    } else if (!scopes.includes(input.defaultScopeGranularity)) {
      errors.push(`defaultScopeGranularity "${input.defaultScopeGranularity}" is not in scopes (${scopes.join(', ')})`);
    } else {
      defaultScopeGranularity = input.defaultScopeGranularity;
    }
  }

  // ── quota (optional; mandatory in practice for resource-creating plugins) ─
  // Per-scope resource cap (§4.6): a loop-triggered agent creating one object
  // per iteration is a runaway the #611 backstop cannot see, so the cap is a
  // manifest field rather than a single platform-wide Settings toggle, and it
  // is enforced per `scopeId` — n members at `agent` granularity means n× the
  // footprint, which the grant UI states as a ceiling before the toggle.
  let quota;
  if (input.quota !== undefined) {
    if (!isPlainObject(input.quota)) {
      errors.push('quota must be an object');
    } else {
      const q = {};
      if (!Number.isInteger(input.quota.maxObjects) || input.quota.maxObjects < 1) {
        errors.push('quota.maxObjects must be a positive integer');
      } else {
        q.maxObjects = input.quota.maxObjects;
      }
      if (input.quota.ttlSeconds !== undefined) {
        if (!Number.isInteger(input.quota.ttlSeconds) || input.quota.ttlSeconds < 1) {
          errors.push('quota.ttlSeconds must be a positive integer');
        } else {
          q.ttlSeconds = input.quota.ttlSeconds;
        }
      }
      if (q.maxObjects !== undefined) quota = q;
    }
  }

  // ── requiresApproval (optional) ──────────────────────────────────────────
  let requiresApproval = [];
  if (input.requiresApproval !== undefined) {
    if (!Array.isArray(input.requiresApproval) || input.requiresApproval.some((s) => !isNonEmptyString(s))) {
      errors.push('requiresApproval must be an array of non-empty strings');
    } else {
      requiresApproval = [...new Set(input.requiresApproval.map((s) => s.trim()))];
    }
  }

  // ── policy (optional; per-subcommand authorization keyed on scope, §4.6) ──
  // The first governance surface that only agent granularity can carry
  // (plugin #2, #1521): "test cases may only be created by the last agent in
  // the flow, once its cross-checks passed." Each key is a CLI subcommand; each
  // value narrows who may run it. `scopes` restricts the calling granularity
  // (⊆ the manifest's `scopes`); `requiresFlowFinal` gates on flow position,
  // which a team-scoped token cannot express — so a rule with it must not admit
  // team granularity. The broker enforces via broker-sdk/authz.js.
  let policy;
  if (input.policy !== undefined) {
    if (!isPlainObject(input.policy)) {
      errors.push('policy must be an object keyed by subcommand');
    } else {
      const out = {};
      for (const [sub, rawRule] of Object.entries(input.policy)) {
        if (!isNonEmptyString(sub)) { errors.push('policy keys must be non-empty subcommand names'); continue; }
        if (!isPlainObject(rawRule)) { errors.push(`policy["${sub}"] must be an object`); continue; }
        const rule = {};
        let ruleScopes = null;
        if (rawRule.scopes !== undefined) {
          if (!Array.isArray(rawRule.scopes) || rawRule.scopes.length === 0) {
            errors.push(`policy["${sub}"].scopes must be a non-empty array`);
          } else {
            const invalid = rawRule.scopes.filter((s) => !SCOPE_GRANULARITIES.includes(s));
            const notHonoured = rawRule.scopes.filter((s) => SCOPE_GRANULARITIES.includes(s) && !scopes.includes(s));
            if (invalid.length) {
              errors.push(`policy["${sub}"].scopes has unknown granularities: ${invalid.map(String).join(', ')}`);
            } else if (notHonoured.length) {
              errors.push(`policy["${sub}"].scopes has granularities not in the plugin's scopes: ${notHonoured.join(', ')}`);
            } else {
              ruleScopes = [...new Set(rawRule.scopes)];
              rule.scopes = ruleScopes;
            }
          }
        }
        if (rawRule.requiresFlowFinal !== undefined) {
          if (typeof rawRule.requiresFlowFinal !== 'boolean') {
            errors.push(`policy["${sub}"].requiresFlowFinal must be a boolean`);
          } else if (rawRule.requiresFlowFinal) {
            // Flow position is only expressible at agent granularity — the rule
            // must not admit a team-scoped caller.
            const effectiveScopes = ruleScopes || scopes;
            if (effectiveScopes.includes('team')) {
              errors.push(`policy["${sub}"].requiresFlowFinal is only expressible at agent granularity; set scopes to ["agent"]`);
            } else {
              rule.requiresFlowFinal = true;
            }
          }
        }
        out[sub] = rule;
      }
      policy = out;
    }
  }

  // ── ui (optional; validated + reserved, not implemented in Phase 1) ──────
  let ui;
  if (input.ui !== undefined) {
    if (!isPlainObject(input.ui)) {
      errors.push('ui must be an object');
    } else {
      ui = {};
      if (input.ui.title !== undefined) {
        if (!isNonEmptyString(input.ui.title)) errors.push('ui.title must be a non-empty string');
        else ui.title = input.ui.title.trim();
      }
      // Opt-in global UI visibility (#1599): when true, an INSTALLED plugin's UI
      // nav entry is shown to every authenticated user and its ordinary-user
      // routes are reachable without a team grant. Purely a human-UI concern —
      // it never widens an agent's capability grant. Off by default; only a
      // `true` value is persisted so a manifest without it normalizes
      // byte-identically to today (no regression for existing plugins).
      if (input.ui.global !== undefined) {
        if (typeof input.ui.global !== 'boolean') errors.push('ui.global must be a boolean');
        else if (input.ui.global) ui.global = true;
      }
      if (input.ui.routes !== undefined) {
        if (!Array.isArray(input.ui.routes)) {
          errors.push('ui.routes must be an array');
        } else {
          const routes = [];
          const seenPaths = new Set();
          for (const r of input.ui.routes) {
            if (!isPlainObject(r)) { errors.push('each ui.routes entry must be an object'); continue; }
            if (!isNonEmptyString(r.path) || !r.path.startsWith('/')) {
              errors.push('ui.routes[].path must be an absolute-style path starting with "/"');
              continue;
            }
            if (!UI_ROLES.includes(r.minRole)) {
              errors.push(`ui.routes[].minRole has unknown role "${String(r.minRole)}" (allowed: ${UI_ROLES.join(', ')})`);
              continue;
            }
            if (seenPaths.has(r.path)) { errors.push(`duplicate ui.routes path: ${r.path}`); continue; }
            seenPaths.add(r.path);
            routes.push({ path: r.path.trim(), minRole: r.minRole });
          }
          ui.routes = routes;
        }
      }
    }
  }

  // ── optional string fields ───────────────────────────────────────────────
  const optionalStrings = {};
  for (const key of ['companionSkill', 'promptLine', 'version']) {
    if (input[key] !== undefined) {
      if (!isNonEmptyString(input[key])) errors.push(`${key} must be a non-empty string`);
      else optionalStrings[key] = input[key].trim();
    }
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  const manifest = {
    pluginVersion: VERSION,
    id: input.id,
    name: input.name.trim(),
    description: input.description.trim(),
    credentials,
    events,
    platforms,
    scopes,
    requiresApproval,
  };
  if (sidecar && Object.keys(sidecar).length > 0) manifest.sidecar = sidecar;
  if (cli) manifest.cli = cli;
  if (commands !== undefined) manifest.commands = commands;
  if (pluginFetch) manifest.fetch = pluginFetch;
  if (defaultScopeGranularity) manifest.defaultScopeGranularity = defaultScopeGranularity;
  if (quota) manifest.quota = quota;
  if (policy) manifest.policy = policy;
  if (ui) manifest.ui = ui;
  Object.assign(manifest, optionalStrings);
  return { ok: true, errors: [], manifest };
}

// Which granularities a (validated) manifest permits a grant to choose.
function grantableGranularities(manifest) {
  return (manifest && Array.isArray(manifest.scopes)) ? manifest.scopes.slice() : ['team'];
}

// The granularity a grant defaults to when the admin does not choose one: the
// manifest's own declared default, else the platform default `team` (§4.4/§10).
// Always returns a granularity the manifest honours (the validator rejects a
// `defaultScopeGranularity` outside `scopes`).
function defaultGranularity(manifest) {
  if (manifest && SCOPE_GRANULARITIES.includes(manifest.defaultScopeGranularity)) {
    return manifest.defaultScopeGranularity;
  }
  return 'team';
}

// A grant may only choose a granularity the broker honours (§4.4/§4.6).
// Returns null if allowed, else an error string. Used by the Phase-2 grant path
// and unit-tested here so the rule is locked before the UI exists.
function assertGranularityGrantable(manifest, granularity) {
  if (!SCOPE_GRANULARITIES.includes(granularity)) {
    return `unknown scope granularity "${String(granularity)}"`;
  }
  if (!grantableGranularities(manifest).includes(granularity)) {
    return `plugin does not honour scope granularity "${granularity}" (declares: ${grantableGranularities(manifest).join(', ')})`;
  }
  return null;
}

module.exports = {
  VERSION,
  CAPABILITIES,
  HOST_MOUNT_PREFIX,
  CLI_RUNTIMES,
  PLATFORMS,
  SCOPE_GRANULARITIES,
  UI_ROLES,
  FETCH_SOURCES,
  validatePluginManifest,
  grantableGranularities,
  defaultGranularity,
  assertGranularityGrantable,
  isValidCapability,
};
