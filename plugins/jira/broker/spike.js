'use strict';

// ─── jira broker: Phase-0 spike helper ──────────────────────────────────────
//
// Runs INSIDE the sidecar (`podman exec aee-plugin-jira node spike.js …`), so
// it needs no scope token and no cross-container curl — it edits the same
// AEE_PLUGIN_STATE_DIR the running poller reads. Delete this file when Phase 4
// ships the /admin watch-config UI.
//
//   node spike.js scopes
//       list every scope that has a watch config (and its inbox depth)
//
//   node spike.js watch --scope <id> --project KAN [--status "Ready for Dev"]
//       set (replace) a scope's watch list — the on-disk equivalent of the
//       Team Admin's /admin UI action, for a session without a console
//
//   node spike.js status --scope <id>
//       the watches, cursors (seen ids), inbox depth
//
//   node spike.js inbox --scope <id> [--consume <id,…>]
//       peek / drain the named event ids from a scope's inbox
//
//   node spike.js probe --project KAN [--window 60] [--status "Ready for Dev"]
//       one-off: run the JQL search + changelog extraction against Jira RIGHT
//       NOW and print every issue found, every status-change event, and which
//       would pass the given --status filter. Uses the env credential
//       (JIRA_SITE_URL / JIRA_EMAIL / JIRA_API_TOKEN). Answers "is it the
//       filter, the API, or the pipeline" in one command.
//
// The <scope id> for a team grant is the team id — read it from a granted
// agent's seeded config:
//   podman exec <orchestrator-container> \
//     cat /workspace/agents/<agentId>/.agent-studio/plugins/jira.json

const path = require('path');
const { brokerConfig } = require('../../../broker-sdk');
const { loadEnvLocal } = require('./env-local');
const { WatchStore } = require('./watch-store');
const { InboxStore } = require('./inbox-store');
const { JiraPoller } = require('./poller');
const jira = require('./jira-client');
const { isChangelogTruncated, extractStatusChangeEvents, matchesStatusFilter, resolveJiraApiBase } = require('./event-extract');

// Same gitignored broker/.env.local server.js reads — spike.js is a separate
// process, so it must load it too (the `probe` command needs the credential).
loadEnvLocal(__dirname);

const cfg = brokerConfig({ fallbacks: { stateDir: ['JIRA_STATE_DIR'] } });
const STATE_DIR = cfg.stateDir || '/state/jira';
const watchStore = new WatchStore({ stateDir: STATE_DIR });
const inboxStore = new InboxStore({ stateDir: STATE_DIR, ttlSeconds: cfg.quota.ttlSeconds, maxObjects: cfg.quota.maxObjects });

function opt(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}
function envCred() {
  const cred = {
    siteUrl: process.env.JIRA_SITE_URL || process.env.JIRA_SITE,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
  };
  if (!cred.siteUrl || !cred.email || !cred.apiToken) {
    die('JIRA_SITE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set (sidecar env or broker/.env.local)');
  }
  return cred;
}

const cmd = process.argv[2];

if (cmd === 'scopes') {
  out(watchStore.listScopes().map((s) => ({ scope: s, watches: watchStore.loadConfig(s).watches.length, inbox: inboxStore.count(s) })));
} else if (cmd === 'watch') {
  const scope = opt('scope') || die('need --scope <id>');
  const project = opt('project') || die('need --project <KEY>');
  const status = opt('status');
  const conf = watchStore.setConfig(scope, {
    watches: [{ projectKey: project, ...(status ? { statusFilters: [status] } : {}) }],
    setBy: 'spike',
  });
  out({ ok: true, scope, watches: conf.watches });
} else if (cmd === 'status') {
  const scope = opt('scope') || die('need --scope <id>');
  const conf = watchStore.loadConfig(scope);
  out({
    scope,
    setBy: conf.setBy,
    setAt: conf.setAt,
    watches: conf.watches,
    cursors: conf.cursors,
    inbox: inboxStore.count(scope),
  });
} else if (cmd === 'inbox') {
  const scope = opt('scope') || die('need --scope <id>');
  const raw = opt('consume');
  if (flag('consume') && !raw) die('--consume takes the event ids to drain: --consume <id>[,<id>…] (a bare --consume no longer drains the whole inbox)');
  if (raw) {
    const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    const { entries, missing } = inboxStore.consumeIds(scope, ids);
    out({ scope, consumed: true, count: entries.length, entries, missing });
  } else {
    const entries = inboxStore.list(scope);
    out({ scope, consumed: false, count: entries.length, entries });
  }
} else if (cmd === 'raw') {
  // Raw passthrough: hit any Jira path with the sidecar's OWN credential and
  // print the HTTP status + body verbatim. The definitive "is it the token, the
  // JQL, or our code" check.  node spike.js raw --path '/rest/api/3/project/search'
  //   node spike.js raw --path /rest/api/3/search/jql --method POST --body '{"jql":"project = KAN","maxResults":3}'
  const cred = envCred();
  const reqPath = opt('path') || die('need --path </rest/api/3/...>');
  const method = (opt('method', 'GET')).toUpperCase();
  const body = opt('body');
  const base = jira.apiBaseFor(cred.siteUrl, process.env);
  (async () => {
    const res = await fetch(base + reqPath, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: jira.basicAuthHeader(cred.email, cred.apiToken),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body || undefined,
    });
    const text = await res.text();
    out({ base, path: reqPath, method, httpStatus: res.status, tokenTail: `…${String(cred.apiToken).slice(-6)}`, body: text.slice(0, 3000) });
  })().catch((e) => die(`raw failed: ${e.message}`));
} else if (cmd === 'poke') {
  // Force one real poll of a scope RIGHT NOW (the exact poller path), logging
  // everything and printing what would be delivered. --scope <id> [--reset]
  const scope = opt('scope') || die('need --scope <id>');
  const cred = envCred();
  if (flag('reset')) {
    const conf = watchStore.loadConfig(scope);
    for (const k of Object.keys(conf.cursors)) delete conf.cursors[k];
    watchStore.setConfig(scope, { watches: conf.watches, setBy: conf.setBy });
    process.stderr.write(`(reset cursors for ${scope})\n`);
  }
  const delivered = [];
  const poller = new JiraPoller({
    watchStore,
    inboxStore,
    resolveCredential: () => cred,
    deliver: async (p) => { delivered.push({ kind: p.kind, convKey: p.convKey, eventIds: (p.events || []).map((e) => e.id) }); },
    env: process.env,
    log: (m) => process.stderr.write(`${m}\n`),
    now: () => Date.now(),
  });
  (async () => {
    const summary = await poller.pollScope(scope);
    out({ summary, delivered, inbox: inboxStore.count(scope) });
  })().catch((e) => die(`poke failed: ${e.stack || e.message}`));
} else if (cmd === 'debug-search') {
  // Exactly what searchProjectIssues does, with every step logged. --project KAN [--window 10080]
  const cred = envCred();
  const project = opt('project') || die('need --project <KEY>');
  const windowMinutes = Number(opt('window', '60'));
  const base = jira.apiBaseFor(cred.siteUrl, process.env);
  const jql = jira.buildProjectJql(project, windowMinutes);
  const reqBody = jira.buildJqlSearchBody(jql);
  (async () => {
    const url = `${base}/rest/api/3/search/jql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agent-studio-jira-plugin',
        Authorization: jira.basicAuthHeader(cred.email, cred.apiToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { PARSE_ERROR: e.message }; }
    out({
      url,
      sentBody: reqBody,
      sentBodyString: JSON.stringify(reqBody),
      httpStatus: res.status,
      contentType: res.headers.get('content-type'),
      respLength: text.length,
      respHead: text.slice(0, 400),
      parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
      issuesType: parsed ? typeof parsed.issues : null,
      issuesCount: parsed && Array.isArray(parsed.issues) ? parsed.issues.length : null,
    });
  })().catch((e) => die(`debug-search failed: ${e.stack || e.message}`));
} else if (cmd === 'whoami-jira') {
  const cred = envCred();
  (async () => {
    out({ site: resolveJiraApiBase(cred.siteUrl), configuredEmail: cred.email, jiraSays: await jira.whoAmI(cred) });
  })().catch((e) => die(`whoami-jira failed: ${e.message}`));
} else if (cmd === 'projects') {
  const cred = envCred();
  (async () => {
    const projects = await jira.listProjects(cred);
    out({ site: resolveJiraApiBase(cred.siteUrl), visibleToTokenUser: projects.length, projects });
  })().catch((e) => die(`projects failed: ${e.message}`));
} else if (cmd === 'probe') {
  const project = opt('project');
  const rawJql = opt('jql');
  if (!project && !rawJql) die('need --project <KEY> or --jql "<query>"');
  const windowMinutes = Number(opt('window', '60'));
  const statusFilter = opt('status') || null;
  const cred = envCred();
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  (async () => {
    const issues = rawJql
      ? await jira.searchJql(cred, rawJql)
      : await jira.searchProjectIssues(cred, { projectKey: project, windowMinutes });
    const report = {
      jql: rawJql || jira.buildProjectJql(project, windowMinutes),
      issuesFound: issues.length,
      issues: [],
    };
    for (const issue of issues) {
      let changelog = issue.changelog;
      const noInline = !changelog || !Array.isArray(changelog.histories) || changelog.histories.length === 0;
      let backfilled = false;
      if (isChangelogTruncated(changelog) || noInline) {
        try {
          changelog = { ...(changelog || {}), histories: await jira.fetchFullChangelog(cred, issue.key) };
          backfilled = true;
        } catch (e) { report.issues.push({ key: issue.key, changelogError: e.message }); continue; }
      }
      const events = extractStatusChangeEvents({ ...issue, changelog }, { projectKey: project || issue.key.split('-')[0], siteBase });
      report.issues.push({
        key: issue.key,
        currentStatus: issue.status,
        changelogBackfilled: backfilled,
        statusChanges: events.map((e) => ({
          id: e.id, from: e.fromStatus, to: e.toStatus, at: e.created,
          passesFilter: matchesStatusFilter(e.toStatus, statusFilter),
        })),
      });
    }
    report.statusFilter = statusFilter;
    report.wouldFire = report.issues.flatMap((i) => (i.statusChanges || []).filter((c) => c.passesFilter).map((c) => c.id));
    out(report);
  })().catch((e) => die(`probe failed: ${e.message}`));
} else {
  die('usage: node spike.js {scopes|watch|status|inbox|whoami-jira|projects|probe|raw|poke|debug-search} [--scope <id>] [--project KEY] [--jql "<query>"] [--status "..."] [--window MIN] [--consume]');
}
