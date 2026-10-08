#!/usr/bin/env python3
"""aee-jira — Jira plugin CLI facade (docs/jira-plugin-plan.md §6.3).

Dependency-free single file (concept §4.5): stdlib only, no pip installs. It is
seeded into a granted agent's workspace at `.agent-studio/bin/` and reads its
broker endpoint + per-scope token from `.agent-studio/plugins/jira.json` (0600,
written at grant time by plugin-sync.js).

All privilege lives in the broker (plugins/jira/broker/server.js), which makes
every Jira call server-side. This CLI is a privilege-less client that just
carries the scope token and the agent's caller token.

Whose Jira account a call runs as (#2562): in a CHAT turn, the person who wrote
the message — their own Jira e-mail + API token, stored in Agent Studio
under Connections → Plugin Tokens. Without one every subcommand is refused and
nothing is sent to Jira. In an AUTOMATED run (schedule, event, loop, hand-off)
the team's service account is used.

Reads:

    aee-jira whoami                               # the resolved plugin scope
    aee-jira inbox                                # peek: every queued event in the team's inbox
    aee-jira inbox --consume KAN-6:10312 [ID…]   # drain exactly the events YOUR wake named (payload `id` / `events[].id`)
    aee-jira projects                             # the projects in this team's scope
    aee-jira statuses --project KAN               # every workflow status the project supports, grouped by issue type
    aee-jira list --project KAN [--status "Ready for Dev"]   # a project's issues
    aee-jira search --jql "<JQL>" [--fields key,summary,status,Team] [--limit N]   # arbitrary JQL, scoped to your team
    aee-jira show KAN-6 [--fields "Team,Sprint"] [--comment <id>]   # one issue (summary, status, type, assignee, created/updated, parent/epic key, URL, priority, labels, reporter, components, fixVersions, dueDate, attachments, availableTransitions; --fields adds custom fields; --comment adds one comment in full)
    aee-jira comments KAN-6 [--limit N] [--offset N]   # the issue's comments, newest first (20 per page)
    aee-jira attachment get KAN-6 10312 [--out path]   # fetch one attachment's content by id
    aee-jira sprint list --board "Team Scrum Board"     # a Scrum board's sprints (resolved by board name)
    aee-jira version list --project KAN           # a project's versions (releases), unreleased first
    aee-jira link-types                           # the site's issue link types: name, outward + inward phrase
    aee-jira users "Anna" [--project KAN | --issue KAN-10] [--limit N]   # find people: name / e-mail → accountId

Writes (attributed, role-gated server-side, no human confirmation — moving a
ticket is routine and reversible):

    aee-jira comment KAN-6 --body "Picked this up, see PR #123"
    aee-jira transition KAN-6 --to "In Progress"
    aee-jira update KAN-6 --description "…"   # replace the issue description (the old one stays in Jira's history)
    aee-jira set-field KAN-6 --field "Team" --value "42"   # set an allow-listed custom field by its Jira name
    aee-jira attachment add KAN-6 report.pdf part-1.pdf   # upload one or more local files as new attachments
    aee-jira create-epic --project KAN --file plan.json   # create one Epic and its child Stories in one operation
    aee-jira add-stories --epic KAN-12 --file stories.json   # add new Stories to an EXISTING Epic (no new Epic)
    aee-jira add-stories --epic KAN-12 --type Bug --file bugs.json   # ... or Bugs, Tasks, any standard type
    aee-jira create-issue --project KAN --type Bug --summary "Login fails"   # one standalone issue, no Epic
    aee-jira add-subtasks --parent KAN-10 --file subtasks.json   # new Sub-tasks under an EXISTING Story/Task/Bug
    aee-jira set-epic KAN-30 KAN-31 --epic KAN-12   # put EXISTING issues under an Epic (or move them to it)
    aee-jira set-epic KAN-30 --none               # take an existing issue out of its Epic
    aee-jira edit KAN-10 --summary "New title" --priority High --add-label backend   # change standard fields
    aee-jira edit KAN-10 --assignee <accountId> --due 2026-10-31    # (--unassign / --clear-due to empty them)
    aee-jira sprint create --board "Team Scrum Board" --name "Sprint 12" --start 2026-10-26 --end 2026-11-01
    aee-jira sprint bulk-create --board "Team Scrum Board" --name-template "Acc2.0 {MMM}_{weekOfMonth}" --until 2026-12-31
    aee-jira sprint close --board "Team Scrum Board"     # complete the board's active sprint
    aee-jira sprint start --board "Team Scrum Board"     # activate the board's next future sprint
    aee-jira sprint advance --board "Team Scrum Board"   # close the active sprint, then start the next future one
    aee-jira version create --project KAN --name 1.5 --release-date 2026-11-30   # a new project version
    aee-jira version release --project KAN --name 1.4 [--date 2026-10-07] [--move-to 1.5]   # mark it released
    aee-jira link KAN-1 blocks KAN-2              # link two issues: "KAN-1 blocks KAN-2"
    aee-jira unlink 10001                         # remove a link by its id (from `show`'s links)
    aee-jira unlink KAN-1 blocks KAN-2            # …or by the same words that created it

`create-epic` turns one ask into its breakdown: it creates a single Epic and N
Stories underneath it (each linked to the Epic) in the named project, in one
call. The Epic + Stories are described by a JSON payload read from --file (or
stdin when --file is omitted or "-"):

    {
      "epic":    { "summary": "Q4 payments revamp", "description": "..." },
      "stories": [
        { "summary": "Design checkout",
          "assignee": "<accountId>",
          "status":   "In Progress",
          "fields":   { "Team": "42", "Story point estimate": 5 } },
        { "summary": "Wire the API" }
      ]
    }

Only a summary is required (on the epic and on each story). Optional per-issue:
"description", "assignee" (an Atlassian accountId), "status" (applied as a
follow-up transition, since Jira creates an issue in the workflow's initial
status), and "fields" (custom fields by their Jira name). Custom fields named in
"fields" are writable by default (the same gate as set-field); if the team set a
non-empty writable-custom-fields allow-list, every named field must be on it or
the whole operation is refused before anything is created. The name is resolved
to its id and the value shaped server-side (a
Team/select/user field is not a plain string; pass an id-bearing field's id).
The result reports the Epic key + URL and, per Story, its key/URL on success or
an error on failure (the Epic and the other Stories still go through — Jira has
no create-transaction). Non-default issue-type names can be overridden with a
top-level "issueTypes": {"epic": "...", "story": "..."} in the payload.

`add-stories` fills an Epic that already exists: it creates N new Stories under
the Epic named by --epic (its key, e.g. KAN-12), in the Epic's own project, and
never creates an Epic. The payload (from --file, or stdin) is a "stories" array
with the same per-story fields as create-epic:

    {
      "stories": [
        { "summary": "Design checkout", "assignee": "<accountId>",
          "status": "In Progress", "fields": { "Team": "42" } },
        { "summary": "Wire the API" }
      ]
    }

The call is refused before anything is created when the key does not exist or
is outside the team's Jira scope, when the issue is not an Epic (the error names
its actual type), when "stories" is empty or a story has no summary, or when a
named custom field is not on a non-empty writable-custom-fields allow-list. The
result reports the Epic and, per Story, its key/URL or an error; one failing
Story does not stop the others, and the CLI exits 1 if any Story failed. Fill
several Epics with one call each.

Any standard issue type can go under the Epic, not only Stories: --type sets
the type for every issue in the call, and an issue's own "type" wins over it
(so one call can add a Bug and a Task). Types are the Epic project's own names,
matched case-insensitively ("bug", a localised "Fehler"). Each issue may also
carry "priority" and "labels", like create-issue; "issues" is accepted as the
array's name instead of "stories":

    {
      "issues": [
        { "type": "Bug", "summary": "Login fails", "priority": "High" },
        { "type": "Task", "summary": "Rotate keys", "labels": ["ops"] }
      ]
    }

An unknown type (the error lists the project's types), an Epic or sub-task
type, or a field the project requires for that type but the issue does not
set fails only that issue — the others are still created, and each result
names its "issueType". Without any type the Stories are created as before.

`create-issue` creates ONE standalone issue (no parent Epic) of any standard
type the project offers — Story, Task, Bug, or a project's own type such as
"Fehler" — matched case-insensitively by the project's own type names:

    aee-jira create-issue --project KAN --type Bug --summary "Login fails" \
        [--description "..."] [--assignee <accountId>] [--priority High] \
        [--label regression --label web] [--status "In Progress"] \
        [--field "Team=42"] [--file issue.json]

--file (or "-" for stdin) is an optional JSON object with the same keys —
"summary", "description", "assignee", "priority", "labels" (a list),
"status", "fields" (custom fields by Jira name; an object value is sent
verbatim) — and the flags win over it. "status" is applied as a follow-up
transition; if that transition is not possible the issue still exists, and the
result reports its key next to "statusError" (exit 1). Refused before anything
is created: a project outside the team's Jira scope, an unknown type (the error
lists the project's types), an Epic type (use create-epic), a sub-task type, a
required field the project needs but the call does not set (named in the
error), a custom field off a non-empty writable-custom-fields allow-list, or a
value Jira rejects (e.g. an unknown assignee accountId).

`add-subtasks` splits an existing Story, Task or Bug: it creates N new
Sub-tasks under the issue named by --parent, in that issue's project. Each
Sub-task takes create-issue's fields — "summary" (required), "description",
"assignee", "priority", "labels", "status" (a follow-up transition) and
"fields" (custom fields by Jira name) — plus an optional "type":

    {
      "subtasks": [
        { "summary": "Write the migration", "assignee": "<accountId>" },
        { "summary": "Update the docs", "status": "In Progress" }
      ]
    }

The sub-task type is the project's own ("Sub-task", "Unteraufgabe", …): with
exactly one it is used without being named; with several, name it with --type
(for the whole call) or a per-Sub-task "type". Refused before anything is
created: a parent that does not exist or is outside the team's Jira scope, a
parent that is an Epic or itself a Sub-task, a project without a sub-task type
(Sub-tasks disabled), or several sub-task types and none named. An unknown or
non-sub-task type, a required field the Sub-task does not set, or a value Jira
rejects fails only that Sub-task — the others are still created; the result
reports each key/URL or the reason, and the CLI exits 1 if any failed.

`set-epic` re-parents issues that already exist: every listed issue goes under
the Epic named by --epic (moved there if it is under another Epic), or with
--none is taken out of its Epic (no parent afterwards). The target is checked
first: a key that does not exist or is outside the team's Jira scope, or an
issue that is not an Epic, is refused and nothing is changed. Then each issue
gets its own outcome — "added", "moved" (with the old Epic), "removed",
"unchanged" ("already under KAN-12" / "has no parent Epic", a success) or
"failed" with the reason (not found / outside the team's scope, an Epic or a
sub-task — neither is moved —, or Jira's own refusal, e.g. a missing Edit
permission). One failing key never stops the others; a key listed twice is
handled once; the CLI exits 1 if any issue failed. `show` then reports the new
`parent`.

`edit` changes the standard fields of ONE existing issue — several in one call:

    aee-jira edit KAN-10 [--summary "..."] [--assignee <accountId> | --unassign]
        [--priority High] [--due 2026-10-31 | --clear-due]
        [--add-label L]... [--remove-label L]... [--set-labels [L ...]]
        [--add-component C]... [--remove-component C]... [--set-components [C ...]]
        [--add-fix-version V]... [--remove-fix-version V]... [--set-fix-versions [V ...]]

--add-* / --remove-* change single values and leave the issue's other values
alone; --set-* replaces the whole list (with no names it empties it), and a
list is either replaced or edited, not both. Labels are single words (no
spaces). The assignee is an Atlassian accountId. Priorities are matched by name
against the site's priorities, components and fix versions by name against the
issue's project (case-insensitive) — an unknown name is refused with the list
of what exists; nothing is created. The due date is YYYY-MM-DD. Everything is
checked first and the changes are applied in ONE Jira edit, so either all of
them land or none does; Jira's refusal is shown per field (a field that is not
on the issue's edit screen is named). The result lists each requested field
with its old and new value and "changed" or "unchanged" (already at that value,
not written). An issue outside the team's Jira scope is refused. Description
(`update`) and custom fields (`set-field`) have their own commands.

`comments` reads the conversation on an issue, newest first, so you know the
context before you act or reply (a plain `show` lists no comments):

    aee-jira comments KAN-10                      # the newest 20: id, author, created, updated, body, origin
    aee-jira comments KAN-10 --limit 5            # only the newest 5 (1-100)
    aee-jira comments KAN-10 --offset 20          # the next older page (`nextOffset` from the previous result)
    aee-jira show KAN-10 --comment <id>           # one comment in full when its body was cut (bodyTruncated)

`origin` is "agent" for a comment your team posted through aee-jira and "human"
otherwise. A body is plain text (mentions read @Name, code and tables as text),
cut at the same length as a comment_added wake — `bodyTruncated: true` then
means read it in full with `show --comment <id>`. `updated` differs from
`created` when a comment was edited. `hasMore: true` means older comments
exist — read them with `--offset <nextOffset>`. No comments is an empty list,
not an error; comments your account may not see are simply not listed. An issue
outside your team's Jira scope is refused.

`users` finds people, so you can assign them: Jira identifies a person by an
opaque accountId, never by name or e-mail, and every `assignee` (`edit
--assignee`, `create-issue --assignee`, a create-epic / add-stories payload's
"assignee") takes that accountId. Search by a name or e-mail fragment:

    aee-jira users "Anna Schmidt"                 # every match: accountId, displayName, email, active, accountType
    aee-jira users "anna.schmidt@acme.com"        # a full e-mail finds that one person (if your account may see them)
    aee-jira users "Anna" --project KAN           # only people who can be assigned issues in KAN
    aee-jira users "Anna" --issue KAN-10          # only people who can be assigned KAN-10
    aee-jira edit KAN-10 --assignee <accountId>   # then assign with the accountId from the result

`email` is only filled when Jira shows it to the calling account (privacy
settings often hide it — then it is null; it is never guessed). Without
--project / --issue a deactivated account is listed with `active: false`; with
them only active, assignable people come back. `accountType` "app" marks a bot
or integration, not a person. Several people with the same name are all listed
and the `note` says so — tell them apart by e-mail or ask, never pick one at
random. No match is an empty `users` list with a "No user found" note (exit 0).
At most 50 people are returned (`--limit` lowers it); `truncated: true` means
there were more — narrow the query. A project or issue outside your team's Jira
scope is refused.

`sprint` manages a Scrum board's sprints, the board resolved by its
human-readable name (e.g. "Accessio 2.0 Scrum Board"). `sprint list` reads the
board's sprints (id, name, state, start/end). `sprint create` makes one future
sprint from an explicit name + start/end. `sprint bulk-create` pre-creates a
whole run of future sprints up to a target end date in a single call: each
sprint is `--cadence-days` long (default 7, i.e. weekly Monday-Sunday), the run
continues by default from the day after the board's latest existing sprint (pass
`--start` to override, and it is required when the board has no sprints yet), and
each sprint's name is computed by `--name-template` off that sprint's start day.
Template placeholders: {MMM} 3-letter month, {MMMM} full month, {MM}/{M} month
number, {YYYY}/{YY} year, {DD}/{D} day, {weekOfMonth} the Nth-weekday-of-month,
{n} the 1-based batch index. The month always comes from the sprint's start
(its Monday) even when the week crosses into the next month — so a sprint
running Mon 26.10-Sun 01.11 with template "Acc2.0 {MMM}_{weekOfMonth}" is
"Acc2.0 Oct_4", and the following Mon 02.11-Sun 08.11 is "Acc2.0 Nov_1". Every
sprint is created as a Jira "future" sprint (a board has only one active
sprint); the result reports each sprint's id, or a per-sprint error.

`sprint close` / `sprint start` / `sprint advance` transition a sprint's state.
`sprint close` completes the board's active sprint (`--sprint-id` overrides which
one) and reports the count of issues left incomplete — these stay on the closed
sprint (there is no move-to-backlog dialog for an agent). `sprint start` activates
the board's next future sprint (the earliest-starting one, `--sprint-id`
overrides); it refuses to add a second active sprint (a board has only one) and a
dateless sprint (Jira rejects that). `sprint advance` is the roll-over in one
call: it closes the active sprint, then starts the next future one, reporting each
half separately so a partial result (e.g. closed but no future sprint to start) is
visible — the CLI exits 1 on such a partial, while still printing both outcomes.

`version` manages a project's versions (the releases issues get as fix
version). `version list` returns each version's name, description, start and
release date, `released`, `archived` (archived ones are listed, marked) and
`overdue`, unreleased first. `version create` adds one version (`--name`,
optional `--description`, `--start`, `--release-date`, dates YYYY-MM-DD); a name
the project already has is refused, as is a release date before the start date.
`version release` marks a version released with today's date or `--date`, and
reports how many of its issues are still unresolved: with `--move-to <version>`
they are moved there (as in Jira's own release dialog), otherwise they stay and
the result says so. Releasing an already released version is reported as
`already-released`, not as an error. Creating and releasing need the Jira
"Administer Projects" permission on the project (typically a project admin);
without it the refusal says so.

`link` links two existing issues and reads like the sentence it records:
`aee-jira link KAN-1 blocks KAN-2` makes KAN-1 block KAN-2. The words between
the two keys are a link type NAME ("Blocks", "Relates") or one of its phrases
("blocks", "is blocked by", "relates to"), case-insensitive — quoting is
optional. The FIRST key is the subject of the phrase: `aee-jira link KAN-2 is
blocked by KAN-1` records the very same link. A type name means its outward
phrase ("Blocks" = "blocks"). `aee-jira link-types` lists the types this site
offers (they are admin-configurable); an unknown type, a phrase two types share,
or linking an issue to itself is refused before anything is written. Linking two
issues that are already linked the same way creates no duplicate — the result
says `created: false` and gives the existing link id. On success the result
states the relationship in plain words (`statement`) and returns the link `id`.
`show` lists an issue's links as seen from that issue
(`links: [{id, type, relationship, otherIssue: {key, summary, status}, statement}]`).
`unlink` removes a link by that `id`, or by the same words that created it; a
link that does not exist is a "not found" error and nothing changes. When Jira
refuses, the error names the cause: the account lacks the "Link Issues"
permission, an issue is not found or not visible, or linking is disabled on the
site.

`set-field` sets ONE custom field. Any custom field is writable by default; if an
admin set a non-empty `writable-custom-fields` allow-list, a field not on that
list is refused. The
field's name → id and value shape (a Team / select / user field is not a plain
string) are resolved server-side. Pass `--value` with the value to set — for an
id-bearing field like Team, pass the id you read via `show --fields "Team"`
(reads return the id alongside the label). `--value-json '<json>'` sends a raw
JSON value verbatim for an exotic field shape. The write is idempotent: setting a
field to the value it already holds reports `changed: false` and makes no change
in Jira's history.

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
options if none leads there. To see those options up front, `show` carries an
`availableTransitions: [{transition, toStatus}, …]` list of the moves the issue's
current status allows. `statuses --project KAN` lists every status the project's
workflow supports, grouped by issue type, independent of any one issue's state.

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
    # Which AGENT is calling (#2562) — set by the platform at container start.
    # The broker forwards it so the platform can pick the credential: the chat
    # sender's own Jira token in a chat turn, the team's service account in an
    # automated run. It names an agent, never a person.
    caller = os.environ.get("AEE_AGENT_CALLER_TOKEN", "")
    if caller:
        headers["X-AEE-Agent-Token"] = caller
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

    p_inbox = sub.add_parser("inbox", parents=[common], help="the queued Jira events (status changes, new issues, comments, field changes) that woke you")
    p_inbox.add_argument(
        "--consume", nargs="+", metavar="EVENT_ID", default=None,
        help="drain exactly these event ids (from your wake payload: `id`, or `events[].id` in a digest); "
             "without --consume the inbox is only peeked",
    )

    sub.add_parser("projects", parents=[common], help="list the Jira projects in this team's scope")

    p_statuses = sub.add_parser(
        "statuses", parents=[common],
        help="list every workflow status a project supports, grouped by issue type",
    )
    p_statuses.add_argument("--project", required=True, help="project key, e.g. KAN")

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
             "row; priority,labels,reporter,components,fixVersions,dueDate add those "
             'columns; any other name is read as a custom field (e.g. "status,Team")',
    )
    p_search.add_argument("--limit", type=int, help="cap the number of issues returned (default 100, max 2000)")

    p_show = sub.add_parser("show", parents=[common], help="read one issue")
    p_show.add_argument("issue", help="issue key, e.g. KAN-6")
    p_show.add_argument(
        "--fields",
        help='comma-separated custom field names to also read, by their Jira name (e.g. "Team,Sprint"); '
             "an empty field comes back as null, distinguishing it from a set one",
    )
    p_show.add_argument(
        "--comment",
        help="also read one comment in full by its id (a comment_added wake's commentId) — "
             "the rest of a body cut short (bodyTruncated)",
    )

    p_comments = sub.add_parser(
        "comments", parents=[common],
        help="read an issue's comments, newest first (id, author, created, updated, body, origin), "
             "e.g. aee-jira comments KAN-10 [--limit N] [--offset N]",
        description="Read the conversation on an issue, newest first: each comment's id, author, created and "
                    "updated (they differ when it was edited), plain-text body and origin (\"agent\" = posted by "
                    "your team through aee-jira, else \"human\"). A long body is cut like a comment_added wake "
                    "(bodyTruncated: true) — read it in full with `aee-jira show <key> --comment <id>`. 20 per "
                    "page by default; hasMore: true means older comments exist — fetch them with --offset "
                    "<nextOffset>. No comments is an empty list; comments your account may not see are not "
                    "listed; an issue outside your team's Jira scope is refused.",
    )
    p_comments.add_argument("issue", help="issue key, e.g. KAN-10")
    p_comments.add_argument("--limit", type=int, help="return at most N comments (1-100, default 20)")
    p_comments.add_argument("--offset", type=int, help="skip the newest N comments, e.g. a result's nextOffset (default 0)")

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

    p_set = sub.add_parser("set-field", parents=[common], help="set an allow-listed custom field on an issue (e.g. Team)")
    p_set.add_argument("issue", help="issue key, e.g. KAN-6")
    p_set.add_argument("--field", required=True, help='the field\'s Jira name, e.g. "Team"')
    g_set = p_set.add_mutually_exclusive_group(required=True)
    g_set.add_argument(
        "--value",
        help="the value to set (shaped per the field's type); for an id-bearing field "
             'like Team pass the id you read with `show --fields "Team"`',
    )
    g_set.add_argument(
        "--value-json",
        help="raw JSON value sent to Jira verbatim (escape hatch for an exotic field shape)",
    )

    p_users = sub.add_parser(
        "users", parents=[common],
        help='find Jira users by name or e-mail → their accountId, the value every --assignee / "assignee" '
             'takes, e.g. aee-jira users "Anna" --project KAN, then aee-jira edit KAN-10 --assignee <accountId>',
        description="Find people so you can assign them. Jira identifies a person by an opaque accountId, never by "
                    "name or e-mail; `edit --assignee`, `create-issue --assignee` and a create-epic / add-stories "
                    "payload's \"assignee\" all take that accountId. Each match carries accountId, displayName, "
                    "email (only when Jira shows it to your account, else null — never guessed), active and "
                    "accountType (\"app\" = a bot, not a person). --project / --issue return only active people "
                    "who can be assigned there. Several people with the same name are all listed and the note says "
                    "so: tell them apart by e-mail or ask — never pick one. No match is an empty list with a "
                    "\"No user found\" note. At most 50 come back; truncated: true means there were more.",
    )
    p_users.add_argument("query", help='a name or e-mail address, or part of one, e.g. "Anna" or "anna@acme.com"')
    g_users = p_users.add_mutually_exclusive_group()
    g_users.add_argument("--project", help="only people who can be assigned issues in this project, e.g. KAN")
    g_users.add_argument("--issue", help="only people who can be assigned this issue, e.g. KAN-10")
    p_users.add_argument("--limit", type=int, help="return at most N people (1-50, default 50)")

    sub.add_parser("link-types", parents=[common], help="list the site's issue link types (name, outward + inward phrase)")

    p_link = sub.add_parser(
        "link", parents=[common],
        help='link two issues, read as a sentence: `link KAN-1 blocks KAN-2` (KAN-1 blocks KAN-2)',
    )
    p_link.add_argument(
        "words", nargs="+", metavar="WORD",
        help='first issue key, a link type name or phrase ("blocks", "is blocked by", "Relates"), second issue key',
    )

    p_unlink = sub.add_parser(
        "unlink", parents=[common],
        help="remove a link by its id (from `show`), or by the words that created it: `unlink KAN-1 blocks KAN-2`",
    )
    p_unlink.add_argument("words", nargs="+", metavar="WORD", help="a link id, or first key, link type, second key")

    p_create = sub.add_parser(
        "create-epic", parents=[common],
        help="create one Epic and its child Stories in one operation (payload from --file or stdin)",
    )
    p_create.add_argument("--project", required=True, help="project key the Epic + Stories are created in, e.g. KAN")
    p_create.add_argument(
        "--file", metavar="PATH",
        help='JSON payload describing {"epic": {...}, "stories": [...]}; omit or use "-" to read stdin',
    )

    p_add_stories = sub.add_parser(
        "add-stories", parents=[common],
        help="add new Stories to an EXISTING Epic (payload from --file or stdin), e.g. "
             "aee-jira add-stories --epic KAN-12 --file stories.json; --type Bug (or a per-issue \"type\") "
             "adds Bugs, Tasks or any standard type instead",
    )
    p_add_stories.add_argument("--epic", required=True, help="key of the existing Epic the Stories go under, e.g. KAN-12")
    p_add_stories.add_argument(
        "--type",
        help='issue type for every issue in the call (default Story), e.g. "Bug", "Task"; a per-issue "type" wins',
    )
    p_add_stories.add_argument(
        "--file", metavar="PATH",
        help='JSON payload describing {"stories": [...]} (or {"issues": [...]}); omit or use "-" to read stdin',
    )

    p_create_issue = sub.add_parser(
        "create-issue", parents=[common],
        help="create ONE standalone issue (Story, Task, Bug, …) without a parent Epic, e.g. "
             'aee-jira create-issue --project KAN --type Bug --summary "Login fails"',
    )
    p_create_issue.add_argument("--project", required=True, help="project key the issue is created in, e.g. KAN")
    p_create_issue.add_argument("--type", required=True, help='the issue type name as the project calls it, e.g. "Bug", "Task", "Story"')
    p_create_issue.add_argument("--summary", help="the issue summary (required here or in --file)")
    p_create_issue.add_argument("--description", help="the description (plain text; blank lines become paragraphs)")
    p_create_issue.add_argument("--assignee", help="the assignee's Atlassian accountId")
    p_create_issue.add_argument("--priority", help='the priority name, e.g. "High"')
    p_create_issue.add_argument("--label", action="append", metavar="LABEL", help="a label (repeatable; Jira labels have no spaces)")
    p_create_issue.add_argument("--status", help="a status to move the new issue to afterwards (a follow-up transition)")
    p_create_issue.add_argument(
        "--field", action="append", metavar="NAME=VALUE",
        help='a custom field by its Jira name, e.g. --field "Team=42" (repeatable)',
    )
    p_create_issue.add_argument(
        "--file", metavar="PATH",
        help='optional JSON object with the same keys (summary, description, assignee, priority, labels, status, fields); "-" reads stdin; flags win',
    )

    p_add_subtasks = sub.add_parser(
        "add-subtasks", parents=[common],
        help="create Sub-tasks under an EXISTING Story / Task / Bug (payload from --file or stdin), e.g. "
             "aee-jira add-subtasks --parent KAN-10 --file subtasks.json",
    )
    p_add_subtasks.add_argument("--parent", required=True, help="key of the existing issue the Sub-tasks go under, e.g. KAN-10")
    p_add_subtasks.add_argument(
        "--type",
        help='the sub-task type for every Sub-task in the call — only needed when the project has several; a per-Sub-task "type" wins',
    )
    p_add_subtasks.add_argument(
        "--file", metavar="PATH",
        help='JSON payload describing {"subtasks": [...]}; omit or use "-" to read stdin',
    )

    p_set_epic = sub.add_parser(
        "set-epic", parents=[common],
        help="put EXISTING issues under an Epic, move them to it, or take them out (--none), e.g. "
             "aee-jira set-epic KAN-30 KAN-31 --epic KAN-12",
    )
    p_set_epic.add_argument("issues", nargs="+", metavar="KEY", help="the existing issues to re-parent, e.g. KAN-30 KAN-31")
    set_epic_target = p_set_epic.add_mutually_exclusive_group(required=True)
    set_epic_target.add_argument("--epic", help="key of the Epic the issues go under, e.g. KAN-12")
    set_epic_target.add_argument("--none", action="store_true", help="take the issues out of their Epic (no parent afterwards)")

    p_edit = sub.add_parser(
        "edit", parents=[common],
        help="change standard fields of an existing issue (summary, assignee, priority, labels, components, "
             'fix versions, due date), e.g. aee-jira edit KAN-10 --priority High --add-label backend',
    )
    p_edit.add_argument("issue", help="issue key, e.g. KAN-10")
    p_edit.add_argument("--summary", help="the new one-line title")
    g_assignee = p_edit.add_mutually_exclusive_group()
    g_assignee.add_argument("--assignee", metavar="ACCOUNT_ID", help="assign to this Atlassian accountId")
    g_assignee.add_argument("--unassign", action="store_true", help="remove the assignee")
    p_edit.add_argument("--priority", help='priority by name, e.g. "High"')
    g_due = p_edit.add_mutually_exclusive_group()
    g_due.add_argument("--due", metavar="YYYY-MM-DD", help="set the due date")
    g_due.add_argument("--clear-due", action="store_true", help="clear the due date")
    for flag, noun in (("label", "label"), ("component", "component"), ("fix-version", "fix version")):
        p_edit.add_argument("--add-%s" % flag, action="append", metavar="NAME", help="add a %s (repeatable)" % noun)
        p_edit.add_argument("--remove-%s" % flag, action="append", metavar="NAME", help="remove a %s (repeatable)" % noun)
        p_edit.add_argument(
            "--set-%ss" % flag, nargs="*", metavar="NAME",
            help="replace all %ss with these (none = empty the list)" % noun,
        )

    p_sprint = sub.add_parser("sprint", parents=[common], help="manage a Scrum board's sprints (list / create / bulk-create / close / start / advance)")
    sprint_sub = p_sprint.add_subparsers(dest="sprint_cmd")

    p_sprint_list = sprint_sub.add_parser("list", parents=[common], help="list a board's sprints (resolved by board name)")
    p_sprint_list.add_argument("--board", required=True, help='the Scrum board name, e.g. "Team Scrum Board"')
    p_sprint_list.add_argument("--project", help="project key/id to disambiguate a board name shared across projects")
    p_sprint_list.add_argument("--state", help="only sprints in these states (comma list of future,active,closed)")

    p_sprint_create = sprint_sub.add_parser("create", parents=[common], help="create one future sprint on a board")
    p_sprint_create.add_argument("--board", required=True, help='the Scrum board name')
    p_sprint_create.add_argument("--project", help="project key/id to disambiguate the board name")
    p_sprint_create.add_argument("--name", required=True, help="the sprint name")
    p_sprint_create.add_argument("--start", required=True, help="start date (YYYY-MM-DD or full ISO-8601)")
    p_sprint_create.add_argument("--end", required=True, help="end date (YYYY-MM-DD or full ISO-8601)")
    p_sprint_create.add_argument("--goal", help="optional sprint goal")

    p_sprint_bulk = sprint_sub.add_parser(
        "bulk-create", parents=[common],
        help="pre-create a run of future sprints up to a target date, continuing from the board's latest sprint",
    )
    p_sprint_bulk.add_argument("--board", required=True, help='the Scrum board name')
    p_sprint_bulk.add_argument("--project", help="project key/id to disambiguate the board name")
    p_sprint_bulk.add_argument(
        "--name-template", required=True, dest="name_template",
        help='name pattern per sprint, e.g. "Acc2.0 {MMM}_{weekOfMonth}"; placeholders '
             "{MMM}/{MMMM}/{MM}/{M} month, {YYYY}/{YY} year, {DD}/{D} day, {weekOfMonth}, {n} — "
             "all computed off the sprint's start day (its Monday)",
    )
    p_sprint_bulk.add_argument("--until", required=True, help="target end date (YYYY-MM-DD) — create sprints through this date")
    p_sprint_bulk.add_argument("--cadence-days", type=int, dest="cadence_days", help="days per sprint (default 7, weekly Mon-Sun)")
    p_sprint_bulk.add_argument(
        "--start",
        help="first sprint's start date; overrides continue-from-latest, and is required when the board has no sprints yet",
    )
    p_sprint_bulk.add_argument("--goal", help="optional goal applied to every created sprint")

    p_sprint_close = sprint_sub.add_parser("close", parents=[common], help="complete (close) the board's active sprint")
    p_sprint_close.add_argument("--board", required=True, help='the Scrum board name')
    p_sprint_close.add_argument("--project", help="project key/id to disambiguate the board name")
    p_sprint_close.add_argument("--sprint-id", dest="sprint_id", help="close this sprint id instead of the board's active one")

    p_sprint_start = sprint_sub.add_parser("start", parents=[common], help="start (activate) the board's next future sprint")
    p_sprint_start.add_argument("--board", required=True, help='the Scrum board name')
    p_sprint_start.add_argument("--project", help="project key/id to disambiguate the board name")
    p_sprint_start.add_argument("--sprint-id", dest="sprint_id", help="start this sprint id instead of the earliest future one")

    p_sprint_advance = sprint_sub.add_parser(
        "advance", parents=[common],
        help="roll the board over: close the active sprint, then start the next future one (both reported)",
    )
    p_sprint_advance.add_argument("--board", required=True, help='the Scrum board name')
    p_sprint_advance.add_argument("--project", help="project key/id to disambiguate the board name")
    p_sprint_advance.add_argument("--close-id", dest="close_id", help="close this sprint id instead of the board's active one")
    p_sprint_advance.add_argument("--start-id", dest="start_id", help="start this sprint id instead of the earliest future one")

    p_version = sub.add_parser("version", parents=[common], help="a project's versions (releases): list / create / release")
    version_sub = p_version.add_subparsers(dest="version_cmd")

    p_version_list = version_sub.add_parser("list", parents=[common], help="list a project's versions, unreleased first")
    p_version_list.add_argument("--project", required=True, help="the project key, e.g. KAN")

    p_version_create = version_sub.add_parser("create", parents=[common], help="create one version in a project")
    p_version_create.add_argument("--project", required=True, help="the project key, e.g. KAN")
    p_version_create.add_argument("--name", required=True, help='the version name, e.g. "1.5"')
    p_version_create.add_argument("--description", help="optional description")
    p_version_create.add_argument("--start", help="optional start date (YYYY-MM-DD)")
    p_version_create.add_argument("--release-date", dest="release_date", help="optional planned release date (YYYY-MM-DD)")

    p_version_release = version_sub.add_parser("release", parents=[common], help="mark a version as released")
    p_version_release.add_argument("--project", required=True, help="the project key, e.g. KAN")
    p_version_release.add_argument("--name", required=True, help='the version to release, e.g. "1.4"')
    p_version_release.add_argument("--date", help="release date (YYYY-MM-DD, default today)")
    p_version_release.add_argument("--move-to", dest="move_to", help="move the version's unresolved issues to this version")

    return parser


def _read_payload_text(file_path):
    """The create-epic / add-stories / add-subtasks payload text: from --file, or stdin when omitted / "-"."""
    if not file_path or file_path == "-":
        return sys.stdin.read()
    with open(file_path, "r", encoding="utf-8") as fh:
        return fh.read()


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
    elif args.cmd == "statuses":
        path = "/statuses?" + urllib.parse.urlencode({"project": args.project})
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
        if args.comment:
            q["comment"] = args.comment
        path = "/show?" + urllib.parse.urlencode(q)
    elif args.cmd == "comments":
        q = {"issue": args.issue}
        if args.limit is not None:
            q["limit"] = args.limit
        if args.offset is not None:
            q["offset"] = args.offset
        path = "/comments?" + urllib.parse.urlencode(q)
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
    elif args.cmd == "set-field":
        payload = {"issue": args.issue, "field": args.field}
        if args.value_json is not None:
            try:
                payload["valueJson"] = json.loads(args.value_json)
            except ValueError as e:
                emit({"ok": False, "error": "usage", "message": "--value-json is not valid JSON: %s" % e}, as_json)
                return EXIT_USAGE
        else:
            payload["value"] = args.value
        path, method, body = "/set-field", "POST", payload
    elif args.cmd == "link-types":
        path = "/link-types"
    elif args.cmd == "users":
        q = {"query": args.query}
        if args.project:
            q["project"] = args.project
        if args.issue:
            q["issue"] = args.issue
        if args.limit is not None:
            q["limit"] = args.limit
        path = "/users?" + urllib.parse.urlencode(q)
    elif args.cmd in ("link", "unlink"):
        words = args.words
        if args.cmd == "unlink" and len(words) == 1:
            body = {"id": words[0]}
        elif len(words) >= 3:
            body = {"from": words[0], "type": " ".join(words[1:-1]), "to": words[-1]}
        else:
            emit({"ok": False, "error": "usage",
                  "message": "usage: aee-jira link <KEY> <link type or phrase> <KEY>   e.g. aee-jira link KAN-1 blocks KAN-2\n"
                             "       aee-jira unlink <linkId>  |  aee-jira unlink <KEY> <link type or phrase> <KEY>"}, as_json)
            return EXIT_USAGE
        path, method = "/" + args.cmd, "POST"
    elif args.cmd == "create-epic":
        try:
            raw = _read_payload_text(args.file)
        except OSError as e:
            emit({"ok": False, "error": "usage", "message": "cannot read payload file: %s" % e}, as_json)
            return EXIT_USAGE
        try:
            doc = json.loads(raw)
        except ValueError as e:
            emit({"ok": False, "error": "usage", "message": "payload is not valid JSON: %s" % e}, as_json)
            return EXIT_USAGE
        if not isinstance(doc, dict) or not isinstance(doc.get("epic"), dict):
            emit({"ok": False, "error": "usage",
                  "message": 'payload must be a JSON object with an "epic" object (and an optional "stories" array)'}, as_json)
            return EXIT_USAGE
        body = {"project": args.project, "epic": doc.get("epic"), "stories": doc.get("stories", [])}
        if isinstance(doc.get("issueTypes"), dict):
            body["issueTypes"] = doc["issueTypes"]
        path, method = "/create-epic", "POST"
    elif args.cmd == "add-stories":
        try:
            raw = _read_payload_text(args.file)
        except OSError as e:
            emit({"ok": False, "error": "usage", "message": "cannot read payload file: %s" % e}, as_json)
            return EXIT_USAGE
        try:
            doc = json.loads(raw)
        except ValueError as e:
            emit({"ok": False, "error": "usage", "message": "payload is not valid JSON: %s" % e}, as_json)
            return EXIT_USAGE
        # #2896: "issues" reads better than "stories" for Bugs and Tasks.
        entries = doc.get("stories", doc.get("issues")) if isinstance(doc, dict) else None
        if not isinstance(entries, list) or not entries:
            emit({"ok": False, "error": "usage",
                  "message": 'payload must be a JSON object with a non-empty "stories" (or "issues") array'}, as_json)
            return EXIT_USAGE
        body = {"epic": args.epic, "stories": entries}
        if args.type:
            body["type"] = args.type
        if isinstance(doc.get("issueTypes"), dict):
            body["issueTypes"] = doc["issueTypes"]
        path, method = "/add-stories", "POST"
    elif args.cmd == "add-subtasks":
        try:
            raw = _read_payload_text(args.file)
        except OSError as e:
            emit({"ok": False, "error": "usage", "message": "cannot read payload file: %s" % e}, as_json)
            return EXIT_USAGE
        try:
            doc = json.loads(raw)
        except ValueError as e:
            emit({"ok": False, "error": "usage", "message": "payload is not valid JSON: %s" % e}, as_json)
            return EXIT_USAGE
        entries = doc.get("subtasks") if isinstance(doc, dict) else None
        if not isinstance(entries, list) or not entries:
            emit({"ok": False, "error": "usage",
                  "message": 'payload must be a JSON object with a non-empty "subtasks" array'}, as_json)
            return EXIT_USAGE
        body = {"parent": args.parent, "subtasks": entries}
        if args.type:
            body["type"] = args.type
        path, method = "/add-subtasks", "POST"
    elif args.cmd == "create-issue":
        issue = {}
        if args.file:
            try:
                raw = _read_payload_text(args.file)
            except OSError as e:
                emit({"ok": False, "error": "usage", "message": "cannot read payload file: %s" % e}, as_json)
                return EXIT_USAGE
            try:
                doc = json.loads(raw)
            except ValueError as e:
                emit({"ok": False, "error": "usage", "message": "payload is not valid JSON: %s" % e}, as_json)
                return EXIT_USAGE
            if not isinstance(doc, dict):
                emit({"ok": False, "error": "usage", "message": "payload must be a JSON object describing the issue"}, as_json)
                return EXIT_USAGE
            issue.update(doc)
        for key in ("summary", "description", "assignee", "priority", "status"):
            value = getattr(args, key)
            if value is not None:
                issue[key] = value
        if args.label:
            issue["labels"] = args.label
        if args.field:
            fields = dict(issue["fields"]) if isinstance(issue.get("fields"), dict) else {}
            for pair in args.field:
                name, sep, value = pair.partition("=")
                if not sep or not name.strip():
                    emit({"ok": False, "error": "usage",
                          "message": '--field takes NAME=VALUE, e.g. --field "Team=42" (got %r)' % pair}, as_json)
                    return EXIT_USAGE
                fields[name.strip()] = value
            issue["fields"] = fields
        if not str(issue.get("summary") or "").strip():
            emit({"ok": False, "error": "usage", "message": "a summary is required (--summary, or \"summary\" in --file)"}, as_json)
            return EXIT_USAGE
        issue_types = issue.pop("issueTypes", None)
        body = {"project": args.project, "type": args.type, "issue": issue}
        if isinstance(issue_types, dict):
            body["issueTypes"] = issue_types
        path, method = "/create-issue", "POST"
    elif args.cmd == "set-epic":
        body = {"issues": args.issues}
        if args.none:
            body["remove"] = True
        else:
            body["epic"] = args.epic
        path, method = "/set-epic", "POST"
    elif args.cmd == "edit":
        body = {"issue": args.issue}
        if args.summary is not None:
            body["summary"] = args.summary
        if args.assignee is not None or args.unassign:
            body["assignee"] = None if args.unassign else args.assignee
        if args.priority is not None:
            body["priority"] = args.priority
        for flag, key in (("label", "labels"), ("component", "components"), ("fix_version", "fixVersions")):
            adds = getattr(args, "add_%s" % flag) or []
            removes = getattr(args, "remove_%s" % flag) or []
            replace = getattr(args, "set_%ss" % flag)
            if replace is not None and (adds or removes):
                dash = flag.replace("_", "-")
                emit({"ok": False, "error": "usage",
                      "message": "--set-%ss replaces the whole list; do not combine it with --add-%s / --remove-%s" % (dash, dash, dash)}, as_json)
                return EXIT_USAGE
            if replace is not None:
                body[key] = {"set": replace}
            elif adds or removes:
                body[key] = {"add": adds, "remove": removes}
        if args.due is not None or args.clear_due:
            body["dueDate"] = None if args.clear_due else args.due
        if len(body) == 1:
            emit({"ok": False, "error": "usage",
                  "message": "nothing to change — pass at least one of --summary, --assignee/--unassign, --priority, "
                             "--add-/--remove-/--set-labels, --add-/--remove-/--set-components, "
                             "--add-/--remove-/--set-fix-versions, --due/--clear-due"}, as_json)
            return EXIT_USAGE
        path, method = "/edit", "POST"
    elif args.cmd == "sprint":
        sprint_cmd = getattr(args, "sprint_cmd", None)
        if sprint_cmd == "list":
            q = {"board": args.board}
            if args.project:
                q["project"] = args.project
            if args.state:
                q["state"] = args.state
            path = "/sprint/list?" + urllib.parse.urlencode(q)
        elif sprint_cmd == "create":
            path, method = "/sprint/create", "POST"
            body = {"board": args.board, "name": args.name, "start": args.start, "end": args.end}
            if args.project:
                body["project"] = args.project
            if args.goal:
                body["goal"] = args.goal
        elif sprint_cmd == "bulk-create":
            path, method = "/sprint/bulk-create", "POST"
            body = {"board": args.board, "nameTemplate": args.name_template, "until": args.until}
            if args.project:
                body["project"] = args.project
            if args.cadence_days is not None:
                body["cadenceDays"] = args.cadence_days
            if args.start:
                body["start"] = args.start
            if args.goal:
                body["goal"] = args.goal
        elif sprint_cmd == "close":
            path, method = "/sprint/close", "POST"
            body = {"board": args.board}
            if args.project:
                body["project"] = args.project
            if args.sprint_id:
                body["sprintId"] = args.sprint_id
        elif sprint_cmd == "start":
            path, method = "/sprint/start", "POST"
            body = {"board": args.board}
            if args.project:
                body["project"] = args.project
            if args.sprint_id:
                body["sprintId"] = args.sprint_id
        elif sprint_cmd == "advance":
            path, method = "/sprint/advance", "POST"
            body = {"board": args.board}
            if args.project:
                body["project"] = args.project
            if args.close_id:
                body["closeSprintId"] = args.close_id
            if args.start_id:
                body["startSprintId"] = args.start_id
        else:
            emit({"ok": False, "error": "usage",
                  "message": "usage: aee-jira sprint list --board <name>\n"
                             "       aee-jira sprint create --board <name> --name <name> --start <date> --end <date>\n"
                             "       aee-jira sprint bulk-create --board <name> --name-template <tmpl> --until <date>\n"
                             "       aee-jira sprint close --board <name> [--sprint-id <id>]\n"
                             "       aee-jira sprint start --board <name> [--sprint-id <id>]\n"
                             "       aee-jira sprint advance --board <name> [--close-id <id>] [--start-id <id>]"}, as_json)
            return EXIT_USAGE
    elif args.cmd == "version":
        version_cmd = getattr(args, "version_cmd", None)
        if version_cmd == "list":
            path = "/version/list?" + urllib.parse.urlencode({"project": args.project})
        elif version_cmd == "create":
            path, method = "/version/create", "POST"
            body = {"project": args.project, "name": args.name}
            if args.description:
                body["description"] = args.description
            if args.start:
                body["startDate"] = args.start
            if args.release_date:
                body["releaseDate"] = args.release_date
        elif version_cmd == "release":
            path, method = "/version/release", "POST"
            body = {"project": args.project, "name": args.name}
            if args.date:
                body["releaseDate"] = args.date
            if args.move_to:
                body["moveTo"] = args.move_to
        else:
            emit({"ok": False, "error": "usage",
                  "message": "usage: aee-jira version list --project <key>\n"
                             "       aee-jira version create --project <key> --name <name> [--description <text>] [--start <date>] [--release-date <date>]\n"
                             "       aee-jira version release --project <key> --name <name> [--date <date>] [--move-to <name>]"}, as_json)
            return EXIT_USAGE
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
    # create-epic is one operation with per-story outcomes: the Epic is created
    # but a story may fail (Jira has no create-transaction). Surface exit 1 so an
    # automated caller notices a partial result, while still printing the Epic
    # key + the per-story map above.
    # add-stories follows the same convention (#2890).
    # set-epic likewise reports one outcome per issue (#2895), add-subtasks
    # one per Sub-task (#2900).
    if args.cmd in ("create-epic", "add-stories", "set-epic", "add-subtasks") and isinstance(result, dict) and result.get("failed"):
        return EXIT_DOMAIN_ERROR
    # create-issue (#2894): the issue exists, but the requested status could not
    # be reached — exit 1 so the caller notices, while still printing the key.
    if args.cmd == "create-issue" and isinstance(result, dict) and result.get("statusError"):
        return EXIT_DOMAIN_ERROR
    # sprint bulk-create is likewise one operation with per-sprint outcomes: a
    # per-sprint failure surfaces exit 1 while still printing the per-sprint map.
    if args.cmd == "sprint" and getattr(args, "sprint_cmd", None) == "bulk-create" \
            and isinstance(result, dict) and result.get("failed"):
        return EXIT_DOMAIN_ERROR
    # sprint advance is a two-phase op (close + start): a partial roll-over
    # (e.g. closed but no future sprint to start) surfaces exit 1 while still
    # printing both phase outcomes above.
    if args.cmd == "sprint" and getattr(args, "sprint_cmd", None) == "advance" \
            and isinstance(result, dict) and result.get("failed"):
        return EXIT_DOMAIN_ERROR
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
