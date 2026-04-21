#!/usr/bin/env bash
# install-git-hooks.sh
# Installs project git hooks by symlinking from .git/hooks/ to scripts/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"

install_hook() {
    local hook_name="$1"
    local source="$SCRIPT_DIR/${hook_name}-briefings-guard.sh"
    local target="$HOOKS_DIR/$hook_name"

    if [ ! -f "$source" ]; then
        echo "SKIP: $source not found"
        return
    fi

    if [ -f "$target" ] && [ ! -L "$target" ]; then
        echo "WARN: $target already exists and is not a symlink."
        echo "      Backing up to ${target}.backup"
        cp "$target" "${target}.backup"
    fi

    ln -sf "$source" "$target"
    chmod +x "$source"
    echo "OK:   $hook_name -> $(basename "$source")"
}

echo "Installing git hooks..."
echo ""
install_hook "pre-commit"
echo ""
echo "Done."
