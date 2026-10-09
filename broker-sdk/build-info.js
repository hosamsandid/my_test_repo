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
//   AEE_BUILD_TAG          nearest release tag, e.g. "v0.4.0" (#2893; empty
//                          when no release tag was reachable at build time)
//   AEE_BUILD_TAG_DISTANCE commits between that tag and the build commit
//                          ("0" = the build sits exactly on the tag)
//
// Reading them from the PROCESS environment — not from the image store — is the
// point: the health route then reports what this running container was actually
// built from, even when a newer `:latest` image was built next to it (or a
// Kubernetes node still caches an old one). The shape and the "dirty" string
// mirror the console's own GIT_COMMIT / GIT_DIRTY / GIT_COMMIT_TIME (#483,
// #1741), so admin-console/src/components/version-info.js formats both alike.

const UNKNOWN = 'unknown';
// Release tags only (scripts/git-release-tag.sh applies the same rule).
const RELEASE_TAG_RE = /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const TAG_DISTANCE_RE = /^\d{1,9}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// `{ commit, dirty, commitTime }` for the given environment, plus
// `{ tag, tagDistance }` (#2893) when the image recorded a release tag. An image
// built before #2646 (or from a tarball) carries none of the variables and
// reports `commit: "unknown"` — never an empty string the UI could mistake for a
// value. Without a usable tag + distance (no tag reachable at build time, an
// image built before #2893) the two keys are simply absent and the console
// falls back to the hash.
function buildInfoFromEnv(env = process.env) {
  const commit = clean(env.AEE_BUILD_COMMIT) || UNKNOWN;
  const info = {
    commit,
    dirty: commit !== UNKNOWN && clean(env.AEE_BUILD_DIRTY) === 'dirty' ? 'dirty' : '',
    commitTime: clean(env.AEE_BUILD_COMMIT_TIME),
  };
  const tag = clean(env.AEE_BUILD_TAG);
  const distance = clean(env.AEE_BUILD_TAG_DISTANCE);
  if (commit !== UNKNOWN && RELEASE_TAG_RE.test(tag) && TAG_DISTANCE_RE.test(distance)) {
    info.tag = tag;
    info.tagDistance = Number(distance);
  }
  return info;
}

module.exports = { buildInfoFromEnv };
