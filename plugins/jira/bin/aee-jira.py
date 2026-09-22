#!/usr/bin/env python3
"""aee-jira — Jira plugin CLI facade (docs/jira-plugin-plan.md §6.3).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
broker endpoint + per-scope token from `.agent-studio/plugins/jira.json` (0600,
written at grant time by plugin-sync.js).

All privilege lives in the broker (plugins/jira/broker/server.js), which holds
the team's Jira credential and makes every Jira call server-side. This CLI is a
privilege-less client that just carries the scope token.

Reads:

    aee-jira whoami                               # the resolved plugin scope
    aee-jira inbox                                # peek: every queued status-change event in the team's inbox
    aee-jira inbox --consume KAN-6:10312 [ID…]   # drain exactly the events YOUR wake named (payload `id` / `events[].id`)
    aee-jira projects                             # the projects in this team's scope
    aee-jira list --project KAN [--status "Ready for Dev"]   # a project's issues
    aee-jira show KAN-6                           # one issue (summary, status, type, assignee, URL, attachments)
    aee-jira attachment get KAN-6 10312 [--out path]   # fetch one attachment's content by id

Writes (attributed, role-gated server-side, no human confirmation — moving a
ticket is routine and reversible):

    aee-jira comment KAN-6 --body "Picked this up, see PR #123"
    aee-jira transition KAN-6 --to "In Progress"
    aee-jira update KAN-6 --description "…"   # replace the issue description (the old one stays in Jira's history)

`inbox` without `--consume` peeks. `--consume` takes one or more event ids and
drains exactly those — the inbox is shared by every agent on the team, each
woken for its own subset, so there is no whole-inbox drain. The ids you may
consume are the ones in your own wake payload: `id` for a single event,
`events[].id` for a digest (a digest with `truncated: true` inlines only the
first 20 of YOUR events — peek, take the rest that carry your status, consume
those too).
`transition` names the TARGET status; the broker resolves the
Jira transition from where the issue currently is and reports the available
options if none leads there.

Contract (§4.5): `--json` on every subcommand; exit 0 ok / 1 domain error /
2 usage / 3 broker unreachable; `--help` carries the agent-readable docs.
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PLUGIN_ID = "jira"

EXIT_OK = 0
EXIT_DOMAIN_ERROR = 1
EXIT_USAGE = 2
EXIT_BROKER_UNREACHABLE = 3


def _config_path():
    ws = os.environ.get("AEE_WORKSPACE", os.path.expanduser("~"))
    new = os.path.join(ws, ".agent-studio", "plugins", "%s.json" % PLUGIN_ID)
    legacy = os.path.join(ws, ".aee", "plugins", "%s.json" % PLUGIN_ID)
    if os.path.exists(new) or not os.path.exists(legacy):
        return new
    return legacy


CONFIG_PATH = _config_path()


def load_config():
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


def _sanitize(name):
    """A filesystem-safe segment (no path separators, no traversal)."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(name or "")) or "attachment"


def _default_attachment_path(att, issue):
    ws = os.environ.get("AEE_WORKSPACE", os.path.expanduser("~"))
    name = att.get("filename") or ("attachment-%s" % att.get("id"))
    return os.path.join(
        ws, ".agent-studio", "jira-attachments", _sanitize(issue),
        "%s-%s" % (_sanitize(att.get("id")), _sanitize(name)),
    )


def emit_attachment(result, out_path, issue, as_json):
    """Surface `attachment get`: text is printed inline (AC5), binary is decoded
    and saved to a workspace path the agent can read (AC6). `--out` forces a save
    for either kind."""
    att = (result or {}).get("attachment") or {}
    encoding = att.get("encoding")
    content = att.get("content") or ""
    raw = base64.b64decode(content) if encoding == "base64" else content.encode("utf-8")

    saved = None
    if out_path or encoding == "base64":
        target = out_path or _default_attachment_path(att, issue)
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(raw)
        saved = target

    meta = {k: att.get(k) for k in ("id", "filename", "mimeType", "size", "author", "encoding")}
    if saved:
        meta["savedPath"] = saved

    if as_json:
        payload = {"ok": True, "result": dict(meta), "scopeId": None}
        if encoding == "text":
            payload["result"]["content"] = content
        print(json.dumps(payload))
        return EXIT_OK

    header = "%s (%s, %s bytes)" % (
        att.get("filename") or att.get("id"), att.get("mimeType") or "unknown type", att.get("size"),
    )
    if encoding == "text" and not out_path:
        print(header)
        print(content)
    elif saved:
        print("%s\nsaved to %s" % (header, saved))
    else:
        print(header)
    return EXIT_OK


class BrokerUnreachable(Exception):
    pass


class BrokerDomainError(Exception):
    pass


def _call(cfg, path, method="GET", body=None):
    base = cfg.get("endpoint")
    token = cfg.get("token")
    if not base:
        raise BrokerUnreachable("no broker endpoint in config")
    url = base.rstrip("/") + "/cli" + path
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer %s" % token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode(errors="replace")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            d = json.loads(body)
            msg = d.get("message") or d.get("error") or body[:400]
        except ValueError:
            msg = body[:400]
        raise BrokerDomainError("broker HTTP %s: %s" % (e.code, msg)) from e
    except (urllib.error.URLError, OSError) as e:
        raise BrokerUnreachable("cannot reach broker at %s: %s" % (url, e)) from e


def build_parser():
    parser = argparse.ArgumentParser(
        prog="aee-jira",
        description="Read Jira issues in your team's scope. All Jira access is server-side in the broker.",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="machine-readable output")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("whoami", parents=[common], help="show the resolved plugin scope")

    p_inbox = sub.add_parser("inbox", parents=[common], help="the queued status-change events that woke you")
    p_inbox.add_argument(
        "--consume", nargs="+", metavar="EVENT_ID", default=None,
        help="drain exactly these event ids (from your wake payload: `id`, or `events[].id` in a digest); "
             "without --consume the inbox is only peeked",
    )

    sub.add_parser("projects", parents=[common], help="list the Jira projects in this team's scope")

    p_list = sub.add_parser("list", parents=[common], help="list a project's issues (most-recently-updated first)")
    p_list.add_argument("--project", required=True, help="project key, e.g. KAN")
    p_list.add_argument("--status", help="only issues currently in this status")

    p_show = sub.add_parser("show", parents=[common], help="read one issue")
    p_show.add_argument("issue", help="issue key, e.g. KAN-6")

    p_att = sub.add_parser("attachment", parents=[common], help="read an issue's attachments (list them with `show`)")
    att_sub = p_att.add_subparsers(dest="att_cmd")
    p_att_get = att_sub.add_parser(
        "get", parents=[common],
        help="fetch one attachment's content by id (from `aee-jira show`)",
    )
    p_att_get.add_argument("issue", help="issue key the attachment is on, e.g. KAN-6")
    p_att_get.add_argument("attachment_id", help="the attachment id shown by `aee-jira show`")
    p_att_get.add_argument(
        "--out", metavar="PATH",
        help="write the content to this file; text is printed inline unless --out is given, "
             "binary is always saved (default: under .agent-studio/jira-attachments/)",
    )

    p_comment = sub.add_parser("comment", parents=[common], help="add a comment to an issue")
    p_comment.add_argument("issue", help="issue key, e.g. KAN-6")
    p_comment.add_argument("--body", required=True, help="the comment text")

    p_trans = sub.add_parser("transition", parents=[common], help="move an issue to a target status")
    p_trans.add_argument("issue", help="issue key, e.g. KAN-6")
    p_trans.add_argument("--to", required=True, help="the TARGET status name, e.g. \"In Progress\"")

    p_update = sub.add_parser("update", parents=[common], help="replace an issue's description (previous text stays in Jira's history)")
    p_update.add_argument("issue", help="issue key, e.g. KAN-6")
    p_update.add_argument("--description", required=True, help="the complete new description text (plain text; blank lines become paragraphs)")

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
             "message": "jira is not granted to this agent (no config at %s)" % CONFIG_PATH},
            as_json,
        )
        return EXIT_BROKER_UNREACHABLE

    if args.cmd == "whoami":
        emit({"ok": True, "result": {"scopeId": cfg.get("scopeId"), "plugin": PLUGIN_ID}, "scopeId": cfg.get("scopeId")}, as_json)
        return EXIT_OK

    method, body = "GET", None
    if args.cmd == "inbox":
        path = "/inbox"
        if args.consume:
            path += "?" + urllib.parse.urlencode({"consume": ",".join(args.consume)})
    elif args.cmd == "projects":
        path = "/projects"
    elif args.cmd == "list":
        q = {"project": args.project}
        if args.status:
            q["status"] = args.status
        path = "/list?" + urllib.parse.urlencode(q)
    elif args.cmd == "show":
        path = "/show?" + urllib.parse.urlencode({"issue": args.issue})
    elif args.cmd == "attachment":
        if getattr(args, "att_cmd", None) != "get":
            emit({"ok": False, "error": "usage",
                  "message": "usage: aee-jira attachment get <issueKey> <attachmentId> [--out PATH]"}, as_json)
            return EXIT_USAGE
        path = "/attachment?" + urllib.parse.urlencode({"issue": args.issue, "id": args.attachment_id})
    elif args.cmd == "comment":
        path, method, body = "/comment", "POST", {"issue": args.issue, "body": args.body}
    elif args.cmd == "transition":
        path, method, body = "/transition", "POST", {"issue": args.issue, "to": getattr(args, "to")}
    elif args.cmd == "update":
        path, method, body = "/update", "POST", {"issue": args.issue, "description": args.description}
    else:
        parser.print_help()
        return EXIT_USAGE

    try:
        result = _call(cfg, path, method, body)
    except BrokerUnreachable as e:
        emit({"ok": False, "error": "broker-unreachable", "message": str(e)}, as_json)
        return EXIT_BROKER_UNREACHABLE
    except BrokerDomainError as e:
        emit({"ok": False, "error": "domain-error", "message": str(e)}, as_json)
        return EXIT_DOMAIN_ERROR

    if args.cmd == "attachment":
        return emit_attachment(result, getattr(args, "out", None), args.issue, as_json)

    emit({"ok": True, "result": result, "scopeId": cfg.get("scopeId")}, as_json)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
