#!/usr/bin/env fish
#
# Start the full e-vgh-claw stack (Conduwuit + Orchestrator + Admin Console + Cinny)
#

set project_dir (path dirname (status filename))

echo "Starting e-vgh-claw stack..."

podman compose -f "$project_dir/docker-compose.yml" up -d --build

if test $status -eq 0
    echo ""
    echo "Stack started. Container status:"
    podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
        --filter name=conduwuit \
        --filter name=cinny \
        --filter name=orchestrator \
        --filter name=admin-console
else
    echo "Failed to start stack." >&2
    exit 1
end
