// Pure helpers for the Session Log's CI-wait card (#2841, #651 convention): a
// Bash tool call that runs `aee-wait-ci` renders as a readable "Waiting for CI ·
// PR #N" block with its verdict instead of a raw command + JSON blob. The full
// command and the raw JSON stay available on expand (ToolBlock).
//
// Option parsing mirrors agent-image/scripts/aee-wait-ci parse_args /
// parse_pr_arg. A call whose arguments do not parse (a usage error, exit 2)
// still renders as a card with its verdict (`Error`), just without a PR.

import { formatElapsed } from './tool-progress.js';

export const DEFAULT_TIMEOUT_MIN = 20;
// aee-wait-ci MAX_TIMEOUT_MIN — a larger --timeout is capped there.
export const MAX_TIMEOUT_MIN = 50;

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Shell control operators end the aee-wait-ci command (pipe into tail,
// `&& echo …`, `; echo exit=$?`, redirections like `2>&1`, background).
const isOperator = (tok) => /^(\d*[<>]|[|&;()])/.test(tok);

// Minimal POSIX-ish tokenizer: whitespace splits, quotes group, operators are
// their own tokens. Good enough to read an agent's one-line command.
export function shellTokens(command) {
  const tokens = [];
  if (typeof command !== 'string') return tokens;
  let cur = '';
  let has = false;
  let quote = null;
  const flush = () => { if (has) tokens.push(cur); cur = ''; has = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if ('|&;<>()'.includes(ch)) {
      // `2>` / `2>&1`: the fd number belongs to the redirection.
      let fd = '';
      if ((ch === '>' || ch === '<') && has && /^\d+$/.test(cur)) { fd = cur; cur = ''; has = false; }
      flush();
      let op = ch;
      const two = command.slice(i, i + 2);
      if (two === '||' || two === '&&' || two === '>>' || two === '|&') { op = two; i++; }
      tokens.push(fd + op);
      continue;
    }
    cur += ch;
    has = true;
  }
  flush();
  return tokens;
}

function isWaitCiToken(tok) {
  return tok === 'aee-wait-ci' || tok.endsWith('/aee-wait-ci');
}

// True when the Bash command runs aee-wait-ci at all, parseable or not.
export function invokesWaitCi(command) {
  return shellTokens(command).some(isWaitCiToken);
}

/**
 * Parse a Bash command for an aee-wait-ci call:
 *   { pr, repoArg, urlRepo, timeoutMinutes } or null when it is not one (or
 * would be a usage error: no PR, two PRs, a bad --timeout, an unknown option).
 */
export function parseCiWaitCommand(command) {
  const tokens = shellTokens(command);
  const start = tokens.findIndex(isWaitCiToken);
  if (start < 0) return null;
  const args = [];
  for (let i = start + 1; i < tokens.length && !isOperator(tokens[i]); i++) args.push(tokens[i]);
  let prRaw = null;
  let repoArg = null;
  let timeout = DEFAULT_TIMEOUT_MIN;
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let val;
    if (a === '--repo' || a === '--timeout' || a === '--head') {
      if (i + 1 >= args.length) return null;
      val = args[++i];
    } else if (/^--(repo|timeout|head)=/.test(a)) {
      const eq = a.indexOf('=');
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (a === '--no-conflict-check' || a === '--json') {
      continue;
    } else if (a.startsWith('-')) {
      return null;
    } else {
      if (prRaw !== null) return null;
      prRaw = a;
      continue;
    }
    if (a === '--repo') repoArg = val;
    else if (a === '--timeout') {
      const n = Number(val);
      if (!Number.isFinite(n) || !(n > 0)) return null;
      timeout = n;
    }
  }
  if (prRaw === null) return null;
  const m = PR_URL_RE.exec(prRaw.trim());
  let pr;
  let urlRepo = null;
  if (m) {
    pr = Number(m[4]);
    urlRepo = { host: m[1].toLowerCase(), slug: `${m[2]}/${m[3]}` };
  } else {
    const s = prRaw.trim().replace(/^#+/, '');
    if (!/^\d+$/.test(s) || Number(s) <= 0) return null;
    pr = Number(s);
  }
  return { pr, repoArg, urlRepo, timeoutMinutes: Math.min(timeout, MAX_TIMEOUT_MIN) };
}

// `owner/name` from a GitHub remote URL (https or ssh), else null.
export function slugFromRemote(url) {
  if (typeof url !== 'string') return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The agent's repositories (GET /api/agents/:id/repositories) as
// [{ dirName, slug }] for resolving a `--repo <clone-dir>` or the default repo.
export function buildRepoDirectory(repositories) {
  if (!Array.isArray(repositories)) return [];
  return repositories
    .map(r => ({ dirName: r?.dirName || null, slug: slugFromRemote(r?.url) }))
    .filter(r => r.slug);
}

/**
 * `owner/name` of the PR's repository, best source first: the result's own
 * `repo` (what aee-wait-ci actually resolved), the PR URL, a `--repo
 * owner/name`, a `--repo <clone-dir>` mapped through the agent's
 * repositories, else the agent's only repository. null when unknown.
 */
export function resolveCiWaitRepo(parsed, result, repoDirectory = []) {
  if (result && typeof result.repo === 'string' && SLUG_RE.test(result.repo)) return result.repo;
  if (!parsed) return null;
  if (parsed.urlRepo) return parsed.urlRepo.slug;
  const dir = Array.isArray(repoDirectory) ? repoDirectory : [];
  if (parsed.repoArg) {
    const arg = parsed.repoArg.replace(/\/+$/, '');
    const fromRemote = arg.includes(':') ? slugFromRemote(arg) : null;
    if (fromRemote) return fromRemote;
    const base = arg.split('/').pop();
    const byDir = dir.find(r => r.dirName && (r.dirName === arg || r.dirName === base));
    if (byDir) return byDir.slug;
    if (SLUG_RE.test(arg) && !arg.startsWith('.')) return arg;
    return null;
  }
  const slugs = [...new Set(dir.map(r => r.slug))];
  return slugs.length === 1 ? slugs[0] : null;
}

export function prUrl(slug, pr, host = 'github.com') {
  if (!slug || !(pr > 0)) return null;
  return `https://${host}/${slug}/pull/${pr}`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : ''))).join('\n');
  }
  return '';
}

/**
 * Read aee-wait-ci's verdict from the tool result: the last JSON line carrying
 * a `status` (the CLI prints exactly one), else an exit code the agent echoed
 * or Claude Code prefixed (`Exit code 4`, `exit=4`). null when neither.
 *   { json: object|null, exitCode: number|null }
 */
export function parseCiWaitResult(content) {
  const text = contentText(content);
  if (!text) return null;
  let json = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && !json; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.status === 'string') json = obj;
    } catch { /* not the result line */ }
  }
  let exitCode = null;
  const em = /(?:^|\n)\s*(?:Exit code:?\s*|exit(?:[ _-]?code)?\s*[=:]\s*)(\d+)\b/i.exec(text);
  if (em) exitCode = Number(em[1]);
  if (json && Number.isInteger(json.exitCode)) exitCode = exitCode ?? json.exitCode;
  if (!json && exitCode === null) return null;
  return { json, exitCode };
}

const VERDICTS = {
  passed: { label: 'CI passed', tone: 'ok' },
  'no-ci': { label: 'No CI configured', tone: 'ok' },
  failed: { label: 'CI failed', tone: 'error' },
  conflict: { label: 'Merge conflict', tone: 'error' },
  timeout: { label: 'Timed out', tone: 'warn' },
  error: { label: 'Error', tone: 'error' },
};

const STATUS_FOR_EXIT = { 0: 'passed', 1: 'error', 2: 'error', 3: 'error', 4: 'failed', 5: 'conflict', 6: 'timeout' };

/**
 * { key, label, tone } for a parsed result, or null (→ normal result view).
 * The JSON wins (`status`, refined by `ci` / `merge`); the exit code is the
 * fallback. Exit 0 alone cannot tell passed from no-ci and reads as passed.
 */
export function ciVerdict(parsedResult) {
  if (!parsedResult) return null;
  const { json, exitCode } = parsedResult;
  let key = null;
  if (json) {
    if (VERDICTS[json.status]) key = json.status;
    else if (json.merge === 'conflict') key = 'conflict';
    else if (json.ci === 'failed') key = 'failed';
    else if (json.ci === 'none') key = 'no-ci';
    else if (json.ci === 'passed') key = 'passed';
  }
  if (!key && exitCode !== null) key = STATUS_FOR_EXIT[exitCode] || null;
  return key ? { key, ...VERDICTS[key] } : null;
}

function formatMinutes(min) {
  const n = Math.round(min * 10) / 10;
  return `${n}m`;
}

/**
 * Everything the CI-wait card shows, or null when the tool call does not run
 * aee-wait-ci (the normal ToolBlock rendering stays).
 *   { pr, repo, url, timeoutText, verdict, waitedSeconds, json }
 * A call whose arguments do not parse (usage error, exit 2) still gets a card:
 * `pr` / `url` are null unless the result names them, the verdict reads from
 * the result (`Error`).
 * `verdict` is null while pending — or when the result could not be read, in
 * which case `unreadable` is true and the normal result view is kept.
 */
export function ciWaitCard(toolUse, toolResult, repoDirectory) {
  if (!toolUse || toolUse.tool !== 'Bash') return null;
  const command = toolUse.input?.command;
  const parsed = parseCiWaitCommand(command);
  if (!parsed && !invokesWaitCi(command)) return null;
  const result = toolResult ? parseCiWaitResult(toolResult.content) : null;
  const json = result?.json || null;
  const repo = resolveCiWaitRepo(parsed, json, repoDirectory);
  const pr = json && Number.isInteger(json.pr) && json.pr > 0 ? json.pr : (parsed?.pr ?? null);
  const verdict = ciVerdict(result);
  return {
    pr,
    repo,
    url: prUrl(repo, pr, parsed?.urlRepo?.host),
    timeoutText: `max ${formatMinutes(parsed ? parsed.timeoutMinutes : DEFAULT_TIMEOUT_MIN)}`,
    verdict,
    unreadable: !!toolResult && !verdict,
    waitedSeconds: json && Number.isFinite(json.waitedSeconds) ? json.waitedSeconds : null,
    json,
  };
}

/**
 * Header text of a ToolBlock: `{ label, trailing }`. A CI-wait card names the
 * wait or its verdict (the command moves to the expand) and shows
 * `6m 00s of max 20m` while waiting; any other block keeps the tool name and
 * gets the run cue (`running · 6m 00s` / `took 6m 12s`) from `toolRunView`.
 */
export function toolHeaderText({ tool, ci, runView, pending, stopped }) {
  const rv = runView || { label: '', elapsedText: '' };
  if (!ci) return { label: tool, trailing: rv.label };
  const label = ci.verdict ? ci.verdict.label : 'Waiting for CI';
  if (stopped) return { label, trailing: rv.label || 'stopped' };
  if (pending) {
    return { label, trailing: rv.elapsedText ? `${rv.elapsedText} of ${ci.timeoutText}` : ci.timeoutText };
  }
  const took = rv.elapsedText || formatElapsed(ci.waitedSeconds);
  return { label, trailing: took ? `took ${took}` : '' };
}
