#
# e-vgh-claw stack — Conduwuit + Orchestrator + Admin Console
#
# Usage:
#   make up        # build + start the full stack
#   make down      # stop the stack
#   make restart   # down + up
#   make build     # rebuild orchestrator image
#   make agent-image # build the per-agent container image (ace-agent:latest)
#   make update    # git pull + down + up (pulls latest, restarts with rebuild)
#   make ps        # show container status
#   make logs      # follow logs of all stack containers
#

COMPOSE     ?= podman compose
COMPOSE_FILE = docker-compose.yml
SERVICES     = conduwuit orchestrator admin-console

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

.PHONY: up down restart build agent-image update ps logs help seed-pool seed-skills seed-memory seed-templates seed-mcp-servers

up:
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
	$(COMPOSE) -f $(COMPOSE_FILE) build orchestrator

agent-image:
	podman build -t ace-agent:latest -f agent-image/Dockerfile agent-image/

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
	podman logs -f --tail=100 orchestrator &
	podman logs -f --tail=100 admin-console &
	podman logs -f --tail=100 conduwuit &
	wait

seed-pool: seed-skills seed-memory seed-templates seed-mcp-servers
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

seed-skills:
	@if [ ! -d "$(ACE_PLUGIN_SKILLS_DIR)/engineering" ]; then \
	  echo "ERROR: $(ACE_PLUGIN_SKILLS_DIR)/engineering not found" >&2; \
	  echo "Install the i-sase plugin via the Claude Code marketplace first." >&2; \
	  exit 1; \
	fi
	@echo "Seeding engineering skill into volume $(SKILL_POOL_VOLUME)..."
	podman run --rm \
	  -v $(SKILL_POOL_VOLUME):/pool \
	  -v $(ACE_PLUGIN_SKILLS_DIR):/src:ro \
	  alpine sh -c 'mkdir -p /pool/skills && rm -rf /pool/skills/engineering && cp -r /src/engineering /pool/skills/engineering'
	@echo "Done. Pool contents:"
	@podman run --rm -v $(SKILL_POOL_VOLUME):/pool:ro alpine ls /pool/skills/

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

help:
	@echo "Targets: up, down, restart, build, agent-image, update, ps, logs, seed-pool, seed-skills, seed-memory, seed-templates, seed-mcp-servers"
