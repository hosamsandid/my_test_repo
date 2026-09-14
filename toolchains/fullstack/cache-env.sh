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

# #2282 Band 1 -- belt and braces on top of the container memory limit
# (toolchains/fullstack/toolchain.json `resources.memoryLimit`): the JVM does
# not size its heap against what else lives in the cgroup unless told to.
# `MaxRAMPercentage` reads the cgroup limit (container-aware since JDK 10).
# `JAVA_TOOL_OPTIONS` reaches every JVM this shell (and anything it forks,
# including a Gradle daemon/worker) starts, so it is the one flag that also
# bounds Gradle's worker JVMs, which `org.gradle.jvmargs` below does not reach.
# A lower percentage than the plain jvm toolchain's, on purpose: a Gradle
# build here can have the daemon, one or more workers and a Maven run's own
# JVM co-resident in the same cgroup.
MAVEN_OPTS="-XX:MaxRAMPercentage=50.0${MAVEN_OPTS:+ $MAVEN_OPTS}"
JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=50.0${JAVA_TOOL_OPTIONS:+ $JAVA_TOOL_OPTIONS}"
export MAVEN_OPTS JAVA_TOOL_OPTIONS

# ── Gradle ──────────────────────────────────────────────────────────────────
GRADLE_USER_HOME="$AEE_TOOLCHAIN_ROOT/gradle"
export GRADLE_USER_HOME
mkdir -p "$GRADLE_USER_HOME" 2>/dev/null || true
# Global (user-level) Gradle properties — NOT the project's own gradle.properties,
# so a repository's own build config is never touched. Bounds the daemon heap
# (JAVA_TOOL_OPTIONS above bounds worker JVMs, which this key does not reach)
# and caps concurrent workers so they cannot multiply past what the cgroup
# limit allows. Written once — an agent that hand-edited this file to tune it
# keeps that choice across a respawn.
if [ ! -f "$GRADLE_USER_HOME/gradle.properties" ]; then
  cat > "$GRADLE_USER_HOME/gradle.properties" <<'EOF'
org.gradle.jvmargs=-XX:MaxRAMPercentage=50.0
org.gradle.workers.max=2
EOF
fi

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
