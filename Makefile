#
# agent-studio stack — Conduwuit + Orchestrator + Admin Console
#
# Run `make help` for the one-line target list. Full reference:
#
# ── Stack lifecycle ─────────────────────────────────────────────────────────
#   make up        # build the agent image + build + start the full stack
#   make down      # stop the stack
#   make restart   # down + up
#   make update    # git pull --ff-only, then down + up (restart with rebuild)
#   make ps        # show container status
#   make logs      # follow logs of all stack containers
#
# ── Image builds ────────────────────────────────────────────────────────────
#   make build         # rebuild orchestrator + admin-console + stt images
#                      # (also builds plugin-images as a dependency)
#   make agent-image   # build the per-agent container image (as-agent:latest);
#                      # retries a few times on a transient registry pull failure
#   make plugin-images # build the plugin broker sidecar images (#1547).
#                      # Included in `make build`, but NOT in `make up` — these
#                      # are heavy images and a stack with no plugins installed
#                      # never needs them. Run it before installing a plugin on
#                      # the Plugins page, or the broker has no image to start.
#
# ── Seeding the skill-pool volume (<project>_claude-workspace) ───────────────
#   make seed-pool             # run every seed below + seed the pool CLAUDE.md
#   make seed-skills           # seed the ACE engineering skill (host-side i-sase
#                              # plugin install); skipped if it isn't present
#   make seed-memory           # seed the memory templates
#   make seed-templates        # seed the agent role templates
#   make seed-process-templates# seed the process / flow templates
#   make seed-mcp-servers      # seed the reference MCP servers
#   make seed-plugins          # seed the reference plugins into the registry
#
# ── E2E tests — podman lane (docs/e2e-testing-concept.md) ────────────────────
#   make e2e       # full Playwright suite (F0–F4) on a disposable stack
#   make e2e-gate  # F0+F1 only — the PR-gate scope
#   make e2e-up    # bring up the disposable e2e stack for test authoring
#   make e2e-down  # tear the e2e stack down
#
# ── E2E tests — kind / Kubernetes lane (#1319) ───────────────────────────────
#   make e2e-kind      # journey suite against the dedicated e2e kind cluster
#   make e2e-kind-up   # bring the e2e kind cluster up
#   make e2e-kind-down # tear the e2e kind cluster down
#
# ── Journey docs & media (docs/journey-spec-concept.md) ──────────────────────
#   make docs-journeys       # generate the Markdown user guide from journeys
#   make docs-journeys-check # fail if the committed guide is stale/hand-edited
#   make docs-deck           # build the PPTX walkthrough deck
#   make video-journeys      # record + render the walkthrough video
#
#   make help      # print the one-line list of all targets
#

COMPOSE     ?= podman compose
COMPOSE_FILE = docker-compose.yml
SERVICES     = conduwuit orchestrator admin-console stt

# Skill pool seed sources — copied into the skill-pool volume by `make seed-pool`.
# Two inputs combine into the pool: the ACE engineering skill (host-side, from
# the user's i-sase plugin install) and the pool CLAUDE.md (repo-side, in
# orchestrator/skill-pool/). Without the engineering skill, bp-instance agents
# only have a brief.md to read; without the CLAUDE.md, agents lose the curated
# skill index they reference.
ACE_PLUGIN_SKILLS_DIR ?= $(HOME)/.claude/plugins/marketplaces/i-sase-marketplace/skills
SKILL_POOL_DEFAULTS    = $(CURDIR)/orchestrator/skill-pool

# The pool volume is named after the compose project. COMPOSE_PROJECT_NAME lives
# in .env, which podman-compose reads but make does NOT — so taking it straight
# from the environment silently fell back to the `agent-studio` default on every
# named stack, and each seed-* target then wrote into (and created) a volume no
# running container mounts. Read it out of .env here, with the environment
# taking precedence and the historic default last.
ENV_FILE ?= .env
COMPOSE_PROJECT_NAME ?= $(shell sed -n 's/^COMPOSE_PROJECT_NAME=//p' $(ENV_FILE) 2>/dev/null | tail -1)
ifeq ($(strip $(COMPOSE_PROJECT_NAME)),)
COMPOSE_PROJECT_NAME = agent-studio
endif
SKILL_POOL_VOLUME      = $(COMPOSE_PROJECT_NAME)_claude-workspace

# Admin Console version footer (#483) — resolved here (not inside the
# Docker build) since the admin-console build context is admin-console/,
# which has no .git. Falls back to "unknown"/clean so a missing .git (e.g.
# a tarball checkout) never fails the build.
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_DIRTY  := $(shell git status --porcelain 2>/dev/null | grep -q . && echo dirty || echo)
# About-page contributors (#1742, ranked in #1778) — same reason: extracted on
# the host, passed into the Docker build. We aggregate the git-log identities to
# `<count>\t<name>\t<email>` lines (`sort | uniq -c` keeps the build arg small —
# one line per distinct identity, not one per commit — while preserving the
# per-identity commit count #1778 sorts by; the sed rewrites uniq's leading
# "  N " into "N\t"), base64-encoded onto a single line, ARG-safe regardless of
# names containing commas, angle brackets or "[bot]"; vite.config.js /
# contributors.js do the human-filter, de-dup and count-ranked extraction. Empty
# on a missing .git so the About section simply hides (AC9).
GIT_CONTRIBUTORS := $(shell git log --format='%aN%x09%aE' 2>/dev/null | sort | uniq -c | sed -E 's/^[[:space:]]*([0-9]+)[[:space:]]/\1\t/' | base64 2>/dev/null | tr -d '\n')
# The commit's own creation timestamp (committer date, strict ISO-8601 with the
# authoring timezone offset preserved, e.g. 2026-08-13T17:52:03+02:00), shown in
# the sidebar About box in place of the hash (#1741). Empty when git is absent —
# the frontend falls back to "unknown".
GIT_COMMIT_TIME := $(shell git show -s --format=%cI HEAD 2>/dev/null || echo)
# Make doesn't export its own variables to recipe subprocesses by default —
# without this, podman-compose would never see GIT_COMMIT/GIT_DIRTY/GIT_COMMIT_TIME/
# GIT_CONTRIBUTORS and the docker-compose.yml `${GIT_COMMIT:-unknown}` interpolation
# would always fall back to "unknown".
export GIT_COMMIT GIT_DIRTY GIT_CONTRIBUTORS GIT_COMMIT_TIME

.PHONY: up down restart build agent-image plugin-images update ps logs help seed-pool seed-skills seed-memory seed-templates seed-process-templates seed-mcp-servers seed-plugins e2e e2e-gate e2e-up e2e-down e2e-kind e2e-kind-up e2e-kind-down docs-journeys docs-journeys-check docs-deck video-journeys tour-manifest tour-manifest\:check

# `up` depends on `agent-image` so a fresh bring-up always has the per-agent
# runtime image built (the agent image is NOT a compose service — it's pulled
# from the local store by the orchestrator at spawn time via libpod, so
# `compose up --build` does not build it). `podman build` is layer-cached, so
# this is a no-op rebuild when agent-image/ is unchanged and rebuilds on change.
# `restart` and `update` route through `up`, so they inherit the build too.
up: agent-image
	@echo "Starting agent-studio stack..."
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --build
	@echo ""
	@echo "Stack started. Container status:"
	@podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
		$(foreach svc,$(SERVICES),--filter name=$(svc))

down:
	$(COMPOSE) -f $(COMPOSE_FILE) down

restart: down up

build: plugin-images
	$(COMPOSE) -f $(COMPOSE_FILE) build orchestrator admin-console stt

# Plugin broker sidecar images (#1547). Like the agent image, these are NOT
# compose services — the orchestrator creates them over libpod when a plugin is
# installed, pulling from the local image store — so `compose build` never
# touches them. Each broker's build context is the REPO ROOT, because its
# Dockerfile vendors broker-sdk/ into the image (a build context cannot reach a
# sibling directory). Image tags must match the `sidecar.image` in the
# corresponding plugins/<id>/plugin.json.
plugin-images:
	@echo "Building plugin broker images..."
	podman build -t localhost/aee-plugin-podman-sandbox:latest -f plugins/podman-sandbox/broker/Dockerfile .
	podman build -t localhost/aee-plugin-test-mgmt:latest -f plugins/test-mgmt/broker/Dockerfile .
	podman build -t localhost/aee-plugin-netzplan:latest -f plugins/netzplan/broker/Dockerfile .
	podman build -t localhost/aee-plugin-patterns-catalog:latest -f plugins/patterns-catalog/broker/Dockerfile .
	podman build -t localhost/aee-plugin-github-issues:latest -f plugins/github-issues/broker/Dockerfile .
	podman build -t localhost/aee-plugin-gke:latest -f plugins/gke/broker/Dockerfile .
	@echo "Done. Plugin broker images:"
	@podman images --filter reference='localhost/aee-plugin-*' --format '  {{.Repository}}:{{.Tag}}'

agent-image:
	@n=0; max=3; \
	until podman build -t as-agent:latest -f agent-image/Dockerfile agent-image/; do \
		n=$$((n+1)); \
		if [ $$n -ge $$max ]; then echo "agent-image: build failed after $$max attempts" >&2; exit 1; fi; \
		echo "agent-image: build failed (attempt $$n/$$max) — likely a transient registry pull; retrying in 15s…" >&2; \
		sleep 15; \
	done

update:
	@echo "Pulling latest changes from git..."
	git pull --ff-only
	@echo "Stopping stack..."
	$(MAKE) down
	@echo "Rebuilding and starting stack..."
	$(MAKE) up

ps:
	@podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
		$(foreach svc,$(SERVICES),--filter name=$(svc))

logs:
	$(foreach svc,$(SERVICES),$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=100 $(svc) &)
	wait

seed-pool: seed-skills seed-memory seed-templates seed-process-templates seed-mcp-servers seed-plugins
	@echo "Seeding pool CLAUDE.md from $(SKILL_POOL_DEFAULTS)/CLAUDE.md..."
	@if [ ! -f "$(SKILL_POOL_DEFAULTS)/CLAUDE.md" ]; then \
	  echo "ERROR: $(SKILL_POOL_DEFAULTS)/CLAUDE.md not found in repo" >&2; \
	  exit 1; \
	fi
	podman run --rm -i \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  alpine sh -c 'cat > /pool/CLAUDE.md' < $(SKILL_POOL_DEFAULTS)/CLAUDE.md
	@echo "Done."

seed-memory:
	@if [ ! -d "$(SKILL_POOL_DEFAULTS)/memory" ]; then \
	  echo "ERROR: $(SKILL_POOL_DEFAULTS)/memory not found in repo" >&2; \
	  exit 1; \
	fi
	@echo "Seeding memory templates into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm --security-opt label=disable \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(SKILL_POOL_DEFAULTS)/memory:/src:ro \
	  alpine sh -c 'rm -rf /pool/memory && mkdir -p /pool/memory && cp -r /src/. /pool/memory/'
	@echo "Done. Pool memory contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/memory/

# Skip (don't fail) when the host-side i-sase engineering skill is absent, so
# `make seed-pool` still completes the repo-side seeds. Only ACE/BP agents need it.
seed-skills:
	@if [ ! -d "$(ACE_PLUGIN_SKILLS_DIR)/engineering" ]; then \
	  echo "WARNING: i-sase engineering skill not found - skipping (only ACE/BriefingPack agents need it)." >&2; \
	else \
	  echo "Seeding engineering skill into volume $(SKILL_POOL_VOLUME)..."; \
	  podman run --rm --security-opt label=disable \
	    -v $(SKILL_POOL_VOLUME):/pool \
	    -v $(ACE_PLUGIN_SKILLS_DIR):/src:ro \
	    alpine sh -c 'mkdir -p /pool/skills && rm -rf /pool/skills/engineering && cp -r /src/engineering /pool/skills/engineering'; \
	  echo "Done. Pool skills:"; \
	  podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/skills/; \
	fi

seed-templates:
	@if [ ! -d "$(SKILL_POOL_DEFAULTS)/agent-templates" ]; then \
	  echo "ERROR: $(SKILL_POOL_DEFAULTS)/agent-templates not found in repo" >&2; \
	  exit 1; \
	fi
	@echo "Seeding agent-templates into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm --security-opt label=disable \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(SKILL_POOL_DEFAULTS)/agent-templates:/src:ro \
	  alpine sh -c 'rm -rf /pool/agent-templates && mkdir -p /pool/agent-templates && cp -r /src/. /pool/agent-templates/'
	@echo "Done. Pool agent-templates contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/agent-templates/

seed-process-templates:
	@if [ ! -d "$(SKILL_POOL_DEFAULTS)/process-templates" ]; then \
	  echo "ERROR: $(SKILL_POOL_DEFAULTS)/process-templates not found in repo" >&2; \
	  exit 1; \
	fi
	@echo "Seeding process-templates into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm --security-opt label=disable \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(SKILL_POOL_DEFAULTS)/process-templates:/src:ro \
	  alpine sh -c 'rm -rf /pool/process-templates && mkdir -p /pool/process-templates && cp -r /src/. /pool/process-templates/'
	@echo "Done. Pool process-templates contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/process-templates/

seed-mcp-servers:
	@if [ ! -d "$(CURDIR)/mcp-servers" ]; then \
	  echo "ERROR: $(CURDIR)/mcp-servers not found in repo" >&2; \
	  exit 1; \
	fi
	@echo "Seeding mcp-servers into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm --security-opt label=disable \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(CURDIR)/mcp-servers:/src:ro \
	  alpine sh -c 'rm -rf /pool/mcp-servers && mkdir -p /pool/mcp-servers && cp -r /src/. /pool/mcp-servers/'
	@echo "Done. Pool mcp-servers contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/mcp-servers/

# Reference plugins (plugin system Phase 1, #1517): each `plugins/<id>/` carries
# plugin.json + bin/. Seeded into the pool as /pool/plugins/<id>/ (→ the
# operator registry at /workspace/plugins/<id>/), mirroring seed-mcp-servers.
# Installing a plugin from the registry grants nothing to any agent.
seed-plugins:
	@if [ ! -d "$(CURDIR)/plugins" ]; then \
	  echo "ERROR: $(CURDIR)/plugins not found in repo" >&2; \
	  exit 1; \
	fi
	@echo "Seeding plugins into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm --security-opt label=disable \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(CURDIR)/plugins:/src:ro \
	  alpine sh -c 'rm -rf /pool/plugins && mkdir -p /pool/plugins && cp -r /src/. /pool/plugins/'
	@echo "Done. Pool plugins contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/plugins/

# ── E2E (Playwright) ────────────────────────────────────────────────────────
# The disposable `aee-e2e` compose project (#666, docs/e2e-testing-concept.md).
# `make e2e` is the one-shot lane: Playwright's global-setup/teardown own the
# full stack lifecycle (build images -> seed -> bootstrap -> up -> down -v), so
# this just installs deps + the browser and runs the suite from a clean state.
# `make e2e-up` / `make e2e-down` keep the stack alive for authoring (drive
# Playwright UI mode against it with E2E_SKIP_STACK=1).
#
# `make e2e`      → FULL suite (F0–F4) — the nightly lane (#668).
# `make e2e-gate` → F0+F1 only — the burn-in PR gate scope (concept §8 phase 2/3:
#                   "PR gate stays F0+F1"). Kept a separate target so promoting
#                   the gate to a required PR check never drags in F2 (expected
#                   red until #253) or the slower F3/F4 flows.
e2e:
	cd e2e && npm ci && npx playwright install --with-deps chromium && npx playwright test

e2e-gate:
	cd e2e && npm ci && npx playwright install --with-deps chromium && npx playwright test tests/f0-*.spec.js tests/f1-*.spec.js

e2e-up:
	./e2e/scripts/stack-up.sh
	@echo ""
	@echo "aee-e2e stack is up. Author tests with:"
	@echo "  cd e2e && E2E_SKIP_STACK=1 npx playwright test --ui"
	@echo "Tear down with: make e2e-down"

e2e-down:
	./e2e/scripts/stack-down.sh

# ── E2E on kind (#1319) ─────────────────────────────────────────────────────
# Same journey suite against the DEDICATED e2e kind cluster (agent-studio-e2e)
# — agents spawn as k8s pods through spawn-kubernetes-pod.js, so this covers
# the primary (k8s) runtime that the compose lane cannot. kind-stack-up.sh owns
# the cluster + fakes + port-forwards (console :4110, fake-github :4114);
# E2E_LANE=ci,kind also picks up kind-only journeys (context-mount). The dev
# kind cluster (agent-studio) and both compose stacks are untouched.
e2e-kind:
	./e2e/scripts/kind-stack-up.sh
	cd e2e && npm ci && npx playwright install --with-deps chromium && \
	E2E_SKIP_STACK=1 E2E_BASE_URL=http://localhost:4110 \
	E2E_FAKE_GITHUB_URL=http://localhost:4114 E2E_LANE=ci,kind \
	ADMIN_USERNAME=admin ADMIN_PASSWORD=e2e-admin-pass \
	npx playwright test --project=journeys

e2e-kind-up:
	./e2e/scripts/kind-stack-up.sh

e2e-kind-down:
	./e2e/scripts/kind-stack-down.sh

# ── Journey documentation (docs/journey-spec-concept.md §3.2, #707) ─────────
# Turn the journeys + a green run's screenshot artifacts into the Markdown user
# guide under docs/user-guide/ plus a coverage report. Pure Node — no browser,
# no podman. The input artifacts dir is parameterisable so this works the same on
# a local `make e2e` run and on CI-downloaded artifacts:
#   make docs-journeys                         # uses e2e/artifacts (default)
#   E2E_ARTIFACTS_DIR=/path/to/artifacts make docs-journeys
# Committing the regenerated docs stays a human step for now; `docs-journeys-check`
# fails if the committed guide is stale or hand-edited.
docs-journeys:
	cd e2e && npm install --no-audit --no-fund --silent && npm run docs:journeys

docs-journeys-check:
	cd e2e && npm install --no-audit --no-fund --silent && npm run docs:journeys:check

# ── Helper Chat tour manifest (docs/helper-chat-concept.md §4, #1736) ─────────
# Distil the narrated journeys into admin-console/api/helper-chat/tour-manifest.json
# — one chapter per narrated journey, voiceover copy + screenshot path per step.
# Pure Node (js-yaml) — no browser, no podman; reads the same validated journey
# YAMLs the runner uses so the tour copy can never drift. `:check` regenerates and
# fails if the committed manifest is stale (ignoring the volatile timestamp), the
# same freshness guard as journeys:catalog:check.
#   make tour-manifest         # regenerate + commit the manifest
#   make tour-manifest:check   # CI: fail if the committed manifest is stale
tour-manifest:
	cd e2e && npm install --no-audit --no-fund --silent && npm run journeys:tour

tour-manifest\:check:
	@cd e2e && npm install --no-audit --no-fund --silent && npm run journeys:tour:check

# ── Journey walkthrough deck (docs/journey-spec-concept.md §3.2 item 2, #708) ──
# Build one PPTX walkthrough deck from all journeys (ordered by `order`) plus a
# green run's screenshot artifacts — section slide per journey, one slide per
# step with the narrative in the speaker notes and the screenshot as the visual.
# Pure Node (pptxgenjs) — no PowerPoint, browser or podman — and structurally
# validated (unzip + OOXML part checks) after generation; the CLI exits non-zero
# if validation fails. Same parameterisable artifacts dir as docs-journeys:
#   make docs-deck                             # uses e2e/artifacts (default)
#   E2E_ARTIFACTS_DIR=/path/to/artifacts make docs-deck
# Output: artifacts/agent-studio-walkthrough.pptx (a build artifact — CI-uploaded
# and human-visual-QA'd, never committed; see .gitignore).
docs-deck:
	cd e2e && npm install --no-audit --no-fund --silent && npm run docs:deck

# ── Journey walkthrough video (docs/journey-spec-concept.md §3.3, epic #741) ───
# Narrated, audio-driven walkthrough video (Variant C) via the Revideo lane in
# e2e/video/ (see e2e/video/README.md). TWO steps, different prerequisites:
#   1. record — a `journey-video` Playwright run records one clip per journey
#      (video: on + slowMo); needs the full podman e2e stack (like `make e2e`).
#   2. assemble — the Revideo sub-project renders the narrated video; needs
#      headless Chromium + ffmpeg + (for voiceover) an Edge-TTS run. Installed in
#      CI, NOT assumed in agent containers (see README "Container feasibility").
# The journey-driven assembler is T5/#745; until then this renders the reference
# example scene so the lane stays exercised end-to-end.
#   make video-journeys                         # record + render (needs stack + Chromium/ffmpeg)
video-journeys:
	cd e2e/video && npm ci --no-audit --no-fund --silent \
	  && npm run render:team-setup \
	  && npm run render:iban-story

help:
	@echo "Targets: up, down, restart, build, agent-image, plugin-images, update, ps, logs, seed-pool, seed-skills, seed-memory, seed-templates, seed-process-templates, seed-mcp-servers, seed-plugins, e2e, e2e-gate, e2e-up, e2e-down, e2e-kind, e2e-kind-up, e2e-kind-down, docs-journeys, docs-journeys-check, docs-deck, video-journeys, tour-manifest, tour-manifest:check"
