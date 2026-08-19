#!/usr/bin/env python3
"""aee-issues — GitHub Issues plugin CLI facade (issue #1633).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
broker endpoint + per-scope token from `.agent-studio/plugins/github-issues.json`
(0600, written at seed time by plugin-sync.js).

The plugin's main surface is the human console page (list issues, read one, add
or remove labels). This CLI is the agent-facing, READ-ONLY companion: an agent
can see which repositories are in its team's scope and browse their issues, but
label writes are a human action in the console. All privilege lives in the
broker (plugins/github-issues/broker/server.js), which holds the team's GitHub token and
makes every GitHub call server-side; this CLI is a privilege-less client that
just carries the scope token.

    aee-issues repos
    aee-issues list --repo owner/name [--state open|closed|all] [--page N]
    aee-issues show --repo owner/name --number 42

Contract (§4.5): `--json` on every subcommand; exit codes 0 ok / 1 domain error
/ 2 usage / 3 broker unreachable; `--help` carries the full agent-readable docs.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PLUGIN_ID = "github-issues"

EXIT_OK = 0
EXIT_DOMAIN_ERROR = 1
EXIT_USAGE = 2
EXIT_BROKER_UNREACHABLE = 3


def _config_path():
    """Path to this agent's plugin config, seeded at grant time (falls back to
    the legacy `.aee/` dir renamed in #1549)."""
    ws = os.environ.get("AEE_WORKSPACE", os.path.expanduser("~"))
    new = os.path.join(ws, ".agent-studio", "plugins", f"{PLUGIN_ID}.json")
    legacy = os.path.join(ws, ".aee", "plugins", f"{PLUGIN_ID}.json")
    if os.path.exists(new) or not os.path.exists(legacy):
        return new
    return legacy


CONFIG_PATH = _config_path()


def load_config():
    """Endpoint + scope token written at seed time. Absent until granted."""
    try:
        with open(_config_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None


def emit(payload, as_json):
    if as_json:
        print(json.dumps(payload))
    elif payload.get("ok"):
        body = payload.get("result", payload.get("message", ""))
        print(body if isinstance(body, str) else json.dumps(body, indent=2))
    else:
        print(payload.get("message", payload.get("error", "error")), file=sys.stderr)


class BrokerUnreachable(Exception):
    pass


class BrokerDomainError(Exception):
    pass


def _get(cfg, path):
    """GET one broker `/cli` endpoint, carrying the scope token. A connection
    failure is unreachability (exit 3); a reachable broker refusing on the
    merits is a domain error (exit 1)."""
    base = cfg.get("endpoint")
    token = cfg.get("token")
    if not base:
        raise BrokerUnreachable("no broker endpoint in config")
    url = base.rstrip("/") + "/cli" + path
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode(errors="replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            msg = json.loads(body).get("error", body[:400])
        except ValueError:
            msg = body[:400]
        raise BrokerDomainError("broker HTTP %s: %s" % (e.code, msg)) from e
    except (urllib.error.URLError, OSError) as e:
        raise BrokerUnreachable("cannot reach broker at %s: %s" % (url, e)) from e


def build_parser():
    parser = argparse.ArgumentParser(
        prog="aee-issues",
        description="Browse your team's GitHub issues (read-only). Label changes are made by a human in the console.",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("repos", parents=[common], help="list the repositories in your team's scope")

    p_list = sub.add_parser("list", parents=[common], help="list a repository's issues (open by default)")
    p_list.add_argument("--repo", required=True, help="repository as owner/name")
    p_list.add_argument("--state", default="open", choices=["open", "closed", "all"], help="issue state (default open)")
    p_list.add_argument("--page", type=int, default=1, help="page number (default 1)")

    p_show = sub.add_parser("show", parents=[common], help="read one issue's details")
    p_show.add_argument("--repo", required=True, help="repository as owner/name")
    p_show.add_argument("--number", type=int, required=True, help="issue number")

    return parser


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = getattr(args, "json", False)

    if args.cmd is None:
        parser.print_help()
        return EXIT_USAGE

    cfg = load_config()
    if cfg is None:
        emit(
            {"ok": False, "error": "not-granted",
             "message": "github-issues is not granted to this agent (no config at %s)" % CONFIG_PATH},
            as_json,
        )
        return EXIT_BROKER_UNREACHABLE

    if args.cmd == "repos":
        path = "/repos"
    elif args.cmd == "list":
        q = urllib.parse.urlencode({"repo": args.repo, "state": args.state, "page": args.page})
        path = "/list?" + q
    elif args.cmd == "show":
        q = urllib.parse.urlencode({"repo": args.repo, "number": args.number})
        path = "/show?" + q
    else:
        parser.print_help()
        return EXIT_USAGE

    try:
        result = _get(cfg, path)
    except BrokerUnreachable as e:
        emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
        return EXIT_BROKER_UNREACHABLE
    except BrokerDomainError as e:
        emit({"ok": False, "error": "domain-error", "message": str(e)}, as_json)
        return EXIT_DOMAIN_ERROR

    emit({"ok": True, "result": result, "scopeId": cfg.get("scopeId")}, as_json)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
