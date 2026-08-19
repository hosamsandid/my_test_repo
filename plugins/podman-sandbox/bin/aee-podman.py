#!/usr/bin/env python3
"""aee-podman — Podman sandbox plugin CLI facade (plugin system Phase 3, #1519).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
broker endpoint + per-scope token from `.agent-studio/plugins/podman-sandbox.json`
(0600, written at seed time by plugin-sync.js).

This CLI is the agent-facing replacement for PR #1287's raw
`podman-mcp-cli.py <tool> '<json>'` RPC and its stdio proxy: agents no longer
speak MCP tool names + JSON blobs, they speak domain verbs —

    aee-podman run docker.io/library/hello-world
    aee-podman compose up -f compose.yml
    aee-podman ps
    aee-podman logs my-service --tail 50
    aee-podman compose down

The broker (podman-mcp/server.js, reworked from #1287) holds the privileged
libpod socket and stamps every container it creates with this scope's owner
label, so containers are private to the caller's scope. All security lives in
the broker; this CLI is a privilege-less client — it just translates verbs to
the broker's tool calls and carries the scope token.

Contract (§4.5): `--json` on every subcommand; exit codes 0 ok / 1 domain error
/ 2 usage / 3 broker unreachable; `--help` carries the full agent-readable docs.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

PLUGIN_ID = "podman-sandbox"


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

# Wire path on top of the seeded base endpoint. The broker serves the MCP
# Streamable-HTTP transport here; /healthz and /internal/teardown-scope are the
# orchestrator's, not ours.
MCP_PATH = "/mcp"

# Domain verb → broker MCP tool name. The broker's tool vocabulary is the
# #1287 podman-mcp surface; the CLI is the only place that vocabulary is
# exposed, so agents never see it.
_TOOLS = {
    "compose_up": "compose_up",
    # `run` is pure CLI sugar: it synthesises a one-service compose document and
    # sends it through compose_up, inheriting validation / network isolation /
    # resource ceilings / owner labels / project scoping / quota for free. It is
    # NOT a distinct broker tool — the broker's TOOLS list is unchanged.
    "run": "compose_up",
    "compose_down": "compose_down",
    "compose_logs": "compose_logs",
    "ps": "container_list",
    "logs": "container_logs",
    "inspect": "container_inspect",
    "exec": "container_exec",
    "stop": "container_stop",
    "rm": "container_rm",
}


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
        if payload.get("ok"):
            body = payload.get("result", payload.get("message", ""))
            print(body if isinstance(body, str) else json.dumps(body, indent=2))
        else:
            print(payload.get("message", payload.get("error", "error")), file=sys.stderr)


class BrokerUnreachable(Exception):
    pass


class BrokerDomainError(Exception):
    pass


def _call_broker(cfg, tool, arguments):
    """Run one MCP tool call against the broker over Streamable-HTTP.

    initialize → notifications/initialized → tools/call, parsing the SSE
    `data:` frames the transport emits. Connection-level failures raise
    BrokerUnreachable (exit 3); a reachable broker returning an error raises
    BrokerDomainError (exit 1).
    """
    base = cfg.get("endpoint")
    token = cfg.get("token")
    if not base:
        raise BrokerUnreachable("no broker endpoint in config")
    # The seeded config carries the sidecar's BASE url (plugin-sync.js
    # sidecarEndpoint) — the platform does not know or care which wire protocol
    # a given broker speaks. The path is this CLI's business: podman-sandbox's
    # broker serves MCP Streamable-HTTP at /mcp and 404s anything else.
    url = base.rstrip("/") + MCP_PATH

    session = {"id": None}

    def post(payload):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if token:
            headers["Authorization"] = "Bearer %s" % token
        if session["id"]:
            headers["Mcp-Session-Id"] = session["id"]
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), headers=headers, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    session["id"] = sid
                if resp.status == 202:
                    return None
                for raw in resp:
                    line = raw.decode(errors="replace").rstrip("\r\n")
                    if line.startswith("data:"):
                        data = line[5:].strip()
                        if data:
                            return json.loads(data)
                return None
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            # A reachable broker that refuses (e.g. 401 forged/missing token,
            # 403 out-of-scope) is a domain error, not unreachability.
            raise BrokerDomainError("broker HTTP %s: %s" % (e.code, body[:400])) from e
        except (urllib.error.URLError, OSError) as e:
            raise BrokerUnreachable("cannot reach broker at %s: %s" % (url, e)) from e

    post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "aee-podman", "version": "1.0"}},
    })
    post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    resp = post({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    })

    if resp is None:
        raise BrokerDomainError("no response from broker for tool '%s'" % tool)
    if "error" in resp:
        err = resp["error"]
        raise BrokerDomainError("broker error %s: %s" % (err.get("code"), err.get("message")))

    result = resp.get("result", resp)
    if isinstance(result, dict) and result.get("isError"):
        raise BrokerDomainError(_unwrap_text(result))
    return _unwrap_text(result)


def _unwrap_text(result):
    """MCP tool results wrap text in a content[] array — unwrap to a string."""
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        parts = []
        for item in result["content"]:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return json.dumps(result)


def _run(cfg, tool, arguments, as_json, extra=None):
    try:
        text = _call_broker(cfg, tool, arguments)
    except BrokerUnreachable as e:
        emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
        return EXIT_BROKER_UNREACHABLE
    except BrokerDomainError as e:
        emit({"ok": False, "error": "broker-error", "message": str(e)}, as_json)
        return EXIT_DOMAIN_ERROR
    payload = {"ok": True, "result": text, "scopeId": cfg.get("scopeId")}
    if extra:
        payload.update(extra)
    emit(payload, as_json)
    return EXIT_OK


def _default_run_name(image):
    """Derive a stable, compose-valid service/container name from an image ref
    when the caller gives no `--name`.

    `docker.io/library/hello-world:latest` -> `hello-world`. Strips the registry
    path (everything up to the last `/`), then a `@digest` / `:tag` (a
    registry-port colon lives in an earlier `/`-segment, already removed, so the
    split is unambiguous), lower-cases, maps anything outside the compose name
    grammar to `-`, and falls back to `app`.
    """
    ref = image.rsplit("/", 1)[-1]
    ref = ref.split("@", 1)[0].split(":", 1)[0]
    cleaned = "".join(ch if (ch.isalnum() or ch in "_.-") else "-" for ch in ref.lower())
    name = cleaned.strip("-._")
    return name or "app"


def _parse_env(pairs):
    """`--env K=V` list -> a `{K: V}` map for the compose `environment:` block.

    Split on the FIRST `=` so a value may itself contain `=` (`K=a=b` -> `a=b`).
    Returns `(env_map, error_message_or_None)`.
    """
    env = {}
    for item in pairs or []:
        if "=" not in item:
            return None, "env must be KEY=VALUE (got %r)" % item
        key, value = item.split("=", 1)
        if not key:
            return None, "env key is empty in %r" % item
        env[key] = value
    return env, None


def _build_run_compose(image, name, env_map, command):
    """Synthesise the one-service compose document for `run`.

    Emitted as JSON — which is valid YAML, and which the broker parses with
    `YAML.parse` — so the CLI stays dependency-free (no PyYAML) AND every value
    (an image tag, a command token with spaces, an env value containing `:`) is
    quoted by `json.dumps` and can never reshape the document. `container_name`
    is pinned so the caller gets a deterministic name back for `logs`/`rm`.
    """
    service = {"image": image, "container_name": name}
    if env_map:
        service["environment"] = env_map
    if command:
        service["command"] = command
    return json.dumps({"services": {name: service}})


def _split_run_command(argv):
    """Split a `run` invocation's args at the first standalone `--`.

    Everything after it is the container command; everything before is parsed by
    argparse (image + flags in any order). Returns `(head, command_or_None)` —
    `None` when there is no `--`, an empty list for a bare trailing `--`. Done
    before argparse because `argparse.REMAINDER` would otherwise greedily
    swallow `--name`/`--env` flags that follow the image positional.
    """
    if "--" in argv:
        i = argv.index("--")
        return argv[:i], argv[i + 1:]
    return argv, None


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")

    parser = argparse.ArgumentParser(
        prog="aee-podman",
        description="Podman sandbox plugin CLI — spawn and manage compose stacks "
                    "and containers private to your scope, through the broker.",
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("whoami", parents=[common], help="print the resolved scope identity")

    p_run = sub.add_parser(
        "run", parents=[common],
        help="run a single container (sugar over `compose up`)",
        description=(
            "Start ONE container without hand-writing a compose file. `run` "
            "synthesises a one-service compose document CLI-side and sends it "
            "through the same `compose up` path, so it inherits validation, "
            "network isolation, resource ceilings, owner labels, project "
            "scoping, quota and teardown identically: ps / logs / stop / rm / "
            "`compose down` all work on the result unchanged. Append "
            "`-- <command> [args...]` to override the image's default command."
        ),
        epilog=(
            "Synthesised document (JSON — which is valid YAML):\n"
            "  {\"services\": {\"<name>\": {\"image\": \"<image>\", "
            "\"container_name\": \"<name>\",\n"
            "                              \"environment\": {..}, \"command\": [..]}}}\n"
            "<name> is --name, else derived from the image "
            "(docker.io/library/hello-world -> hello-world).\n"
            "\n"
            "Network: the broker forces every sandbox network internal:true, so a\n"
            "container started with `run` has NO outbound network. Image pulls still\n"
            "work (they happen host-side), but anything expecting egress at runtime\n"
            "will not.\n"
            "\n"
            "Need more than one service, a build, ports or volumes? Write a\n"
            "compose.yml and use `aee-podman compose up -f compose.yml` instead."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_run.add_argument("image", help="image reference, e.g. docker.io/library/hello-world")
    p_run.add_argument("--name", help="container name (default: derived from the image)")
    p_run.add_argument("-e", "--env", action="append", metavar="K=V",
                       help="set an environment variable (repeatable)")
    p_run.add_argument("-p", "--project", help="optional project name (scoped regardless)")

    p_compose = sub.add_parser("compose", help="manage a compose stack scoped to you")
    csub = p_compose.add_subparsers(dest="subcmd")
    c_up = csub.add_parser("up", parents=[common], help="bring up a compose stack (detached)")
    c_up.add_argument("-f", "--file", required=True, help="path to a docker-compose.yml")
    c_up.add_argument("-p", "--project", help="optional project name (scoped regardless)")
    c_down = csub.add_parser("down", parents=[common], help="tear down a compose stack you brought up")
    c_down.add_argument("-p", "--project", help="project name passed to `compose up`")
    c_logs = csub.add_parser("logs", parents=[common], help="logs for a compose stack you brought up")
    c_logs.add_argument("-p", "--project", help="project name passed to `compose up`")
    c_logs.add_argument("--tail", type=int, help="number of lines to tail (default 100)")

    p_ps = sub.add_parser("ps", parents=[common], help="list containers you own")

    p_logs = sub.add_parser("logs", parents=[common], help="logs for a container you own")
    p_logs.add_argument("name", help="container name or id")
    p_logs.add_argument("--tail", type=int, help="number of lines to tail (default 100)")

    p_inspect = sub.add_parser("inspect", parents=[common], help="inspect a container you own")
    p_inspect.add_argument("name", help="container name or id")

    p_exec = sub.add_parser("exec", parents=[common], help="run a command in a container you own")
    p_exec.add_argument("name", help="container name or id")
    p_exec.add_argument("argv", nargs=argparse.REMAINDER, help="command + args, e.g. -- ls -la")

    p_stop = sub.add_parser("stop", parents=[common], help="stop a container you own")
    p_stop.add_argument("name", help="container name or id")

    p_rm = sub.add_parser("rm", parents=[common], help="force-remove a container you own")
    p_rm.add_argument("name", help="container name or id")

    return parser


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    # For `run`, peel off the trailing `-- <command>` before argparse sees it so
    # flags after the image still parse (argparse.REMAINDER would swallow them).
    run_command = None
    if argv and argv[0] == "run":
        argv, run_command = _split_run_command(argv)

    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = getattr(args, "json", False)

    if args.cmd is None:
        parser.print_help()
        return EXIT_USAGE
    if args.cmd == "compose" and getattr(args, "subcmd", None) is None:
        print("usage: aee-podman compose {up,down,logs} ... (see `aee-podman compose up --help`)",
              file=sys.stderr)
        return EXIT_USAGE

    cfg = load_config()
    if cfg is None:
        emit(
            {"ok": False, "error": "not-granted",
             "message": "podman-sandbox is not granted to this agent (no config at %s)" % CONFIG_PATH},
            as_json,
        )
        return EXIT_BROKER_UNREACHABLE

    if args.cmd == "whoami":
        emit({"ok": True, "scopeId": cfg.get("scopeId"), "endpoint": cfg.get("endpoint")}, as_json)
        return EXIT_OK

    if args.cmd == "run":
        env_map, err = _parse_env(args.env)
        if err is not None:
            emit({"ok": False, "error": "usage", "message": err}, as_json)
            return EXIT_USAGE
        name = args.name or _default_run_name(args.image)
        # A bare trailing `--` (run_command == []) means "no command override".
        command = run_command if run_command else None
        compose_file = _build_run_compose(args.image, name, env_map, command)
        payload = {"composeFile": compose_file}
        if args.project:
            payload["projectName"] = args.project
        # Surface the pinned container name so the caller knows what to pass to
        # `logs`/`rm` — especially when it was derived rather than given.
        return _run(cfg, _TOOLS["run"], payload, as_json, extra={"container": name})

    if args.cmd == "compose":
        if args.subcmd == "up":
            try:
                with open(args.file, "r", encoding="utf-8") as fh:
                    compose_file = fh.read()
            except OSError as e:
                emit({"ok": False, "error": "usage", "message": "cannot read compose file: %s" % e}, as_json)
                return EXIT_USAGE
            payload = {"composeFile": compose_file}
            if args.project:
                payload["projectName"] = args.project
            return _run(cfg, _TOOLS["compose_up"], payload, as_json)
        if args.subcmd == "down":
            payload = {}
            if args.project:
                payload["projectName"] = args.project
            return _run(cfg, _TOOLS["compose_down"], payload, as_json)
        if args.subcmd == "logs":
            payload = {}
            if args.project:
                payload["projectName"] = args.project
            if args.tail is not None:
                payload["tail"] = args.tail
            return _run(cfg, _TOOLS["compose_logs"], payload, as_json)
        return EXIT_USAGE

    if args.cmd == "ps":
        return _run(cfg, _TOOLS["ps"], {}, as_json)

    if args.cmd == "logs":
        payload = {"name": args.name}
        if args.tail is not None:
            payload["tail"] = args.tail
        return _run(cfg, _TOOLS["logs"], payload, as_json)

    if args.cmd == "inspect":
        return _run(cfg, _TOOLS["inspect"], {"name": args.name}, as_json)

    if args.cmd == "exec":
        # REMAINDER captures everything after NAME verbatim (including a stray
        # `--json`), so recover the flag from the tail and drop the `--` guard.
        cmd = list(args.argv or [])
        if "--json" in cmd:
            as_json = True
            cmd = [c for c in cmd if c != "--json"]
        if cmd and cmd[0] == "--":
            cmd = cmd[1:]
        if not cmd:
            emit({"ok": False, "error": "usage", "message": "exec needs a command, e.g. exec NAME -- ls -la"}, as_json)
            return EXIT_USAGE
        return _run(cfg, _TOOLS["exec"], {"name": args.name, "cmd": cmd}, as_json)

    if args.cmd == "stop":
        return _run(cfg, _TOOLS["stop"], {"name": args.name}, as_json)

    if args.cmd == "rm":
        return _run(cfg, _TOOLS["rm"], {"name": args.name}, as_json)

    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
