# Redirect this stack's OWN caches into the agent workspace, sourced by
# `aee-toolchain` once $AEE_TOOLCHAIN_ROOT is resolved (#1941 AC8).
#
# Without this, only the JDK survives a respawn: Maven's local repository
# defaults to ~/.m2 inside the container filesystem, which every respawn throws
# away — so an agent would re-download its whole dependency tree on each
# restart while the JDK sat warm in the workspace. `MAVEN_ARGS` is read by the
# `mvn` launcher itself (Maven 3.9+), so it also applies to a repository's own
# ./mvnw wrapper run through `aee-toolchain run`.
#
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

GRADLE_USER_HOME="$AEE_TOOLCHAIN_ROOT/gradle"
export GRADLE_USER_HOME
unset _m2
