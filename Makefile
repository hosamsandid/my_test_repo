#
# e-vgh-claw stack — Conduwuit + Orchestrator + Admin Console
#
# Usage:
#   make up        # build the agent image + build + start the full stack
#   make down      # stop the stack
#   make restart   # down + up
#   make build     # rebuild orchestrator + admin-console images
#   make agent-image # build the per-agent container image (as-agent:latest)
#   make update    # git pull + down + up (pulls latest, restarts with rebuild)
#   make ps        # show container status
#   make logs      # follow logs of all stack containers
#

COMPOSE     ?= podman compose
COMPOSE_FILE = docker-compose.yml
SERVICES     = conduwuit orchestrator admin-console whisper-asr

# Skill pool seed sources — copied into the skill-pool volume by `make seed-pool`.
# Two inputs combine into the pool: the ACE engineering skill (host-side, from
# the user's i-sase plugin install) and the pool CLAUDE.md (repo-side, in
# orchestrator/skill-pool/). Without the engineering skill, bp-instance agents
# only have a brief.md to read; without the CLAUDE.md, agents lose the curated
# skill index they reference.
ACE_PLUGIN_SKILLS_DIR ?= $(HOME)/.claude/plugins/marketplaces/i-sase-marketplace/skills
SKILL_POOL_DEFAULTS    = $(CURDIR)/orchestrator/skill-pool
SKILL_POOL_VOLUME      = $(COMPOSE_PROJECT_NAME)_claude-workspace
ifeq ($(COMPOSE_PROJECT_NAME),)
SKILL_POOL_VOLUME      = vgh-claw_claude-workspace
endif

# Admin Console version footer (#483) — resolved here (not inside the
# Docker build) since the admin-console build context is admin-console/,
# which has no .git. Falls back to "unknown"/clean so a missing .git (e.g.
# a tarball checkout) never fails the build.
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_DIRTY  := $(shell git status --porcelain 2>/dev/null | grep -q . && echo dirty || echo)
# Make doesn't export its own variables to recipe subprocesses by default —
# without this, podman-compose would never see GIT_COMMIT/GIT_DIRTY and the
# docker-compose.yml `${GIT_COMMIT:-unknown}` interpolation would always fall
# back to "unknown".
export GIT_COMMIT GIT_DIRTY

.PHONY: up down restart build agent-image update ps logs help seed-pool seed-skills seed-memory seed-templates seed-process-templates seed-mcp-servers e2e e2e-gate e2e-up e2e-down docs-journeys docs-journeys-check docs-deck video-journeys

# `up` depends on `agent-image` so a fresh bring-up always has the per-agent
# runtime image built (the agent image is NOT a compose service — it's pulled
# from the local store by the orchestrator at spawn time via libpod, so
# `compose up --build` does not build it). `podman build` is layer-cached, so
# this is a no-op rebuild when agent-image/ is unchanged and rebuilds on change.
# `restart` and `update` route through `up`, so they inherit the build too.
up: agent-image
	@echo "Starting e-vgh-claw stack..."
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --build
	@echo ""
	@echo "Stack started. Container status:"
	@podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
		$(foreach svc,$(SERVICES),--filter name=$(svc))

down:
	$(COMPOSE) -f $(COMPOSE_FILE) down

restart: down up

build:
	$(COMPOSE) -f $(COMPOSE_FILE) build orchestrator admin-console

agent-image:
	podman build -t as-agent:latest -f agent-image/Dockerfile agent-image/

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

seed-pool: seed-skills seed-memory seed-templates seed-process-templates seed-mcp-servers
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
	podman run --rm \
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
	  podman run --rm \
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
	podman run --rm \
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
	podman run --rm \
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
	podman run --rm \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(CURDIR)/mcp-servers:/src:ro \
	  alpine sh -c 'rm -rf /pool/mcp-servers && mkdir -p /pool/mcp-servers && cp -r /src/. /pool/mcp-servers/'
	@echo "Done. Pool mcp-servers contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/mcp-servers/

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
	@echo "Targets: up, down, restart, build, agent-image, update, ps, logs, seed-pool, seed-skills, seed-memory, seed-templates, seed-process-templates, seed-mcp-servers, e2e, e2e-gate, e2e-up, e2e-down, docs-journeys, docs-journeys-check, docs-deck, video-journeys"
