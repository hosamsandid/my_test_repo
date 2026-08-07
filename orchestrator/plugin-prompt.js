'use strict';

// ─── plugin capabilities prompt block (plugin system Phase 2, #1518) ─────────
//
// The generic "Plugin Capabilities" section injected into a granted agent's
// CLAUDE.md (docs/plugin-system-concept.md §4.7). Built from the RESOLVED grant
// — never from an environment or from the plugin config file's contents — one
// `promptLine` per granted plugin, so a grant flip that rebuilds CLAUDE.md via
// the existing prompt-rebuild path adds or drops exactly the lines that changed.
//
// Pure/fs-free, the prompt-assembly.js discipline: the caller resolves the grant
// (plugin-grants.js) and reads each granted plugin's manifest, then passes the
// display data in as `[{ id, name?, cliName?, promptLine?, scopeGranularity? }]`.
// A plugin with no authored `promptLine` still gets a generic, honest line
// naming its CLI (fail-soft). Returns null when the grant is empty (AC: the
// section is absent entirely, not an empty heading).

const HEADING = 'Plugin Capabilities';

const INTRO =
  'You have access to the outside world through the platform plugins granted below. ' +
  'Each is a dependency-free CLI on your PATH backed by a governed broker sidecar — ' +
  'run `<cli> --help` for its contract (every subcommand takes `--json`; exit codes ' +
  '0 ok / 1 domain error / 2 usage / 3 broker unreachable). All authorisation is ' +
  'server-side against your scope token; you never handle a backend credential.';

// One agent-readable line for a single granted plugin. Prefers the manifest's
// authored `promptLine`; otherwise a generic line naming the CLI.
function pluginPromptLine(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
  const cli = typeof p.cliName === 'string' && p.cliName.trim() ? p.cliName.trim() : null;
  const authored = typeof p.promptLine === 'string' ? p.promptLine.replace(/\s+/g, ' ').trim() : '';
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id;
  const body = authored
    ? authored
    : (cli ? `You can use the **${name}** plugin via \`${cli}\` — run \`${cli} --help\`.` : `You can use the **${name}** plugin.`);
  return `- ${body}`;
}

// Compose the Plugin Capabilities section from the resolved grant's display
// data. Returns null when nothing is granted (the caller drops the section).
function pluginCapabilitiesSection(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  const items = list.map(pluginPromptLine).filter(Boolean);
  if (!items.length) return null;
  return `## ${HEADING}\n\n${INTRO}\n\n${items.join('\n')}`;
}

module.exports = {
  HEADING,
  INTRO,
  pluginPromptLine,
  pluginCapabilitiesSection,
};
