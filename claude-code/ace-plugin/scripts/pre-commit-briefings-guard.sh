#!/usr/bin/env bash
# pre-commit-briefings-guard.sh
# Guardrail: Only brief.md, .index.json, and templates/*.md are allowed in artifacts/briefings/.
# Non-allowed files are automatically unstaged and the user is warned.
#
# Install: scripts/install-git-hooks.sh
# Or:      cp scripts/pre-commit-briefings-guard.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -euo pipefail

BRIEFINGS_PREFIX="artifacts/briefings/"

# Get staged added/copied/modified/renamed files under artifacts/briefings/
# (exclude deletions so that removing disallowed files is not blocked)
STAGED_FILES=$(git diff --cached --diff-filter=ACMR --name-only -- "$BRIEFINGS_PREFIX" 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

VIOLATIONS=()

while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Allow templates/*.md under artifacts/briefings/templates/
    case "$file" in
        artifacts/briefings/templates/*.md)
            continue
            ;;
    esac
    basename=$(basename "$file")
    case "$basename" in
        brief.md|.index.json)
            # Allowed file
            ;;
        *)
            VIOLATIONS+=("$file")
            ;;
    esac
done <<< "$STAGED_FILES"

if [ ${#VIOLATIONS[@]} -eq 0 ]; then
    exit 0
fi

# Unstage violations
for f in "${VIOLATIONS[@]}"; do
    git restore --staged -- "$f" >/dev/null 2>&1 || true
done

# Warn the user
echo ""
echo "=========================================================================="
echo "  BRIEFING GUARDRAIL: Non-allowed files removed from commit"
echo "=========================================================================="
echo ""
echo "  The following files were automatically UNSTAGED because only brief.md,"
echo "  .index.json, and templates/*.md are allowed in"
echo "  artifacts/briefings/:"
echo ""
for f in "${VIOLATIONS[@]}"; do
    echo "    - $f"
done
echo ""
echo "  WARNING: These files remain in your working directory as untracked/modified"
echo "  files. They are NOT committed and may be LOST on branch switches, git clean,"
echo "  or checkout operations. If you need them, move them to a different location."
echo ""
echo "=========================================================================="
echo ""

# Check if there are still staged files left to commit
REMAINING=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$REMAINING" ]; then
    echo "ERROR: No staged files remaining after removing violations. Commit aborted."
    echo "Stage your brief.md files and try again."
    exit 1
fi

exit 0
