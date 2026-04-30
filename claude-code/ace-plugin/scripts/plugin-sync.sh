#!/usr/bin/env bash
# plugin-sync.sh — Fast file sync for ACE plugin updates
# Copies plugin-owned scripts/templates to the target project.
# Usage: bash scripts/plugin-sync.sh [--target <project-dir>] [--init]
#
# If --target is not specified, auto-detects the project that installed this plugin.
# --init also seeds mentorscripts/team.md (skipped if already present).
# Exit codes: 0 = success, 1 = error

set -euo pipefail

# Resolve plugin root (this script lives at <plugin-root>/scripts/plugin-sync.sh)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Parse arguments
TARGET_DIR=""
INIT=false  # true during --init, false otherwise (update-only, skip mentorscripts/CLAUDE.md)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  TARGET_DIR="$2"; shift 2 ;;
    --init)    INIT=true; shift ;;
    *)         echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Auto-detect target: if this plugin is installed in a project, the project root
# is typically the current working directory.
if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$(pwd)"
fi

# Ensure target exists
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: Target directory does not exist: $TARGET_DIR" >&2
  exit 1
fi

COPIED=()
SKIPPED=()
CREATED_DIRS=()

# Helper: copy a file, report action
copy_file() {
  local src="$1"
  local dst="$2"
  local always_overwrite="${3:-true}"

  # Ensure parent directory exists
  local dst_dir
  dst_dir="$(dirname "$dst")"
  if [[ ! -d "$dst_dir" ]]; then
    mkdir -p "$dst_dir"
    CREATED_DIRS+=("${dst_dir#"$TARGET_DIR"/}")
  fi

  if [[ "$always_overwrite" == "false" && -f "$dst" ]]; then
    SKIPPED+=("${dst#"$TARGET_DIR"/}")
    return
  fi

  cp "$src" "$dst"
  COPIED+=("${dst#"$TARGET_DIR"/}")
}

echo "ACE Plugin Sync"
echo "==============="
echo "Plugin:  $PLUGIN_ROOT"
echo "Target:  $TARGET_DIR"
echo ""

# --- Directory structure (always ensure these exist) ---
for dir in \
  artifacts/briefings/.archive \
  artifacts/blueprints \
  artifacts/guidance/crp \
  artifacts/guidance/mrp \
  artifacts/guidance/vcr \
  artifacts/log \
  mentorscripts \
  scripts \
  scripts/bp-explorer; do
  if [[ ! -d "$TARGET_DIR/$dir" ]]; then
    mkdir -p "$TARGET_DIR/$dir"
    CREATED_DIRS+=("$dir")
  fi
done

# --- Plugin-owned scripts (ALWAYS overwrite entire scripts/ tree) ---
while IFS= read -r -d '' src_file; do
  rel_path="${src_file#"$PLUGIN_ROOT"/}"
  copy_file "$src_file" "$TARGET_DIR/$rel_path" true
done < <(find "$PLUGIN_ROOT/scripts" -type f \
  -not -path '*/.venv/*' \
  -not -path '*/.pytest_cache/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.mypy_cache/*' \
  -not -name '*.pyc' \
  -not -name '.DS_Store' \
  -print0 | sort -z)

# --- LoopScripts: NO LONGER COPIED ---
# Standard LoopScripts (standard.yaml, high-rigor.yaml) are resolved directly
# from the plugin install path at runtime via sase_lib._detect_plugin_root().
# Projects can still place custom LoopScripts in skills/engineering/loops/ to override.

# --- MentorScripts: global.md is always ensured (framework baseline) ---
if [[ -f "$PLUGIN_ROOT/mentorscripts/global.md" && ! -f "$TARGET_DIR/mentorscripts/global.md" ]]; then
  copy_file "$PLUGIN_ROOT/mentorscripts/global.md" "$TARGET_DIR/mentorscripts/global.md" false
fi

# --- Init-only files (only during --init, skip if exists) ---
if [[ "$INIT" == "true" ]]; then
  # MentorScripts (global.md already handled above)
  if [[ -f "$PLUGIN_ROOT/mentorscripts/team.md" ]]; then
    copy_file "$PLUGIN_ROOT/mentorscripts/team.md" "$TARGET_DIR/mentorscripts/team.md" false
  fi
fi

# --- Report ---
echo "Results:"

if [[ ${#CREATED_DIRS[@]} -gt 0 ]]; then
  echo ""
  echo "  Created directories:"
  for d in "${CREATED_DIRS[@]}"; do
    echo "    + $d"
  done
fi

if [[ ${#COPIED[@]} -gt 0 ]]; then
  echo ""
  echo "  Copied/updated files:"
  for f in "${COPIED[@]}"; do
    echo "    → $f"
  done
fi

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo ""
  echo "  Skipped (already exist):"
  for f in "${SKIPPED[@]}"; do
    echo "    - $f"
  done
fi

echo ""
echo "Done. ${#COPIED[@]} files synced, ${#SKIPPED[@]} skipped."
