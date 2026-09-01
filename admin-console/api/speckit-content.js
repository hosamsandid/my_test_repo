'use strict';

// Pure spec-kit content resolution (#1865).
//
// The spec-kit plugin (#1798) is a command-only plugin whose fetch-at-install
// pulls the raw upstream command templates from `github/spec-kit`. Those raw
// templates are NOT runnable on their own: `specify init` normally resolves a
// set of placeholders and lays down a `.specify/` scaffold. We replicate that
// resolution here so the plugin can seed a self-contained project WITHOUT ever
// running the `specify` CLI.
//
// This is a faithful, dependency-free port of the load-bearing parts of
// github/spec-kit `src/specify_cli/agents.py` (`CommandRegistrar`) for the
// **claude + sh** combination:
//   • frontmatter `scripts.sh` resolves `{SCRIPT}` in the body;
//   • `{ARGS}` → `$ARGUMENTS`, `__AGENT__` → the agent name;
//   • repo-relative `scripts/` `templates/` `memory/` references are rewritten
//     to their generated-project `.specify/...` locations.
//
// Kept pure (no fs, no network) so it is unit-testable and reusable by the
// install-time fetch path in api.js.

// Port of CommandRegistrar.rewrite_project_relative_paths (no extension id, the
// only case a first-party plugin needs). Rewrites the top-level repo layout to
// the `.specify/` layout a generated project uses. The regex boundaries mirror
// the Python source verbatim: only a reference at string start or preceded by
// whitespace / a quote / backtick / '(' is rewritten, so prose like
// "descriptors/" is never touched.
function rewriteProjectPaths(text) {
  if (typeof text !== 'string' || !text) return text;

  let out = text
    .split('../../memory/').join('.specify/memory/')
    .split('../../scripts/').join('.specify/scripts/')
    .split('../../templates/').join('.specify/templates/');

  // (^|[\s`"'(])(?:\.?/)?<dir>/  →  \1.specify/<dir>/
  out = out.replace(/(^|[\s`"'(])(?:\.?\/)?memory\//g, '$1.specify/memory/');
  out = out.replace(/(^|[\s`"'(])(?:\.?\/)?scripts\//g, '$1.specify/scripts/');
  out = out.replace(/(^|[\s`"'(])(?:\.?\/)?templates\//g, '$1.specify/templates/');

  // Collapse any accidental doubling (mirrors the Python guard).
  return out.split('.specify/.specify/').join('.specify/').split('.specify.specify/').join('.specify/');
}

// Split a Markdown document into its YAML frontmatter block (raw text, without
// the `---` fences) and the body. Returns { frontmatter: '', body: md } when the
// document has no frontmatter.
function splitFrontmatter(md) {
  if (typeof md !== 'string') return { frontmatter: '', body: '' };
  const lines = md.split('\n');
  if (lines[0] !== '---') return { frontmatter: '', body: md };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { frontmatter: '', body: md };
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

// Extract the `scripts:` mapping from a frontmatter block, e.g.
//   scripts:
//     sh: scripts/bash/setup-plan.sh --json
//     ps: scripts/powershell/setup-plan.ps1 -Json
// Returns a { sh, ps, py, ... } object (empty when there is no scripts block).
// Deliberately a minimal indent-scanner rather than a YAML dependency: the
// upstream block is always a flat one-level map of string values.
function parseScriptsBlock(frontmatter) {
  const scripts = {};
  if (typeof frontmatter !== 'string' || !frontmatter) return scripts;
  const lines = frontmatter.split('\n');
  let inScripts = false;
  let baseIndent = null;
  for (const line of lines) {
    if (!inScripts) {
      if (/^scripts:\s*$/.test(line)) { inScripts = true; }
      continue;
    }
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^(\s+)/);
    if (!indentMatch) break; // dedented back to a top-level key — scripts block ended
    const indent = indentMatch[1].length;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;
    const kv = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) scripts[kv[1]] = kv[2].trim();
  }
  return scripts;
}

// Resolve one raw spec-kit command template into the runnable form a generated
// `specify init --ai claude --script sh` project would contain. The original
// frontmatter is preserved verbatim (its `description` feeds our seeded-commands
// manifest, and claude ignores the spec-kit-specific keys); only the body is
// transformed. Port of the body handling in agents.py (lines ~505-524).
function resolveSpecKitCommand(rawMd, { scriptVariant = 'sh', agentName = 'claude' } = {}) {
  if (typeof rawMd !== 'string' || !rawMd) return rawMd;
  const { frontmatter, body: rawBody } = splitFrontmatter(rawMd);
  let body = rawBody;

  const scripts = parseScriptsBlock(frontmatter);
  let scriptCommand = scripts[scriptVariant];
  if (scriptCommand) {
    scriptCommand = scriptCommand.split('{ARGS}').join('$ARGUMENTS');
    body = body.split('{SCRIPT}').join(scriptCommand);
  }
  body = body.split('{ARGS}').join('$ARGUMENTS').split('__AGENT__').join(agentName);
  body = rewriteProjectPaths(body);

  // Reassemble with the original frontmatter fence, byte-preserving when there
  // was no frontmatter.
  if (!frontmatter) return body;
  return `---\n${frontmatter}\n---\n${body}`;
}

module.exports = {
  rewriteProjectPaths,
  splitFrontmatter,
  parseScriptsBlock,
  resolveSpecKitCommand,
};
