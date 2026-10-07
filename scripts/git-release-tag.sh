#!/bin/sh
# Nearest release tag of a commit, for the plugin build identity (#2893).
#
#   scripts/git-release-tag.sh [rev]     (rev defaults to HEAD)
#
# Prints "<tag> <distance>" — e.g. "v0.4.0 12", or "v0.4.0 0" when <rev> is
# exactly the tag — and prints NOTHING when no release tag is reachable (no
# tags, a shallow clone / checkout without fetched tags, a tarball without
# .git). It always exits 0, so a build never fails over a missing tag; the
# Plugins page then falls back to the short commit hash.
#
# Rules:
#   - only release tags count: v<major>.<minor>.<patch> (e.g. v0.4.0). Any other
#     tag (v1-test, jira/v1.2.0, nightly) is ignored, so a random tag never
#     becomes the "version";
#   - "nearest" = fewest commits between the tag and <rev>
#     (git rev-list --count <tag>..<rev>, the distance `git describe` reports);
#   - several release tags at the same distance (e.g. two tags on one commit):
#     the highest version wins (git's own version sort, deterministic).
rev=${1:-HEAD}
best_tag=
best_dist=
# Highest version first, so a tie keeps the highest one (strict `-lt` below).
for t in $(git tag --merged "$rev" --list 'v*' --sort=-v:refname 2>/dev/null \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
  d=$(git rev-list --count "$t..$rev" 2>/dev/null) || continue
  case "$d" in ''|*[!0-9]*) continue ;; esac
  if [ -z "$best_dist" ] || [ "$d" -lt "$best_dist" ]; then
    best_tag=$t
    best_dist=$d
  fi
done
if [ -n "$best_tag" ]; then
  printf '%s %s\n' "$best_tag" "$best_dist"
fi
exit 0
