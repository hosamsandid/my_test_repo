'use strict';

// Subscription-OAuth login flows for Model Providers (#feat/llm-subscription-oauth).
//
// Drives the *official* `claude setup-token` command — the sanctioned way to
// mint a long-lived (~1 year) Claude subscription OAuth token — under a
// pseudo-terminal, so the Admin Console can walk an operator through the
// browser login without anyone needing a local shell:
//
//   1. start()      → spawns `claude setup-token` (via util-linux `script`,
//                     which allocates the PTY the interactive CLI requires),
//                     scrapes the authorize URL from its output
//   2. operator opens the URL, approves in the browser, receives a code
//   3. submitCode() → writes the code into the CLI's stdin
//   4. the CLI prints the long-lived token; we capture it in memory only
//   5. claimToken() → one-time read by the admin console (server-side), which
//                     persists it into the LLM-endpoint token store; the flow
//                     manager wipes its copy immediately
//
// Deliberate properties:
//   - The token never touches disk here and never appears in a status
//     response — only the explicit one-shot claim returns it.
//   - Raw CLI output is kept only in memory for URL/token scraping and is
//     never logged (it contains the token at the end).
//   - Single-slot: starting a new flow cancels a previous unfinished one.
//     Login flows are an operator action; there is no concurrent use case.
//   - Each flow runs with a throwaway $HOME under /tmp so the orchestrator's
//     own Claude state is untouched, and with all ANTHROPIC_* variables
//     stripped so the proxy configuration cannot interfere with the login.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Pure output-scraping helpers (unit-tested) ─────────────────────────────

// Remove ANSI escape/control sequences and carriage returns so URL/token
// regexes see plain text even when the CLI renders a TUI.
function stripAnsi(s) {
  return String(s)
    // CSI sequences (colors, cursor movement) incl. private-mode prefixes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences (terminal title, hyperlinks) — keep the visible payload
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // stray escapes + carriage returns
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '\n');
}

// A usable authorize URL must carry the full query string — a URL cut off by
// a terminal line-wrap or a mid-URL output chunk is rejected by claude.ai
// with "Missing redirect_uri parameter". `redirect_uri` and `state` sit at
// the tail end of the query, so their presence is a good completeness signal.
function isCompleteAuthUrl(url) {
  return /[?&]redirect_uri=/.test(url) && /[?&]state=/.test(url);
}

// First https URL that belongs to the Claude OAuth flow. The CLI may print it
// several times while redrawing its TUI, and a narrow terminal may wrap it
// across lines. Strategy: scan the text as-is first (the flow widens the PTY
// so the URL normally sits on one line), then retry with wrapped lines
// re-joined; prefer a complete candidate, else the longest one seen. The
// character class is a strict URL alphabet so surrounding prose can never be
// glued onto a candidate by the line-joining pass.
const AUTH_URL_RE = /https:\/\/(?:claude\.ai|claude\.com|console\.anthropic\.com)\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]*oauth[A-Za-z0-9\-._~:/?#@!$&*+,;=%]*/g;

function extractAuthUrl(cleanText) {
  const direct = cleanText.match(AUTH_URL_RE) || [];
  const completeDirect = direct.find(isCompleteAuthUrl);
  if (completeDirect) return completeDirect;
  const joined = (cleanText.replace(/\n(?=[^\s])/g, '').match(AUTH_URL_RE)) || [];
  const completeJoined = joined.find(isCompleteAuthUrl);
  if (completeJoined) return completeJoined;
  const all = [...direct, ...joined];
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.length > a.length ? b : a));
}

// Long-lived subscription token as printed by `claude setup-token` — always
// prefixed `sk-ant-oat…` (the value the CLI stores as CLAUDE_CODE_OAUTH_TOKEN).
// We must NOT match the bare `sk-ant-at…` prefix: that is the short-lived OAuth
// *access token* which flashes in the PTY output during the code exchange, is
// rejected by api.anthropic.com ("Invalid bearer token"), and — because it
// appears before the final `oat` token — would otherwise be captured first.
// `sk-ant-api…` keys are likewise excluded so a stray API key in the
// environment can't be mistaken for the freshly minted token.
const OAUTH_TOKEN_RE = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}/;

function extractToken(cleanText) {
  const m = cleanText.match(OAUTH_TOKEN_RE);
  return m ? m[0] : null;
}

// Exchange failures the CLI reports after a code was submitted, e.g.
// "OAuth error: Invalid code. …". The CLI keeps running ("Press Enter to
// retry."), so these are recoverable — the flow returns to awaiting-code.
function extractOauthErrors(cleanText) {
  return cleanText.match(/OAuth error:?[^\n]*/gi) || [];
}

// ── Flow manager ────────────────────────────────────────────────────────────

const FLOW_TTL_MS = 10 * 60 * 1000;        // whole login must finish within 10 min
const CLAIM_TTL_MS = 10 * 60 * 1000;       // captured token is held at most 10 min
const URL_WAIT_MS = 15 * 1000;             // start() waits this long for the URL
const OUTPUT_CAP = 256 * 1024;             // buffer cap — the CLI output is tiny

function createLlmAuthFlowManager({ workDirRoot = '/tmp/llm-auth-flows', log = console } = {}) {
  let active = null; // single-slot: { id, state, ... }

  function publicView(flow) {
    if (!flow) return null;
    return {
      flowId: flow.id,
      status: flow.state,
      authUrl: flow.authUrl || null,
      error: flow.error || null,
      startedAt: flow.startedAt,
    };
  }

  // Failure-path diagnostics: the last chunk of what the CLI actually showed,
  // with any token redacted. Logged only when a flow fails, so an operator
  // can tell an unexpected prompt from a network problem without shell access.
  function redactedTail(flow, n = 600) {
    return stripAnsi(flow.output)
      .replace(/sk-ant-o?at[0-9]{2}-[A-Za-z0-9_-]{10,}/g, '<TOKEN>')
      .replace(/\n{3,}/g, '\n\n')
      .slice(-n);
  }

  function cleanupFlow(flow, nextState, errorMsg) {
    if (!flow) return;
    if (flow.ttlTimer) clearTimeout(flow.ttlTimer);
    if (flow.urlSettleTimer) { clearTimeout(flow.urlSettleTimer); flow.urlSettleTimer = null; }
    if (flow.child && flow.child.exitCode === null && !flow.child.killed) {
      try { flow.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    flow.child = null;
    flow.output = '';
    if (nextState) flow.state = nextState;
    if (errorMsg) flow.error = errorMsg;
    // remove the throwaway HOME (best effort)
    if (flow.home) {
      try { fs.rmSync(flow.home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  function acceptAuthUrl(flow, url) {
    if (flow.authUrl) return;
    flow.authUrl = url;
    if (flow.urlSettleTimer) { clearTimeout(flow.urlSettleTimer); flow.urlSettleTimer = null; }
    if (flow.state === 'starting') flow.state = 'awaiting-code';
    log.log(`[LlmAuth] flow ${flow.id}: authorize URL captured — awaiting code`);
  }

  function scan(flow) {
    const clean = stripAnsi(flow.output);
    if (!flow.authUrl) {
      const url = extractAuthUrl(clean);
      if (url && isCompleteAuthUrl(url)) {
        acceptAuthUrl(flow, url);
      } else if (url) {
        // Candidate looks truncated — most likely an output chunk ended in
        // the middle of the URL. Re-check after the output settles; by then
        // the rest has arrived (or this really is all the CLI printed).
        if (flow.urlSettleTimer) clearTimeout(flow.urlSettleTimer);
        flow.urlSettleTimer = setTimeout(() => {
          flow.urlSettleTimer = null;
          const settled = extractAuthUrl(stripAnsi(flow.output));
          if (settled) acceptAuthUrl(flow, settled);
        }, 1000);
        if (flow.urlSettleTimer.unref) flow.urlSettleTimer.unref();
      }
    }
    // Recoverable exchange failure (wrong/incomplete code): surface it, nudge
    // the CLI back to its paste prompt ("Press Enter to retry.") and let the
    // operator paste again. Redraw frames can repeat an old error line, so
    // only a *new* occurrence (vs the count recorded at submit time) counts.
    if (flow.state === 'exchanging' && !flow.token) {
      const errs = extractOauthErrors(clean);
      if (errs.length > (flow.oauthErrorCount || 0)) {
        flow.oauthErrorCount = errs.length;
        flow.error = `${errs[errs.length - 1].slice(0, 160).trim()} — paste the code again.`;
        flow.state = 'awaiting-code';
        try { flow.child?.stdin.write('\r'); } catch { /* prompt nudge is best effort */ }
        log.warn(`[LlmAuth] flow ${flow.id}: code exchange failed — awaiting new code`);
      }
    }

    const token = extractToken(clean);
    if (token && !flow.token) {
      flow.token = token;
      flow.state = 'done';
      log.log(`[LlmAuth] flow ${flow.id}: token captured (held in memory for claim)`);
      // Token is in hand — stop the CLI and drop the output buffer so the
      // secret exists in exactly one place (flow.token) until claimed.
      cleanupFlow(flow, 'done');
      flow.claimTimer = setTimeout(() => {
        if (flow.token) {
          flow.token = null;
          flow.state = 'expired';
          flow.error = 'Token was not claimed in time and has been discarded.';
          log.warn(`[LlmAuth] flow ${flow.id}: unclaimed token discarded`);
        }
      }, CLAIM_TTL_MS);
      if (flow.claimTimer.unref) flow.claimTimer.unref();
    }
  }

  // Submit the just-pasted code by sending lone Return keystrokes as separate
  // writes, on a short cadence, until the CLI leaves the paste prompt (token
  // issued, or an error flips the flow back to 'awaiting-code'). A single '\r'
  // was observed to be enough once the paste settled; the extra nudges cover
  // slower processing. Each is guarded on still-exchanging, so a nudge can't
  // leak a stray newline into a later prompt.
  function scheduleSubmitReturns(flow) {
    for (const delay of [350, 1000, 2200]) {
      const t = setTimeout(() => {
        if (flow.state !== 'exchanging' || !flow.child) return;
        try { flow.child.stdin.write('\r'); } catch { /* best effort */ }
      }, delay);
      if (t.unref) t.unref();
    }
  }

  async function start() {
    // Cancel a lingering previous flow — single slot.
    if (active && !['done', 'error', 'expired', 'cancelled'].includes(active.state)) {
      log.warn(`[LlmAuth] cancelling previous flow ${active.id} (superseded)`);
      cleanupFlow(active, 'cancelled', 'Superseded by a newer login flow.');
    }

    const id = crypto.randomBytes(8).toString('hex');
    const home = path.join(workDirRoot, id);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Pre-seed onboarding state so the CLI goes straight to the token flow
    // instead of asking first-run questions in the PTY.
    try {
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
        { mode: 0o600 },
      );
    } catch { /* non-fatal — worst case the CLI asks, and the flow times out */ }

    // Strip every credential/endpoint variable so the login runs against the
    // real Anthropic endpoints, not the operator's proxy.
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
    }
    env.HOME = home;
    env.TERM = 'xterm-256color';
    env.NO_COLOR = '1';

    const flow = {
      id,
      state: 'starting',
      startedAt: new Date().toISOString(),
      home,
      output: '',
      authUrl: null,
      token: null,
      error: null,
      child: null,
      ttlTimer: null,
      claimTimer: null,
      urlSettleTimer: null,
      oauthErrorCount: 0,
    };
    active = flow;

    // `claude setup-token` needs a TTY; util-linux `script` allocates one and
    // forwards our pipe-stdin to it — no native pty dependency required.
    // The PTY is widened first (`stty cols 500`) so the CLI never line-wraps
    // the authorize URL — a wrapped URL is easy to scrape incorrectly and a
    // truncated one is rejected by claude.ai ("Missing redirect_uri").
    let child;
    try {
      child = spawn('script', ['-qefc', 'stty cols 500 rows 100 2>/dev/null; claude setup-token', '/dev/null'], {
        env,
        cwd: home,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      cleanupFlow(flow, 'error', `Could not start login flow: ${err.message}`);
      return publicView(flow);
    }
    flow.child = child;

    const onData = (d) => {
      if (flow.output.length < OUTPUT_CAP) flow.output += d.toString('utf8');
      scan(flow);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      // e.g. `script` binary missing in the image
      if (flow.state !== 'done') {
        cleanupFlow(flow, 'error', `Login flow failed to launch: ${err.message}`);
      }
    });
    child.on('exit', (code) => {
      if (flow.state === 'done') return; // token already captured
      if (['error', 'expired', 'cancelled'].includes(flow.state)) return;
      log.warn(`[LlmAuth] flow ${flow.id}: CLI exited early (code ${code}); last output (redacted):\n${redactedTail(flow)}`);
      cleanupFlow(
        flow,
        'error',
        `claude setup-token exited (code ${code}) before a token was issued. ` +
        'Check that the code was pasted correctly, or use the manual token paste instead.',
      );
    });

    flow.ttlTimer = setTimeout(() => {
      if (!['done', 'error', 'cancelled'].includes(flow.state)) {
        log.warn(`[LlmAuth] flow ${flow.id}: timed out in state '${flow.state}'; last output (redacted):\n${redactedTail(flow)}`);
        cleanupFlow(flow, 'expired', 'Login flow timed out. Start a new login.');
      }
    }, FLOW_TTL_MS);
    if (flow.ttlTimer.unref) flow.ttlTimer.unref();

    // Give the CLI a moment to print the authorize URL so the UI gets it in
    // the start response; if it's slower the client keeps polling.
    const deadline = Date.now() + URL_WAIT_MS;
    while (!flow.authUrl && flow.state === 'starting' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }
    return publicView(flow);
  }

  function get(flowId) {
    if (!active || active.id !== flowId) return null;
    return publicView(active);
  }

  function submitCode(flowId, code) {
    if (!active || active.id !== flowId) return { error: 'flow not found', status: 404 };
    const flow = active;
    if (!['awaiting-code', 'starting'].includes(flow.state)) {
      return { error: `flow is in state '${flow.state}', not awaiting a code`, status: 409 };
    }
    if (!flow.child || flow.child.exitCode !== null) {
      return { error: 'login process is no longer running', status: 409 };
    }
    const trimmed = String(code || '').trim();
    if (!trimmed) return { error: 'code is required', status: 400 };
    try {
      // Deliver the code WITHOUT a trailing Return: the CLI's Ink paste prompt
      // absorbs a carriage return that arrives in the same write as the pasted
      // text, so it never submits. Submitting reliably needs a *separate*
      // Return keystroke once the paste has been processed (verified against
      // the real CLI — the token only appeared after a standalone '\r').
      flow.child.stdin.write(trimmed);
    } catch (err) {
      return { error: `could not deliver code to the login process: ${err.message}`, status: 500 };
    }
    flow.state = 'exchanging';
    flow.error = null;
    // Baseline for the recoverable-failure detector: only error lines printed
    // *after* this submission count as this submission's failure.
    flow.oauthErrorCount = extractOauthErrors(stripAnsi(flow.output)).length;
    scheduleSubmitReturns(flow);
    log.log(`[LlmAuth] flow ${flow.id}: code submitted — exchanging`);
    return { ok: true, view: publicView(flow) };
  }

  // One-shot: returns the token exactly once, then forgets it.
  function claimToken(flowId) {
    if (!active || active.id !== flowId) return { error: 'flow not found', status: 404 };
    const flow = active;
    if (flow.state !== 'done' || !flow.token) {
      return { error: `flow is in state '${flow.state}' — no token to claim`, status: 409 };
    }
    const token = flow.token;
    flow.token = null;
    flow.state = 'claimed';
    if (flow.claimTimer) clearTimeout(flow.claimTimer);
    log.log(`[LlmAuth] flow ${flow.id}: token claimed`);
    return { token };
  }

  function cancel(flowId) {
    if (!active || active.id !== flowId) return { error: 'flow not found', status: 404 };
    const flow = active;
    flow.token = null;
    if (flow.claimTimer) clearTimeout(flow.claimTimer);
    cleanupFlow(flow, 'cancelled', null);
    log.log(`[LlmAuth] flow ${flow.id}: cancelled`);
    return { ok: true };
  }

  return { start, get, submitCode, claimToken, cancel };
}

module.exports = { createLlmAuthFlowManager, stripAnsi, extractAuthUrl, extractToken, isCompleteAuthUrl, extractOauthErrors };
