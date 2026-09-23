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
    aee-jira search --jql "<JQL>" [--fields key,summary,status,Team] [--limit N]   # arbitrary JQL, scoped to your team
    aee-jira show KAN-6 [--fields "Team,Sprint"]   # one issue (summary, status, type, assignee, created/updated, parent/epic key, URL, attachments; --fields adds custom fields)
    aee-jira attachment get KAN-6 10312 [--out path]   # fetch one attachment's content by id

Writes (attributed, role-gated server-side, no human confirmation — moving a
ticket is routine and reversible):

    aee-jira comment KAN-6 --body "Picked this up, see PR #123"
    aee-jira transition KAN-6 --to "In Progress"
    aee-jira update KAN-6 --description "…"   # replace the issue description (the old one stays in Jira's history)
    aee-jira attachment add KAN-6 report.pdf part-1.pdf   # upload one or more local files as new attachments

`attachment add` takes an issue key and one or more local file paths; each file
becomes a separate attachment (Jira never overwrites — a same-named upload is a
new, additional attachment). Every path is checked to exist and be readable
before any upload starts; when several files are given and one upload fails, the
others still go through and the result reports per-file success/failure. On
success each created attachment's id + filename come back (machine-readable with
`--json`). The file bytes travel to the broker, which does the upload
server-side — the Jira token never reaches this CLI.

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

# Client-side upload cap, mirroring the broker's JIRA_ATTACHMENT_UPLOAD_MAX_BYTES
# (default 10 MB). The broker is the authoritative gate; this is only so an
# over-cap file is refused with a clear, path-naming message before the bytes are
# read and shipped. A non-positive value disables the client-side check.
def _upload_cap():
    try:
        v = int(os.environ.get("JIRA_ATTACHMENT_UPLOAD_MAX_BYTES") or (10 * 1024 * 1024))
    except ValueError:
        v = 10 * 1024 * 1024
    return v


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


def do_attachment_add(cfg, issue, paths, as_json):
    """Upload each local path as a new attachment on `issue`.

    AC5 / edge case: every path is validated (exists, readable, within the cap)
    BEFORE any upload is attempted — a bad path aborts the whole batch with a
    message naming it, so nothing is half-uploaded. AC6: once uploads start, a
    per-file failure is recorded and does not abort the files after it; the
    result reports which succeeded and which failed.
    """
    cap = _upload_cap()
    problems = []
    for p in paths:
        if not os.path.isfile(p):
            problems.append("%s: not found or not a regular file" % p)
        elif not os.access(p, os.R_OK):
            problems.append("%s: not readable" % p)
        elif cap > 0:
            try:
                size = os.path.getsize(p)
            except OSError as e:
                problems.append("%s: cannot read size (%s)" % (p, e))
                continue
            if size > cap:
                problems.append("%s: %d bytes, over the %d-byte upload limit" % (p, size, cap))
    if problems:
        emit(
            {"ok": False, "error": "invalid-path",
             "message": "refusing to upload — fix these path(s) first:\n  " + "\n  ".join(problems)},
            as_json,
        )
        return EXIT_DOMAIN_ERROR

    results = []
    n_unreachable = 0
    for p in paths:
        filename = os.path.basename(p) or "attachment"
        try:
            with open(p, "rb") as fh:
                data = fh.read()
            resp = _call(cfg, "/attachment/add", "POST", {
                "issue": issue,
                "filename": filename,
                "contentBase64": base64.b64encode(data).decode("ascii"),
            })
            att = (resp or {}).get("attachment") or {}
            results.append({
                "path": p, "filename": att.get("filename") or filename, "ok": True,
                "id": att.get("id"), "size": att.get("size"), "mimeType": att.get("mimeType"),
            })
        except BrokerUnreachable as e:
            n_unreachable += 1
            results.append({"path": p, "filename": filename, "ok": False, "error": str(e)})
        except (BrokerDomainError, OSError) as e:
            results.append({"path": p, "filename": filename, "ok": False, "error": str(e)})

    uploaded = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]

    if as_json:
        print(json.dumps({
            "ok": not failed,
            "result": {"issue": issue, "uploaded": len(uploaded), "failed": len(failed), "results": results},
            "scopeId": cfg.get("scopeId"),
        }))
    else:
        for r in results:
            if r["ok"]:
                print("✓ %s → attachment %s (%s)" % (r["filename"], r.get("id"), issue))
            else:
                print("✗ %s — %s" % (r["filename"], r.get("error")), file=sys.stderr)
        print("%d uploaded, %d failed" % (len(uploaded), len(failed)))

    if not failed:
        return EXIT_OK
    # Every file failed and every failure was connectivity → surface exit 3 so a
    # down broker is not misreported as a Jira domain error.
    if not uploaded and n_unreachable == len(failed):
        return EXIT_BROKER_UNREACHABLE
    return EXIT_DOMAIN_ERROR


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

    p_search = sub.add_parser(
        "search", parents=[common],
        help="run an arbitrary JQL query (scoped to your team's site & projects)",
    )
    p_search.add_argument("--jql", required=True, help='the JQL query, e.g. "created >= -2d AND issuetype = Story"')
    p_search.add_argument(
        "--fields",
        help="comma-separated fields to return (default all standard columns): standard "
             "columns key,summary,status,issueType,assignee,updated,parent,url narrow the "
             'row; any other name is read as a custom field (e.g. "status,Team")',
    )
    p_search.add_argument("--limit", type=int, help="cap the number of issues returned (default 100, max 2000)")

    p_show = sub.add_parser("show", parents=[common], help="read one issue")
    p_show.add_argument("issue", help="issue key, e.g. KAN-6")
    p_show.add_argument(
        "--fields",
        help='comma-separated custom field names to also read, by their Jira name (e.g. "Team,Sprint"); '
             "an empty field comes back as null, distinguishing it from a set one",
    )

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
    p_att_add = att_sub.add_parser(
        "add", parents=[common],
        help="upload one or more local files as new attachments to an issue",
    )
    p_att_add.add_argument("issue", help="issue key to attach to, e.g. KAN-6")
    p_att_add.add_argument(
        "paths", nargs="+", metavar="PATH",
        help="local file path(s) to upload; each becomes a separate attachment (Jira does not overwrite)",
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
    elif args.cmd == "search":
        q = {"jql": args.jql}
        if args.fields:
            q["fields"] = args.fields
        if args.limit is not None:
            q["limit"] = args.limit
        path = "/search?" + urllib.parse.urlencode(q)
    elif args.cmd == "show":
        q = {"issue": args.issue}
        if args.fields:
            q["fields"] = args.fields
        path = "/show?" + urllib.parse.urlencode(q)
    elif args.cmd == "attachment":
        att_cmd = getattr(args, "att_cmd", None)
        if att_cmd == "add":
            return do_attachment_add(cfg, args.issue, args.paths, as_json)
        if att_cmd != "get":
            emit({"ok": False, "error": "usage",
                  "message": "usage: aee-jira attachment get <issueKey> <attachmentId> [--out PATH]\n"
                             "       aee-jira attachment add <issueKey> <path> [<path> …]"}, as_json)
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
