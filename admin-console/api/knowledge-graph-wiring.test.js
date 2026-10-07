'use strict';

// #571 wiring guard: GET /api/knowledge/graph builds one knowledge fleet per
// build and threads it through every sweep helper, goes through the shared
// single-flight cache, bounds its orchestrator augment calls and runs them side
// by side; a successful knowledge-affecting mutation clears the cache.
// Source-reading, like the other api.js guards (pure halves:
// knowledge-fleet.js, knowledge-graph-cache.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function body(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  return API_SRC.slice(start, API_SRC.indexOf('\n}', start));
}

test('the route goes through the cache, keyed per viewer, with 0 = off', () => {
  const r = API_SRC.slice(API_SRC.indexOf("app.get('/api/knowledge/graph',"), API_SRC.indexOf('\n});', API_SRC.indexOf("app.get('/api/knowledge/graph',")));
  assert.match(r, /knowledgeGraphCache\.getOrCompute\(/);
  assert.match(r, /knowledgeGraphCacheKey\(\{ scope: parsed\.scope, includeArchived, viewerScope: scope \}\)/);
  assert.match(r, /KNOWLEDGE_GRAPH_TTL_MS > 0/);
  assert.doesNotMatch(r, /listAgentDirs|readJsonFile|gatherTeamEntries/, 'the build lives in buildKnowledgeGraphResponse');
  assert.match(API_SRC, /const KNOWLEDGE_GRAPH_TTL_MS = knowledgeGraphTtlMsFromEnv\(process\.env\);/);
  assert.match(API_SRC, /const knowledgeGraphCache = createTtlCache\(\{ ttlMs: KNOWLEDGE_GRAPH_TTL_MS/);
});

test('one fleet per build, threaded through every sweep helper', () => {
  const b = body('async function buildKnowledgeGraphResponse(');
  assert.equal(b.match(/buildKnowledgeFleetNow\(\)/g).length, 1, 'exactly one fleet build');
  assert.match(b, /knowledgeScopeTeams\(parsed, scope, fleet\)/);
  assert.match(b, /gatherTeamEntries\(teamId, \{ fleet \}\)/);
  assert.match(b, /gatherKnowledgeAgents\(scope, teamIds, fleet\)/);
  assert.match(b, /gatherKnowledgeSkills\(scope, fleet\)/);
  assert.match(b, /augmentSkillActivation\(graph, parsed, fleet\)/);
  assert.doesNotMatch(b, /listAgentDirs|readdirSync/);
});

test('gatherTeamEntries threads its fleet into every lookup it makes', () => {
  const b = body('function gatherTeamEntries(');
  assert.match(b, /resolveTeamStorePath\(teamId, kfleet\)/);
  assert.match(b, /teamAgentIds\(teamId, kfleet\)/);
  assert.match(b, /knowledgeTeamByAgent\(kfleet\)/);
  assert.match(b, /teamKnowledgeEnv\(teamId, kfleet\)/);
});

// #2920: the store sits on NFS — a sync read of every shard blocked the event
// loop for ~0.5 s per call.
test('gatherTeamEntries reads the store async, behind the fingerprint cache', () => {
  const b = body('async function gatherTeamEntries(');
  assert.doesNotMatch(b, /readFileSync|readdirSync|existsSync|statSync/);
  assert.match(b, /listStoreFiles\(store, \{ fsp \}\)/);
  assert.match(b, /await fileSignature\(\[\.\.\.listed\.map\(\(l\) => l\.manifest\), \.\.\.storeFiles, \.\.\.teamOverlayFiles\(teamId\)\]/);
  assert.match(b, /teamEntriesCache\.get\(teamId, fingerprint, async \(\) => \{\n\s+let read = await readStoreFiles\(storeFiles/);
  assert.match(b, /JSON\.stringify\(\[\.\.\.originTeams\]/, 're-homing input is part of the fingerprint');
  const overlays = body('function teamOverlayFiles(');
  for (const dir of ['KNOWLEDGE_ARCHIVED_DIR', 'KNOWLEDGE_REVIEW_DIR', 'KNOWLEDGE_VALIDITY_DIR', 'KNOWLEDGE_TRIGGERS_DIR']) {
    assert.match(overlays, new RegExp(dir), `${dir} sidecars are part of the fingerprint`);
  }
  // Now async: every call is awaited (or mapped into a Promise.all).
  assert.doesNotMatch(API_SRC, /(?<!await |function |=> )gatherTeamEntries\(/);
  assert.doesNotMatch(API_SRC, /(?<!await |function )adHocCandidate\(/);
});

test('the summary badge is memoised per scope + teams on the entries fingerprints and the minute', () => {
  const start = API_SRC.indexOf("app.get('/api/knowledge/summary',");
  const r = API_SRC.slice(start, API_SRC.indexOf('\n});', start));
  assert.match(r, /Promise\.all\(teamIds\.map\(\(teamId\) => gatherTeamEntries\(teamId, \{ fleet \}\)\)\)/);
  assert.match(r, /Math\.floor\(now \/ 60_000\), \.\.\.gathered\.map\(\(g\) => g\.fingerprint\)/);
  assert.match(r, /knowledgeSummaryCache\.get\(`\$\{parsed\.scope\}\|\$\{teamIds\.join\(','\)\}`, fingerprint,/);
});

test('the sweep helpers no longer read configs themselves', () => {
  for (const name of [
    'function knowledgeTeamVisible(', 'function resolveTeamStorePath(', 'function resolveTeamRepoUrl(', 'function teamAgentIds(',
    'function knowledgeTeamByAgent(', 'function knowledgeScopeTeams(', 'function gatherKnowledgeAgents(',
    'function teamEnvironment(',
  ]) {
    assert.doesNotMatch(body(name), /listAgentDirs\(\)|readdirSync|readJsonFile/, name);
  }
  const act = API_SRC.slice(API_SRC.indexOf('function augmentSkillActivation('), API_SRC.indexOf('// Ghost nodes for active-list skills'));
  assert.match(act, /knowledgeFleetLib\.teamMembers\(kfleet, teamId\)/);
  assert.doesNotMatch(act, /readdirSync\(AGENTS_DIR\)/);
  assert.match(API_SRC, /const state = !m\.provisioned \? 'stub'/, 'the token never leaves the fleet build');
});

test('the other multi-helper knowledge routes build one fleet and thread it', () => {
  const route = (marker) => {
    const start = API_SRC.indexOf(marker);
    assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
    return API_SRC.slice(start, API_SRC.indexOf('\n});', start));
  };
  const cases = {
    "app.get('/api/knowledge/summary',": [/knowledgeScopeTeams\(parsed, scope, fleet\)/, /gatherTeamEntries\(teamId, \{ fleet \}\)/],
    "app.get('/api/knowledge/item/:id',": [/knowledgeTeamVisible\(scope, teamId, fleet\)/, /gatherTeamEntries\(teamId, \{ fleet \}\)/, /resolveTeamRepoUrl\(teamId, fleet\)/],
    "app.get('/api/knowledge/review-queue',": [/knowledgeTeamVisible\(scope, teamId, fleet\)/, /gatherTeamEntries\(teamId, \{ fleet \}\)/, /teamKnowledgeEnv\(teamId, fleet\)/],
    "app.get('/api/knowledge/gates',": [/knowledgeTeamVisible\(scope, teamId, fleet\)/, /teamKnowledgeEnv\(teamId, fleet\)/],
    "app.post('/api/knowledge/summaries/backfill',": [/knowledgeTeamVisible\(scope, teamId, fleet\)/, /gatherTeamEntries\(teamId, \{ fleet \}\)/],
  };
  for (const [marker, patterns] of Object.entries(cases)) {
    const r = route(marker);
    assert.equal((r.match(/buildKnowledgeFleetNow\(\)/g) || []).length, 1, `${marker} builds exactly one fleet`);
    for (const re of patterns) assert.match(r, re, `${marker} ${re}`);
  }
  // A wrapper given an explicit null still builds its own (a default param would not).
  for (const name of ['function resolveTeamStorePath(', 'function resolveTeamRepoUrl(', 'function teamAgentIds(',
    'function knowledgeTeamByAgent(', 'function gatherKnowledgeAgents(', 'function teamEnvironment(']) {
    assert.match(body(name), /fleet = null\) \{\n\s+return knowledgeFleetLib\.\w+\(fleet \|\| buildKnowledgeFleetNow\(\)/, name);
  }
});

test('the three orchestrator augments run side by side, each fetch bounded', () => {
  const b = body('async function buildKnowledgeGraphResponse(');
  assert.match(b, /await Promise\.all\(\[\n\s+augmentDigestInclusion\(graph, teamIds\),\n\s+augmentSkillRoles\(graph, teamIds\),\n\s+augmentRetrievalStats\(graph, teamIds\),\n\s+\]\)/);
  for (const name of ['async function augmentDigestInclusion(', 'async function augmentSkillRoles(', 'async function augmentRetrievalStats(']) {
    const start = API_SRC.indexOf(name);
    const fnSrc = API_SRC.slice(start, API_SRC.indexOf('\n}\n', start));
    assert.match(fnSrc, /signal: AbortSignal\.timeout\(KNOWLEDGE_AUGMENT_TIMEOUT_MS\)/, name);
  }
  assert.match(API_SRC, /const KNOWLEDGE_AUGMENT_TIMEOUT_MS = knowledgeAugmentTimeoutMsFromEnv\(process\.env\);/);
});

test('a successful mutation clears the cache, behind the auth gate, on res.end, status-checked', () => {
  // res.end + final-status behaviour: invalidate-on-write.test.js.
  const at = API_SRC.indexOf("app.use('/api', invalidateOnSuccessfulWrite(mutationInvalidatesKnowledgeGraph, invalidateKnowledgeGraphCache));");
  assert.ok(at > 0, 'invalidation middleware missing');
  assert.ok(at > API_SRC.indexOf("app.use('/api', auth.gate);"), 'mounted after the auth gate');
  assert.match(API_SRC, /function invalidateKnowledgeGraphCache\(\) \{ knowledgeGraphCache\.clear\(\); \}/);
});

test('a build failure answers a generic 500', () => {
  const r = API_SRC.slice(API_SRC.indexOf("app.get('/api/knowledge/graph',"));
  assert.match(r.slice(0, 1200), /res\.status\(500\)\.json\(\{ error: 'knowledge graph build failed' \}\)/);
});

test('a tailed feed event clears the cache before the client hears of it', () => {
  const start = API_SRC.indexOf("app.get('/api/knowledge/stream',");
  assert.ok(start > 0, 'stream route not found');
  const emit = API_SRC.slice(API_SRC.indexOf('const emitLine = (line, endOffset) => {', start), API_SRC.indexOf('const drain = () => {', start));
  const clearAt = emit.indexOf('invalidateKnowledgeGraphCacheForEvent(ev, endOffset);');
  const writeAt = emit.indexOf('writeEvent(ev)');
  assert.ok(clearAt > 0 && writeAt > clearAt, 'clear first, then write — the feed reload must miss the cache');
  assert.doesNotMatch(emit, /invalidateKnowledgeGraphCache\(\)/, 'a feed event never clears the whole cache');
});

test('a feed event clears only its graphs, once across every open stream', () => {
  const fn = body('function invalidateKnowledgeGraphCacheForEvent(');
  assert.match(fn, /claimKnowledgeEventOffset\(knowledgeEventsInvalidatedThrough, endOffset\)/);
  assert.match(fn, /knowledgeGraphCache\.deleteWhere\(\(key\) => knowledgeGraphKeyStaleForEvent\(key, ev\)\)/);
  assert.doesNotMatch(fn, /\.clear\(\)/);
  // The stream feeds each line's END byte offset and resets on truncation.
  const start = API_SRC.indexOf("app.get('/api/knowledge/stream',");
  const r = API_SRC.slice(start, API_SRC.indexOf('\n});', start));
  assert.match(r, /lineStart \+= Buffer\.byteLength\(line, 'utf8'\) \+ 1;\n\s+if \(line\.trim\(\)\) emitLine\(line, lineStart\);/);
  assert.match(r, /noteKnowledgeEventsFileSize\(size\);/);
  assert.match(r, /lineStart = 0;/);
});

test('a broken agent config is warned with its real cause, re-armed by a clean read', () => {
  const b = body('function buildKnowledgeFleetNow(');
  assert.match(b, /readJsonFile\(path\.join\(AGENTS_DIR, id, 'config\.json'\), null, \(err\) => \{ cause = err; \}\);\n\s+if \(cause\) throw cause;/);
  assert.match(b, /_knowledgeFleetWarnings\.shouldWarn\(id, err\)/);
  assert.match(b, /onEntryOk: \(id\) => _knowledgeFleetWarnings\.ok\(id\)/);
  assert.match(body('function readJsonFile('), /catch \(err\) \{\n\s+if \(onError\) onError\(err\);\n\s+return fallback;/);
});
