# Shared helpers for the fake-claude role playbooks (issue #711,
# docs/journey-spec-concept.md §6.2). Sourced by ba-create-issue.sh /
# developer-implement.sh / reviewer-approve.sh.
#
# DESIGN DECISION (issue #711, point 2 — the "gh-CLI caveat"): playbooks talk to
# the fake GitHub REST API DIRECTLY with `curl`, NOT the `gh` CLI. `gh` against a
# non-github.com host expects the GitHub-Enterprise path shape
# (`https://<host>/api/v3/...`) and a configured `GH_HOST`; the in-stack
# fake-github (§6.1) serves the plain github.com shape (`/repos/:owner/:repo/…`)
# with no auth. Rather than reshape the fake or juggle GH_HOST, curl against
# $GITHUB_API_BASE is the smallest honest thing that works. Deps: curl + python3
# only — both are in the agent image; jq is NOT installed. See README.md.
#
# Sourced, so no shebang. `set -u` for safety, but deliberately NOT `set -e`: a
# playbook must never hard-fail the shim (the shim treats a non-zero exit as a
# logged warning, not an abort — the label still wakes the real trigger chain).
set -uo pipefail

GH_API_BASE="${GITHUB_API_BASE:-http://fake-github}"

log() { echo "[playbook] $*" >&2; }

# Locate the agent's workspace repo clone (best-effort). The runtime usually
# invokes claude with cwd inside the clone; fall back to /repo, $REPO_DIR, or the
# sole `.git` under $HOME — mirroring _resolve_repo_dir in agent-entrypoint.py.
repo_dir() {
  local d
  d="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$d" ]; then echo "$d"; return; fi
  for d in /repo "${REPO_DIR:-}"; do
    if [ -n "$d" ] && [ -d "$d/.git" ]; then echo "$d"; return; fi
  done
  d="$(find "${HOME:-/root}" -maxdepth 3 -name .git -type d 2>/dev/null | head -n1 || true)"
  if [ -n "$d" ]; then dirname "$d"; return; fi
  echo ""
}

# Pull a scalar out of the prompt's <external-event> JSON block (present on the
# Developer/Reviewer github-event triggers). $1 is a python expression over `d`
# (the parsed event object); prints the value or "" if absent/unparseable.
_event_field() {
  AEE_FAKE_CLAUDE_PROMPT="${AEE_FAKE_CLAUDE_PROMPT:-}" python3 - "$1" <<'PY'
import json, os, re, sys
expr = sys.argv[1]
prompt = os.environ.get("AEE_FAKE_CLAUDE_PROMPT", "")
m = re.search(r"<external-event[^>]*>\s*(\{.*\})\s*</external-event>", prompt, re.S)
if not m:
    print(""); sys.exit(0)
try:
    d = json.loads(m.group(1))
    val = eval(expr, {"__builtins__": {}}, {"d": d})  # trusted, self-authored prompt
except Exception:
    val = None
print("" if val is None else val)
PY
}

event_repo()   { _event_field 'd.get("repo")'; }
issue_number() { _event_field '((d.get("payload") or {}).get("issue") or {}).get("number")'; }
pr_number()    { _event_field '((d.get("payload") or {}).get("pull_request") or {}).get("number")'; }

# Resolve owner/repo. Prefer the github event's `repo` (Developer/Reviewer);
# else derive from the workspace clone's origin URL by its last two path
# segments (the BA has no event payload) — mirrors deriveRepoIdentity (#667) and
# the poller's #711 non-github fallback, so all three agree on `e2e/fixture`.
resolve_repo() {
  local r; r="$(event_repo)"
  if [ -n "$r" ]; then echo "$r"; return; fi
  local dir url; dir="$(repo_dir)"
  if [ -n "$dir" ]; then
    url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
    python3 - "$url" <<'PY'
import re, sys
u = sys.argv[1] if len(sys.argv) > 1 else ""
m = re.search(r"[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", u or "")
print(f"{m.group(1)}/{m.group(2)}" if m else "")
PY
    return
  fi
  echo ""
}

# curl helpers against fake-github. gh_post <path> <json>; gh_get <path>.
gh_post() { curl -sS -X POST "${GH_API_BASE}$1" -H 'Content-Type: application/json' -d "$2"; }
gh_get()  { curl -sS "${GH_API_BASE}$1"; }

# Read a scalar field from a JSON blob on stdin (no jq in the image).
json_field() { python3 -c 'import sys,json;
try: d=json.load(sys.stdin)
except Exception: d={}
print(d.get(sys.argv[1], "") if isinstance(d, dict) else "")' "$1"; }
