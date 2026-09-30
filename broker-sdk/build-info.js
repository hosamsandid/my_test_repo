'use strict';

// ─── Broker SDK: build identity (#2646) ──────────────────────────────────────
//
// Every reference broker image is built with the repo's git identity baked in
// as environment variables (see the `ARG`/`ENV` block at the end of each
// plugins/<id>/broker/Dockerfile, fed by `make plugin-images`):
//
//   AEE_BUILD_COMMIT       short commit hash ("unknown" without git metadata)
//   AEE_BUILD_DIRTY        "dirty" when the working tree had uncommitted changes
//   AEE_BUILD_COMMIT_TIME  the commit's committer date, strict ISO-8601 (%cI)
//
// Reading them from the PROCESS environment — not from the image store — is the
// point: the health route then reports what this running container was actually
// built from, even when a newer `:latest` image was built next to it (or a
// Kubernetes node still caches an old one). The shape and the "dirty" string
// mirror the console's own GIT_COMMIT / GIT_DIRTY / GIT_COMMIT_TIME (#483,
// #1741), so admin-console/src/components/version-info.js formats both alike.

const UNKNOWN = 'unknown';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// `{ commit, dirty, commitTime }` for the given environment. An image built
// before #2646 (or from a tarball) carries none of the variables and reports
// `commit: "unknown"` — never an empty string the UI could mistake for a value.
function buildInfoFromEnv(env = process.env) {
  const commit = clean(env.AEE_BUILD_COMMIT) || UNKNOWN;
  return {
    commit,
    dirty: commit !== UNKNOWN && clean(env.AEE_BUILD_DIRTY) === 'dirty' ? 'dirty' : '',
    commitTime: clean(env.AEE_BUILD_COMMIT_TIME),
  };
}

module.exports = { buildInfoFromEnv };
