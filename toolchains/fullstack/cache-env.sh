# Redirect this stack's OWN caches into the agent workspace, sourced by
# `aee-toolchain` once $AEE_TOOLCHAIN_ROOT is resolved (#1941 AC8).
#
# Without this, only the language runtimes (JDK, Node) survive a respawn: the
# package managers' caches default into the container filesystem, which every
# respawn throws away — so an agent would re-download its whole dependency tree
# on each restart while the runtimes sat warm in the workspace. Everything below
# points a cache at <workspace>/.aee-toolchain, a volume that outlives the
# container and is per-agent, so two projects never share a cache.

# ── Maven ───────────────────────────────────────────────────────────────────
# `MAVEN_ARGS` is read by the `mvn` launcher itself (Maven 3.9+), so it also
# applies to a repository's own ./mvnw wrapper run through `aee-toolchain run`.
# A settings.xml placed at <root>/m2/settings.xml is picked up automatically —
# that is the documented drop point for an internal Nexus / mirror in a
# locked-down network (docs/agent-toolchains.md §"Locked-down networks").
_m2="$AEE_TOOLCHAIN_ROOT/m2"
mkdir -p "$_m2" 2>/dev/null || true
MAVEN_ARGS="-Dmaven.repo.local=$_m2/repository${MAVEN_ARGS:+ $MAVEN_ARGS}"
if [ -f "$_m2/settings.xml" ]; then
  MAVEN_ARGS="-s $_m2/settings.xml $MAVEN_ARGS"
fi
export MAVEN_ARGS

# ── Gradle ──────────────────────────────────────────────────────────────────
GRADLE_USER_HOME="$AEE_TOOLCHAIN_ROOT/gradle"
export GRADLE_USER_HOME

# ── Node / npm / corepack ───────────────────────────────────────────────────
# npm's download cache (~/.npm) and corepack's package-manager cache both live
# in the container home by default; redirect them so `npm ci` on the second run
# is served from the workspace instead of re-fetching every tarball. Read via
# the `npm_config_<key>` env convention, so this reaches ./`npm` scripts too.
npm_config_cache="$AEE_TOOLCHAIN_ROOT/npm-cache"
COREPACK_HOME="$AEE_TOOLCHAIN_ROOT/corepack"
mkdir -p "$npm_config_cache" "$COREPACK_HOME" 2>/dev/null || true
export npm_config_cache COREPACK_HOME

unset _m2
