#!/usr/bin/env python3
"""aee-echo — reference plugin CLI facade (plugin system Phase 1, #1517).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
endpoint + per-agent scope token from `.agent-studio/plugins/dummy-echo.json`
(0600, written at seed time). It brokers nothing real — it echoes its arguments
so the registry, sidecar lifecycle and grant-driven network wiring can be
verified before a real broker exists (Phase 3).

Contract (§4.5): `--json` on every subcommand; exit codes 0 ok / 1 domain error
/ 2 usage / 3 broker unreachable; `--help` carries the full agent-readable docs.
"""
import argparse
import json
import os
import sys

PLUGIN_ID = "dummy-echo"


def _config_path():
    """Path to this agent's plugin config, seeded at grant time.

    Resolves the current `.agent-studio/` state dir, falling back to the legacy
    `.aee/` (renamed in #1549) so a config seeded before the workspace was
    migrated is still found.
    """
    ws = os.environ.get("AEE_WORKSPACE", os.path.expanduser("~"))
    new = os.path.join(ws, ".agent-studio", "plugins", f"{PLUGIN_ID}.json")
    legacy = os.path.join(ws, ".aee", "plugins", f"{PLUGIN_ID}.json")
    if os.path.exists(new) or not os.path.exists(legacy):
        return new
    return legacy


CONFIG_PATH = _config_path()

EXIT_OK = 0
EXIT_DOMAIN_ERROR = 1
EXIT_USAGE = 2
EXIT_BROKER_UNREACHABLE = 3


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
    else:
        print(payload.get("message", json.dumps(payload)))


def main(argv=None):
    # `--json` is defined per subcommand (contract §4.5: --json on every
    # subcommand) via a shared parent, so `aee-echo <cmd> --json` is the form.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")

    parser = argparse.ArgumentParser(
        prog="aee-echo",
        description="Reference plugin CLI — echoes text through the dummy broker.",
    )
    sub = parser.add_subparsers(dest="cmd")

    p_echo = sub.add_parser("echo", parents=[common], help="echo TEXT back through the broker")
    p_echo.add_argument("text", nargs="*", help="text to echo")

    sub.add_parser("whoami", parents=[common], help="print the resolved scope identity")

    args = parser.parse_args(argv)

    if args.cmd is None:
        parser.print_help()
        return EXIT_USAGE

    cfg = load_config()
    if cfg is None:
        emit(
            {"ok": False, "error": "not-granted",
             "message": "dummy-echo is not granted to this agent (no config at %s)" % CONFIG_PATH},
            args.json,
        )
        return EXIT_BROKER_UNREACHABLE

    if args.cmd == "whoami":
        emit({"ok": True, "scopeId": cfg.get("scopeId"), "endpoint": cfg.get("endpoint")}, args.json)
        return EXIT_OK

    if args.cmd == "echo":
        text = " ".join(args.text)
        emit({"ok": True, "message": text, "scopeId": cfg.get("scopeId")}, args.json)
        return EXIT_OK

    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
