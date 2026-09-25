# Supply-chain pins — how to bump a pinned SHA or digest

Three external building blocks of the build pipeline are pinned to an exact,
verified revision so an upstream change (or a compromised upstream) can never be
adopted silently on the next build (#2458):

| What | Where | Pinned to |
|---|---|---|
| GitHub Actions (`uses:`) | `.github/workflows/*.yml` | a full commit **SHA**, with the version as a trailing `# vX.Y.Z` comment |
| Docker base image | `agent-image/Dockerfile` (`FROM python:3.12-slim@sha256:…`) | a manifest-index **digest**, tag kept for readability |
| npm dependencies | every `package.json` | the lockfile / manifest range; **Dependabot** raises upgrade PRs |

Pinning is deliberately a floor, not a ceiling: **[Dependabot](../.github/dependabot.yml)**
opens review-ready PRs so these pins get bumped on a schedule instead of
calcifying into permanently stale (and eventually themselves-vulnerable)
dependencies. The steps below are for a manual, out-of-band bump when you can't
wait for the Dependabot PR.

## Bumping a GitHub Action pin

A `uses:` line looks like:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

To move it to a new version, resolve that version's **tag** to its commit SHA and
update both the SHA and the trailing comment together:

```bash
# Resolve a tag (annotated tags need the second deref):
gh api repos/actions/checkout/git/ref/tags/v4.4.1 --jq '.object.sha'   # -> object type
# if that returned an annotated-tag object, deref it:
gh api repos/actions/checkout/git/tags/<that-sha> --jq '.object.sha'   # -> the commit SHA
```

Pin to a SHA that belongs to the **major version the workflow already uses**
unless a major bump is intended and reviewed — a major bump can change behavior.
Keep the trailing `# vX.Y.Z` comment accurate; it is the only human-readable
record of what the SHA points at.

## Bumping the Docker base-image digest

The base image in `agent-image/Dockerfile` is pinned as
`FROM python:3.12-slim@sha256:…`. To adopt a new build of the same tag (e.g. a
Python patch or a security fix), resolve the tag's current **manifest-index
digest** (multi-arch — covers amd64 CI and arm64 dev machines) and replace it:

```bash
docker buildx imagetools inspect python:3.12-slim   # copy the top-level "Digest:"
# or, without buildx:
docker pull python:3.12-slim && docker inspect --format '{{index .RepoDigests 0}}' python:3.12-slim
```

Keep the `python:3.12-slim` tag in the `FROM` line for readability; only the
`@sha256:…` suffix changes. The toolchain variant images
(`toolchains/*/Dockerfile`) build `FROM ${AGENT_BASE_IMAGE}` (the locally-built
`as-agent:latest`), so they inherit this pin and need no separate digest of their
own.

## Bumping npm dependencies

Merge the Dependabot PR (preferred — it carries the changelog and CI result), or
bump manually in the relevant directory and commit the updated `package.json` /
lockfile. CI runs `npm install --no-audit` for speed, so Dependabot — not
`npm audit` in CI — is what surfaces known vulnerabilities; keep the
`.github/dependabot.yml` entry list in sync when you add or remove a
`package.json`.
