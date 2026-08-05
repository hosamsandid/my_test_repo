# git-remote image for the KIND e2e stack (#1319). The compose e2e stack runs
# this service as a plain python:3.12-slim with ./srv bind-mounted; a kind
# cluster has no host bind-mounts, so the fixture content is BAKED into the
# image instead — kind-up.sh --e2e runs e2e/scripts/seed-fixture-repo.sh first,
# then builds this. No kubectl-cp race, survives pod restarts, and a re-run of
# kind-up re-seeds + rebuilds. Serves the same anonymous read-only dumb-HTTP
# git transport as the compose service (docs/e2e-testing-concept.md §2 v1.1).
FROM python:3.12-slim
COPY srv /srv
EXPOSE 80
CMD ["python", "-m", "http.server", "80", "--directory", "/srv"]
