'use strict';

// Custom slash-command provisioning (#1796, foundation for #1797/#1798).
//
// Agent Studio agents run on Claude Code, which loads reusable **slash commands**
// from `.claude/commands/*.md` (a human invokes one by typing `/name`). This
// module is the pure core that lets those commands be carried by the EXISTING
// team-scoped skill grant: a granted skill directory may ship a `commands/`
// subdirectory of `*.md` command definitions, and wherever that skill is seeded
// or (de)activated (skill-source.js / the additive skill sync), its commands are
// projected into / out of the agent workspace's `.claude/commands/` tree.
//
// There is deliberately NO new grant type and NO per-agent ad-hoc authoring — a
// command reaches an agent only by granting a skill that carries it, so the whole
// additive-file-sync + team-scoping machinery (and #1798 spec-kit-as-a-bundle)
// is reused unchanged.
//
// Namespacing: each skill's commands are projected under a per-skill subdirectory
// `.claude/commands/<namespace>/<name>.md`, so Claude Code exposes them as
// `/<namespace>:<name>`. Namespacing per skill means two skills (or a built-in
// Claude Code command) can never collide (issue edge case).
//
// Pure apart from the injected fs readers (mirrors skill-source.js), so it is
// unit-testable without booting the orchestrator or touching a real workspace.

const fs = require('fs');
const path = require('path');
const { parseSkillDescription } = require('./skill-source');

// The `commands/` subdir inside a skill's source directory.
const COMMANDS_SUBDIR = 'commands';
// The Claude Code command root inside an agent workspace (relative to the agent
// dir). This is also the reseed path prefix mirrored into an isolated volume.
const AGENT_COMMANDS_DIR = path.join('.claude', 'commands');
// The per-agent provisioning manifest (name + description per command) that a
// downstream reader (#1797 composer autocomplete) consumes. Lives beside
// seeded-skills.json under the migrating state dir.
const SEEDED_COMMANDS_FILE = 'seeded-commands.json';

// A command definition is a top-level `*.md` in the skill's `commands/` dir.
// Dotfiles and nested dirs are ignored (one level only for the foundation).
function isCommandFile(name) {
  return typeof name === 'string' && /\.md$/i.test(name) && !name.startsWith('.');
}

// A safe lower-case slug used for both the command name (file stem) and the
// namespace (skill name). Collapses anything outside [a-z0-9_-] to a single '-'
// and trims. Returns null when nothing survives (caller skips it).
function slugify(raw) {
  const slug = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// The command name (Claude Code sub-name) derived from a file name (stem).
function commandNameFromFile(fileName) {
  return slugify(String(fileName).replace(/\.md$/i, ''));
}

// The namespace for a skill's commands: the skill name slugified. A skill name
// that slugifies to nothing (all punctuation) falls back to a stable literal.
function commandNamespace(skillName) {
  return slugify(skillName) || 'skill';
}

// How a human invokes the command in chat.
function commandInvocation(namespace, cmdName) {
  return `/${namespace}:${cmdName}`;
}

// Enumerate the commands a skill source directory ships. Returns [] when the
// skill has no `commands/` subdir (the common case — fail-soft). Each record
// carries everything the projector and the manifest need. Deterministic order.
function readSkillCommands(skillDir, skillName, {
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const dir = path.join(skillDir, COMMANDS_SUBDIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no commands/ subdir, or unreadable — nothing to project
  }
  const namespace = commandNamespace(skillName);
  const out = [];
  const seen = new Set();
  for (const ent of entries) {
    // Tolerate both Dirent objects (real fs) and bare strings (test doubles).
    const fname = typeof ent === 'string' ? ent : ent.name;
    const isFile = ent && typeof ent.isFile === 'function' ? ent.isFile() : true;
    if (!isFile || !isCommandFile(fname)) continue;
    const name = commandNameFromFile(fname);
    if (!name || seen.has(name)) continue; // skip empty/duplicate slugs
    seen.add(name);
    let content = '';
    try { content = readFileSync(path.join(dir, fname), 'utf8'); } catch { content = ''; }
    out.push({
      skill: skillName,
      namespace,
      name,
      command: `${namespace}:${name}`,
      invocation: commandInvocation(namespace, name),
      sourceFile: fname,
      // Path of the projected file relative to the agent workspace root.
      targetPath: path.join(AGENT_COMMANDS_DIR, namespace, `${name}.md`),
      description: parseSkillDescription(content),
      content,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Build the seeded-commands.json manifest fragment for one skill's records.
// Shape (keyed by `<namespace>:<name>`):
//   { skill, name, namespace, invocation, description, file, seededAt }
// `description` is null when the command file has none (name-only is valid).
function manifestEntriesFor(records, seededAt) {
  const m = {};
  for (const r of records) {
    m[r.command] = {
      skill: r.skill,
      name: r.name,
      namespace: r.namespace,
      invocation: r.invocation,
      description: r.description || null,
      file: r.targetPath,
      seededAt,
    };
  }
  return m;
}

// Drop every manifest entry contributed by a skill (used on deactivation).
function manifestWithoutSkill(manifest, skillName) {
  const out = {};
  for (const [k, v] of Object.entries(manifest || {})) {
    if (v && v.skill === skillName) continue;
    out[k] = v;
  }
  return out;
}

// Flatten the manifest into the array the provisioning-output endpoint returns
// for #1797 (name + description per command). Deterministic order.
function commandsListFromManifest(manifest) {
  return Object.entries(manifest || {})
    .map(([command, v]) => ({
      command,
      name: (v && v.name) || command,
      namespace: (v && v.namespace) || null,
      skill: (v && v.skill) || null,
      invocation: (v && v.invocation) || `/${command}`,
      description: (v && v.description) || null,
    }))
    .sort((a, b) => a.command.localeCompare(b.command));
}

// The command name (invocation sub-name) derived from a provisioned file name.
// Unlike `commandNameFromFile` (used when projecting a skill's source file, where
// slugification guarantees a safe on-disk name), a file that already lives in the
// agent workspace was named by the projector OR dropped in by hand — Claude Code
// invokes it by its literal stem, so we preserve it verbatim (minus `.md`).
function provisionedCommandName(fileName) {
  return String(fileName).replace(/\.md$/i, '');
}

// Enumerate the slash commands ACTUALLY provisioned in an agent workspace by
// walking its `.claude/commands/` tree — the workspace is the source of truth for
// #1797, so a command dropped in by hand (never in the seed manifest) surfaces
// too. Layout mirrors the projector: top-level `*.md` are un-namespaced
// (`/<name>`); each first-level subdirectory is a namespace (`/<namespace>:<name>`).
// `manifest` (optional, from seeded-commands.json) only enriches the seeded rows
// with their originating `skill`; a hand-added command has `skill: null`. Pure
// apart from the injected fs readers (mirrors `readSkillCommands`); returns []
// when the commands dir is absent/unreadable (the common no-commands case).
function scanProvisionedCommands(commandsRootDir, {
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
  manifest = {},
} = {}) {
  const readMd = (absPath) => {
    try { return readFileSync(absPath, 'utf8'); } catch { return ''; }
  };
  const listDir = (dir) => {
    try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  };
  const isFileEnt = (ent) => (ent && typeof ent.isFile === 'function' ? ent.isFile() : true);
  const isDirEnt = (ent) => (ent && typeof ent.isDirectory === 'function' ? ent.isDirectory() : false);
  const entName = (ent) => (typeof ent === 'string' ? ent : ent.name);

  const rootEntries = listDir(commandsRootDir);
  if (!rootEntries) return [];

  const out = [];
  const push = (namespace, fname, absPath) => {
    if (!isCommandFile(fname)) return;
    const name = provisionedCommandName(fname);
    if (!name) return;
    const command = namespace ? `${namespace}:${name}` : name;
    const known = manifest && manifest[command];
    out.push({
      command,
      name,
      namespace: namespace || null,
      skill: (known && known.skill) || null,
      invocation: namespace ? commandInvocation(namespace, name) : `/${name}`,
      description: parseSkillDescription(readMd(absPath)),
    });
  };

  const seen = new Set();
  for (const ent of rootEntries) {
    const fname = entName(ent);
    if (!fname || fname.startsWith('.')) continue;
    if (isDirEnt(ent)) {
      const namespace = fname; // literal dir name is the namespace Claude Code uses
      const sub = listDir(path.join(commandsRootDir, fname));
      if (!sub) continue;
      for (const sEnt of sub) {
        const sName = entName(sEnt);
        if (!isFileEnt(sEnt) || !sName) continue;
        const key = `${namespace}:${provisionedCommandName(sName)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        push(namespace, sName, path.join(commandsRootDir, fname, sName));
      }
    } else if (isFileEnt(ent)) {
      const key = provisionedCommandName(fname);
      if (seen.has(key)) continue;
      seen.add(key);
      push(null, fname, path.join(commandsRootDir, fname));
    }
  }
  out.sort((a, b) => a.command.localeCompare(b.command));
  return out;
}

// The set of leading `/<token>` command tokens the runtime should treat as
// "known" (so a chat message is passed to Claude Code verbatim to expand). Built
// from a seeded-commands manifest. Tokens carry NO leading slash. Mirrors the
// Python `_discover_slash_commands` in agent-entrypoint.py — kept here so the
// naming/namespacing is single-sourced and node:test-covered.
function knownCommandTokens(manifest) {
  return new Set(Object.keys(manifest || {}));
}

module.exports = {
  COMMANDS_SUBDIR,
  AGENT_COMMANDS_DIR,
  SEEDED_COMMANDS_FILE,
  isCommandFile,
  slugify,
  commandNameFromFile,
  provisionedCommandName,
  commandNamespace,
  commandInvocation,
  readSkillCommands,
  scanProvisionedCommands,
  manifestEntriesFor,
  manifestWithoutSkill,
  commandsListFromManifest,
  knownCommandTokens,
};
