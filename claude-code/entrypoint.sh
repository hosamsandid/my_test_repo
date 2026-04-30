#!/bin/sh
set -e

# --- Restore Claude auth if needed ---
if [ ! -f /root/.claude.json ] && [ -d /root/.claude/backups ]; then
  latest=$(ls -t /root/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
  [ -n "$latest" ] && cp "$latest" /root/.claude.json
fi

# --- Initialize workspace if needed ---
if [ ! -f /workspace/CLAUDE.md ]; then
  cp /defaults/CLAUDE.md /workspace/CLAUDE.md
  mkdir -p /workspace/memory /workspace/skills
fi

# --- Enable ACE plugin in workspace project settings ---
if [ ! -f /workspace/.claude/settings.json ]; then
  mkdir -p /workspace/.claude
  printf '{\n  "enabledPlugins": {\n    "ace@i-sase-marketplace": true\n  }\n}\n' > /workspace/.claude/settings.json
  echo "[entrypoint] Created /workspace/.claude/settings.json with ACE enabled."
fi

# --- Install ACE plugin into the auth volume if not already present ---
ACE_PLUGIN_DIR="/root/.claude/plugins/cache/i-sase-marketplace/ace/1.38.1"
if [ ! -d "$ACE_PLUGIN_DIR" ]; then
  echo "[entrypoint] Installing ACE plugin v1.38.1..."
  mkdir -p "$(dirname "$ACE_PLUGIN_DIR")"
  cp -r /defaults/ace-plugin/. "$ACE_PLUGIN_DIR/"
  echo "[entrypoint] ACE plugin files installed."
else
  echo "[entrypoint] ACE plugin already present."
fi

# --- Register ACE in installed_plugins.json ---
mkdir -p /root/.claude/plugins
node - << 'NODEJS'
const fs = require('fs');
const path = '/root/.claude/plugins/installed_plugins.json';
const key = 'ace@i-sase-marketplace';
const entry = {
  scope: "user",
  installPath: "/root/.claude/plugins/cache/i-sase-marketplace/ace/1.38.1",
  version: "1.38.1",
  installedAt: "2026-04-30T00:00:00.000Z",
  lastUpdated: "2026-04-30T00:00:00.000Z",
  gitCommitSha: "d8ec76abac5f4d2091bd1eab2ae380f810e67354"
};
let data = { version: 2, plugins: {} };
if (fs.existsSync(path)) {
  try { data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) { data = { version: 2, plugins: {} }; }
}
if (!data.plugins) data.plugins = {};
if (!data.plugins[key]) {
  data.plugins[key] = [entry];
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('[entrypoint] ACE registered in installed_plugins.json');
} else {
  console.log('[entrypoint] ACE already registered in installed_plugins.json');
}
NODEJS

# --- Enable ACE in /root/.claude/settings.json ---
node - << 'NODEJS'
const fs = require('fs');
const path = '/root/.claude/settings.json';
const key = 'ace@i-sase-marketplace';
let data = {};
if (fs.existsSync(path)) {
  try { data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) { data = {}; }
}
if (!data.enabledPlugins) data.enabledPlugins = {};
if (!data.enabledPlugins[key]) {
  data.enabledPlugins[key] = true;
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('[entrypoint] ACE enabled in settings.json');
} else {
  console.log('[entrypoint] ACE already enabled in settings.json');
}
NODEJS

exec "$@"
