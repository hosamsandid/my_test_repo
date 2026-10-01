'use strict';

// ─── hill-climb card write routes (#1224 merge, #1225 apply, #1226 rollback) ──
//
// The three POST routes that write the improvement-card store on the console's
// behalf. Kept in their own module (deps injected) so they can be executed by a
// test with a real JSON body — they once double-parsed the object `readBody()`
// returns (`JSON.parse(<object>)` → `"[object Object]" is not valid JSON` →
// 500), which turned every Apply into a 502 applied-not-recorded (#2709).
//
// `deps`:
//   loadAgentConfig(id)                              → config | null
//   hillClimbCardConfig(teamId)                      → { autonomy, … }
//   readHillClimbCards(teamId)                       → card[]
//   mergeAndPersistHillClimbCards(teamId, cards, o)  → { added, bumped, deferred, rejected, cards }
//   applyHillClimbCard(teamId, cardId, o)            → { ok, card } | { ok:false, code, … }
//   rollbackHillClimbCard(teamId, cardId, o)         → { ok, card } | { ok:false, code, … }
//   readBody(req)                                    → Promise<object> (already parsed; {} when empty)
//   sendJson(res, status, payload)
//   log(msg)                                         → optional

const MERGE_RE = /^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/merge$/;
const APPLY_RE = /^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/([^/]+)\/apply$/;
const ROLLBACK_RE = /^\/internal\/teams\/([^/]+)\/hill-climb\/cards\/([^/]+)\/rollback$/;

function resultStatus(code) {
  return code === 'card-not-found' ? 404
    : code === 'autonomy-locked' ? 403
    : 409;
}

function createHillClimbCardRoutes(deps) {
  const {
    loadAgentConfig, hillClimbCardConfig, readHillClimbCards, mergeAndPersistHillClimbCards,
    applyHillClimbCard, rollbackHillClimbCard, readBody, sendJson,
  } = deps;
  const log = deps.log || ((msg) => console.error(msg));

  // `readBody` resolves to the parsed object — never parse it again. A
  // malformed body rejects with `statusHint: 400`, answered as a client error.
  async function bodyOf(req) {
    const body = await readBody(req);
    return body && typeof body === 'object' ? body : {};
  }

  function fail(res, what, teamId, err) {
    log(`[Orchestrator] hill-climb card ${what} error for ${teamId}: ${err.message}`);
    return sendJson(res, err.statusHint === 400 ? 400 : 500, { error: err.message });
  }

  function isTeam(teamId) {
    const cfg = loadAgentConfig(teamId);
    return !!(cfg && cfg.role === 'team');
  }

  // POST /internal/teams/:teamId/hill-climb/cards/merge — hand-back path for
  // the console's server-side analyst. Body: { cards: [...] } (raw analyst
  // JSON). Every card is re-validated through the schema by the store (the
  // analyst is untrusted) and merged under the budget/dedup/cooldown rules.
  async function merge(req, res, teamId) {
    try {
      if (!isTeam(teamId)) return sendJson(res, 404, { error: 'agent team not found' });
      const { autonomy } = hillClimbCardConfig(teamId);
      if (autonomy < 1) return sendJson(res, 200, { teamId, autonomy, merge: null, cards: readHillClimbCards(teamId) });
      const body = await bodyOf(req);
      const incoming = Array.isArray(body.cards) ? body.cards : [];
      const result = mergeAndPersistHillClimbCards(teamId, incoming, { source: 'analyst' });
      return sendJson(res, 200, {
        teamId,
        merge: { added: result.added, bumped: result.bumped, deferred: result.deferred, rejected: result.rejected },
        cards: result.cards,
      });
    } catch (err) {
      return fail(res, 'merge', teamId, err);
    }
  }

  // POST /internal/teams/:teamId/hill-climb/cards/:cardId/apply — record an
  // APPLIED card. The console has already run the card's apply path through the
  // audited choke-point; this only stamps the outcome (+ undo payload) onto the
  // card. Body: { appliedBy?, undo?, configVersionRef? }.
  async function apply(req, res, teamId, cardId) {
    try {
      if (!isTeam(teamId)) return sendJson(res, 404, { error: 'agent team not found' });
      const body = await bodyOf(req);
      const result = applyHillClimbCard(teamId, cardId, {
        appliedBy: body.appliedBy || null,
        undo: body.undo || null,
        configVersionRef: body.configVersionRef || null,
      });
      if (!result.ok) return sendJson(res, resultStatus(result.code), { error: result.code, autonomy: result.autonomy, status: result.status });
      return sendJson(res, 200, { teamId, card: result.card });
    } catch (err) {
      return fail(res, 'apply', teamId, err);
    }
  }

  // POST /internal/teams/:teamId/hill-climb/cards/:cardId/rollback — record a
  // ROLLED-BACK card (fresh cooldown). The console has already executed the
  // rollback plan. Body: { rolledBackBy?, undoResult? }.
  async function rollback(req, res, teamId, cardId) {
    try {
      if (!isTeam(teamId)) return sendJson(res, 404, { error: 'agent team not found' });
      const body = await bodyOf(req);
      const result = rollbackHillClimbCard(teamId, cardId, {
        rolledBackBy: body.rolledBackBy || null,
        undoResult: body.undoResult || null,
      });
      if (!result.ok) return sendJson(res, resultStatus(result.code), { error: result.code, autonomy: result.autonomy, status: result.status });
      return sendJson(res, 200, { teamId, card: result.card });
    } catch (err) {
      return fail(res, 'rollback', teamId, err);
    }
  }

  // Returns the handler's promise when the request is one of these routes,
  // otherwise null (the caller falls through to the next route).
  function handle(req, res) {
    if (req.method !== 'POST') return null;
    let m = req.url.match(MERGE_RE);
    if (m) return merge(req, res, decodeURIComponent(m[1]));
    m = req.url.match(APPLY_RE);
    if (m) return apply(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    m = req.url.match(ROLLBACK_RE);
    if (m) return rollback(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    return null;
  }

  return { handle };
}

module.exports = { createHillClimbCardRoutes };
