#
# e-vgh-claw stack — Conduwuit + Orchestrator + Admin Console
#
# Usage:
#   make up        # build + start the full stack
#   make down      # stop the stack
#   make restart   # down + up
#   make build     # rebuild orchestrator image
#   make update    # git pull + down + up (pulls latest, restarts with rebuild)
#   make ps        # show container status
#   make logs      # follow logs of all stack containers
#

COMPOSE     ?= podman compose
COMPOSE_FILE = docker-compose.yml
SERVICES     = conduwuit orchestrator admin-console

.PHONY: up down restart build update ps logs help

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

help:
	@echo "Targets: up, down, restart, build, update, ps, logs"
