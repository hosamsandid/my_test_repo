#!/usr/bin/env python3
"""aee-test — Test-management plugin CLI facade (plugin system Phase 5, #1521).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
broker endpoint + per-scope token from `.agent-studio/plugins/test-mgmt.json`
(0600, written at seed time by plugin-sync.js).

Agents never see the vendor's API (Xray/Zephyr/qTest) nor its credential — they
speak domain verbs to the broker, which holds the one vendor token:

    aee-test create-case --title "Login rejects empty password" --folder REGRESSION
    aee-test trigger --plan REGRESSION --wait
    aee-test run-status RUN-1234
    aee-test data list
    aee-test data delete FIXTURE-9        # destructive → waits for human confirm

All security lives in the broker (server.js on broker-sdk): it verifies the
scope token, stamps every artifact it creates with this scope's owner label (so
another team's agent cannot see it), enforces the manifest `policy` — creating
test cases is restricted to the flow-final agent whose cross-checks passed — and
parks destructive ops for human approval. This CLI is a privilege-less client:
it translates verbs to broker tool calls and carries the scope token.

Contract (§4.5): `--json` on every subcommand; exit codes 0 ok / 1 domain error
/ 2 usage / 3 broker unreachable; `--help` carries the full agent-readable docs.
When the broker refuses on policy (e.g. a non-final agent calling create-case)
that is a DOMAIN error (exit 1) — the broker is reachable and answered.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

PLUGIN_ID = "test-mgmt"


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

# Domain verb → broker MCP tool name. The broker's tool vocabulary is the only
# place the vendor surface is named; agents never see it.
_TOOLS = {
    "create_case": "test_case_create",
    "run_submit": "test_run_submit",
    "run_status": "test_run_status",
    "data_list": "test_data_list",
    "data_set": "test_data_set",
    "data_delete": "test_data_delete",
}

# Submit→poll defaults for `trigger --wait`. Deliberately bounded so a stuck run
# can never hang an agent forever; the broker is the source of truth for the
# terminal states.
POLL_INTERVAL_S = 5
POLL_MAX_ATTEMPTS = 120
TERMINAL_STATES = {"passed", "failed", "error", "aborted", "cancelled"}


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
    BrokerUnreachable (exit 3); a reachable broker returning an error — including
    a policy refusal or a parked approval — raises BrokerDomainError (exit 1).
    """
    url = cfg.get("endpoint")
    token = cfg.get("token")
    if not url:
        raise BrokerUnreachable("no broker endpoint in config")

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
            # A reachable broker that refuses (401 forged token, 403 out-of-scope
            # / policy refusal) is a domain error, not unreachability.
            raise BrokerDomainError("broker HTTP %s: %s" % (e.code, body[:400])) from e
        except (urllib.error.URLError, OSError) as e:
            raise BrokerUnreachable("cannot reach broker at %s: %s" % (url, e)) from e

    post({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "aee-test", "version": "1.0"}},
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


def _run(cfg, tool, arguments, as_json):
    try:
        text = _call_broker(cfg, tool, arguments)
    except BrokerUnreachable as e:
        emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
        return EXIT_BROKER_UNREACHABLE
    except BrokerDomainError as e:
        emit({"ok": False, "error": "broker-error", "message": str(e)}, as_json)
        return EXIT_DOMAIN_ERROR
    emit({"ok": True, "result": text, "scopeId": cfg.get("scopeId")}, as_json)
    return EXIT_OK


def _parse_state(text):
    """Best-effort pull of a run state from the broker's text result."""
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return None
    if isinstance(obj, dict):
        state = obj.get("state") or obj.get("status")
        return str(state).lower() if state else None
    return None


def _trigger_and_wait(cfg, arguments, as_json):
    """Submit a run, then poll its status to a terminal state (submit→poll)."""
    try:
        submit_text = _call_broker(cfg, _TOOLS["run_submit"], arguments)
    except BrokerUnreachable as e:
        emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
        return EXIT_BROKER_UNREACHABLE
    except BrokerDomainError as e:
        emit({"ok": False, "error": "broker-error", "message": str(e)}, as_json)
        return EXIT_DOMAIN_ERROR

    run_id = None
    try:
        parsed = json.loads(submit_text)
        if isinstance(parsed, dict):
            run_id = parsed.get("runId") or parsed.get("id")
    except (ValueError, TypeError):
        run_id = None
    if not run_id:
        emit({"ok": True, "result": submit_text, "scopeId": cfg.get("scopeId")}, as_json)
        return EXIT_OK

    last = submit_text
    for _ in range(POLL_MAX_ATTEMPTS):
        try:
            last = _call_broker(cfg, _TOOLS["run_status"], {"runId": run_id})
        except BrokerUnreachable as e:
            emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
            return EXIT_BROKER_UNREACHABLE
        except BrokerDomainError as e:
            emit({"ok": False, "error": "broker-error", "message": str(e)}, as_json)
            return EXIT_DOMAIN_ERROR
        state = _parse_state(last)
        if state in TERMINAL_STATES:
            ok = state == "passed"
            emit({"ok": ok, "result": last, "runId": run_id, "state": state,
                  "scopeId": cfg.get("scopeId")}, as_json)
            return EXIT_OK if ok else EXIT_DOMAIN_ERROR
        time.sleep(POLL_INTERVAL_S)

    emit({"ok": False, "error": "timeout", "runId": run_id,
          "message": "run %s did not reach a terminal state in time" % run_id,
          "result": last}, as_json)
    return EXIT_DOMAIN_ERROR


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")

    parser = argparse.ArgumentParser(
        prog="aee-test",
        description="Test-management plugin CLI — create test cases, trigger runs "
                    "and manage test data through the broker, scoped to you.",
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("whoami", parents=[common], help="print the resolved scope identity")

    p_create = sub.add_parser(
        "create-case", parents=[common],
        help="create a test case (broker policy: flow-final agent, cross-checks passed)")
    p_create.add_argument("--title", required=True, help="test case title")
    p_create.add_argument("--description", help="test case description / steps")
    p_create.add_argument("--folder", help="target folder / plan key")

    p_trigger = sub.add_parser("trigger", parents=[common], help="trigger a test run")
    p_trigger.add_argument("--plan", help="test plan key to run")
    p_trigger.add_argument("--suite", help="test suite key to run")
    p_trigger.add_argument("--wait", action="store_true",
                           help="poll the run to a terminal state (submit→poll)")

    p_status = sub.add_parser("run-status", parents=[common], help="status of one run")
    p_status.add_argument("run_id", help="run id returned by trigger")

    p_data = sub.add_parser("data", help="manage test data scoped to you")
    dsub = p_data.add_subparsers(dest="subcmd")
    dsub.add_parser("list", parents=[common], help="list test-data fixtures you own")
    d_set = dsub.add_parser("set", parents=[common], help="create/update a test-data fixture")
    d_set.add_argument("key", help="fixture key")
    d_set.add_argument("value", help="fixture value (JSON or string)")
    d_del = dsub.add_parser("delete", parents=[common],
                            help="delete a fixture (destructive → waits for human confirm)")
    d_del.add_argument("key", help="fixture key")

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = getattr(args, "json", False)

    if args.cmd is None:
        parser.print_help()
        return EXIT_USAGE
    if args.cmd == "data" and getattr(args, "subcmd", None) is None:
        print("usage: aee-test data {list,set,delete} ... (see `aee-test data set --help`)",
              file=sys.stderr)
        return EXIT_USAGE

    cfg = load_config()
    if cfg is None:
        emit(
            {"ok": False, "error": "not-granted",
             "message": "test-mgmt is not granted to this agent (no config at %s)" % CONFIG_PATH},
            as_json,
        )
        return EXIT_BROKER_UNREACHABLE

    if args.cmd == "whoami":
        emit({"ok": True, "scopeId": cfg.get("scopeId"), "endpoint": cfg.get("endpoint")}, as_json)
        return EXIT_OK

    if args.cmd == "create-case":
        payload = {"title": args.title}
        if args.description:
            payload["description"] = args.description
        if args.folder:
            payload["folder"] = args.folder
        return _run(cfg, _TOOLS["create_case"], payload, as_json)

    if args.cmd == "trigger":
        if not args.plan and not args.suite:
            emit({"ok": False, "error": "usage", "message": "trigger needs --plan or --suite"}, as_json)
            return EXIT_USAGE
        payload = {}
        if args.plan:
            payload["plan"] = args.plan
        if args.suite:
            payload["suite"] = args.suite
        if args.wait:
            return _trigger_and_wait(cfg, payload, as_json)
        return _run(cfg, _TOOLS["run_submit"], payload, as_json)

    if args.cmd == "run-status":
        return _run(cfg, _TOOLS["run_status"], {"runId": args.run_id}, as_json)

    if args.cmd == "data":
        if args.subcmd == "list":
            return _run(cfg, _TOOLS["data_list"], {}, as_json)
        if args.subcmd == "set":
            return _run(cfg, _TOOLS["data_set"], {"key": args.key, "value": args.value}, as_json)
        if args.subcmd == "delete":
            return _run(cfg, _TOOLS["data_delete"], {"key": args.key}, as_json)
        return EXIT_USAGE

    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
